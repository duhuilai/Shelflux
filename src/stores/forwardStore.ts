// 端口转发规则与运行时状态管理
//
// 规则（PortForward）持久化在 localStorage；运行时状态（ForwardRuntime）
// 由后端 `forward-status` 事件驱动，进程重启后自动清空。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  ForwardRuntime,
  PortForward,
  PortForwardConfig,
  Server,
} from "../types";
import { uid } from "../utils/format";
import * as storage from "../utils/storage";

const KEY = "forward-rules";

/** 剥离 serverId，得到后端认识的配置结构 */
export function toConfig(rule: PortForward): PortForwardConfig {
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    bindAddr: rule.bindAddr,
    bindPort: rule.bindPort,
    destHost: rule.destHost,
    destPort: rule.destPort,
  };
}

interface ForwardStoreState {
  rules: PortForward[];
  runtime: Record<string, ForwardRuntime>;

  addRule: (data: Omit<PortForward, "id"> & { id?: string }) => PortForward;
  updateRule: (id: string, patch: Partial<PortForward>) => void;
  removeRule: (id: string) => void;
  rulesOf: (serverId: string) => PortForward[];

  /** 由 forward-status 事件调用 */
  applyRuntime: (rt: ForwardRuntime) => void;
  /** 全量同步后端当前活跃列表 */
  syncRuntime: () => Promise<void>;

  start: (rule: PortForward, server: Server) => Promise<void>;
  stop: (id: string) => Promise<void>;
  /** 不传 serverId 表示全部停止 */
  stopAll: (serverId?: string) => Promise<void>;
}

const persist = (rules: PortForward[]) => storage.save(KEY, rules);

export const useForwardStore = create<ForwardStoreState>((set, get) => ({
  rules: storage.load<PortForward[]>(KEY, []),
  runtime: {},

  addRule: (data) => {
    const rule: PortForward = { ...data, id: data.id || uid() } as PortForward;
    const rules = [...get().rules, rule];
    persist(rules);
    set({ rules });
    return rule;
  },

  updateRule: (id, patch) => {
    const rules = get().rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
    persist(rules);
    set({ rules });
  },

  removeRule: (id) => {
    const rules = get().rules.filter((r) => r.id !== id);
    persist(rules);
    const runtime = { ...get().runtime };
    delete runtime[id];
    set({ rules, runtime });
  },

  rulesOf: (serverId) => get().rules.filter((r) => r.serverId === serverId),

  applyRuntime: (rt) => {
    const runtime = { ...get().runtime };
    if (!rt.active && !rt.error) {
      delete runtime[rt.id];
    } else {
      runtime[rt.id] = rt;
    }
    set({ runtime });
  },

  syncRuntime: async () => {
    try {
      const list = await invoke<ForwardRuntime[]>("forward_list");
      const runtime: Record<string, ForwardRuntime> = {};
      for (const rt of list) runtime[rt.id] = rt;
      set({ runtime });
    } catch {
      /* 后端未就绪时忽略 */
    }
  },

  start: async (rule, server) => {
    const rt = await invoke<ForwardRuntime>("forward_start", {
      server,
      config: toConfig(rule),
    });
    // 后端可能回填了服务端分配的端口（remote + bindPort=0）
    if (rt.config.bindPort && rt.config.bindPort !== rule.bindPort) {
      get().updateRule(rule.id, { bindPort: rt.config.bindPort });
    }
    set({ runtime: { ...get().runtime, [rt.id]: rt } });
  },

  stop: async (id) => {
    await invoke("forward_stop", { id });
    const runtime = { ...get().runtime };
    delete runtime[id];
    set({ runtime });
  },

  stopAll: async (serverId?: string) => {
    await invoke("forward_stop_all", { serverId: serverId ?? null });
    if (!serverId) {
      set({ runtime: {} });
      return;
    }
    const runtime = { ...get().runtime };
    for (const [id, rt] of Object.entries(runtime)) {
      if (rt.serverId === serverId) delete runtime[id];
    }
    set({ runtime });
  },
}));
