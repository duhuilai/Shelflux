use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

use crate::types::ServerConfig;

/// 内部 SSH Shell 句柄（不导出到前端）
pub struct ShellHandle {
    /// 用于向读写任务发送命令的通道
    pub cmd_tx: tokio::sync::mpsc::UnboundedSender<ShellCommand>,
    /// 任务句柄
    pub join: Option<tokio::task::JoinHandle<()>>,
    /// 元数据
    pub server: ServerConfig,
}

#[derive(Debug, Clone)]
pub enum ShellCommand {
    Write(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    Close,
}

/// SFTP 会话句柄
#[derive(Clone)]
pub struct SftpHandle {
    pub session: Arc<Mutex<russh_sftp::client::SftpSession>>,
    pub server: ServerConfig,
    /// 上次健康检查时间，用于缓存探测结果，避免每次操作都探测
    pub last_check: Instant,
    /// 上次实际使用时间（连接池空闲 TTL 回收判定依据，不随健康检查刷新）
    pub last_used: Instant,
}

/// 原始 SSH 连接句柄池（key = server.id）
/// 用于在 Shell 和 SFTP 之间复用同一 TCP/SSH 连接，避免重复建连
// 注意：池存储 Arc<Mutex<Handle>> 而非直接存 Handle，因为 russh::client::Handle 不实现 Clone
// 每次使用时 lock 获取独占访问来开 channel

#[derive(Default)]
pub struct AppState {
    pub shells: Arc<Mutex<HashMap<String, ShellHandle>>>,
    /// 活跃的端口转发规则（key = 规则 id）
    pub forwards: Arc<Mutex<HashMap<String, crate::commands::forward::ForwardHandle>>>,
    /// SFTP 会话池（key = server.id）
    pub sftp_sessions: Arc<Mutex<HashMap<String, SftpHandle>>>,
    /// SSH 原始连接池（key = server.id），Shell 和 SFTP 复用
    pub ssh_pool: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<russh::client::Handle<crate::commands::client_handler::ClientHandler>>>>>>,
    /// 已请求取消的传输任务集合（key = task_id），IO 循环内轮询判定
    pub cancelled_transfers: Arc<Mutex<HashSet<String>>>,
}
