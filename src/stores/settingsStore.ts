// 应用设置
import { create } from "zustand";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../types";
import * as storage from "../utils/storage";

interface SettingsStoreState {
  settings: AppSettings;
  /** 解析后的实际主题（system 会被解析成 dark/light） */
  effectiveTheme: "dark" | "light";
  setSettings: (patch: Partial<AppSettings>) => void;
  /** 删除某个扩展名的默认打开程序（合并式 setSettings 无法删除键，故单独提供） */
  removeDefaultApp: (ext: string) => void;
  setEffectiveTheme: (t: "dark" | "light") => void;
  reset: () => void;
}

const persisted = storage.load<AppSettings>("settings", DEFAULT_APP_SETTINGS);
const merged: AppSettings = {
  ...DEFAULT_APP_SETTINGS,
  ...persisted,
  theme: persisted.theme || DEFAULT_APP_SETTINGS.theme,
  terminal: { ...DEFAULT_APP_SETTINGS.terminal, ...(persisted.terminal || {}) },
  transfers: {
    ...DEFAULT_APP_SETTINGS.transfers,
    ...(persisted.transfers || {}),
  },
  defaultApps: { ...(persisted.defaultApps || {}) },
};

export function resolveTheme(mode: AppSettings["theme"]): "dark" | "light" {
  if (mode === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    }
    return "dark";
  }
  return mode;
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  settings: merged,
  effectiveTheme: resolveTheme(merged.theme),

  setSettings: (patch) => {
    const next: AppSettings = {
      ...get().settings,
      ...patch,
      terminal: { ...get().settings.terminal, ...(patch.terminal || {}) },
      transfers: { ...get().settings.transfers, ...(patch.transfers || {}) },
      defaultApps: { ...get().settings.defaultApps, ...(patch.defaultApps || {}) },
    };
    set({ settings: next, effectiveTheme: resolveTheme(next.theme) });
    storage.save("settings", next);
  },

  setEffectiveTheme: (t) => set({ effectiveTheme: t }),

  removeDefaultApp: (ext) => {
    const next = { ...get().settings.defaultApps };
    delete next[ext];
    const updated: AppSettings = { ...get().settings, defaultApps: next };
    set({ settings: updated, effectiveTheme: resolveTheme(updated.theme) });
    storage.save("settings", updated);
  },

  reset: () => {
    set({
      settings: DEFAULT_APP_SETTINGS,
      effectiveTheme: resolveTheme(DEFAULT_APP_SETTINGS.theme),
    });
    storage.save("settings", DEFAULT_APP_SETTINGS);
  },
}));
