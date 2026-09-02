// 应用入口
import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TabBar } from "./components/TabBar/TabBar";
import { MainArea } from "./components/MainArea/MainArea";
import { ToastContainer } from "./components/Toast/ToastContainer";
import { ServerForm } from "./components/Sidebar/ServerForm";
import { ServerPicker } from "./components/ServerPicker/ServerPicker";
import { Settings } from "./components/Settings/Settings";
import { ForwardPanel } from "./components/Forward/ForwardPanel";
import { ConfirmDialog } from "./components/Common/ConfirmDialog";
import { PromptDialog } from "./components/Common/PromptDialog";
import { OverwriteDialog } from "./components/Common/OverwriteDialog";
import { useUiStore } from "./stores/uiStore";
import { useTabStore } from "./stores/tabStore";
import { useSettingsStore, resolveTheme } from "./stores/settingsStore";
import { toast } from "./stores/toastStore";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// 右键菜单项（支持级联子菜单）
interface ContextMenuItem {
  /** 分隔线项无需 label */
  label?: string;
  icon?: React.ReactNode;
  action?: () => void;
  danger?: boolean;
  divider?: boolean;
  disabled?: boolean;
  submenu?: ContextMenuItem[];
}

// 右键菜单组件（全局，支持级联子菜单）
function ContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [activeSub, setActiveSub] = useState<number | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setMenu({ x: detail.x, y: detail.y, items: detail.items });
      setActiveSub(null);
      detail.onClose = () => setMenu(null);
    };
    const clickHandler = () => setMenu(null);
    const scrollHandler = () => setMenu(null);

    document.addEventListener("shelflux-context-menu", handler);
    document.addEventListener("click", clickHandler);
    window.addEventListener("scroll", scrollHandler, true);
    return () => {
      document.removeEventListener("shelflux-context-menu", handler);
      document.removeEventListener("click", clickHandler);
      window.removeEventListener("scroll", scrollHandler, true);
    };
  }, []);

  if (!menu) return null;

  // 确保菜单不超出视口
  const menuWidth = 180;
  const menuHeight = menu.items.length * 28;
  const maxX = window.innerWidth - menuWidth - 8;
  const maxY = window.innerHeight - menuHeight - 8;
  const x = Math.min(menu.x, maxX);
  const y = Math.min(menu.y, maxY);

  const renderItems = (
    items: ContextMenuItem[],
    parentIdx = -1,
    nested = false
  ) =>
    items.map((item, idx) => {
      if (item.divider) {
        return (
          <div
            key={idx}
            style={{ height: 1, background: "var(--border-light)", margin: "4px 0" }}
          />
        );
      }
      const hasSub = !nested && !!item.submenu?.length;
      return (
        <div key={idx} style={{ position: "relative" }}>
          <div
            className="context-menu-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 12,
              color: item.danger ? "var(--color-error)" : "var(--fg-primary)",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
              if (hasSub) setActiveSub(idx);
              else if (!nested) setActiveSub(null);
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "";
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (hasSub) return;
              item.action?.();
              setMenu(null);
              setActiveSub(null);
            }}
          >
            {item.icon && <span style={{ opacity: 0.7, flexShrink: 0 }}>{item.icon}</span>}
            <span style={{ flex: 1 }}>{item.label}</span>
            {hasSub && <span style={{ opacity: 0.5, marginLeft: 4 }}>▸</span>}
          </div>
          {hasSub && activeSub === idx && (
            <div
              style={{
                position: "absolute",
                left: "100%",
                top: -4,
                background: "var(--bg-base)",
                border: "1px solid var(--border-default)",
                borderRadius: 6,
                padding: "4px 0",
                minWidth: 150,
                boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                zIndex: 10000,
              }}
              onMouseEnter={() => setActiveSub(idx)}
              onMouseLeave={() => setActiveSub(null)}
            >
              {renderItems(item.submenu!, idx, true)}
            </div>
          )}
        </div>
      );
    });

  return (
    <div
      className="context-menu"
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 9999,
        background: "var(--bg-base)",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        padding: "4px 0",
        minWidth: menuWidth,
        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {renderItems(menu.items)}
    </div>
  );
}

/** 是否为文本输入框（受 execCommand / 选区操作支持） */
function isTextInput(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
  return (
    (el instanceof HTMLInputElement &&
      !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(el.type)) ||
    el instanceof HTMLTextAreaElement
  );
}

/** 把文本插入光标处并触发 React onChange */
async function pasteInto(el: HTMLElement) {
  let text = "";
  try {
    text = await invoke<string>("read_from_clipboard");
  } catch {
    return;
  }
  if (!text) return;
  if (isTextInput(el)) {
    el.focus();
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    try {
      el.setRangeText(text, start, end, "end");
    } catch {
      // number 等类型不支持 setRangeText，退化为直接追加
      el.value = el.value + text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // contenteditable
    document.execCommand("insertText", false, text);
  }
}

function selectAllIn(el: HTMLElement) {
  if (isTextInput(el)) {
    el.focus();
    el.select();
  } else {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

/** 输入框右键：应用内编辑菜单（替代含“重新加载”的原生菜单） */
function showEditContextMenu(e: MouseEvent, el: HTMLElement) {
  const run = (fn: () => void) => () => {
    el.focus();
    fn();
  };
  const items: ContextMenuItem[] = [
    { label: "撤销", action: run(() => document.execCommand("undo")) },
    { label: "重做", action: run(() => document.execCommand("redo")) },
    { divider: true },
    { label: "剪切", action: run(() => document.execCommand("cut")) },
    { label: "复制", action: run(() => document.execCommand("copy")) },
    { label: "粘贴", action: () => void pasteInto(el) },
    { divider: true },
    { label: "全选", action: run(() => selectAllIn(el)) },
  ];
  document.dispatchEvent(
    new CustomEvent("shelflux-context-menu", {
      detail: { x: e.clientX, y: e.clientY, items },
    })
  );
}

export default function App() {
  const themeMode = useSettingsStore((s) => s.settings.theme);
  const effectiveTheme = useSettingsStore((s) => s.effectiveTheme);
  const setEffectiveTheme = useSettingsStore((s) => s.setEffectiveTheme);

  useEffect(() => {
    setEffectiveTheme(resolveTheme(themeMode));
    if (themeMode !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setEffectiveTheme(mq.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themeMode, setEffectiveTheme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", effectiveTheme);
  }, [effectiveTheme]);

  const serverForm = useUiStore((s) => s.serverForm);
  const closeServerForm = useUiStore((s) => s.closeServerForm);
  const serverPickerOpen = useUiStore((s) => s.serverPickerOpen);
  const closeServerPicker = useUiStore((s) => s.closeServerPicker);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const forwardPanelOpen = useUiStore((s) => s.forwardPanelOpen);
  const closeForwardPanel = useUiStore((s) => s.closeForwardPanel);
  const openServerPicker = useUiStore((s) => s.openServerPicker);
  const openServerForm = useUiStore((s) => s.openServerForm);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // 显式声明保留原生菜单的区域
      if (target.closest(".allow-contextmenu")) return;
      // 自定义菜单自身不拦截
      if (target.closest(".context-menu")) return;

      // 禁用 WebView 原生右键菜单：
      // 原生菜单含「重新加载 / 检查元素」等浏览器项，误触会重载整个应用并丢失全部会话，
      // 与桌面客户端行为不符，因此全局屏蔽。
      e.preventDefault();

      // 终端区域：仅屏蔽原生菜单，不弹编辑菜单（终端自带粘贴快捷键，避免干扰）
      if (target.closest(".xterm")) return;

      // 输入类元素改用应用内编辑菜单（撤销/剪切/复制/粘贴/全选），
      // 兼顾"禁用原生菜单"与"输入框仍需右键编辑能力"。
      const editable = target.closest(
        "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable='true']"
      ) as HTMLElement | null;
      if (editable) {
        showEditContextMenu(e, editable);
      }
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && (e.key === "n" || e.key === "t")) {
        e.preventDefault();
        openServerPicker();
      }
      if (ctrl && e.shiftKey && e.key === "N") {
        e.preventDefault();
        openServerForm();
      }
      if (ctrl && e.key === "w") {
        e.preventDefault();
        const { activeTabId, closeTab } = useTabStore.getState();
        if (activeTabId) {
          closeTab(activeTabId);
          (document.activeElement as HTMLElement)?.blur();
        }
      }
      if (ctrl && e.key === ",") {
        e.preventDefault();
        useUiStore.getState().openSettings();
      }
      if (ctrl && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        useUiStore.getState().openForwardPanel();
      }
      if (ctrl && e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const { tabs, activeTabId, setActive } = useTabStore.getState();
        if (tabs.length > 1) {
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          const next = tabs[(idx + 1) % tabs.length];
          setActive(next.id);
        }
      }
      if (ctrl && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        const { tabs, activeTabId, setActive } = useTabStore.getState();
        if (tabs.length > 1) {
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
          setActive(prev.id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openServerPicker, openServerForm]);

  // 监听远端文件编辑后自动回传服务器的事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ name: string; status: string; message: string | null }>(
      "remote-file-synced",
      (e) => {
        const { name, status, message } = e.payload;
        if (status === "synced") {
          toast.success("已同步到服务器", message || name);
        } else if (status === "error") {
          toast.error("同步失败", message || name);
        }
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  return (
    <div className="window">
      {/* Main Layout */}
      <div className="main">
        {/* Sidebar */}
        <Sidebar />

        {/* Content */}
        <div className="content">
          <TabBar />
          <MainArea />
        </div>
      </div>

      {serverForm.open && <ServerForm onClose={closeServerForm} />}
      {serverPickerOpen && <ServerPicker onClose={closeServerPicker} />}
      {settingsOpen && <Settings onClose={closeSettings} />}
      {forwardPanelOpen && <ForwardPanel onClose={closeForwardPanel} />}

      <ConfirmDialog />
      <PromptDialog />
      <OverwriteDialog />
      <ToastContainer />
      <ContextMenu />
    </div>
  );
}
