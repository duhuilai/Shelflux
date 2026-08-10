// 轻量级 Toast 通知
import { create } from "zustand";
import { uid } from "../utils/format";

export type ToastKind = "info" | "success" | "error" | "warn";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  duration?: number; // ms, 0 = 不自动关闭
}

interface ToastStoreState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => string;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastStoreState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = uid();
    const t: Toast = { id, duration: 4000, ...toast };
    set({ toasts: [...get().toasts, t] });
    if (t.duration && t.duration > 0) {
      setTimeout(() => {
        get().remove(id);
      }, t.duration);
    }
    return id;
  },
  remove: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: "info", title, message }),
  success: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: "success", title, message }),
  error: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: "error", title, message }),
  warn: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: "warn", title, message }),
};
