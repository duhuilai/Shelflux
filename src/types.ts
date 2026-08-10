// 共享类型定义（与 Rust 端 types.rs 保持一致）

export type Protocol = "ssh" | "sftp" | "telnet" | "rlogin";

export type ProxyKind = "none" | "http" | "socks5";

export interface ProxyConfig {
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export const DEFAULT_PROXY: ProxyConfig = {
  kind: "none",
  host: "",
  port: 1080,
};

export interface Server {
  id: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  alias?: string;
  defaultRemotePath?: string;
  defaultLocalPath?: string;
  groupId?: string | null; // null = 顶层（未分组）
  proxy?: ProxyConfig;
}

/* ---------------- 主机指纹 ---------------- */

export interface KnownHostEntry {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string; // SHA256:base64
  addedAt: number; // unix 秒
}

export type HostKeyVerdict = "trusted" | "unknown" | "mismatch";

export interface HostKeyCheck {
  verdict: HostKeyVerdict;
  keyType: string;
  fingerprint: string;
  knownFingerprint?: string;
}

/* ---------------- 端口转发 ---------------- */

export type ForwardKind = "local" | "remote" | "dynamic";

/** 传给后端的转发配置（与 Rust PortForwardConfig 一一对应） */
export interface PortForwardConfig {
  id: string;
  name: string;
  kind: ForwardKind;
  /** local/dynamic 为本机监听地址；remote 为服务端监听地址 */
  bindAddr: string;
  bindPort: number;
  /** dynamic 时忽略 */
  destHost: string;
  /** dynamic 时忽略 */
  destPort: number;
}

/** 前端保存的规则 = 后端配置 + 所属服务器 */
export type PortForward = PortForwardConfig & { serverId: string };

export interface ForwardRuntime {
  id: string;
  serverId: string;
  config: PortForwardConfig;
  active: boolean;
  connections: number;
  error?: string;
}

export const DEFAULT_FORWARD: Omit<PortForward, "id" | "serverId"> = {
  name: "",
  kind: "local",
  bindAddr: "127.0.0.1",
  bindPort: 8080,
  destHost: "127.0.0.1",
  destPort: 80,
};

export interface ServerGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export type FileKind = "file" | "dir" | "symlink";

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  modified?: number;
  permissions?: number;
  isSymlink: boolean;
}

export interface TransferProgress {
  taskId: string;
  transferred: number;
  total: number;
  speed: number;
  status: "running" | "done" | "error" | "cancelled";
  message?: string;
}

export type TabKind = "sftp" | "ssh" | "telnet" | "rlogin";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  server: Server;
  sessionId?: string; // 后端返回的 SSH 会话 id
}

export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  foreground: string;
  background: string;
  cursorColor: string;
  cursorBlink: boolean;
}

export type ThemeMode = "dark" | "light" | "system";

export interface AppSettings {
  theme: ThemeMode;
  terminal: TerminalSettings;
  defaultApps: Record<string, string>; // 后缀 -> 应用路径
  transfers: {
    confirmOverwrite: boolean;
  };
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSize: 14,
  fontFamily:
    '"JetBrains Mono", "Cascadia Code", "SF Mono", "Consolas", "Microsoft YaHei Mono", monospace',
  foreground: "#e6e8ef",
  background: "transparent",
  cursorColor: "#7aa2f7",
  cursorBlink: true,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "dark",
  terminal: DEFAULT_TERMINAL_SETTINGS,
  defaultApps: {},
  transfers: {
    confirmOverwrite: true,
  },
};
