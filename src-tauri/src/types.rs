use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 代理类型: none / http / socks5
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    #[serde(default = "proxy_kind_none")]
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

fn proxy_kind_none() -> String {
    "none".to_string()
}

impl ProxyConfig {
    pub fn is_enabled(&self) -> bool {
        matches!(self.kind.as_str(), "http" | "socks5") && !self.host.is_empty() && self.port != 0
    }
}

/// 注意：必须使用 camelCase，前端 `Server` 对象直接以 JSON 传入
/// （privateKey / defaultRemotePath ...）。缺少此属性会导致私钥、默认路径
/// 等字段静默丢失。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// 服务器 ID（前端生成）
    pub id: String,
    /// 协议: ssh / sftp / telnet / rlogin
    pub protocol: String,
    /// 主机
    pub host: String,
    /// 端口（缺省按协议默认）
    pub port: u16,
    /// 用户名
    pub username: String,
    /// 密码
    #[serde(default)]
    pub password: String,
    /// 私钥（OpenSSH 格式 PEM 文本）
    #[serde(default)]
    pub private_key: String,
    /// 私钥口令
    #[serde(default)]
    pub passphrase: String,
    /// 别名
    #[serde(default)]
    pub alias: String,
    /// 默认打开的路径（SFTP 远端）
    #[serde(default)]
    pub default_remote_path: String,
    /// 默认打开的路径（本地）
    #[serde(default)]
    pub default_local_path: String,
    /// 代理设置（可选）
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
}

impl ServerConfig {
    pub fn effective_port(&self) -> u16 {
        if self.port == 0 {
            match self.protocol.as_str() {
                "ssh" => 22,
                "sftp" => 22,
                "telnet" => 23,
                "rlogin" => 513,
                _ => 22,
            }
        } else {
            self.port
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// "file" | "dir" | "symlink"
    pub kind: String,
    pub size: u64,
    pub modified: Option<i64>,
    pub permissions: Option<u32>,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub task_id: String,
    pub transferred: u64,
    pub total: u64,
    pub speed: u64,
    pub status: String, // "running" | "done" | "error" | "cancelled"
    pub message: Option<String>,
}

impl TransferProgress {
    pub fn percent(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            (self.transferred as f64 / self.total as f64) * 100.0
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub data_dir: PathBuf,
    pub home_dir: Option<PathBuf>,
}

/// "打开方式"对话框里的一个可选程序
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithApp {
    /// 显示名（如 "Notepad"）
    pub name: String,
    /// 可执行文件完整路径（如 "C:\\Windows\\System32\\notepad.exe"）
    pub path: String,
}

/// 一条 known_hosts 记录
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    /// 密钥类型，如 ssh-ed25519 / rsa-sha2-256
    pub key_type: String,
    /// SHA256:<base64>
    pub fingerprint: String,
    /// 首次信任时间（unix 秒）
    #[serde(default)]
    pub added_at: i64,
}

/// 端口转发配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// local | remote | dynamic
    pub kind: String,
    /// 监听地址（local/dynamic 为本机地址，remote 为服务端地址）
    #[serde(default = "default_bind_addr")]
    pub bind_addr: String,
    pub bind_port: u16,
    /// dynamic 时忽略
    #[serde(default)]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
}

fn default_bind_addr() -> String {
    "127.0.0.1".to_string()
}

/// 端口转发运行态（推送给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRuntime {
    pub id: String,
    pub server_id: String,
    pub config: PortForwardConfig,
    pub active: bool,
    pub connections: u32,
    pub error: Option<String>,
}
