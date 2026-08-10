// 服务器与分组状态管理
import { create } from "zustand";
import type { Server, ServerGroup, Protocol } from "../types";
import { uid } from "../utils/format";
import * as storage from "../utils/storage";

interface ServerStoreState {
  groups: ServerGroup[];
  servers: Server[];

  addGroup: (name: string) => ServerGroup;
  renameGroup: (id: string, name: string) => void;
  removeGroup: (id: string) => void;
  toggleGroupCollapsed: (id: string) => void;

  addServer: (
    data: Omit<Server, "id"> & { id?: string }
  ) => Server;
  updateServer: (id: string, patch: Partial<Server>) => void;
  removeServer: (id: string) => void;
  moveServer: (id: string, targetGroupId: string | null, beforeIndex?: number) => void;
  moveGroup: (id: string, beforeIndex: number) => void;
  setServerOrder: (orderedIds: string[]) => void;
  setGroupOrder: (orderedIds: string[]) => void;

  importData: (groups: ServerGroup[], servers: Server[]) => void;
  exportData: () => { groups: ServerGroup[]; servers: Server[] };
}

const persist = (
  get: () => ServerStoreState,
  set: (partial: Partial<ServerStoreState>) => void
) => {
  const data = {
    groups: get().groups,
    servers: get().servers,
  };
  storage.save("server-data", data);
  set(data);
};

export const useServerStore = create<ServerStoreState>((set, get) => {
  const initial = storage.load<{
    groups: ServerGroup[];
    servers: Server[];
  }>("server-data", {
    groups: [],
    servers: [],
  });

  return {
    groups: initial.groups,
    servers: initial.servers,

    addGroup: (name) => {
      const g: ServerGroup = {
        id: uid(),
        name: name.trim() || "新分组",
        collapsed: false,
      };
      set({ groups: [...get().groups, g] });
      persist(get, set);
      return g;
    },

    renameGroup: (id, name) => {
      set({
        groups: get().groups.map((g) => (g.id === id ? { ...g, name } : g)),
      });
      persist(get, set);
    },

    removeGroup: (id) => {
      set({
        groups: get().groups.filter((g) => g.id !== id),
        // 删除分组时把组内服务器移到顶层
        servers: get().servers.map((s) =>
          s.groupId === id ? { ...s, groupId: null } : s
        ),
      });
      persist(get, set);
    },

    toggleGroupCollapsed: (id) => {
      set({
        groups: get().groups.map((g) =>
          g.id === id ? { ...g, collapsed: !g.collapsed } : g
        ),
      });
      persist(get, set);
    },

    addServer: (data) => {
      const s: Server = {
        id: data.id || uid(),
        protocol: data.protocol,
        host: data.host,
        port: data.port || 0,
        username: data.username,
        password: data.password,
        privateKey: data.privateKey,
        passphrase: data.passphrase,
        alias: data.alias,
        defaultRemotePath: data.defaultRemotePath,
        defaultLocalPath: data.defaultLocalPath,
        groupId: data.groupId ?? null,
      };
      set({ servers: [...get().servers, s] });
      persist(get, set);
      return s;
    },

    updateServer: (id, patch) => {
      set({
        servers: get().servers.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      });
      persist(get, set);
    },

    removeServer: (id) => {
      set({ servers: get().servers.filter((s) => s.id !== id) });
      persist(get, set);
    },

    moveServer: (id, targetGroupId, beforeIndex) => {
      const servers = [...get().servers];
      const idx = servers.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const [item] = servers.splice(idx, 1);
      item.groupId = targetGroupId;
      // 找到目标位置
      let insertAt = servers.length;
      if (typeof beforeIndex === "number") {
        // 计算同一 groupId 下的索引
        const sameGroup = servers.filter((s) => s.groupId === targetGroupId);
        if (beforeIndex < sameGroup.length) {
          const target = sameGroup[beforeIndex];
          insertAt = servers.findIndex((s) => s.id === target.id);
        } else {
          // 插入到该 group 末尾
          let lastIndex = -1;
          servers.forEach((s, i) => {
            if (s.groupId === targetGroupId) lastIndex = i;
          });
          insertAt = lastIndex + 1;
        }
      }
      servers.splice(insertAt, 0, item);
      set({ servers });
      persist(get, set);
    },

    moveGroup: (id, beforeIndex) => {
      const groups = [...get().groups];
      const idx = groups.findIndex((g) => g.id === id);
      if (idx < 0) return;
      const [item] = groups.splice(idx, 1);
      const at = Math.max(0, Math.min(beforeIndex, groups.length));
      groups.splice(at, 0, item);
      set({ groups });
      persist(get, set);
    },

    setServerOrder: (orderedIds) => {
      const map = new Map(get().servers.map((s) => [s.id, s]));
      const next: Server[] = [];
      orderedIds.forEach((id) => {
        const s = map.get(id);
        if (s) next.push(s);
      });
      // 追加遗漏的
      get().servers.forEach((s) => {
        if (!orderedIds.includes(s.id)) next.push(s);
      });
      set({ servers: next });
      persist(get, set);
    },

    setGroupOrder: (orderedIds) => {
      const map = new Map(get().groups.map((g) => [g.id, g]));
      const next: ServerGroup[] = [];
      orderedIds.forEach((id) => {
        const g = map.get(id);
        if (g) next.push(g);
      });
      get().groups.forEach((g) => {
        if (!orderedIds.includes(g.id)) next.push(g);
      });
      set({ groups: next });
      persist(get, set);
    },

    importData: (groups, servers) => {
      // 合并：以 id 判定
      const existingGroupIds = new Set(get().groups.map((g) => g.id));
      const existingServerIds = new Set(get().servers.map((s) => s.id));
      const mergedGroups = [
        ...get().groups,
        ...groups.filter((g) => !existingGroupIds.has(g.id)),
      ];
      const mergedServers = [
        ...get().servers,
        ...servers.filter((s) => !existingServerIds.has(s.id)),
      ];
      set({ groups: mergedGroups, servers: mergedServers });
      persist(get, set);
    },

    exportData: () => ({
      groups: get().groups,
      servers: get().servers,
    }),
  };
});
