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

// 右键菜单项
interface ContextMenuItem {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  danger?: boolean;
}

// 右键菜单组件
function ContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setMenu({ x: detail.x, y: detail.y, items: detail.items });
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
  const menuWidth = 160;
  const menuHeight = menu.items.length * 28;
  const maxX = window.innerWidth - menuWidth - 8;
  const maxY = window.innerHeight - menuHeight - 8;
  const x = Math.min(menu.x, maxX);
  const y = Math.min(menu.y, maxY);

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
      {menu.items.map((item, idx) => (
        <div
          key={idx}
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
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
          onClick={(e) => {
            e.stopPropagation();
            item.action();
            setMenu(null);
          }}
        >
          <span style={{ opacity: 0.7, flexShrink: 0 }}>{item.icon}</span>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
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
      if (target.closest(".xterm")) return;
      if (target.closest(".allow-contextmenu")) return;
      if (target.closest(".context-menu")) return;
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
