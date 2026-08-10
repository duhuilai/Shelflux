// SFTP 视图 - 左右双栏
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Tab, FileEntry, TransferProgress } from "../../types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { toast } from "../../stores/toastStore";
import { joinPath, basename, uid } from "../../utils/format";
import { FilePanel } from "./FilePanel";
import { TransferList, type TransferItem } from "./TransferList";
import "./SftpView.css";

interface Props {
  tab: Tab;
}

export function SftpView({ tab }: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const askConfirm = useUiStore((s) => s.askConfirm);

  // 本地路径：使用 server 配置的默认值，否则获取系统 home
  const [localPath, setLocalPath] = useState<string>(() => {
    return tab.server.defaultLocalPath || "";
  });
  const [remotePath, setRemotePath] = useState<string>(() => {
    return tab.server.defaultRemotePath || "/";
  });
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [localPathInitialized, setLocalPathInitialized] = useState(!!tab.server.defaultLocalPath);

  // 初始化本地路径
  useEffect(() => {
    if (localPathInitialized) return;
    (async () => {
      try {
        const home = await invoke<string>("local_home");
        setLocalPath(home || "/");
        setLocalPathInitialized(true);
      } catch {
        setLocalPath("/");
        setLocalPathInitialized(true);
      }
    })();
  }, [localPathInitialized]);

  const runningCount = transfers.filter(
    (t) => t.status === "running"
  ).length;

  // 监听传输进度
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    // 监听所有 transfer-progress-* 事件
    // 注意：listen 的事件名需要提前知道，无法用通配符。
    // 我们在添加 transfer 时单独 listen 该 taskId
    return () => {
      unlisteners.forEach((u) => u());
    };
  }, []);

  // 单个传输任务：监听其进度
  const trackTransfer = useCallback(async (taskId: string) => {
    const unlisten = await listen<TransferProgress>(
      `transfer-progress-${taskId}`,
      (event) => {
        const p = event.payload;
        setTransfers((prev) => {
          return prev.map((t) => {
            if (t.id !== taskId) return t;
            return {
              ...t,
              transferred: p.transferred,
              total: p.total,
              speed: p.speed,
              status: p.status as any,
              message: p.message || t.message,
            };
          });
        });
        // 自动清理完成/失败的项（5秒后）
        if (p.status === "done" || p.status === "error") {
          setTimeout(() => {
            setTransfers((prev) => prev.filter((t) => t.id !== taskId));
          }, 5000);
        }
      }
    );
    return unlisten;
  }, []);

  // 传输文件
  const handleTransfer = useCallback(
    async (items: FileEntry[], direction: "upload" | "download") => {
      for (const item of items) {
        const taskId = uid();
        const targetDir = direction === "upload" ? remotePath : localPath;
        const destPath = joinPath(targetDir, item.name);
        const sourcePath = item.path;

        const transfer: TransferItem = {
          id: taskId,
          name: basename(direction === "upload" ? sourcePath : destPath),
          direction,
          transferred: 0,
          total: item.size || 0,
          speed: 0,
          status: "running",
          message: direction === "upload"
            ? `上传到 ${destPath}`
            : `下载到 ${destPath}`,
        };
        setTransfers((prev) => [...prev, transfer]);

        // 监听进度
        const unlisten = await trackTransfer(taskId);

        try {
          if (direction === "upload") {
            await invoke("sftp_upload", {
              server: tab.server,
              local: sourcePath,
              remote: destPath,
              taskId,
            });
          } else {
            await invoke("sftp_download", {
              server: tab.server,
              remote: sourcePath,
              local: destPath,
              taskId,
            });
          }
        } catch (e: any) {
          setTransfers((prev) =>
            prev.map((t) =>
              t.id === taskId
                ? { ...t, status: "error", message: e.toString() }
                : t
            )
          );
          toast.error("传输失败", item.name);
        } finally {
          unlisten();
        }
      }
    },
    [localPath, remotePath, tab.server, trackTransfer]
  );

  // 传输确认：检查目标文件是否存在
  const checkAndTransfer = useCallback(
    async (items: FileEntry[], direction: "upload" | "download") => {
      if (!settings.transfers.confirmOverwrite) {
        handleTransfer(items, direction);
        return;
      }
      // 简化为：批量传输，覆盖提示在 Rust 端由 overwrite 决定
      // 这里只对第一个文件提示
      for (const item of items) {
        const targetDir = direction === "upload" ? remotePath : localPath;
        const destPath = joinPath(targetDir, item.name);
        try {
          let exists = false;
          if (direction === "upload") {
            exists = await invoke<boolean>("sftp_exists", {
              server: tab.server,
              path: destPath,
            });
          } else {
            exists = await invoke<boolean>("local_exists", { path: destPath });
          }
          if (exists) {
            const ok = await askConfirm({
              title: "文件已存在",
              message: `目标位置已存在 "${item.name}"，是否覆盖？`,
              confirmText: "覆盖",
              danger: true,
            });
            if (!ok) continue;
          }
        } catch {
          /* ignore */
        }
        handleTransfer([item], direction);
      }
    },
    [settings.transfers.confirmOverwrite, remotePath, localPath, tab.server, askConfirm, handleTransfer]
  );

  return (
    <div className="sftp-view">
      <div className="sftp-toolbar">
        <div className="sftp-panel-label">SFTP</div>
        <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
          {tab.server.username}@{tab.server.host}
        </span>
        <div className="toolbar-spacer" />
        {runningCount > 0 && (
          <div className="transfer-summary active">
            {runningCount} 个任务进行中
          </div>
        )}
      </div>
      <div className="sftp-panels">
        <FilePanel
          title="本地"
          labelClass="local"
          currentPath={localPath}
          onPathChange={setLocalPath}
          onTransfer={(items) => checkAndTransfer(items, "upload")}
          server={tab.server}
          side="local"
        />
        <FilePanel
          title="远端"
          labelClass="remote"
          currentPath={remotePath}
          onPathChange={setRemotePath}
          onTransfer={(items) => checkAndTransfer(items, "download")}
          server={tab.server}
          side="remote"
        />
      </div>
      <TransferList transfers={transfers} onClear={() => setTransfers([])} />
    </div>
  );
}
