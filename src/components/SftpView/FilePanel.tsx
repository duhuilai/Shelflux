// 文件列表面板（左侧或右侧共用）
import { useState, useEffect, useRef, useCallback, useId } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FileEntry, Server } from "../../types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useBookmarkStore } from "../../stores/bookmarkStore";
import { toast } from "../../stores/toastStore";
import { joinPath, dirname, formatDate, formatSize, basename, extOf, uid } from "../../utils/format";
import { PathBreadcrumb } from "./PathBreadcrumb";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { PropertiesDialog } from "./PropertiesDialog";

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

/** Unix 权限位 → 八进制字符串（如 755）；无权限信息时显示 — */
const permOctal = (p?: number) =>
  p == null ? "—" : (p & 0o777).toString(8).padStart(3, "0");

/** 记录当前获得焦点的面板实例 id（按实例而非全局 side，避免多 SFTP 标签页串扰） */
let focusedPanelId: string | null = null;

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
  const [isPointerDragging, setIsPointerDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileEntry | null;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 属性详情面板（P3）
  const [propsItem, setPropsItem] = useState<FileEntry | null>(null);
  // 排序状态
  type SortKey = "name" | "size" | "modified" | "type";
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // 打开方式子菜单用的应用列表（右键文件时预加载）
  const [openWithApps, setOpenWithApps] = useState<Array<{ name: string; path: string }>>([]);
  const dragCounter = useRef(0);
  // 本面板实例 id（用于焦点路由，避免跨标签页串扰）
  const panelId = useId();
  // 内联搜索/过滤（P2）
  const [filter, setFilter] = useState("");

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
  const addBookmark = useBookmarkStore((s) => s.add);
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
      if (focusedPanelId !== panelId) return;

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

      if (key === "a") {
        // Ctrl+A 全选；Ctrl+Shift+A 反选
        e.preventDefault();
        if (e.shiftKey) {
          const next = new Set<string>();
          for (const en of entries) {
            if (!selected.has(en.path)) next.add(en.path);
          }
          setSelected(next);
        } else {
          setSelected(new Set(entries.map((en) => en.path)));
        }
        return;
      }
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
  // 慢点两下（600ms~3s）→ 行内重命名
  const FAST_DBLCLICK_MAX = 600;
  const SLOW_DBLCLICK_MAX = 3000;

  // 选中 + 双击节奏判定。
  // 由 onRowMouseDown 的 onUp(!moved) 调用，而不是 React 的 onClick——
  // Windows/WebView2 下 mousedown→mouseup 间只要鼠标有微小移动（<系统拖拽阈值）
  // 就不会派发 click，导致慢双击（手抖更明显）的 click 被吞、双击计时失效。
  // mouseup 必然派发，改为在此直接触发点击逻辑，行为稳定可靠。
  const handleClick = (
    item: FileEntry,
    mods: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
  ) => {
    // —— 选中逻辑（与多选兼容）——
    if (mods.ctrlKey || mods.metaKey) {
      const next = new Set(selected);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      setSelected(next);
    } else if (mods.shiftKey && selected.size > 0) {
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
    if (renamingPath || mods.ctrlKey || mods.metaKey || mods.shiftKey) {
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
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) {
        moved = true;
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
      if (!moved) {
        // 未发生拖拽 = 一次有效点击（不依赖浏览器 click，避免移动被吞）
        handleClick(item, {
          ctrlKey: ev.ctrlKey,
          metaKey: ev.metaKey,
          shiftKey: ev.shiftKey,
        });
        return;
      }
      // 发生拖拽：清理幽灵，按鼠标 X 判定目标面板（左列右侧即分隔线）
      setIsPointerDragging(false);
      if (dragGhostRef.current) {
        dragGhostRef.current.remove();
        dragGhostRef.current = null;
      }
      const cols = document.querySelectorAll<HTMLElement>(".sftp-panel-col");
      let targetSide: "local" | "remote" = "remote";
      if (cols.length >= 2) {
        const localRect = cols[0].getBoundingClientRect();
        targetSide = ev.clientX < localRect.right ? "local" : "remote";
      } else {
        targetSide = ev.clientX < window.innerWidth / 2 ? "local" : "remote";
      }
      if (targetSide !== side && items.length > 0) {
        onTransfer(items); // 跨面板传输
      } else {
        // 同侧拖放（moved 但落回本侧）= 视为一次点击，保证双击计时/选中一致
        handleClick(item, {
          ctrlKey: ev.ctrlKey,
          metaKey: ev.metaKey,
          shiftKey: ev.shiftKey,
        });
      }
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
    // 使用 dataTransfer.items + webkitGetAsEntry 以正确处理文件夹结构。
    // 方向由所在面板 side 决定（修复 B1）：本地面板 = 写入本地目录；远端面板 = 上传到服务器。
    const entries = Array.from(e.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry())
      .filter(Boolean) as FileSystemEntry[];
    if (entries.length === 0) return;

    // 递归收集所有文件并记录相对路径
    const files: { rel: string; file: File }[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string) => {
      if (entry.isFile) {
        const f = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject)
        );
        files.push({ rel: prefix ? `${prefix}/${f.name}` : f.name, file: f });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const readBatch = () =>
          new Promise<FileSystemEntry[]>((resolve) =>
            reader.readEntries((es) => resolve(es))
          );
        let batch = await readBatch();
        while (batch.length > 0) {
          for (const ch of batch) {
            await walk(ch, prefix ? `${prefix}/${entry.name}` : entry.name);
          }
          batch = await readBatch();
        }
      }
    };
    for (const entry of entries) {
      await walk(entry, "");
    }
    if (files.length === 0) return;

    if (side === "local") {
      // OS → 本地面板：把字节直接写入当前目录（含子目录结构）
      for (const { rel, file } of files) {
        const dest = joinPath(currentPath, rel);
        const buf = new Uint8Array(await file.arrayBuffer());
        try {
          await invoke("local_write_file", { path: dest, data: Array.from(buf) });
        } catch (err: any) {
          toast.error("写入失败", err.toString());
        }
      }
      toast.success("已放入本地", `${files.length} 项`);
      await load(currentPath);
      return;
    }

    // OS → 远端面板：先写临时文件，再 sftp_upload（保留 mtime），最后清理临时文件
    const tmpBase = joinPath(await invoke<string>("local_home"), ".shelflux-dnd");
    let okCount = 0;
    for (const { rel, file } of files) {
      const tmp = joinPath(tmpBase, rel);
      const remoteDest = joinPath(currentPath, rel);
      const buf = new Uint8Array(await file.arrayBuffer());
      try {
        await invoke("local_write_file", { path: tmp, data: Array.from(buf) });
        await invoke("sftp_upload", {
          server,
          local: tmp,
          remote: remoteDest,
          taskId: uid(),
          offset: null,
          preserveMtime: settings.transfers.preserveTimestamps,
        });
        await invoke("local_remove", { path: tmp });
        okCount += 1;
      } catch (err: any) {
        toast.error("上传失败", err.toString());
        try {
          await invoke("local_remove", { path: tmp });
        } catch {
          /* ignore */
        }
      }
    }
    if (okCount > 0) toast.success("已上传", `${okCount} 项`);
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

  // 将当前面板路径加入书签（P2 书签功能）
  const handleAddBookmark = async () => {
    if (!currentPath) {
      toast.warn("当前路径为空，无法收藏");
      return;
    }
    const def = basename(currentPath) || currentPath;
    const existing = useBookmarkStore.getState().byServer[server.id] || [];
    if (existing.some((b) => b.side === side && b.path === currentPath)) {
      toast.info("已收藏", `${def}（${side === "local" ? "本地" : "远端"}）`);
      return;
    }
    const name = await askPrompt({
      title: "添加书签",
      message: `为当前${side === "local" ? "本地" : "远端"}路径添加书签`,
      placeholder: "书签名称",
      defaultValue: def,
    });
    if (name == null) return;
    const finalName = name.trim() || def;
    addBookmark(server.id, { name: finalName, side, path: currentPath });
    toast.success("已添加书签", finalName);
  };

  // 修改远端文件/目录权限（chmod，P1）
  const changePermissions = async (item: FileEntry) => {
    if (side !== "remote") {
      toast.info("本地不支持", "本地（Windows）暂不支持修改 Unix 权限，请在远端文件上使用");
      return;
    }
    const cur = item.permissions != null ? (item.permissions & 0o777).toString(8) : "";
    const input = await askPrompt({
      title: "修改权限",
      message: `输入八进制权限（如 755 / 644），应用于 "${item.name}"`,
      defaultValue: cur,
    });
    if (input == null) return;
    const mode = parseInt(input.trim(), 8);
    if (Number.isNaN(mode) || mode < 0 || mode > 0o7777) {
      toast.error("权限格式错误", "应为 0-7777 的八进制数");
      return;
    }
    try {
      await invoke("sftp_chmod", { server, path: item.path, mode });
      await load(currentPath);
      toast.success("已更新权限", `${(mode & 0o777).toString(8)} ${item.name}`);
    } catch (e: any) {
      toast.error("修改权限失败", e.toString());
    }
  };

  // 创建远端符号链接：link_path 指向 target（P1）
  const createSymlink = async () => {
    if (side !== "remote") {
      toast.info("仅远端支持", "符号链接创建目前仅支持远端（Unix）服务器");
      return;
    }
    const linkName = await askPrompt({
      title: "创建符号链接",
      message: "链接名称（将创建在当前目录）",
      placeholder: "link",
    });
    if (!linkName) return;
    const target = await askPrompt({
      title: "创建符号链接",
      message: `链接 "${linkName.trim()}" 指向的目标路径`,
      placeholder: "/path/to/target",
    });
    if (!target) return;
    const linkPath = joinPath(currentPath, linkName.trim());
    try {
      await invoke("sftp_symlink", { server, target: target.trim(), linkPath });
      await load(currentPath);
      toast.success("已创建符号链接", linkName.trim());
    } catch (e: any) {
      toast.error("创建符号链接失败", e.toString());
    }
  };

  // 读取符号链接目标并复制到剪贴板
  const copyLinkTarget = async (item: FileEntry) => {
    if (side !== "remote") return;
    try {
      const target = await invoke<string>("sftp_readlink", { server, path: item.path });
      await navigator.clipboard.writeText(target).catch(() => {});
      toast.success("链接目标已复制", target);
    } catch (e: any) {
      toast.error("读取链接失败", e.toString());
    }
  };

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
        { label: "创建符号链接...", icon: <LinkIcon />, onClick: createSymlink },
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
        { label: "修改权限...", icon: <EditIcon />, onClick: () => changePermissions(item) },
        { label: "属性", icon: <InfoIcon />, onClick: () => setPropsItem(item) },
        { divider: true },
        { label: "粘贴", icon: <PasteIcon />, onClick: () => void pasteItems(), disabled: !canPaste },
        { divider: true },
        { label: "新建文件夹", icon: <FolderPlusIcon />, onClick: newFolder },
        { label: "新建文件", icon: <FilePlusIcon />, onClick: newFile },
        { label: "创建符号链接...", icon: <LinkIcon />, onClick: createSymlink },
        { divider: true },
        { label: "刷新", icon: <RefreshIcon />, onClick: refresh },
        { divider: true },
        { label: "删除", icon: <TrashIcon />, danger: true, onClick: () => deleteItem(item) },
      ];
    }
    // 文件 —— 构建"打开方式"子菜单
    const ext = extOf(item.name);
    const filePath = side === "local" ? item.path : null; // 远端文件需先下载，openWith 内部处理
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
      { label: "修改权限...", icon: <EditIcon />, onClick: () => changePermissions(item) },
      { label: "属性", icon: <InfoIcon />, onClick: () => setPropsItem(item) },
      { divider: true },
      { label: "复制", icon: <CopyIcon />, onClick: () => { setSelected(new Set([item.path])); copySelection(); } },
      { label: "复制路径", icon: <LinkIcon />, onClick: () => copyUrl(item) },
      { label: "复制为", icon: <CopyIcon />, onClick: () => copyFile(item) },
      ...(item.isSymlink
        ? [{ label: "复制链接目标", icon: <LinkIcon />, onClick: () => copyLinkTarget(item) } as ContextMenuItem]
        : []),
      { divider: true },
      { label: "粘贴", icon: <PasteIcon />, onClick: () => void pasteItems(), disabled: !canPaste },
      { divider: true },
      { label: "创建符号链接...", icon: <LinkIcon />, onClick: createSymlink },
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

  // 搜索过滤后的可见列表
  const visibleEntries = filter.trim()
    ? sortedEntries.filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : sortedEntries;

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
        focusedPanelId = panelId;
      }}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      <div className="sftp-panel-header">
        <span className={`sftp-panel-label ${labelClass}`}>{title}</span>
        <input
          className="sftp-search-input"
          type="text"
          placeholder="搜索"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
        />
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
        <button
          className="btn btn-ghost btn-icon tooltip"
          data-tip="收藏当前路径"
          onClick={handleAddBookmark}
        >
          <StarIcon />
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
          <div className="sftp-files-loading">
            <span className="sftp-spinner" />
            加载中...
          </div>
        ) : error ? (
          <div className="sftp-files-loading" style={{ color: "var(--color-error)" }}>
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="sftp-files-empty">
            <FolderOutlineIcon />
            <span>空目录</span>
          </div>
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
              <div className="sftp-grid-cell sftp-grid-head permissions">
                权限
              </div>
            </div>

            {/* 数据行 */}
            {visibleEntries.map((item) => (
              <div
                key={item.path}
                className={`sftp-grid-row ${selected.has(item.path) ? "selected" : ""} ${isPointerDragging ? "dragging" : ""}`}
                onMouseDown={(e) => onRowMouseDown(e, item)}
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
                <div className="sftp-grid-cell permissions">
                  {permOctal(item.permissions)}
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
          }}
        />
      )}

      {propsItem && (
        <PropertiesDialog
          item={propsItem}
          side={side}
          server={server}
          onClose={() => setPropsItem(null)}
        />
      )}
    </div>
  );
}

// ===== Icons（全幅图形风格，类似 Windows 资源管理器）=====
// 所有图标使用 24×24 viewBox，图形填满整个区域

function FolderIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M3 6a2 2 0 012-2h4.586a1 1 0 01.707.293L11.414 6H19a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" fill="#FFC107"/>
      <path d="M3 10h18v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8z" fill="#FFD54F"/>
      <path d="M3 6a2 2 0 012-2h4.586a1 1 0 01.707.293L11.414 6H19a2 2 0 012 2v0H3V6z" fill="#FFA000" opacity=".35"/>
    </svg>
  );
}

function SymlinkIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 3h9l5 5v13a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z" fill="#f0f0f0" stroke="#bbb" strokeWidth="1"/>
      <path d="M14 3l5 5h-4a1 1 0 01-1-1V3z" fill="#e0e0e0" stroke="#bbb" strokeWidth=".7"/>
      <circle cx="17" cy="17" r="5" fill="#4A90D9"/>
      <path d="M15 17l2-2 3 3m0-3l-3 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 11v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="7.6" r="1.1" fill="currentColor" />
    </svg>
  );
}

/** 空目录占位图标（线性风格，弱化不抢内容） */
function FolderOutlineIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M3 11h18" stroke="currentColor" strokeWidth="1.3" opacity=".5" />
    </svg>
  );
}

// ── Word 文档：蓝色底 + 大 W ──
function WordIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#2B579A"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#1e4278"/>
      <text x="11" y="18" fill="#fff" fontSize="11" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">W</text>
    </svg>
  );
}
// ── Excel 表格：绿色底 + 网格/X ──
function ExcelIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#217346"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#185a33"/>
      <text x="11" y="18" fill="#fff" fontSize="11" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">X</text>
    </svg>
  );
}
// ── PPT 演示文稿：橙红底 + 图表 ──
function PptIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#D24726"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#a83a1c"/>
      <rect x="7" y="11" width="3" height="6" rx=".5" fill="#fff" opacity=".85"/>
      <rect x="11.5" y="13" width="3" height="4" rx=".5" fill="#fff" opacity=".65"/>
    </svg>
  );
}
// ── PDF 文档：红色底 + PDF 标识 ──
function PdfIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#E03A2F"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#b82d30"/>
      <text x="11" y="16.5" fill="#fff" fontSize="6" fontWeight="800" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle" letterSpacing=".5">PDF</text>
    </svg>
  );
}
// ── 文本文件：灰色底 + 横线 ──
function TextIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#78909C"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#607d8b"/>
      <line x1="7.5" y1="12" x2="16.5" y2="12" stroke="#fff" strokeWidth="1.2" opacity=".8" strokeLinecap="round"/>
      <line x1="7.5" y1="15" x2="14.5" y2="15" stroke="#fff" strokeWidth="1.2" opacity=".6" strokeLinecap="round"/>
      <line x1="7.5" y1="18" x2="12" y2="18" stroke="#fff" strokeWidth="1.2" opacity=".4" strokeLinecap="round"/>
    </svg>
  );
}
// ── Markdown：深灰底 + M 符号 ──
function MarkdownIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#333"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#222"/>
      <text x="11" y="17.5" fill="#fff" fontSize="8" fontWeight="700" fontFamily="monospace" textAnchor="middle">MD</text>
    </svg>
  );
}
// ── 电子书：棕色底 + 书本 ──
function BookIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#B45309"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#8b4007"/>
      <path d="M8 10c-1.5-.8-3-.8-4 0v8c1-.8 2.5-.8 4 0s2.5.8 4 0v-8c-1.5.8-3 .8-4 0z" fill="#fff" opacity=".85"/>
    </svg>
  );
}
// ── 图片：绿色底 + 山景 ──
function ImageIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#2BA84A"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#218838"/>
      <circle cx="16" cy="9" r="2" fill="#fff" opacity=".9"/>
      <path d="M6 18l3.5-4 3 3 3-3 4.5 4H6z" fill="#fff" opacity=".75"/>
    </svg>
  );
}
// ── 视频：紫色底 + 播放按钮 ──
function VideoIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#7C4DFF"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#651fff"/>
      <path d="M9 9v7l6-3.5L9 9z" fill="#fff" opacity=".95"/>
    </svg>
  );
}
// ── 音频：橙色底 + 波形 ──
function AudioIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#F59E0B"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#d97706"/>
      <g fill="#fff" opacity=".9">
        <rect x="7" y="10" width="2" height="7" rx=".5"/><rect x="11" y="8" width="2" height="9" rx=".5"/><rect x="15" y="12" width="2" height="5" rx=".5"/>
      </g>
    </svg>
  );
}
// ── 压缩包：棕黄底 + 盒子 ──
function ArchiveIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#C9972B"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#a67c20"/>
      <rect x="7" y="11" width="10" height="7" rx="1" stroke="#fff" strokeWidth="1" fill="none" opacity=".8"/>
      <line x1="7" y1="14.5" x2="17" y2="14.5" stroke="#fff" strokeWidth="1" opacity=".6"/>
      <line x1="12" y1="11" x2="12" y2="18" stroke="#fff" strokeWidth="1" opacity=".6"/>
    </svg>
  );
}
// ── 磁盘镜像：灰蓝底 + 光盘 ──
function DiskImageIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#5A6B7B"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#445566"/>
      <circle cx="12" cy="13" r="5" stroke="#fff" strokeWidth="1" fill="none" opacity=".8"/>
      <circle cx="12" cy="13" r="1.8" fill="#fff" opacity=".85"/>
    </svg>
  );
}
// ── 配置文件：青色底 + 齿轮 ──
function ConfigIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#0F9D9D"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#0c7a7a"/>
      <g fill="#fff" opacity=".9">
        <path d="M12 8.5l1.3 2.5 2.7.4-2 1.9.5 2.7-2.5 1.3L12 18l-1.5-2.7-2.5-1.3.5-2.7-2-1.9 2.7-.4z"/>
      </g>
    </svg>
  );
}
// ── HTML：红色底 + 代码括号 ──
function HtmlIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#E44D26"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#c23d1b"/>
      <path d="M8 10l-2 2 2 2M16 10l2 2-2 2M12 8l-1.5 8" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".9"/>
    </svg>
  );
}
// ── CSS：蓝色底 + 代码括号 ──
function CssIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#2965F1"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#1a50da"/>
      <path d="M8 10l-2 2 2 2M16 10l2 2-2 2M12 8l-1.5 8" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".9"/>
    </svg>
  );
}
// ── Vue/Svelte：绿色底 + 代码括号 ──
function WebCompIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#41B883"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#329c69"/>
      <path d="M8 10l-2 2 2 2M16 10l2 2-2 2M12 8l-1.5 8" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".9"/>
    </svg>
  );
}
// ── JS：黄色底 + JS ──
function JsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#E8A400"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#c98a00"/>
      <text x="11" y="17.5" fill="#fff" fontSize="8" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">JS</text>
    </svg>
  );
}
// ── TS：蓝色底 + TS ──
function TsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#2D79C7"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#2261a3"/>
      <text x="11" y="17.5" fill="#fff" fontSize="8" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">TS</text>
    </svg>
  );
}
// ── Python：蓝色底 + PY ──
function PythonIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#3A76A8"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#2d5f87"/>
      <text x="11" y="17.5" fill="#fff" fontSize="8" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">PY</text>
    </svg>
  );
}
// ── Shell：深灰底 + 终端 >_ ──
function ShellIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#2E3138"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#1e2025"/>
      <path d="M7.5 11l3 2.5-3 2.5" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".9"/>
      <rect x="14" y="15" width="3" height="1.5" rx=".3" fill="#fff" opacity=".8"/>
    </svg>
  );
}
// ── Java：橙色底 + 咖啡杯 ──
function JavaIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#E76F00"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#c45a00"/>
      <path d="M7 10h5.5v3c0 1.2-1.2 2-2.7 2S7 14.2 7 13v-3z" fill="#fff" opacity=".85"/>
      <path d="M12.5 10.5h1.5c.6 0 1 .5 1 1s-.4 1-1 1h-1.5" stroke="#fff" strokeWidth=".8" fill="none" opacity=".7"/>
    </svg>
  );
}
// ── C++：深蓝底 + C++ ──
function CppIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#00599C"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#00447a"/>
      <text x="11" y="17.5" fill="#fff" fontSize="7" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">C++</text>
    </svg>
  );
}
// ── Go：青色底 + GO ──
function GoIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#00ADD8"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#008cb0"/>
      <text x="11" y="17.5" fill="#fff" fontSize="8" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">GO</text>
    </svg>
  );
}
// ── Rust：锈红底 + 齿轮 ──
function RustIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#CE412B"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#a83321"/>
      <g fill="#fff" opacity=".9"><path d="M12 8.5l1.3 2.5 2.7.4-2 1.9.5 2.7-2.5 1.3L12 18l-1.5-2.7-2.5-1.3.5-2.7-2-1.9 2.7-.4z"/></g>
    </svg>
  );
}
// ── Ruby：红色底 + 宝石 ──
function RubyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#CC342D"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#a32822"/>
      <path d="M9 9h6l1.5 2.5-3 5-3-5L9 9z" fill="#fff" opacity=".85"/>
      <path d="M9 9 8 12h8L15 9M8.5 12 12 17.5M15.5 12 12 17.5M10 12h4" stroke="#fff" strokeWidth=".6" fill="none" opacity=".5"/>
    </svg>
  );
}
// ── PHP：紫蓝底 + PHP ──
function PhpIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#777BB4"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#5e62a0"/>
      <text x="11" y="17.5" fill="#fff" fontSize="8" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">PHP</text>
    </svg>
  );
}
// ── SQL：青色底 + 数据库 ──
function SqlIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#1F8A9E"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#176d7c"/>
      <ellipse cx="12" cy="10" rx="4.5" ry="1.8" fill="#fff" opacity=".85"/>
      <path d="M7.5 10v4.5c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V10" stroke="#fff" strokeWidth="1" fill="none" opacity=".7"/>
      <path d="M7.5 12.3c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" stroke="#fff" strokeWidth="1" fill="none" opacity=".5"/>
    </svg>
  );
}
// ── Swift：橙红底 + SWIFT ──
function SwiftIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#F05138"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#c93f2a"/>
      <text x="11" y="16" fill="#fff" fontSize="5.5" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">SWIFT</text>
    </svg>
  );
}
// ── Kotlin：紫色底 + KT ──
function KotlinIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#A97BFF"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#8a5fe0"/>
      <text x="11" y="17.5" fill="#fff" fontSize="8" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">KT</text>
    </svg>
  );
}
// ── Dart：蓝色底 + DART ──
function DartIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#0175C2"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#015a9a"/>
      <text x="11" y="16" fill="#fff" fontSize="5.5" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">DART</text>
    </svg>
  );
}
// ── C#：绿色底 + CS ──
function CSharpIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#239120"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#1b7318"/>
      <text x="11" y="17.5" fill="#fff" fontSize="8" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">CS</text>
    </svg>
  );
}
// ── Lua：蓝色底 + LUA ──
function LuaIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#2C5AA0"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#224780"/>
      <text x="11" y="17.5" fill="#fff" fontSize="7" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">LUA</text>
    </svg>
  );
}
// ── R 语言：蓝色底 + R ──
function RLangIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#276DC3"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#1f569c"/>
      <text x="11" y="17.5" fill="#fff" fontSize="10" fontWeight="700" fontFamily="Arial,Helvetica,sans-serif" textAnchor="middle">R</text>
    </svg>
  );
}
// ── 通用代码：靛蓝底 + CODE ──
function CodeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#5C6BC0"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#4855a0"/>
      <path d="M8 10l-2 2 2 2M16 10l2 2-2 2M12 8l-1.5 8" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".9"/>
    </svg>
  );
}
// ── 可执行：深灰底 + 齿轮 ──
function ExeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#3A3F47"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#2a2e34"/>
      <g fill="#fff" opacity=".9"><path d="M12 8.5l1.3 2.5 2.7.4-2 1.9.5 2.7-2.5 1.3L12 18l-1.5-2.7-2.5-1.3.5-2.7-2-1.9 2.7-.4z"/></g>
    </svg>
  );
}
// ── 数据库：青色底 + 圆柱 ──
function DatabaseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#1F8A9E"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#176d7c"/>
      <ellipse cx="12" cy="10" rx="4.5" ry="1.8" fill="#fff" opacity=".85"/>
      <path d="M7.5 10v4.5c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V10" stroke="#fff" strokeWidth="1" fill="none" opacity=".7"/>
      <path d="M7.5 12.3c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" stroke="#fff" strokeWidth="1" fill="none" opacity=".5"/>
    </svg>
  );
}
// ── 字体：紫色底 + A ──
function FontIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#8B5CF6"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#7144cf"/>
      <path d="M12 8 9 17h2l.8-2.2h3.4L16 17h2L15 8zm-.8 5.5L12 11l.8 2.5z" fill="#fff" opacity=".9"/>
    </svg>
  );
}
// ── 密钥/证书：绿色底 + 钥匙 ──
function KeyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#2E9E5B"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#247d49"/>
      <circle cx="9" cy="11" r="2.5" stroke="#fff" strokeWidth="1.2" fill="none" opacity=".85"/>
      <path d="M11 12.5 15 17M14 15.5l1.5 1.5M13 14.5l1.5 1.5" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" fill="none" opacity=".8"/>
    </svg>
  );
}
// ── 备份：灰色底 + 光盘 ──
function BackupIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#6B7785"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#555f6a"/>
      <circle cx="12" cy="13" r="5" stroke="#fff" strokeWidth="1" fill="none" opacity=".8"/>
      <circle cx="12" cy="13" r="1.8" fill="#fff" opacity=".85"/>
    </svg>
  );
}
// ── 日志：灰蓝底 + 横线 ──
function LogIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#5A6B7B"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#445566"/>
      <line x1="7.5" y1="12" x2="16.5" y2="12" stroke="#fff" strokeWidth="1.2" opacity=".8" strokeLinecap="round"/>
      <line x1="7.5" y1="15" x2="14.5" y2="15" stroke="#fff" strokeWidth="1.2" opacity=".6" strokeLinecap="round"/>
      <line x1="7.5" y1="18" x2="12" y2="18" stroke="#fff" strokeWidth="1.2" opacity=".4" strokeLinecap="round"/>
    </svg>
  );
}
// ── 默认文件：灰色底 ──
function FileIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M5 2h9l6 6v13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#9AA5B1"/>
      <path d="M14 2l6 6h-5a1 1 0 01-1-1V2z" fill="#828c96"/>
      <line x1="7.5" y1="12" x2="16.5" y2="12" stroke="#fff" strokeWidth="1.2" opacity=".5" strokeLinecap="round"/>
      <line x1="7.5" y1="15.5" x2="13" y2="15.5" stroke="#fff" strokeWidth="1.2" opacity=".3" strokeLinecap="round"/>
    </svg>
  );
}

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
function StarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M6.5 1.8l1.5 3.1 3.4.5-2.5 2.4.6 3.4-3-1.6-3 1.6.6-3.4L1.6 5.4l3.4-.5L6.5 1.8z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill="none" />
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
