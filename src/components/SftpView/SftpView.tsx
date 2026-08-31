// SFTP 视图 - 左右双栏，每栏支持多个文件夹页签
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Tab, FileEntry, TransferProgress, TransferItem } from "../../types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useTransferStore } from "../../stores/transferStore";
import { toast } from "../../stores/toastStore";
import { joinPath, basename, uid } from "../../utils/format";
import { FilePanel } from "./FilePanel";
import { TransferList } from "./TransferList";
import "./SftpView.css";

interface FolderTab {
  id: string;
  path: string;
}

interface Props {
  tab: Tab;
}

export function SftpView({ tab }: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const askConfirm = useUiStore((s) => s.askConfirm);

  // 本地路径页签
  const [localTabs, setLocalTabs] = useState<FolderTab[]>(() => [
    { id: uid(), path: tab.server.defaultLocalPath || "" },
  ]);
  const [activeLocalTabId, setActiveLocalTabId] = useState<string>(() => localTabs[0].id);
  const [localPathInitialized, setLocalPathInitialized] = useState(!!tab.server.defaultLocalPath);

  // 远端路径页签
  const [remoteTabs, setRemoteTabs] = useState<FolderTab[]>(() => [
    { id: uid(), path: tab.server.defaultRemotePath || "/" },
  ]);
  const [activeRemoteTabId, setActiveRemoteTabId] = useState<string>(() => remoteTabs[0].id);

  // 传输队列来自全局 store（跨 SFTP 标签页共享，避免卸载后幽灵传输）
  const transfers = useTransferStore((s) => s.transfers);
  const transferAdd = useTransferStore((s) => s.add);
  const transferUpdate = useTransferStore((s) => s.update);
  const transferRemove = useTransferStore((s) => s.remove);
  const transferClear = useTransferStore((s) => s.clear);

  const activeLocalPath = localTabs.find((t) => t.id === activeLocalTabId)?.path || "";
  const activeRemotePath = remoteTabs.find((t) => t.id === activeRemoteTabId)?.path || "/";

  // 初始化本地首标签路径（无默认值时取系统 home）
  useEffect(() => {
    if (localPathInitialized) return;
    (async () => {
      try {
        const home = await invoke<string>("local_home");
        setLocalTabs((prev) => prev.map((t, i) => (i === 0 ? { ...t, path: home || "/" } : t)));
      } catch {
        setLocalTabs((prev) => prev.map((t, i) => (i === 0 ? { ...t, path: "/" } : t)));
      } finally {
        setLocalPathInitialized(true);
      }
    })();
  }, [localPathInitialized]);

  const runningCount = transfers.filter((t) => t.status === "running").length;

  // 单个传输任务进度（写入全局 store）
  const trackTransfer = useCallback(
    async (taskId: string) => {
      const unlisten = await listen<TransferProgress>(
        `transfer-progress-${taskId}`,
        (event) => {
          const p = event.payload;
          transferUpdate(taskId, {
            transferred: p.transferred,
            total: p.total,
            speed: p.speed,
            status: p.status as TransferItem["status"],
            message: p.message || undefined,
          });
          if (p.status === "done") {
            // 完成后稍作停留再移除（保留绿色进度条让用户看到结果）
            setTimeout(() => transferRemove(taskId), 5000);
          } else if (p.status === "error") {
            // 失败项保留在队列中，供用户点"续传"
            transferUpdate(taskId, { canResume: false });
          }
        }
      );
      return unlisten;
    },
    [transferUpdate, transferRemove]
  );

  // 计算断点续传偏移：取目标端已存在文件的大小
  const computeResumeOffset = useCallback(
    async (direction: "upload" | "download", sourcePath: string, destPath: string): Promise<number> => {
      let existing = 0;
      try {
        if (direction === "upload") {
          const meta = await invoke<{ size?: number } | null>("sftp_stat", { server: tab.server, path: destPath });
          existing = meta?.size ?? 0;
        } else {
          const meta = await invoke<{ size?: number } | null>("local_stat", { path: destPath });
          existing = meta?.size ?? 0;
        }
      } catch {
        existing = 0;
      }
      return existing;
    },
    [tab.server]
  );

  // 传输单个文件（目标目录取当前激活页签路径）
  // offset>0 时断点续传：从目标已存在大小处继续
  const transferOne = useCallback(
    async (item: FileEntry, direction: "upload" | "download", offset = 0) => {
      // 跳过符号链接 / NTFS 结点（无法可靠读取或传输）
      if (item.isSymlink || item.kind === "symlink") {
        toast.warn(`已跳过（符号链接/结点）`, item.name);
        return;
      }

      const taskId = uid();
      const targetDir = direction === "upload" ? activeRemotePath : activeLocalPath;
      const destPath = joinPath(targetDir, item.name);
      const sourcePath = item.path;

      const transfer: TransferItem = {
        id: taskId,
        name: basename(direction === "upload" ? sourcePath : destPath),
        direction,
        transferred: offset,
        total: item.size || 0,
        speed: 0,
        status: "running",
        message: direction === "upload" ? `上传到 ${destPath}` : `下载到 ${destPath}`,
        sourcePath,
        destPath,
      };
      transferAdd(transfer);

      const unlisten = await trackTransfer(taskId);

      try {
        if (direction === "upload") {
          await invoke("sftp_upload", { server: tab.server, local: sourcePath, remote: destPath, taskId, offset: offset || null });
        } else {
          await invoke("sftp_download", { server: tab.server, remote: sourcePath, local: destPath, taskId, offset: offset || null });
        }
      } catch (e: any) {
        const errMsg = e?.toString() || "未知错误";
        // 目标端存在部分数据则允许续传
        const resumeOffset = await computeResumeOffset(direction, sourcePath, destPath);
        transferUpdate(taskId, {
          status: "error",
          message: errMsg,
          transferred: resumeOffset,
          canResume: resumeOffset > 0,
        });
        const shortMsg = errMsg.length > 80 ? errMsg.slice(0, 80) + "…" : errMsg;
        toast.error(`传输失败: ${shortMsg}`, item.name);
      } finally {
        unlisten();
      }
    },
    [activeLocalPath, activeRemotePath, tab.server, trackTransfer, transferAdd, transferUpdate, computeResumeOffset]
  );

  // 传输多个文件：按设置中的并发数分批次并行（默认 3）
  const handleTransfer = useCallback(
    async (items: FileEntry[], direction: "upload" | "download", offset = 0) => {
      const conc = Math.max(1, Math.min(10, settings.transfers.concurrency || 1));
      for (let i = 0; i < items.length; i += conc) {
        const batch = items.slice(i, i + conc);
        await Promise.all(batch.map((it) => transferOne(it, direction, offset)));
      }
    },
    [settings.transfers.concurrency, transferOne]
  );

  // 续传：对失败项从断点继续
  const resumeTransfer = useCallback(
    async (item: TransferItem) => {
      if (!item.sourcePath || !item.destPath) return;
      const offset = await computeResumeOffset(item.direction, item.sourcePath, item.destPath);
      const it: FileEntry = {
        name: item.name,
        path: item.sourcePath,
        kind: "file",
        size: item.total || 0,
        isSymlink: false,
      };
      // 以续传模式重跑（handleTransfer 内部会重新建 transfer 项，旧 error 项保留供对照）
      await handleTransfer([it], item.direction, offset);
    },
    [computeResumeOffset, handleTransfer]
  );

  // 传输确认：检查目标文件是否存在
  const checkAndTransfer = useCallback(
    async (items: FileEntry[], direction: "upload" | "download") => {
      if (!settings.transfers.confirmOverwrite) {
        handleTransfer(items, direction);
        return;
      }
      for (const item of items) {
        const targetDir = direction === "upload" ? activeRemotePath : activeLocalPath;
        const destPath = joinPath(targetDir, item.name);
        try {
          let exists = false;
          if (direction === "upload") {
            exists = await invoke<boolean>("sftp_exists", { server: tab.server, path: destPath });
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
    [settings.transfers.confirmOverwrite, activeRemotePath, activeLocalPath, tab.server, askConfirm, handleTransfer]
  );

  // 全局 drop 处理：解决 WebView2 跨面板拖放事件丢失问题
  // Windows WebView2 下，源面板拖出的 dragover/dragenter/drop 不会派发到目标面板，
  // 只能在 document 级别捕获 drop，再根据鼠标 X 坐标判定落在哪一侧。
  // 方向由“源侧”决定：本地文件→远端 = 上传；远端文件→本地 = 下载。
  // macOS 上目标面板自身 onDrop 也会触发，但 FilePanel 已对 shelflux: 内部拖放做了 no-op，
  // 因此不会重复传输，全局 handler 是内部跨面板拖放的唯一处理入口。
  useEffect(() => {
    // 无条件允许放置：drop 端会校验数据格式（shelflux: 前缀），非内部拖放不处理。
    // 必须在 dragover + dragenter 都 preventDefault，否则 WebView2 显示 ⊘ 禁止光标。
    const handleGlobalDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };
    const handleGlobalDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };

    const handleGlobalDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const raw = dt.getData("text/plain");
      if (!raw || !raw.startsWith("shelflux:")) return; // 非内部拖放（外部文件）交给 FilePanel

      e.preventDefault();
      e.stopPropagation();

      try {
        const parsed = JSON.parse(raw.slice("shelflux:".length));
        if (parsed.side === undefined || !Array.isArray(parsed.items)) return;

        // 根据鼠标位置判定目标面板（取两个面板列的实际边界，左列右侧即分隔线）
        const cols = document.querySelectorAll<HTMLElement>(".sftp-panel-col");
        let targetSide: "local" | "remote" = "remote";
        if (cols.length >= 2) {
          const localRect = cols[0].getBoundingClientRect();
          targetSide = e.clientX < localRect.right ? "local" : "remote";
        } else {
          const midX = window.innerWidth / 2;
          targetSide = e.clientX < midX ? "local" : "remote";
        }

        // 不能拖到同侧
        if (parsed.side === targetSide) return;

        // 方向由源侧决定：本地文件→远端=上传，远端文件→本地=下载
        const direction = parsed.side === "local" ? "upload" : "download";
        checkAndTransfer(parsed.items, direction);
      } catch {
        // 忽略解析错误
      }
    };

    document.addEventListener("dragenter", handleGlobalDragEnter);
    document.addEventListener("dragover", handleGlobalDragOver);
    document.addEventListener("drop", handleGlobalDrop);
    return () => {
      document.removeEventListener("dragenter", handleGlobalDragEnter);
      document.removeEventListener("dragover", handleGlobalDragOver);
      document.removeEventListener("drop", handleGlobalDrop);
    };
  }, [checkAndTransfer]);

  // ===== 文件夹页签操作 =====
  const setLocalTabPath = useCallback((id: string, p: string) => {
    setLocalTabs((prev) => prev.map((t) => (t.id === id ? { ...t, path: p } : t)));
  }, []);
  const addLocalTab = useCallback(() => {
    const id = uid();
    const base = activeLocalPath || "/";
    setLocalTabs((prev) => [...prev, { id, path: base }]);
    setActiveLocalTabId(id);
  }, [activeLocalPath]);
  const closeLocalTab = useCallback((id: string) => {
    setLocalTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeLocalTabId) {
        const neighbor = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveLocalTabId(neighbor.id);
      }
      return next;
    });
  }, [activeLocalTabId]);

  const setRemoteTabPath = useCallback((id: string, p: string) => {
    setRemoteTabs((prev) => prev.map((t) => (t.id === id ? { ...t, path: p } : t)));
  }, []);
  const addRemoteTab = useCallback(() => {
    const id = uid();
    const base = activeRemotePath || "/";
    setRemoteTabs((prev) => [...prev, { id, path: base }]);
    setActiveRemoteTabId(id);
  }, [activeRemotePath]);
  const closeRemoteTab = useCallback((id: string) => {
    setRemoteTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeRemoteTabId) {
        const neighbor = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveRemoteTabId(neighbor.id);
      }
      return next;
    });
  }, [activeRemoteTabId]);

  return (
    <div className="sftp-view">
      <div className="sftp-toolbar">
        <div className="sftp-panel-label">SFTP</div>
        <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
          {tab.server.username}@{tab.server.host}
        </span>
        <div className="toolbar-spacer" />
        {runningCount > 0 && (
          <div className="transfer-summary active">{runningCount} 个任务进行中</div>
        )}
      </div>

      <div className="sftp-panels">
        {/* 本地面板 + 文件夹页签 */}
        <div className="sftp-panel-col">
          <FolderTabBar
            accent="local"
            tabs={localTabs}
            activeId={activeLocalTabId}
            onActivate={(id) => setActiveLocalTabId(id)}
            onClose={closeLocalTab}
            onAdd={addLocalTab}
          />
          <FilePanel
            key={activeLocalTabId}
            title="本地"
            labelClass="local"
            currentPath={localPathInitialized ? activeLocalPath : activeLocalPath || "/"}
            onPathChange={(p) => setLocalTabPath(activeLocalTabId, p)}
            onTransfer={(items) => checkAndTransfer(items, "upload")}
            server={tab.server}
            side="local"
          />
        </div>

        {/* 远端面板 + 文件夹页签 */}
        <div className="sftp-panel-col">
          <FolderTabBar
            accent="remote"
            tabs={remoteTabs}
            activeId={activeRemoteTabId}
            onActivate={(id) => setActiveRemoteTabId(id)}
            onClose={closeRemoteTab}
            onAdd={addRemoteTab}
          />
          <FilePanel
            key={activeRemoteTabId}
            title="远端"
            labelClass="remote"
            currentPath={activeRemotePath}
            onPathChange={(p) => setRemoteTabPath(activeRemoteTabId, p)}
            onTransfer={(items) => checkAndTransfer(items, "download")}
            server={tab.server}
            side="remote"
          />
        </div>
      </div>

      <TransferList transfers={transfers} onClear={transferClear} onResume={resumeTransfer} />
    </div>
  );
}

/** 文件夹页签栏 */
function FolderTabBar({
  accent,
  tabs,
  activeId,
  onActivate,
  onClose,
  onAdd,
}: {
  accent: "local" | "remote";
  tabs: FolderTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
}) {
  const labelOf = (p: string) => {
    if (!p || p === "/") return p || "/";
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || p;
  };

  return (
    <div className="sftp-foldertabbar">
      <span className={`sftp-foldertab-accent ${accent === "remote" ? "accent-remote" : ""}`}>
        {accent === "local" ? "本地" : "远端"}
      </span>
      <div className="sftp-foldertab-scroll">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`sftp-foldertab ${accent === "remote" ? "accent-remote" : ""} ${
              t.id === activeId ? "active" : ""
            }`}
            title={t.path}
            onClick={() => onActivate(t.id)}
          >
            <span className="sftp-foldertab-name">{labelOf(t.path)}</span>
            {tabs.length > 1 && (
              <span
                className="sftp-foldertab-close"
                title="关闭页签"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                ×
              </span>
            )}
          </div>
        ))}
      </div>
      <button className="sftp-foldertab-add" title="新页签" onClick={onAdd}>
        +
      </button>
    </div>
  );
}
