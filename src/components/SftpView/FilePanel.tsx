// 文件列表面板（左侧或右侧共用）
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FileEntry, Server } from "../../types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { toast } from "../../stores/toastStore";
import { joinPath, dirname, formatDate, formatSize, basename, extOf, uid } from "../../utils/format";
import { PathBreadcrumb } from "./PathBreadcrumb";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

interface Props {
  title: string;
  labelClass: "local" | "remote";
  currentPath: string;
  onPathChange: (p: string) => void;
  onTransfer: (items: FileEntry[]) => void;
  server: Server;
  side: "local" | "remote";
}

/** 列宽约束（px）：名称列为自适应列，三个固定列不得把它挤没 */
const MIN_NAME_W = 100;
const MIN_SIZE_W = 56;
const MIN_TIME_W = 96;
const MIN_TYPE_W = 80;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi < lo ? lo : hi);

/** 目录路径归一化：统一斜杠、去掉结尾分隔符，便于跨端比较 */
const normDir = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** 记录当前获得焦点的面板侧（用于决定 Ctrl+C/V 作用于哪个面板） */
let activeSide: "local" | "remote" | null = null;

/** 外部（如文件夹页签栏）主动声明焦点侧，保证快捷键路由正确 */
export function focusSide(side: "local" | "remote") {
  activeSide = side;
}

export function FilePanel({
  title,
  labelClass,
  currentPath,
  onPathChange,
  onTransfer,
  server,
  side,
}: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingPath, setEditingPath] = useState(false);
  // 行内重命名状态
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  // 双击节奏判定：区分“快速双击”（传输/打开）与“慢点两下”（重命名）
  const lastClickRef = useRef<{ time: number; path: string | null }>({ time: 0, path: null });
  // 自定义指针拖拽（替代 HTML5 DnD，规避 Windows WebView2 跨面板事件丢失 / 禁止光标）
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const [isPointerDragging, setIsPointerDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileEntry | null;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 排序状态
  type SortKey = "name" | "size" | "modified" | "type";
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // 打开方式子菜单用的应用列表（右键文件时预加载）
  const [openWithApps, setOpenWithApps] = useState<Array<{ name: string; path: string }>>([]);
  const [openWithFilePath, setOpenWithFilePath] = useState<string | null>(null);
  const dragCounter = useRef(0);

  // server 用 ref 持有，保证下面的 loadEntries 只依赖稳定的 side，
  // 不随 server 对象引用变化而频繁重建（否则会触发目录反复重新拉取 → 页面闪烁）
  const serverRef = useRef(server);
  serverRef.current = server;

  // 目录拉取改为内部定义，依赖稳定的 side（而非外部每次渲染都新建的回调），
  // 从根上打断"重渲染 → 重建 loadEntries → 重新拉取 → 再重渲染"的循环
  const loadEntries = useCallback(async (path: string) => {
    if (side === "local") {
      return await invoke<FileEntry[]>("local_list", { path });
    }
    return await invoke<FileEntry[]>("sftp_list", {
      server: serverRef.current,
      path,
    });
  }, [side]);

  const tableRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  // 固定列宽（px）：大小 / 修改时间
  // 名称列不设宽度 → table-layout:fixed 下浏览器自动分配剩余空间 = 表格宽 - 90 - 150
  // 无需 JS 计算、无需 ResizeObserver、无需 state 驱动
  const FIXED_SIZE_COL = 90;
  const FIXED_TIME_COL = 150;

  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const removeDefaultApp = useSettingsStore((s) => s.removeDefaultApp);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const askPrompt = useUiStore((s) => s.askPrompt);
  const askOverwrite = useUiStore((s) => s.askOverwrite);
  const setClipboard = useUiStore((s) => s.setClipboard);

  const load = useCallback(
    async (path: string) => {
      if (!path) return;
      setLoading(true);
      setError(null);
      setSelected(new Set());
      try {
        // 前端 45s 超时兜底：后端 sftp_list 已有 30s 超时，这里多留余量
        const result = await Promise.race([
          loadEntries(path),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('加载超时（服务器无响应）')), 45000)
          ),
        ]);
        setEntries(result);
      } catch (e: any) {
        setError(e.toString());
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [loadEntries]
  );

  useEffect(() => {
    if (currentPath) load(currentPath);
  }, [currentPath, load]);

  // 监听传输/同步完成事件：当本面板所在侧、且目录与当前目录一致时，刷新列表
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const refreshTimer = useRef<number | null>(null);
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<{ side: string; dir: string }>(
        "sftp-dir-changed",
        (event) => {
          if (event.payload.side !== side) return;
          if (normDir(event.payload.dir) !== normDir(currentPathRef.current)) return;
          // 防抖合并多次连续刷新
          if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => {
            load(currentPathRef.current);
          }, 400);
        }
      );
      if (cancelled) u();
      else unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [side, load]);

  // 复制选中项到应用内剪贴板（Ctrl+C）
  const copySelection = useCallback(() => {
    if (selected.size === 0) return false;
    const items = entries.filter((e) => selected.has(e.path));
    if (items.length === 0) return false;
    setClipboard({
      side,
      server: side === "remote" ? server : null,
      items,
    });
    toast.info("已复制", `${items.length} 项`);
    return true;
  }, [selected, entries, side, server, setClipboard]);

  // 粘贴剪贴板内容到当前目录（Ctrl+V）
  const pasteItems = useCallback(async () => {
    const clip = useUiStore.getState().clipboard;
    if (!clip || clip.items.length === 0) return;

    // 跨侧粘贴：当作传输到对面处理
    if (clip.side !== side) {
      onTransfer(clip.items);
      toast.info("已传输到对面");
      return;
    }

    setLoading(true);
    try {
      for (const item of clip.items) {
        let destName = item.name;
        let destPath = joinPath(currentPath, destName);
        const exists = side === "local"
          ? await invoke<boolean>("local_exists", { path: destPath })
          : await invoke<boolean>("sftp_exists", { server, path: destPath });
        if (exists) {
          const choice = await askOverwrite({
            title: "文件已存在",
            message: `"${destName}" 已存在，是否覆盖或重命名？`,
          });
          if (choice === "skip") continue;
          if (choice === "rename") {
            const newName = await askPrompt({
              title: "重命名副本",
              message: "请输入新名称",
              defaultValue: destName,
            });
            if (!newName || newName === destName) continue;
            destName = newName;
            destPath = joinPath(currentPath, newName);
          }
          // overwrite：直接复制，后端会覆盖既有文件
        }
        if (side === "local") {
          await invoke("local_copy", { from: item.path, to: destPath });
        } else {
          await invoke("sftp_copy", {
            server: clip.server ?? server,
            from: item.path,
            to: destPath,
            taskId: uid(),
          });
        }
      }
      await load(currentPath);
      toast.success("已粘贴", `${clip.items.length} 项`);
    } catch (e: any) {
      toast.error("粘贴失败", e.toString());
    } finally {
      setLoading(false);
    }
  }, [side, currentPath, server, onTransfer, askOverwrite, askPrompt, load]);

  // 监听 Ctrl+C / Ctrl+V / Delete（仅作用于当前获得焦点的面板；输入框/弹窗中不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const st = useUiStore.getState();
      if (st.confirm.open || st.prompt.open || st.overwrite.open) return;
      if (activeSide !== side) return;

      const key = e.key.toLowerCase();
      // Delete / Backspace：批量删除选中项
      if (key === "delete" || key === "backspace") {
        if (selected.size > 0) {
          e.preventDefault();
          void deleteItems();
        }
        return;
      }
      // 以下需要 Ctrl/Meta
      if (!(e.ctrlKey || e.metaKey)) return;

      if (key === "c") {
        if (selected.size === 0) return;
        if (copySelection()) e.preventDefault();
      } else if (key === "v") {
        const clip = useUiStore.getState().clipboard;
        if (clip && clip.items.length > 0) {
          e.preventDefault();
          void pasteItems();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [side, selected, copySelection, pasteItems]);

  // 关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  // 上级目录
  const goUp = () => {
    if (currentPath && currentPath !== "/" && currentPath !== "")
      onPathChange(dirname(currentPath));
  };

  // 双击节奏改由 handleClick 内按两次点击的时间间隔判定（见下方）

  // 开始行内重命名
  const startRename = useCallback((item: FileEntry) => {
    setRenamingPath(item.path);
    setRenameValue(item.name);
    // 下次渲染后聚焦并选中文本
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 10);
  }, []);

  // 完成重命名
  const finishRename = useCallback(async () => {
    if (!renamingPath) return;
    const item = entries.find(e => e.path === renamingPath);
    if (!item || !renameValue.trim() || renameValue.trim() === item.name) {
      setRenamingPath(null);
      return;
    }
    const newName = renameValue.trim();
    try {
      const from = item.path;
      const to = joinPath(dirname(item.path), newName);
      if (side === "local") {
        await invoke("local_rename", { from, to });
      } else {
        await invoke("sftp_rename", { server, from, to });
      }
      await load(currentPath);
      toast.success("已重命名", newName);
    } catch (e: any) {
      toast.error("重命名失败", e.toString());
    } finally {
      setRenamingPath(null);
    }
  }, [renamingPath, renameValue, entries, side, server, currentPath, load]);

  // 取消重命名
  const cancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // 点击外部时取消重命名
  useEffect(() => {
    if (!renamingPath) return;
    const onClick = (e: MouseEvent) => {
      if (renameInputRef.current && !renameInputRef.current.contains(e.target as Node)) {
        void finishRename();
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [renamingPath, finishRename]);

  // 单击选中 + 双击节奏判定
  // 快速双击（≤600ms）→ 目录进入 / 文件传输（与拖到对侧等价）
  // 慢点两下（600ms~2s）→ 行内重命名
  const FAST_DBLCLICK_MAX = 600;
  const SLOW_DBLCLICK_MAX = 2000;

  const handleClick = (e: React.MouseEvent, item: FileEntry) => {
    // 自定义拖拽结束后浏览器可能补发一次 click，忽略它避免误选/误触发
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // —— 选中逻辑（与多选兼容）——
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      setSelected(next);
    } else if (e.shiftKey && selected.size > 0) {
      // 范围选择
      const lastSelected = Array.from(selected).pop()!;
      const startIdx = entries.findIndex((en) => en.path === lastSelected);
      const endIdx = entries.findIndex((en) => en.path === item.path);
      const [s, e2] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
      const next = new Set(selected);
      for (let i = s; i <= e2; i++) next.add(entries[i].path);
      setSelected(next);
    } else {
      setSelected(new Set([item.path]));
    }

    // 重命名进行中或带修饰键时，不做双击判定，避免误触发传输
    if (renamingPath || e.ctrlKey || e.metaKey || e.shiftKey) {
      lastClickRef.current = { time: 0, path: null };
      return;
    }

    const now = Date.now();
    const last = lastClickRef.current;
    if (last.path === item.path) {
      const gap = now - last.time;
      if (gap <= FAST_DBLCLICK_MAX) {
        // 快速双击：目录进入，文件传输（与拖到对侧等价）
        lastClickRef.current = { time: 0, path: null };
        if (item.kind === "dir") onPathChange(item.path);
        else void onTransfer([item]);
        return;
      } else if (gap <= SLOW_DBLCLICK_MAX) {
        // 慢点两下（1-2 秒内）：行内重命名
        lastClickRef.current = { time: 0, path: null };
        startRename(item);
        return;
      }
      // 间隔超过 2s：视为一次新的单击，下面更新记录
    }
    lastClickRef.current = { time: now, path: item.path };
  };

  // 自定义指针拖拽（替代 HTML5 DnD）
  // Windows WebView2 下 HTML5 跨面板拖放的 dragover/enter/drop 不会派发到目标面板，
  // 导致光标全程显示 ⊘ 且无法传输。改用鼠标事件自建拖拽，跨平台一致、可控。
  const onRowMouseDown = (e: React.MouseEvent, item: FileEntry) => {
    if (e.button !== 0) return; // 仅左键
    if (renamingPath) return; // 重命名中不拖
    const t = e.target as HTMLElement;
    if (t.closest(".col-resizer") || t.closest("input")) return; // 列宽手柄 / 输入框不拖

    const items = selected.has(item.path)
      ? entries.filter((en) => selected.has(en.path))
      : [item];
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
        moved = true;
        suppressClickRef.current = true;
        setIsPointerDragging(true);
        const ghost = document.createElement("div");
        ghost.className = "sftp-drag-ghost";
        ghost.textContent =
          items.length > 1 ? `${items[0].name} 等 ${items.length} 项` : items[0].name;
        document.body.appendChild(ghost);
        dragGhostRef.current = ghost;
      }
      if (moved && dragGhostRef.current) {
        dragGhostRef.current.style.left = `${ev.clientX + 14}px`;
        dragGhostRef.current.style.top = `${ev.clientY + 14}px`;
      }
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) {
        setIsPointerDragging(false);
        if (dragGhostRef.current) {
          dragGhostRef.current.remove();
          dragGhostRef.current = null;
        }
        // 按鼠标 X 判定目标面板（左列右侧即分隔线）
        const cols = document.querySelectorAll<HTMLElement>(".sftp-panel-col");
        let targetSide: "local" | "remote" = "remote";
        if (cols.length >= 2) {
          const localRect = cols[0].getBoundingClientRect();
          targetSide = ev.clientX < localRect.right ? "local" : "remote";
        } else {
          targetSide = ev.clientX < window.innerWidth / 2 ? "local" : "remote";
        }
        // 拖到对侧才传输（本侧拖放为 no-op）
        if (targetSide !== side && items.length > 0) {
          onTransfer(items);
        }
      }
      // 兜底清除抑制标志（若浏览器未补发 click）
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 接收来自另一侧的拖动
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);

    // 1. Shelflux 内部拖放（跨侧传输）交由 SftpView 的全局 document drop 监听统一处理，
    //    本面板不再处理，避免 macOS 上目标面板 onDrop 与全局 handler 重复触发传输。
    const raw = e.dataTransfer.getData("text/plain");
    if (raw && raw.startsWith("shelflux:")) {
      return;
    }

    // 2. 外部拖动：从系统文件管理器拖入文件/文件夹
    // 使用 dataTransfer.items 以正确处理文件夹（webkitGetAsEntry）
    const items: FileEntry[] = [];
    const collectEntries = async (entry: FileSystemEntry) => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject)
        );
        items.push({
          name: file.name,
          path: file.webkitRelativePath || file.name,
          kind: "file",
          size: file.size,
          isSymlink: false,
        });
      } else if (entry.isDirectory) {
        const dirReader = (entry as FileSystemDirectoryEntry).createReader();
        const readBatch = (): Promise<void> =>
          new Promise((resolve) =>
            dirReader.readEntries(async (entries) => {
              if (entries.length === 0) {
                resolve();
                return;
              }
              await Promise.all(entries.map(collectEntries));
              resolve();
            })
          );
        await readBatch();
      }
    };

    const entries = Array.from(e.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry())
      .filter(Boolean) as FileSystemEntry[];

    if (entries.length === 0) return;

    for (const entry of entries) {
      await collectEntries(entry);
    }

    if (items.length > 0) {
      onTransfer(items);
    }
  };

  // 右键菜单
  const handleContextMenu = async (e: React.MouseEvent, item: FileEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, item });
    // 预加载"打开方式"应用列表（仅文件）
    if (item && item.kind !== "dir") {
      const ext = extOf(item.name);
      try {
        const apps = await invoke<Array<{ name: string; path: string }>>("get_open_with_apps", { extension: ext });
        setOpenWithApps(apps);
      } catch {
        setOpenWithApps([]);
      }
      setOpenWithFilePath(null);  // 远端文件还没下载
    }
  };

  // 右键菜单操作
  const newFolder = async () => {
    const name = await askPrompt({ title: "新建文件夹", message: "请输入文件夹名称", placeholder: "新建文件夹" });
    if (!name) return;
    try {
      const newPath = joinPath(currentPath, name);
      if (side === "local") {
        await invoke("local_mkdir", { path: newPath });
      } else {
        await invoke("sftp_mkdir", { server, path: newPath });
      }
      await load(currentPath);
      toast.success("已创建", name);
    } catch (e: any) {
      toast.error("创建失败", e.toString());
    }
  };

  const newFile = async () => {
    const name = await askPrompt({ title: "新建文件", message: "请输入文件名称", placeholder: "新建文件" });
    if (!name) return;
    try {
      const newPath = joinPath(currentPath, name);
      if (side === "local") {
        await invoke("local_create_file", { path: newPath });
      } else {
        await invoke("sftp_create_file", { server, path: newPath });
      }
      await load(currentPath);
      toast.success("已创建", name);
    } catch (e: any) {
      toast.error("创建失败", e.toString());
    }
  };

  const refresh = () => load(currentPath);

  const renameItem = async (item: FileEntry) => {
    const newName = await askPrompt({ title: "重命名", message: "请输入新名称", defaultValue: item.name });
    if (!newName || newName === item.name) return;
    try {
      const from = item.path;
      const to = joinPath(dirname(item.path), newName);
      if (side === "local") {
        await invoke("local_rename", { from, to });
      } else {
        await invoke("sftp_rename", { server, from, to });
      }
      await load(currentPath);
      toast.success("已重命名", newName);
    } catch (e: any) {
      toast.error("重命名失败", e.toString());
    }
  };

  const copyUrl = async (item: FileEntry) => {
    try {
      await navigator.clipboard.writeText(item.path);
      toast.success("已复制路径", item.path);
    } catch {
      toast.error("复制失败");
    }
  };

  /** 同侧复制（本地→本地 / 远端→远端），目录会递归复制 */
  const copyFile = async (item: FileEntry) => {
    const dir = dirname(item.path);
    const existsAt = async (p: string) => {
      try {
        return side === "local"
          ? await invoke<boolean>("local_exists", { path: p })
          : await invoke<boolean>("sftp_exists", { server, path: p });
      } catch {
        return false;
      }
    };

    // 生成不冲突的默认副本名：name 副本 / name 副本 2 ...
    const dot = item.kind === "dir" ? -1 : item.name.lastIndexOf(".");
    const stem = dot > 0 ? item.name.slice(0, dot) : item.name;
    const ext = dot > 0 ? item.name.slice(dot) : "";
    let suggest = `${stem} 副本${ext}`;
    for (let i = 2; i < 100; i++) {
      if (!(await existsAt(joinPath(dir, suggest)))) break;
      suggest = `${stem} 副本 ${i}${ext}`;
    }

    const newName = await askPrompt({ title: "复制副本", message: "请输入副本名称", defaultValue: suggest });
    if (!newName || newName === item.name) return;

    const to = joinPath(dir, newName);
    if (await existsAt(to)) {
      const ok = await askConfirm({
        title: "目标已存在",
        message: `"${newName}" 已存在，继续将覆盖同名内容。是否继续？`,
        confirmText: "覆盖",
        danger: true,
      });
      if (!ok) return;
    }

    setLoading(true);
    try {
      if (side === "local") {
        await invoke("local_copy", { from: item.path, to });
      } else {
        await invoke("sftp_copy", { server, from: item.path, to, taskId: uid() });
      }
      await load(currentPath);
      toast.success("已复制", newName);
    } catch (e: any) {
      toast.error("复制失败", e.toString());
    } finally {
      setLoading(false);
    }
  };

  /** 删除：优先删除全部选中项，无选中时只删当前项 */
  const deleteItems = async (item?: FileEntry) => {
    const items = selected.size > 0
      ? entries.filter((e) => selected.has(e.path))
      : item
        ? [item]
        : [];
    if (items.length === 0) return;

    const names = items.map((i) => i.name);
    const msg = items.length === 1
      ? `确定要删除 "${names[0]}" 吗？此操作不可撤销。`
      : `确定要删除选中的 ${items.length} 项吗？此操作不可撤销。\n\n${names.slice(0, 5).join("\n")}${names.length > 5 ? `\n... 等 ${names.length} 项` : ""}`;

    const ok = await askConfirm({
      title: "确认删除",
      message: msg,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;

    try {
      for (const it of items) {
        if (side === "local") {
          await invoke("local_remove", { path: it.path });
        } else {
          await invoke("sftp_remove", { server, path: it.path });
        }
      }
      setSelected(new Set());
      await load(currentPath);
      toast.success("已删除", `${items.length} 项`);
    } catch (e: any) {
      toast.error("删除失败", e.toString());
    }
  };

  // 兼容旧调用（单文件场景）
  const deleteItem = (item: FileEntry) => deleteItems(item);

  const openItem = async (item: FileEntry) => {
    try {
      const ext = extOf(item.name);
      const defaultApp = settings.defaultApps[ext];
      if (side === "local") {
        // 本地文件：有自定义默认应用则用指定程序，否则系统默认
        if (defaultApp) {
          await invoke("open_with_program", { filePath: item.path, programPath: defaultApp });
        } else {
          await invoke("open_with_default_app", { path: item.path });
        }
      } else {
        // 远端文件：下载 → 打开（优先用自定义默认应用）→ 监控回传
        const tmpDir = await invoke<string>("local_home");
        // 用 server.alias/id 隔离不同服务器，用完整路径隔离同服务器不同目录下的同名文件
        const cacheDir = server.alias || server.id;
        const cacheKey = item.path.replace(/[\/\\]/g, "_");
        const tmpPath = joinPath(tmpDir, ".shelflux-cache", cacheDir, cacheKey);
        toast.info("下载中", item.name);
        if (defaultApp) {
          await invoke("open_remote_file_with", { server, remote: item.path, local: tmpPath, program: defaultApp });
        } else {
          await invoke("open_remote_file", { server, remote: item.path, local: tmpPath });
        }
      }
    } catch (e: any) {
      toast.error("打开失败", e.toString());
    }
  };

  /** 用指定程序打开文件（本地路径） */
  const openWithProgram = async (filePath: string, programPath: string) => {
    try {
      await invoke("open_with_program", { filePath, programPath });
    } catch (e: any) {
      toast.error("打开失败", e.toString());
    }
  };

  /** 远程文件：用指定程序打开并开始监控回传 */
  const openRemoteWithProgram = async (item: FileEntry, programPath: string) => {
    try {
      const tmpDir = await invoke<string>("local_home");
      const cacheDir = server.alias || server.id;
      const cacheKey = item.path.replace(/[\/\\]/g, "_");
      const tmpPath = joinPath(tmpDir, ".shelflux-cache", cacheDir, cacheKey);
      toast.info("下载中", item.name);
      await invoke("open_remote_file_with", {
        server,
        remote: item.path,
        local: tmpPath,
        program: programPath,
      });
    } catch (e: any) {
      toast.error("打开失败", e.toString());
    }
  };

  /** 右键"打开方式"：预加载应用列表，子菜单由 buildContextMenu 构建（已在 handleContextMenu 中调用） */

  // 构造右键菜单项
  const buildContextMenu = (): ContextMenuItem[] => {
    const item = contextMenu?.item;
    const clip = useUiStore.getState().clipboard;
    const canPaste = clip !== null && clip.items.length > 0;

    if (!item) {
      // 空白处
      return [
        { label: "新建文件夹", icon: <FolderPlusIcon />, onClick: newFolder },
        { label: "新建文件", icon: <FilePlusIcon />, onClick: newFile },
        { divider: true },
        { label: "复制当前路径", icon: <LinkIcon />, onClick: () => copyUrl({ name: currentPath, path: currentPath, kind: "dir", size: 0, isSymlink: false }) },
        { divider: true },
        { label: "粘贴", icon: <PasteIcon />, onClick: () => void pasteItems(), disabled: !canPaste },
        { divider: true },
        { label: "刷新", icon: <RefreshIcon />, onClick: refresh },
      ];
    }
    if (item.kind === "dir") {
      return [
        { label: "打开", icon: <ArrowRightIcon />, onClick: () => onPathChange(item.path) },
        { label: "传输到对面", icon: <TransferIcon />, onClick: () => onTransfer([item]) },
        { divider: true },
        { label: "复制", icon: <CopyIcon />, onClick: () => { setSelected(new Set([item.path])); copySelection(); } },
        { label: "复制路径", icon: <LinkIcon />, onClick: () => copyUrl(item) },
        { divider: true },
        { label: "重命名", icon: <EditIcon />, onClick: () => renameItem(item) },
        { divider: true },
        { label: "粘贴", icon: <PasteIcon />, onClick: () => void pasteItems(), disabled: !canPaste },
        { divider: true },
        { label: "新建文件夹", icon: <FolderPlusIcon />, onClick: newFolder },
        { label: "新建文件", icon: <FilePlusIcon />, onClick: newFile },
        { divider: true },
        { label: "刷新", icon: <RefreshIcon />, onClick: refresh },
        { divider: true },
        { label: "删除", icon: <TrashIcon />, danger: true, onClick: () => deleteItem(item) },
      ];
    }
    // 文件 —— 构建"打开方式"子菜单
    const ext = extOf(item.name);
    const filePath = side === "local"
      ? item.path
      : openWithFilePath;  // 远端文件：下载后的临时路径（prepareOpenWith 已设置）
    const defaultAppPath = settings.defaultApps[ext] || "";

    // 在列表中模糊匹配默认应用（兼容旧格式：可能存的是文件名而非完整路径）
    const findDefaultInList = () => {
      if (!defaultAppPath) return undefined;
      // 1. 精确匹配
      let found = openWithApps.find((a) => a.path === defaultAppPath);
      if (found) return found;
      // 2. 文件名匹配（兼容存 "Notepad--.exe" 的情况）
      const base = defaultAppPath.replace(/.*[/\\]/, "").toLowerCase();
      found = openWithApps.find((a) => a.path.replace(/.*[/\\]/, "").toLowerCase() === base);
      if (found) return found;
      // 3. 后缀匹配（兼容存部分路径的情况）
      const norm = defaultAppPath.toLowerCase().replace(/\\/g, "/");
      found = openWithApps.find((a) => a.path.toLowerCase().replace(/\\/g, "/").endsWith(norm));
      return found;
    };

    const prettyName = (p: string) =>
      p.replace(/.*[/\\]/, "").replace(/\.(exe|EXE)$/, "");

    // 默认应用项：在列表中找到就用列表项；否则用设置值构造（让默认项始终能显示出来）
    const listDefault = findDefaultInList();
    const defaultApp = listDefault ?? (defaultAppPath
      ? { name: prettyName(defaultAppPath), path: defaultAppPath }
      : undefined);

    const submenuItems: ContextMenuItem[] = [];

    // 用指定程序打开当前文件（本地路径或远端下载后）
    const openWith = (programPath: string) => {
      if (filePath) {
        openWithProgram(filePath, programPath);
      } else {
        openRemoteWithProgram(item, programPath);
      }
    };

    // 把当前扩展名关联到指定程序（保存的是完整 exe 路径，而非注册表键名）
    const setDefaultApp = (programPath: string) => {
      setSettings({ defaultApps: { ...settings.defaultApps, [ext]: programPath } });
      toast.success("已设为默认", `${prettyName(programPath)} 用于打开 .${ext}`);
    };
    const clearDefaultApp = () => {
      removeDefaultApp(ext);
      toast.success("已取消默认", `.${ext} 不再有默认打开程序`);
    };

    // 如果设置了默认应用，提到最顶部（点击直接用默认程序打开；子菜单可取消）
    if (defaultApp) {
      submenuItems.push({
        label: `${defaultApp.name}  （默认）`,
        onClick: () => openWith(defaultApp.path),
        submenu: [
          { label: "取消默认打开方式", onClick: clearDefaultApp },
        ],
      });
      submenuItems.push({ divider: true });
    }

    // 其余应用（排除已在顶部显示的默认应用）：点击直接用该程序打开；
    // 悬停子菜单可"设为默认"（保存完整 exe 路径）
    const otherApps = listDefault
      ? openWithApps.filter((a) => a.path !== listDefault.path)
      : openWithApps;
    for (const app of otherApps) {
      submenuItems.push({
        label: app.name,
        onClick: () => openWith(app.path),
        submenu: [
          { label: "设为默认打开此类型", onClick: () => setDefaultApp(app.path) },
        ],
      });
    }

    const isMac = navigator.platform?.startsWith("Mac") || false;

    submenuItems.push({ divider: true });
    submenuItems.push({
      label: "选择其他程序打开...",
      onClick: async () => {
        if (isMac) {
          // macOS：调用 native dialog，返回 .app 路径
          try {
            const picked = await invoke<string>("open_with_dialog", { path: "" });
            if (picked && picked.trim()) {
              openWith(picked.trim());
            }
          } catch { /* 取消 */ }
        } else {
          // Windows：用 tauri dialog
          const { open } = await import("@tauri-apps/plugin-dialog");
          try {
            const picked = await open({
              title: "选择程序",
              filters: [{ name: "可执行程序", extensions: ["exe"] }],
            });
            if (picked && typeof picked === "string") {
              openWith(picked);
            }
          } catch { /* 取消 */ }
        }
      },
    });
    submenuItems.push({
      label: "其他程序设为默认...",
      onClick: async () => {
        if (isMac) {
          try {
            const picked = await invoke<string>("open_with_dialog", { path: "" });
            if (picked && picked.trim()) {
              setDefaultApp(picked.trim());
            }
          } catch { /* 取消 */ }
        } else {
          const { open } = await import("@tauri-apps/plugin-dialog");
          try {
            const picked = await open({
              title: "选择程序",
              filters: [{ name: "可执行程序", extensions: ["exe"] }],
            });
            if (picked && typeof picked === "string") {
              setDefaultApp(picked);
            }
          } catch { /* 取消 */ }
        }
      },
    });

    return [
      { label: "打开", icon: <OpenIcon />, onClick: () => openItem(item) },
      {
        label: "打开方式",
        icon: <OpenWithIcon />,
        submenu: submenuItems,
      },
      { divider: true },
      { label: "传输到对面", icon: <TransferIcon />, onClick: () => onTransfer([item]) },
      { label: "重命名", icon: <EditIcon />, onClick: () => renameItem(item) },
      { divider: true },
      { label: "复制", icon: <CopyIcon />, onClick: () => { setSelected(new Set([item.path])); copySelection(); } },
      { label: "复制路径", icon: <LinkIcon />, onClick: () => copyUrl(item) },
      { label: "复制为", icon: <CopyIcon />, onClick: () => copyFile(item) },
      { divider: true },
      { label: "粘贴", icon: <PasteIcon />, onClick: () => void pasteItems(), disabled: !canPaste },
      { divider: true },
      { label: "删除", icon: <TrashIcon />, danger: true, onClick: () => deleteItem(item) },
    ];
  };

  /** 远端文件还没下载时，先下载再用指定程序打开并开始监控 */
  const prepareOpenWithThenOpen = async (item: FileEntry, programPath: string) => {
    if (side !== "remote") return;
    try {
      const tmpDir = await invoke<string>("local_home");
      const cacheDir = server.alias || server.id;
      const cacheKey = item.path.replace(/[\/\\]/g, "_");
      const tmpPath = joinPath(tmpDir, ".shelflux-cache", cacheDir, cacheKey);
      toast.info("下载中", item.name);
      await invoke("open_remote_file_with", {
        server,
        remote: item.path,
        local: tmpPath,
        program: programPath,
      });
    } catch (e: any) {
      toast.error("打开失败", e.toString());
    }
  };

  // 拖拽调整列宽（单位 px）：
  //   colIndex=0 → 名称/大小 边界
  //   colIndex=1 → 大小/修改时间 边界
  //   colIndex=2 → 修改时间/类型 边界
  const [dragCols, setDragCols] = useState<[number, number, number]>([FIXED_SIZE_COL, FIXED_TIME_COL, MIN_TYPE_W]);

  // 排序切换：同列反转方向，不同列默认升序
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // 排序后的 entries（文件夹始终排在最前，同类型内按排序键排列）
  const sortedEntries = [...entries].sort((a, b) => {
    // 文件夹优先
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    let cmp = 0;
    switch (sortKey) {
      case "name":
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        break;
      case "size":
        cmp = a.size - b.size;
        break;
      case "modified": {
        const ma = a.modified ?? 0;
        const mb = b.modified ?? 0;
        cmp = ma - mb;
        break;
      }
      case "type": {
        const ea = extOf(a.name).toLowerCase();
        const eb = extOf(b.name).toLowerCase();
        cmp = ea.localeCompare(eb);
        break;
      }
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const startResize = (e: React.MouseEvent, colIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const tableWidth = filesRef.current?.clientWidth ?? 0;
    if (tableWidth <= 0) return;
    const startX = e.clientX;
    const [startSize, startTime, startType] = dragCols;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      let nextSize = startSize;
      let nextTime = startTime;
      let nextType = startType;

      if (colIndex === 0) {
        const maxSize = tableWidth - MIN_NAME_W - startTime - startType;
        nextSize = clamp(startSize - delta, MIN_SIZE_W, Math.max(MIN_SIZE_W, maxSize));
      } else if (colIndex === 1) {
        const totalST = startSize + startTime;
        nextSize = clamp(startSize + delta, MIN_SIZE_W, totalST - MIN_TIME_W);
        nextTime = totalST - nextSize;
      } else {
        const totalTT = startTime + startType;
        nextTime = clamp(startTime + delta, MIN_TIME_W, totalTT - MIN_TYPE_W);
        nextType = totalTT - nextTime;
      }

      const maxFixed = Math.max(MIN_SIZE_W + MIN_TIME_W + MIN_TYPE_W, tableWidth - MIN_NAME_W);
      const totalFixed = nextSize + nextTime + nextType;
      if (totalFixed > maxFixed) {
        const scale = maxFixed / totalFixed;
        nextSize = Math.max(MIN_SIZE_W, nextSize * scale);
        nextTime = Math.max(MIN_TIME_W, nextTime * scale);
        nextType = Math.max(MIN_TYPE_W, nextType * scale);
      }
      setDragCols([Math.round(nextSize), Math.round(nextTime), Math.round(nextType)]);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`sftp-panel ${dragOver ? "dragover" : ""}`}
      onMouseDown={() => {
        activeSide = side;
      }}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      <div className="sftp-panel-header">
        <span className={`sftp-panel-label ${labelClass}`}>{title}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-ghost btn-icon tooltip"
          data-tip="上级目录"
          onClick={goUp}
          disabled={!currentPath || currentPath === "/" || currentPath === ""}
        >
          <UpIcon />
        </button>
        <button
          className="btn btn-ghost btn-icon tooltip"
          data-tip="刷新"
          onClick={refresh}
        >
          <RefreshIcon />
        </button>
        <button
          className="btn btn-ghost btn-icon tooltip"
          data-tip="新建文件夹"
          onClick={newFolder}
        >
          <FolderPlusIcon />
        </button>
      </div>

      <PathBreadcrumb
        path={currentPath}
        editable
        onPathChange={onPathChange}
        onEditingChange={setEditingPath}
      />

      <div
        ref={filesRef}
        className="sftp-files"
        style={{ width: "100%", maxWidth: "100%", overflowX: "hidden" }}
      >
        {loading ? (
          <div className="sftp-files-loading">加载中...</div>
        ) : error ? (
          <div className="sftp-files-loading" style={{ color: "var(--color-error)" }}>
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="sftp-files-empty">空目录</div>
        ) : (
          <div className="sftp-files-list" ref={tableRef}>
            {/* 表头（sticky 吸顶） */}
            <div className="sftp-grid-head-row">
              <div className={`sftp-grid-cell sftp-grid-head name ${sortKey === "name" ? "sorted" : ""}`} onClick={() => handleSort("name")}>
                名称
                <span className={`sort-arrow ${sortKey === "name" ? (sortDir === "asc" ? "up" : "down") : ""}`}>▲</span>
                <span
                  className="col-resizer"
                  onMouseDown={(e) => startResize(e, 0)}
                />
              </div>
              <div
                className={`sftp-grid-cell sftp-grid-head size ${sortKey === "size" ? "sorted" : ""}`}
                style={{ width: `${dragCols[0]}px` }}
                onClick={() => handleSort("size")}
              >
                大小
                <span className={`sort-arrow ${sortKey === "size" ? (sortDir === "asc" ? "up" : "down") : ""}`}>▲</span>
                <span
                  className="col-resizer"
                  onMouseDown={(e) => startResize(e, 1)}
                />
              </div>
              <div
                className={`sftp-grid-cell sftp-grid-head modified ${sortKey === "modified" ? "sorted" : ""}`}
                style={{ width: `${dragCols[1]}px` }}
                onClick={() => handleSort("modified")}
              >
                修改时间
                <span className={`sort-arrow ${sortKey === "modified" ? (sortDir === "asc" ? "up" : "down") : ""}`}>▲</span>
                <span
                  className="col-resizer"
                  onMouseDown={(e) => startResize(e, 2)}
                />
              </div>
              <div
                className={`sftp-grid-cell sftp-grid-head filetype ${sortKey === "type" ? "sorted" : ""}`}
                style={{ width: `${dragCols[2]}px` }}
                onClick={() => handleSort("type")}
              >
                类型
                <span className={`sort-arrow ${sortKey === "type" ? (sortDir === "asc" ? "up" : "down") : ""}`}>▲</span>
              </div>
            </div>

            {/* 数据行 */}
            {sortedEntries.map((item) => (
              <div
                key={item.path}
                className={`sftp-grid-row ${selected.has(item.path) ? "selected" : ""} ${isPointerDragging ? "dragging" : ""}`}
                onMouseDown={(e) => onRowMouseDown(e, item)}
                onClick={(e) => handleClick(e, item)}
                onContextMenu={(e) => handleContextMenu(e, item)}
              >
                <div className="sftp-grid-cell name">
                  {renamingPath === item.path ? (
                    <input
                      ref={renameInputRef}
                      className="sftp-rename-input"
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void finishRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      onBlur={() => void finishRename()}
                      maxLength={255}
                    />
                  ) : (
                    <div className="sftp-file-name">
                      <span className={`sftp-file-icon ${item.kind}`}>
                        {item.kind === "dir" ? <FolderIcon /> : item.kind === "symlink" ? <SymlinkIcon /> : getFileTypeIcon(item.name)}
                      </span>
                      <span className="sftp-file-name-text" title={item.path}>
                        {item.name}
                      </span>
                    </div>
                  )}
                </div>
                <div
                  className="sftp-grid-cell size"
                  style={{ width: `${dragCols[0]}px` }}
                >
                  {item.kind === "dir" ? "—" : formatSize(item.size)}
                </div>
                <div
                  className="sftp-grid-cell modified"
                  style={{ width: `${dragCols[1]}px` }}
                >
                  {formatDate(item.modified)}
                </div>
                <div
                  className="sftp-grid-cell filetype"
                  style={{ width: `${dragCols[2]}px` }}
                >
                  {item.kind === "dir" ? "文件夹" : item.kind === "symlink" ? "链接" : extOf(item.name).toUpperCase() || "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenu()}
          onClose={() => {
            setContextMenu(null);
            setOpenWithApps([]);
            setOpenWithFilePath(null);
          }}
        />
      )}
    </div>
  );
}

// ===== Icons =====
// ── 通用文档底图：白底折角 + 底部类型色带 + 扩展名文字 + 可选图形 ──
function DocPage({ accent, label, glyph }: { accent: string; label: string; glyph?: JSX.Element }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3.1 1.3h7L14 5.2v9.3c0 .3-.2.5-.5.5H3.6c-.3 0-.5-.2-.5-.5V1.8c0-.3.2-.5.5-.5z" fill="#ffffff" stroke="#c2cad4" strokeWidth="0.6" />
      <path d="M10 1.3L14 5.2h-3.5c-.3 0-.5-.2-.5-.5V1.3z" fill="#e7ecf1" stroke="#c2cad4" strokeWidth="0.35" />
      {glyph}
      <path d="M2.6 11h10.8V14c0 .3-.2.5-.5.5H3.1c-.3 0-.5-.2-.5-.5V11z" fill={accent} />
      <text x="8" y="13.35" fill="#ffffff" fontSize="3.3" fontWeight="800" fontFamily="Arial, Helvetica, sans-serif" textAnchor="middle" letterSpacing="0.1">{label}</text>
    </svg>
  );
}
// ── 小图形（白色叠加在文档上方）──
function GImage() {
  return (<g opacity="0.92"><circle cx="10.4" cy="4.1" r="1" fill="#fff" /><path d="M4.2 9.4 6.4 6.6 8.3 8.5 9.6 7 11.8 9.6H4.2z" fill="#fff" /></g>);
}
function GVideo() {
  return (<path d="M6.4 4.8 6.4 8.4 10.2 6.6z" fill="#fff" opacity="0.95" />);
}
function GAudio() {
  return (<g fill="#fff" opacity="0.92"><ellipse cx="6.4" cy="7.4" rx="0.9" ry="0.75" /><ellipse cx="9.4" cy="6.9" rx="0.9" ry="0.75" /><rect x="7.1" y="4.6" width="0.5" height="2.9" /><rect x="10.1" y="4.1" width="0.5" height="2.9" /><rect x="7.1" y="4.6" width="3.5" height="0.5" /></g>);
}
function GBox() {
  return (<g stroke="#fff" strokeWidth="0.55" fill="none" opacity="0.92"><rect x="5" y="4.8" width="6" height="4.4" rx="0.6" /><line x1="5" y1="6" x2="11" y2="6" /><path d="M5.6 4.8v4.4M10.4 4.8v4.4" /></g>);
}
function GDisc() {
  return (<g fill="none" stroke="#fff" strokeWidth="0.6" opacity="0.92"><circle cx="8" cy="6.6" r="3" /><circle cx="8" cy="6.6" r="0.85" fill="#fff" /></g>);
}
function GDb() {
  return (<g opacity="0.92"><ellipse cx="8" cy="5.2" rx="3" ry="1.1" fill="#fff" /><path d="M5 5.2v3.6c0 .6 1.34 1.1 3 1.1s3-.5 3-1.1V5.2" fill="none" stroke="#fff" strokeWidth="0.6" /><path d="M5 6.8c0 .6 1.34 1.1 3 1.1s3-.5 3-1.1" fill="none" stroke="#fff" strokeWidth="0.6" /></g>);
}
function GKey() {
  return (<g stroke="#fff" strokeWidth="0.6" fill="none" opacity="0.92" strokeLinecap="round"><circle cx="6" cy="5.6" r="1.5" /><path d="M7.1 6.7 9.6 9.2M8.9 8.5l1 1M8.1 7.7l1 1" /></g>);
}
function GCode() {
  return (<g stroke="#fff" strokeWidth="0.8" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.95"><path d="M6 4.8 4 6.8 6 8.8M10 4.8 12 6.8 10 8.8M8.5 4.2 7.5 9.1" /></g>);
}
function GSheet() {
  return (<g stroke="#fff" strokeWidth="0.6" fill="none" opacity="0.9"><rect x="5" y="4.4" width="6" height="4.2" rx="0.4" /><line x1="5" y1="8" x2="11" y2="8" /></g>);
}
function GGrid() {
  return (<g stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.9"><rect x="5" y="4.2" width="6" height="4.2" rx="0.4" /><line x1="7" y1="4.2" x2="7" y2="8.4" /><line x1="9" y1="4.2" x2="9" y2="8.4" /><line x1="5" y1="5.8" x2="11" y2="5.8" /><line x1="5" y1="7" x2="11" y2="7" /></g>);
}
function GLines() {
  return (<g stroke="#fff" strokeWidth="0.7" strokeLinecap="round" opacity="0.9"><line x1="5" y1="4.6" x2="11" y2="4.6" /><line x1="5" y1="6.1" x2="11" y2="6.1" /><line x1="5" y1="7.6" x2="9" y2="7.6" /></g>);
}
function GBook() {
  return (<g fill="#fff" opacity="0.92"><path d="M8 4.4c-1.2-.7-2.6-.7-3.6 0v7c1-.7 2.4-.7 3.6 0z" /><path d="M8 4.4c1.2-.7 2.6-.7 3.6 0v7c-1 .7-2.4.7-3.6 0z" opacity="0.7" /></g>);
}
function GGear() {
  return (<g fill="#fff" opacity="0.92"><path d="M8 3.2l.9 1.7 1.9.2-.9 1.7.9 1.7-1.9-.2L8 10.8l-.9-1.7-1.9.2.9-1.7L6.2 6.8l1.9-.2z" /></g>);
}
function GMd() {
  return (<g stroke="#fff" strokeWidth="0.7" strokeLinecap="round" opacity="0.9" fill="none"><line x1="5" y1="4.6" x2="5" y2="7.6" /><line x1="6.7" y1="4.6" x2="6.7" y2="7.6" /><line x1="8.4" y1="4.6" x2="8.4" y2="7.6" /><path d="M5 8.4h6" /></g>);
}
function GShell() {
  return (<g fill="#fff" opacity="0.92"><path d="M6.5 4.6 4.6 6.6 6.5 8.6V7.4h2V7H6.5z" /><rect x="8.6" y="7.4" width="1.6" height="0.7" /></g>);
}
function GCoffee() {
  return (<g opacity="0.9"><path d="M5 5h4.5v2.6c0 1-1 1.6-2.2 1.6S5 8.6 5 7.6z" fill="#fff" /><path d="M9.5 5.4h1c.5 0 .8.4.8.9s-.3.9-.8.9H9.5" fill="none" stroke="#fff" strokeWidth="0.5" /><path d="M6 9.6h3" stroke="#fff" strokeWidth="0.5" /></g>);
}
function GGem() {
  return (<g opacity="0.92"><path d="M6 4.6h4l1 1.6-3 3.4-3-3.4z" fill="#fff" /><path d="M6 4.6 5 6.2h6L10 4.6M5.5 6.2 8 9.6M10.5 6.2 8 9.6M6.5 6.2h3" stroke="#fff" strokeWidth="0.4" fill="none" /></g>);
}
function GFont() {
  return (<path d="M8 4.4 5.4 9h1.1l.5-1.3h2l.5 1.3h1.1L8 4.4zM7.3 7.2 8 5.4l.7 1.8z" fill="#fff" opacity="0.92" />);
}

// ── 文件夹（清爽双色）──
function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M1.7 3.4c0-.4.3-.7.7-.7h3l1.1 1.1h6.1c.4 0 .7.3.7.7v6.8c0 .4-.3.7-.7.7H2.4c-.4 0-.7-.3-.7-.7V3.4z" fill="#E8A93A" />
      <path d="M1.7 5.2h12.6v5c0 .4-.3.7-.7.7H2.4c-.4 0-.7-.3-.7-.7V5.2z" fill="#FFC857" />
    </svg>
  );
}
// ── 软链接（文档 + 链接徽标）──
function SymlinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3.1 1.3h7L14 5.2v9.3c0 .3-.2.5-.5.5H3.6c-.3 0-.5-.2-.5-.5V1.8c0-.3.2-.5.5-.5z" fill="#ffffff" stroke="#c2cad4" strokeWidth="0.6" />
      <path d="M10 1.3L14 5.2h-3.5c-.3 0-.5-.2-.5-.5V1.3z" fill="#e7ecf1" stroke="#c2cad4" strokeWidth="0.35" />
      <circle cx="11" cy="11" r="3.1" fill="#3B82F6" />
      <g stroke="#fff" strokeWidth="0.9" fill="none" strokeLinecap="round">
        <path d="M10.1 11.3 11.7 9.7M11.9 10 13.5 11.6" />
      </g>
    </svg>
  );
}

// ── 各类文件图标（白底文档 + 类型色带 + 扩展名 + 图形）──
function WordIcon() { return <DocPage accent="#2B579A" label="DOC" />; }
function ExcelIcon() { return <DocPage accent="#217346" label="XLS" glyph={<GGrid />} />; }
function PptIcon() { return <DocPage accent="#D24726" label="PPT" glyph={<GSheet />} />; }
function PdfIcon() { return <DocPage accent="#E03A2F" label="PDF" />; }
function TextIcon() { return <DocPage accent="#7A8794" label="TXT" glyph={<GLines />} />; }
function MarkdownIcon() { return <DocPage accent="#2D2D2D" label="MD" glyph={<GMd />} />; }
function BookIcon() { return <DocPage accent="#B45309" label="BOOK" glyph={<GBook />} />; }
function ImageIcon() { return <DocPage accent="#2BA84A" label="IMG" glyph={<GImage />} />; }
function VideoIcon() { return <DocPage accent="#7C4DFF" label="VID" glyph={<GVideo />} />; }
function AudioIcon() { return <DocPage accent="#F59E0B" label="AUD" glyph={<GAudio />} />; }
function ArchiveIcon() { return <DocPage accent="#C9972B" label="ZIP" glyph={<GBox />} />; }
function DiskImageIcon() { return <DocPage accent="#5A6B7B" label="ISO" glyph={<GDisc />} />; }
function ConfigIcon() { return <DocPage accent="#0F9D9D" label="CFG" glyph={<GGear />} />; }
function HtmlIcon() { return <DocPage accent="#E44D26" label="HTML" glyph={<GCode />} />; }
function CssIcon() { return <DocPage accent="#2965F1" label="CSS" glyph={<GCode />} />; }
function WebCompIcon() { return <DocPage accent="#41B883" label="VUE" glyph={<GCode />} />; }
function JsIcon() { return <DocPage accent="#E8A400" label="JS" />; }
function TsIcon() { return <DocPage accent="#2D79C7" label="TS" />; }
function PythonIcon() { return <DocPage accent="#3A76A8" label="PY" />; }
function ShellIcon() { return <DocPage accent="#2E3138" label="SH" glyph={<GShell />} />; }
function JavaIcon() { return <DocPage accent="#E76F00" label="JAVA" glyph={<GCoffee />} />; }
function CppIcon() { return <DocPage accent="#00599C" label="C++" />; }
function GoIcon() { return <DocPage accent="#00ADD8" label="GO" />; }
function RustIcon() { return <DocPage accent="#CE412B" label="RS" glyph={<GGear />} />; }
function RubyIcon() { return <DocPage accent="#CC342D" label="RB" glyph={<GGem />} />; }
function PhpIcon() { return <DocPage accent="#777BB4" label="PHP" />; }
function SqlIcon() { return <DocPage accent="#1F8A9E" label="SQL" glyph={<GDb />} />; }
function CodeIcon() { return <DocPage accent="#5C6BC0" label="CODE" glyph={<GCode />} />; }
function ExeIcon() { return <DocPage accent="#3A3F47" label="EXE" glyph={<GGear />} />; }
function DatabaseIcon() { return <DocPage accent="#1F8A9E" label="DB" glyph={<GDb />} />; }
function FontIcon() { return <DocPage accent="#8B5CF6" label="FONT" glyph={<GFont />} />; }
function KeyIcon() { return <DocPage accent="#2E9E5B" label="KEY" glyph={<GKey />} />; }
function BackupIcon() { return <DocPage accent="#6B7785" label="BAK" glyph={<GDisc />} />; }
function LogIcon() { return <DocPage accent="#5A6B7B" label="LOG" glyph={<GLines />} />; }
function FileIcon() { return <DocPage accent="#9AA5B1" label="FILE" />; }
function SwiftIcon() { return <DocPage accent="#F05138" label="SWIFT" />; }
function KotlinIcon() { return <DocPage accent="#A97BFF" label="KT" />; }
function DartIcon() { return <DocPage accent="#0175C2" label="DART" />; }
function CSharpIcon() { return <DocPage accent="#239120" label="CS" />; }
function LuaIcon() { return <DocPage accent="#2C5AA0" label="LUA" />; }
function RLangIcon() { return <DocPage accent="#276DC3" label="R" />; }

// ── 按扩展名映射到图标 ──
function getFileTypeIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  // 文档 / 办公
  if (['doc', 'docx', 'docm', 'rtf', 'odt'].includes(ext)) return <WordIcon />;
  if (['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods'].includes(ext)) return <ExcelIcon />;
  if (['ppt', 'pptx', 'pptm', 'odp', 'key'].includes(ext)) return <PptIcon />;
  if (ext === 'pdf') return <PdfIcon />;
  if (['txt', 'text'].includes(ext)) return <TextIcon />;
  if (['md', 'markdown', 'mdx'].includes(ext)) return <MarkdownIcon />;
  if (['epub', 'mobi', 'azw', 'azw3', 'fb2'].includes(ext)) return <BookIcon />;
  // 图片
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'icns', 'avif', 'tiff', 'tif', 'heic', 'heif', 'raw', 'cr2', 'nef'].includes(ext)) return <ImageIcon />;
  // 视频
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'mpg', 'mpeg', 'vob', 'ogv', 'rm', 'rmvb'].includes(ext)) return <VideoIcon />;
  // 音频
  if (['mp3', 'wav', 'flac', 'ogg', 'oga', 'aac', 'wma', 'm4a', 'opus', 'ape', 'mid', 'midi', 'aiff', 'caf'].includes(ext)) return <AudioIcon />;
  // 压缩 / 归档
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'tgz', 'tbz2', 'lz', 'lz4', 'z', 'cab', 'ace', 'arj'].includes(ext)) return <ArchiveIcon />;
  // 磁盘镜像
  if (['iso', 'img', 'dmg', 'vhd', 'vhdx', 'vmdk', 'vdi', 'qcow2', 'wim', 'esd', 'sparseimage'].includes(ext)) return <DiskImageIcon />;
  // 代码 / 标记
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return <JsIcon />;
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return <TsIcon />;
  if (['py', 'pyw', 'pyi'].includes(ext)) return <PythonIcon />;
  if (['sh', 'bash', 'zsh', 'ksh', 'fish'].includes(ext)) return <ShellIcon />;
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'properties', 'editorconfig', 'npmrc', 'gitignore', 'gitattributes'].includes(ext)) return <ConfigIcon />;
  if (['html', 'htm', 'xhtml'].includes(ext)) return <HtmlIcon />;
  if (['css', 'scss', 'less', 'sass', 'styl'].includes(ext)) return <CssIcon />;
  if (['vue', 'svelte'].includes(ext)) return <WebCompIcon />;
  if (['java', 'class', 'jar'].includes(ext)) return <JavaIcon />;
  if (['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'ino'].includes(ext)) return <CppIcon />;
  if (['go'].includes(ext)) return <GoIcon />;
  if (['rs'].includes(ext)) return <RustIcon />;
  if (['rb'].includes(ext)) return <RubyIcon />;
  if (['php'].includes(ext)) return <PhpIcon />;
  if (['sql'].includes(ext)) return <SqlIcon />;
  if (['swift'].includes(ext)) return <SwiftIcon />;
  if (['kt', 'kts'].includes(ext)) return <KotlinIcon />;
  if (['dart'].includes(ext)) return <DartIcon />;
  if (['cs'].includes(ext)) return <CSharpIcon />;
  if (['lua'].includes(ext)) return <LuaIcon />;
  if (['r', 'rmd'].includes(ext)) return <RLangIcon />;
  if (['hs', 'ml', 'mli', 'fs', 'fsi', 'fsx', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'scala', 'groovy', 'gradle', 'proto', 'graphql', 'gql', 'vim', 'ps1', 'psm1', 'bat', 'cmd', 'asm', 's', 'v', 'sv', 'svh', 'vh', 'dockerfile', 'makefile', 'cmake', 'tf', 'hcl', 'nix', 'pl', 'pm', 'vb', 'pas', 'd', 'nim', 'zig'].includes(ext)) return <CodeIcon />;
  // 可执行 / 应用 / 安装包
  if (['exe', 'msi', 'dll', 'so', 'dylib', 'bin', 'app', 'apk', 'deb', 'rpm', 'run', 'out'].includes(ext)) return <ExeIcon />;
  // 数据库
  if (['db', 'sqlite', 'sqlite3', 'sqlitedb', 'mdb', 'accdb', 'mdf', 'ldf', 'dump', 'dat'].includes(ext)) return <DatabaseIcon />;
  // 字体
  if (['ttf', 'otf', 'woff', 'woff2', 'eot', 'fon', 'ttc'].includes(ext)) return <FontIcon />;
  // 证书 / 密钥
  if (['pem', 'crt', 'cer', 'cert', 'crl', 'key', 'p12', 'pfx', 'ca-bundle', 'csr', 'pub', 'asc', 'gpg', 'pgp'].includes(ext)) return <KeyIcon />;
  // 备份
  if (['bak', 'old', 'backup', 'gho', 'tib'].includes(ext)) return <BackupIcon />;
  // 日志
  if (['log', 'logs'].includes(ext)) return <LogIcon />;
  // 默认
  return <FileIcon />;
}
function UpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M3 7l3.5-3.5L10 7M6.5 4v7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M11 5.5A5 5 0 1 0 11 7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M11 2v3.5H7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FolderPlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M1.5 3.5C1.5 3 1.9 2.5 2.5 2.5h2.7c.4 0 .8.2 1 .5L7 4h4.5c.6 0 1 .4 1 1v5.5c0 .6-.4 1-1 1H2.5c-.6 0-1-.4-1-1V3.5z" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M6.5 6.5v3M5 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function FilePlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M3 1.5h5l2.5 2.5V11c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V2.5c0-.6.4-1 1-1z" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M6.5 6.5v3M5 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M5 7l4-4M3 9l-1 1M9 3l1-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1 8l5-5 3 3-5 5H1V8zM6 3l2-2 3 3-2 2" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 3h8M4 3V2h4v1M3.5 3l.5 7.5h4L8.5 3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M2 8V2h6" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  );
}
function PasteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="2" y="2" width="8" height="9" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M4.5 2V1h3v1M4 4h4v4H4z" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  );
}
function OpenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 4l2 5h4l2-5M2 4h8M5.5 2h1L7 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
function OpenWithIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 8V3h8v5M2 8h8M6 5l-1.5 1.5M6 5l1.5 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
function TransferIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 5h7M6 2l3 3-3 3M10 7H3M6 10L3 7l3-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
function ArrowRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 6h7M6 3l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
