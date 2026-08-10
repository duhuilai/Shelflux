// 页签状态管理
import { create } from "zustand";
import type { Server, Tab, TabKind } from "../types";
import { uid } from "../utils/format";

interface TabStoreState {
  tabs: Tab[];
  activeTabId: string | null;

  openTab: (server: Server, kind?: TabKind) => Tab;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  getActiveTab: () => Tab | null;
}

const tabKindFor = (s: Server): TabKind => {
  if (s.protocol === "sftp") return "sftp";
  if (s.protocol === "ssh") return "ssh";
  if (s.protocol === "telnet") return "telnet";
  return "rlogin";
};

export const useTabStore = create<TabStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (server, kind) => {
    const k = kind || tabKindFor(server);
    // 协议兼容性：sftp 协议可以选择打开 sftp 或 ssh（同一台服务器）
    // 但为简单起见，sftp 协议默认开 sftp 视图；ssh 协议开 shell
    const title =
      server.alias ||
      `${server.username}@${server.host}${server.port ? `:${server.port}` : ""}`;

    // 已存在：直接激活
    const existing = get().tabs.find(
      (t) => t.server.id === server.id && t.kind === k
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing;
    }

    const tab: Tab = {
      id: uid(),
      kind: k,
      title,
      server,
    };
    const tabs = [...get().tabs, tab];
    set({ tabs, activeTabId: tab.id });
    return tab;
  },

  closeTab: (id) => {
    const tabs = get().tabs.filter((t) => t.id !== id);
    let activeTabId = get().activeTabId;
    if (activeTabId === id) {
      activeTabId = tabs[tabs.length - 1]?.id || null;
    }
    set({ tabs, activeTabId });
  },

  setActive: (id) => {
    set({ activeTabId: id });
  },

  updateTab: (id, patch) => {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  },

  getActiveTab: () => {
    const id = get().activeTabId;
    return get().tabs.find((t) => t.id === id) || null;
  },
}));
