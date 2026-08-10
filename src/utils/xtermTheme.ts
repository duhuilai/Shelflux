// 根据应用主题 + 终端设置生成 xterm 配色
import type { ITheme } from "@xterm/xterm";
import type { TerminalSettings } from "../types";

const DARK_ANSI = {
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

const LIGHT_ANSI = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

/** 暗色默认前景 -> 亮色下的等价色 */
const FG_DARK_TO_LIGHT: Record<string, string> = {
  "#e6e8ef": "#24292f",
  "#9aa1b5": "#57606a",
  "#e0af68": "#7d4e00",
  "#9ece6a": "#116329",
};

/** 亮色下光标色映射（保证在白底上可见） */
const CURSOR_DARK_TO_LIGHT: Record<string, string> = {
  "#7aa2f7": "#0969da",
  "#bb9af7": "#8250df",
  "#7dcfff": "#1b7c83",
  "#f7768e": "#cf222e",
  "#9ece6a": "#116329",
  "#e0af68": "#7d4e00",
  "#e6e8ef": "#24292f",
  "#9aa1b5": "#57606a",
};

export function buildXtermTheme(
  mode: "dark" | "light",
  ts: TerminalSettings
): ITheme {
  const transparent = ts.background === "transparent";
  if (mode === "light") {
    return {
      background: transparent ? "#00000000" : ts.background,
      foreground: FG_DARK_TO_LIGHT[ts.foreground] || ts.foreground,
      cursor: CURSOR_DARK_TO_LIGHT[ts.cursorColor] || ts.cursorColor,
      cursorAccent: transparent ? "#ffffff" : ts.background,
      selectionBackground: "rgba(59, 111, 212, 0.28)",
      ...LIGHT_ANSI,
    };
  }
  return {
    background: transparent ? "#00000000" : ts.background,
    foreground: ts.foreground,
    cursor: ts.cursorColor,
    cursorAccent: transparent ? "#0e1118" : ts.background,
    selectionBackground: "rgba(122, 162, 247, 0.35)",
    ...DARK_ANSI,
  };
}
