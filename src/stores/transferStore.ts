// 全局传输队列（跨 SFTP 标签页共享）
// 解决原 SftpView 局部 useState 的缺陷：切标签卸载后监听器泄漏 + 幽灵传输、
// 命令 Err 失败项不自动移除。
import { create } from "zustand";
import type { TransferItem } from "../types";

interface TransferStoreState {
  transfers: TransferItem[];
  add: (t: TransferItem) => void;
  update: (id: string, patch: Partial<TransferItem>) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useTransferStore = create<TransferStoreState>((set) => ({
  transfers: [],
  add: (t) => set((s) => ({ transfers: [...s.transfers, t] })),
  update: (id, patch) =>
    set((s) => ({
      transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  remove: (id) =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),
  clear: () => set({ transfers: [] }),
}));
