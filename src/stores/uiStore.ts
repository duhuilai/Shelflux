// UI 状态管理（弹窗、确认对话框等）
import { create } from "zustand";
import type { Server, ServerGroup, FileEntry } from "../types";

/** 文件复制粘贴剪贴板（应用内） */
export interface ClipboardState {
  side: "local" | "remote";
  server: Server | null; // 远端复制需要连接信息
  items: FileEntry[];
}

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

interface PromptState {
  open: boolean;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  resolve?: (v: string | null) => void;
}

export type OverwriteChoice = "overwrite" | "rename" | "skip";

interface OverwriteState {
  open: boolean;
  title: string;
  message: string;
  resolve?: (v: OverwriteChoice) => void;
}

interface UiStoreState {
  serverForm: ServerFormState;
  serverPickerOpen: boolean;
  settingsOpen: boolean;
  forwardPanelOpen: boolean;
  confirm: ConfirmState;
  prompt: PromptState;
  overwrite: OverwriteState;
  clipboard: ClipboardState | null;

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
  askPrompt: (opts: {
    title: string;
    message?: string;
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<string | null>;
  resolvePrompt: (v: string | null) => void;
  askOverwrite: (opts: { title: string; message: string }) => Promise<OverwriteChoice>;
  resolveOverwrite: (v: OverwriteChoice) => void;
  setClipboard: (c: ClipboardState | null) => void;
}

export const useUiStore = create<UiStoreState>((set, get) => ({
  serverForm: { open: false, editing: null },
  serverPickerOpen: false,
  settingsOpen: false,
  forwardPanelOpen: false,
  confirm: { open: false, title: "", message: "" },
  prompt: { open: false, title: "" },
  overwrite: { open: false, title: "", message: "" },
  clipboard: null,

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

  askPrompt: (opts) => {
    return new Promise<string | null>((resolve) => {
      set({
        prompt: {
          open: true,
          title: opts.title,
          message: opts.message,
          defaultValue: opts.defaultValue || "",
          placeholder: opts.placeholder,
          confirmText: opts.confirmText || "确定",
          cancelText: opts.cancelText || "取消",
          resolve,
        },
      });
    });
  },

  resolvePrompt: (v) => {
    const r = get().prompt.resolve;
    set({ prompt: { open: false, title: "" } });
    r?.(v);
  },

  askOverwrite: (opts) => {
    return new Promise<OverwriteChoice>((resolve) => {
      set({
        overwrite: {
          open: true,
          title: opts.title,
          message: opts.message,
          resolve,
        },
      });
    });
  },

  resolveOverwrite: (v) => {
    const r = get().overwrite.resolve;
    set({ overwrite: { open: false, title: "", message: "" } });
    r?.(v);
  },

  setClipboard: (c) => set({ clipboard: c }),
}));
