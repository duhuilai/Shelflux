// SFTP 视图 - 左右双栏，每栏支持多个文件夹页签
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Tab, FileEntry, TransferProgress } from "../../types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { toast } from "../../stores/toastStore";
import { joinPath, basename, uid } from "../../utils/format";
import { FilePanel, focusSide } from "./FilePanel";
import { TransferList, type TransferItem } from "./TransferList";
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

  const [transfers, setTransfers] = useState<TransferItem[]>([]);

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

  // 监听传输进度
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    return () => {
      unlisteners.forEach((u) => u());
    };
  }, []);

  // 单个传输任务进度
  const trackTransfer = useCallback(async (taskId: string) => {
    const unlisten = await listen<TransferProgress>(
      `transfer-progress-${taskId}`,
      (event) => {
        const p = event.payload;
        setTransfers((prev) =>
          prev.map((t) =>
            t.id !== taskId
              ? t
              : {
                  ...t,
                  transferred: p.transferred,
                  total: p.total,
                  speed: p.speed,
                  status: p.status as any,
                  message: p.message || t.message,
                }
          )
        );
        if (p.status === "done" || p.status === "error") {
          setTimeout(() => {
            setTransfers((prev) => prev.filter((t) => t.id !== taskId));
          }, 5000);
        }
      }
    );
    return unlisten;
  }, []);

  // 传输文件（目标目录取当前激活页签路径）
  const handleTransfer = useCallback(
    async (items: FileEntry[], direction: "upload" | "download") => {
      for (const item of items) {
        const taskId = uid();
        const targetDir = direction === "upload" ? activeRemotePath : activeLocalPath;
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
          message: direction === "upload" ? `上传到 ${destPath}` : `下载到 ${destPath}`,
        };
        setTransfers((prev) => [...prev, transfer]);

        const unlisten = await trackTransfer(taskId);

        try {
          if (direction === "upload") {
            await invoke("sftp_upload", { server: tab.server, local: sourcePath, remote: destPath, taskId });
          } else {
            await invoke("sftp_download", { server: tab.server, remote: sourcePath, local: destPath, taskId });
          }
        } catch (e: any) {
          setTransfers((prev) =>
            prev.map((t) =>
              t.id === taskId ? { ...t, status: "error", message: e.toString() } : t
            )
          );
          toast.error("传输失败", item.name);
        } finally {
          unlisten();
        }
      }
    },
    [activeLocalPath, activeRemotePath, tab.server, trackTransfer]
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
        <div className="sftp-panel-col" onMouseDown={() => focusSide("local")}>
          <FolderTabBar
            accent="local"
            tabs={localTabs}
            activeId={activeLocalTabId}
            onActivate={(id) => {
              setActiveLocalTabId(id);
              focusSide("local");
            }}
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
        <div className="sftp-panel-col" onMouseDown={() => focusSide("remote")}>
          <FolderTabBar
            accent="remote"
            tabs={remoteTabs}
            activeId={activeRemoteTabId}
            onActivate={(id) => {
              setActiveRemoteTabId(id);
              focusSide("remote");
            }}
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

      <TransferList transfers={transfers} onClear={() => setTransfers([])} />
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
