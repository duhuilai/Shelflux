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

/** 列宽约束（px）：名称列为自适应列，两个固定列不得把它挤没 */
const MIN_NAME_W = 100;
const MIN_SIZE_W = 56;
const MIN_TIME_W = 96;

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
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileEntry | null;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
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
        const result = await loadEntries(path);
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

  // 监听 Ctrl+C / Ctrl+V（仅作用于当前获得焦点的面板；输入框/弹窗中不拦截）
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
      if (!(e.ctrlKey || e.metaKey)) return;

      const key = e.key.toLowerCase();
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

  // 双击文件
  const handleDoubleClick = (item: FileEntry) => {
    if (item.kind === "dir") {
      onPathChange(item.path);
    } else {
      // 双击文件 = 上传/下载
      onTransfer([item]);
    }
  };

  // 单击选中
  const handleClick = (e: React.MouseEvent, item: FileEntry) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      setSelected(next);
    } else if (e.shiftKey && selected.size > 0) {
      // 范围选择
      const lastSelected = Array.from(selected).pop()!;
      const startIdx = entries.findIndex((e) => e.path === lastSelected);
      const endIdx = entries.findIndex((e) => e.path === item.path);
      const [s, e2] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
      const next = new Set(selected);
      for (let i = s; i <= e2; i++) next.add(entries[i].path);
      setSelected(next);
    } else {
      setSelected(new Set([item.path]));
    }
  };

  // 拖动文件到另一侧
  const handleDragStart = (e: React.DragEvent, item: FileEntry) => {
    // 只在按住时把已选中的项目一起拖动
    const items = selected.has(item.path)
      ? entries.filter((e) => selected.has(e.path))
      : [item];
    e.dataTransfer.setData(
      "application/x-shelflux-files",
      JSON.stringify({ side, items: items.map((i) => i.path) })
    );
    e.dataTransfer.effectAllowed = "move";
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
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const data = e.dataTransfer.getData("application/x-shelflux-files");
    if (!data) return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.side === side) {
        // 同侧：尝试移动（仅对同协议）
        // 简化：这里只支持跨侧传输
        return;
      }
      const items = (parsed.items as string[])
        .map((p) => entries.find((e) => e.path === p))
        .filter(Boolean) as FileEntry[];
      if (items.length > 0) onTransfer(items);
    } catch {
      /* noop */
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

  const deleteItem = async (item: FileEntry) => {
    const ok = await askConfirm({
      title: "确认删除",
      message: `确定要删除 "${item.name}" 吗？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      if (side === "local") {
        await invoke("local_remove", { path: item.path });
      } else {
        await invoke("sftp_remove", { server, path: item.path });
      }
      await load(currentPath);
      toast.success("已删除", item.name);
    } catch (e: any) {
      toast.error("删除失败", e.toString());
    }
  };

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
        const tmpPath = joinPath(tmpDir, ".shelflux-cache", basename(item.path));
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
      const tmpPath = joinPath(tmpDir, ".shelflux-cache", basename(item.path));
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
    if (!item) {
      // 空白处
      return [
        { label: "新建文件夹", icon: <FolderPlusIcon />, onClick: newFolder },
        { label: "新建文件", icon: <FilePlusIcon />, onClick: newFile },
        { divider: true },
        { label: "刷新", icon: <RefreshIcon />, onClick: refresh },
        { label: "复制当前路径", icon: <LinkIcon />, onClick: () => copyUrl({ name: currentPath, path: currentPath, kind: "dir", size: 0, isSymlink: false }) },
      ];
    }
    if (item.kind === "dir") {
      return [
        { label: "打开", icon: <ArrowRightIcon />, onClick: () => onPathChange(item.path) },
        { label: "重命名", icon: <EditIcon />, onClick: () => renameItem(item) },
        { divider: true },
        { label: "新建文件夹", icon: <FolderPlusIcon />, onClick: newFolder },
        { label: "新建文件", icon: <FilePlusIcon />, onClick: newFile },
        { divider: true },
        { label: "刷新", icon: <RefreshIcon />, onClick: refresh },
        { divider: true },
        { label: "复制路径", icon: <LinkIcon />, onClick: () => copyUrl(item) },
        { label: "复制为", icon: <CopyIcon />, onClick: () => copyFile(item) },
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

    submenuItems.push({ divider: true });
    submenuItems.push({
      label: "选择其他程序打开...",
      onClick: async () => {
        // 浏览选择程序
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
      },
    });
    submenuItems.push({
      label: "其他程序设为默认...",
      onClick: async () => {
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
      { label: "复制路径", icon: <LinkIcon />, onClick: () => copyUrl(item) },
      { label: "复制为", icon: <CopyIcon />, onClick: () => copyFile(item) },
      { divider: true },
        { label: "删除", icon: <TrashIcon />, danger: true, onClick: () => deleteItem(item) },
      ];
  };

  /** 远端文件还没下载时，先下载再用指定程序打开并开始监控 */
  const prepareOpenWithThenOpen = async (item: FileEntry, programPath: string) => {
    if (side !== "remote") return;
    try {
      const tmpDir = await invoke<string>("local_home");
      const tmpPath = joinPath(tmpDir, ".shelflux-cache", basename(item.path));
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
  //   colIndex=0 → 名称/大小 边界：名称是 auto 列，右移即压缩「大小」列
  //   colIndex=1 → 大小/修改时间 边界：两个固定列之间此消彼长，名称列不变
  // 始终保证 大小 + 修改时间 <= 表宽 - MIN_NAME，名称列永远有可用空间，表不会溢出分栏
  const [dragCols, setDragCols] = useState<[number, number]>([FIXED_SIZE_COL, FIXED_TIME_COL]);

  const startResize = (e: React.MouseEvent, colIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const tableWidth = filesRef.current?.clientWidth ?? 0;
    if (tableWidth <= 0) return;
    const startX = e.clientX;
    const [startSize, startTime] = dragCols;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      let nextSize = startSize;
      let nextTime = startTime;

      if (colIndex === 0) {
        const maxSize = tableWidth - MIN_NAME_W - startTime;
        nextSize = clamp(startSize - delta, MIN_SIZE_W, Math.max(MIN_SIZE_W, maxSize));
      } else {
        const total = startSize + startTime;
        nextSize = clamp(startSize + delta, MIN_SIZE_W, total - MIN_TIME_W);
        nextTime = total - nextSize;
      }

      const maxFixed = Math.max(MIN_SIZE_W + MIN_TIME_W, tableWidth - MIN_NAME_W);
      if (nextSize + nextTime > maxFixed) {
        const scale = maxFixed / (nextSize + nextTime);
        nextSize = Math.max(MIN_SIZE_W, nextSize * scale);
        nextTime = Math.max(MIN_TIME_W, maxFixed - nextSize);
      }
      setDragCols([Math.round(nextSize), Math.round(nextTime)]);
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
              <div className="sftp-grid-cell sftp-grid-head name">
                名称
                <span
                  className="col-resizer"
                  onMouseDown={(e) => startResize(e, 0)}
                />
              </div>
              <div
                className="sftp-grid-cell sftp-grid-head size"
                style={{ width: `${dragCols[0]}px` }}
              >
                大小
                <span
                  className="col-resizer"
                  onMouseDown={(e) => startResize(e, 1)}
                />
              </div>
              <div
                className="sftp-grid-cell sftp-grid-head modified"
                style={{ width: `${dragCols[1]}px` }}
              >
                修改时间
              </div>
            </div>

            {/* 数据行 */}
            {entries.map((item) => (
              <div
                key={item.path}
                className={`sftp-grid-row ${selected.has(item.path) ? "selected" : ""}`}
                draggable
                onDragStart={(e) => handleDragStart(e, item)}
                onClick={(e) => handleClick(e, item)}
                onDoubleClick={() => handleDoubleClick(item)}
                onContextMenu={(e) => handleContextMenu(e, item)}
              >
                <div className="sftp-grid-cell name">
                  <div className="sftp-file-name">
                    <span className={`sftp-file-icon ${item.kind}`}>
                      {item.kind === "dir" ? <FolderIcon /> : item.kind === "symlink" ? <LinkIcon /> : <FileIcon />}
                    </span>
                    <span className="sftp-file-name-text" title={item.path}>
                      {item.name}
                    </span>
                  </div>
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
function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1.5 3.5C1.5 3 1.9 2.5 2.5 2.5h2.7c.4 0 .8.2 1 .5L7 4h4.5c.6 0 1 .4 1 1v5.5c0 .6-.4 1-1 1H2.5c-.6 0-1-.4-1-1V3.5z" fill="currentColor" fillOpacity="0.18" />
      <path d="M1.5 3.5C1.5 3 1.9 2.5 2.5 2.5h2.7c.4 0 .8.2 1 .5L7 4h4.5c.6 0 1 .4 1 1v5.5c0 .6-.4 1-1 1H2.5c-.6 0-1-.4-1-1V3.5z" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}
function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M3 1.5h5l2.5 2.5V11c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V2.5c0-.6.4-1 1-1z" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M8 1.5V4h2.5" stroke="currentColor" strokeWidth="1" fill="none" />
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
