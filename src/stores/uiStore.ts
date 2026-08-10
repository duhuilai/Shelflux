// UI 状态管理（弹窗、确认对话框等）
import { create } from "zustand";
import type { Server, ServerGroup } from "../types";

interface ServerFormState {
  open: boolean;
  // 编辑模式
  editing: Server | null;
  // 预设的分组（创建后定位到该分组）
  groupId?: string | null;
}

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  resolve?: (v: boolean) => void;
}

interface UiStoreState {
  serverForm: ServerFormState;
  serverPickerOpen: boolean;
  settingsOpen: boolean;
  forwardPanelOpen: boolean;
  confirm: ConfirmState;

  openServerForm: (editing?: Server, groupId?: string | null) => void;
  closeServerForm: () => void;
  openServerPicker: () => void;
  closeServerPicker: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openForwardPanel: () => void;
  closeForwardPanel: () => void;
  askConfirm: (opts: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  resolveConfirm: (v: boolean) => void;
}

export const useUiStore = create<UiStoreState>((set, get) => ({
  serverForm: { open: false, editing: null },
  serverPickerOpen: false,
  settingsOpen: false,
  forwardPanelOpen: false,
  confirm: { open: false, title: "", message: "" },

  openServerForm: (editing, groupId) =>
    set({
      serverForm: { open: true, editing: editing || null, groupId },
    }),

  closeServerForm: () =>
    set({ serverForm: { open: false, editing: null } }),

  openServerPicker: () => set({ serverPickerOpen: true }),
  closeServerPicker: () => set({ serverPickerOpen: false }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openForwardPanel: () => set({ forwardPanelOpen: true }),
  closeForwardPanel: () => set({ forwardPanelOpen: false }),

  askConfirm: (opts) => {
    return new Promise<boolean>((resolve) => {
      set({
        confirm: {
          open: true,
          title: opts.title,
          message: opts.message,
          confirmText: opts.confirmText || "确定",
          cancelText: opts.cancelText || "取消",
          danger: opts.danger,
          resolve,
        },
      });
    });
  },

  resolveConfirm: (v) => {
    const r = get().confirm.resolve;
    set({
      confirm: { open: false, title: "", message: "" },
    });
    r?.(v);
  },
}));
