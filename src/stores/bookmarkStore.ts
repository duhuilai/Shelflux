// 书签：按服务器分组持久化到 localStorage（纯前端，无需后端命令）
import { create } from "zustand";
import { load, save } from "../utils/storage";
import { uid } from "../utils/format";

export interface Bookmark {
  id: string;
  name: string;
  side: "local" | "remote";
  path: string;
}

interface BookmarkState {
  byServer: Record<string, Bookmark[]>;
  add: (serverId: string, bm: Omit<Bookmark, "id">) => void;
  remove: (serverId: string, id: string) => void;
}

const STORAGE_KEY = "bookmarks";
const initial = load<Record<string, Bookmark[]>>(STORAGE_KEY, {});

export const useBookmarkStore = create<BookmarkState>((set) => ({
  byServer: initial,
  add: (serverId, bm) =>
    set((state) => {
      const arr = state.byServer[serverId] || [];
      const next = [...arr, { ...bm, id: uid() }];
      const byServer = { ...state.byServer, [serverId]: next };
      save(STORAGE_KEY, byServer);
      return { byServer };
    }),
  remove: (serverId, id) =>
    set((state) => {
      const arr = state.byServer[serverId] || [];
      const next = arr.filter((b) => b.id !== id);
      const byServer = { ...state.byServer, [serverId]: next };
      save(STORAGE_KEY, byServer);
      return { byServer };
    }),
}));

const EMPTY: Bookmark[] = [];
/** 订阅某服务器的书签列表（未定义时返回稳定空数组引用，避免无意义重渲染） */
export function useBookmarks(serverId: string): Bookmark[] {
  return useBookmarkStore((s) => s.byServer[serverId] || EMPTY);
}
