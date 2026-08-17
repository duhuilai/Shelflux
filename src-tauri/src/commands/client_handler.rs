// 共享的 SSH 客户端逻辑：事件处理器、主机指纹校验、私钥解析、连接与认证

use std::io::Write;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use russh::client::{self, Handler, Session};
use russh::{Channel, ChannelId};
use russh_keys::key::KeyPair;
use tokio::sync::mpsc;

use crate::commands::known_hosts;
use crate::commands::proxy;
use crate::error::AppError;
use crate::types::ServerConfig;

/// 主机密钥校验结果
#[derive(Debug, Clone)]
pub struct HostKeyOutcome {
    pub key_type: String,
    /// SHA256:<base64>
    pub fingerprint: String,
    /// "new" | "match" | "mismatch"
    pub verdict: &'static str,
    pub known_fingerprint: Option<String>,
}

/// 服务端主动打开的远程转发通道
pub struct ForwardedChannel {
    pub channel: Channel<client::Msg>,
    pub connected_address: String,
    pub connected_port: u32,
    pub originator_address: String,
    pub originator_port: u32,
}

/// 客户端事件处理器。
///
/// 主机密钥采用 TOFU 策略校验（见 `known_hosts` 模块）：首次连接自动记录，
/// 之后指纹必须一致，否则拒绝连接。
pub struct ClientHandler {
    host: String,
    port: u16,
    outcome: Arc<StdMutex<Option<HostKeyOutcome>>>,
    forwarded_tx: Option<mpsc::UnboundedSender<ForwardedChannel>>,
}

impl ClientHandler {
    pub fn new(host: &str, port: u16, outcome: Arc<StdMutex<Option<HostKeyOutcome>>>) -> Self {
        Self {
            host: host.to_string(),
            port,
            outcome,
            forwarded_tx: None,
        }
    }

    pub fn with_forwarded(mut self, tx: mpsc::UnboundedSender<ForwardedChannel>) -> Self {
        self.forwarded_tx = Some(tx);
        self
    }
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let key_type = server_public_key.name().to_string();
        let fingerprint = format!("SHA256:{}", server_public_key.fingerprint());

        let (verdict, known_fp, accept) = match known_hosts::lookup(&self.host, self.port) {
            None => {
                // TOFU：首次见到该主机，记录并放行
                known_hosts::upsert(&self.host, self.port, &key_type, &fingerprint);
                ("new", None, true)
            }
            Some(entry) if entry.fingerprint == fingerprint => ("match", Some(entry.fingerprint), true),
            Some(entry) => ("mismatch", Some(entry.fingerprint), false),
        };

        if let Ok(mut slot) = self.outcome.lock() {
            *slot = Some(HostKeyOutcome {
                key_type,
                fingerprint,
                verdict,
                known_fingerprint: known_fp,
            });
        }
        Ok(accept)
    }

    /// 远程端口转发：服务端主动开的通道转交给转发任务
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(tx) = &self.forwarded_tx {
            let _ = tx.send(ForwardedChannel {
                channel,
                connected_address: connected_address.to_string(),
                connected_port,
                originator_address: originator_address.to_string(),
                originator_port,
            });
        }
        Ok(())
    }

    fn server_channel_handle_unknown(&self, _channel: ChannelId, _channel_type: &[u8]) -> bool {
        false
    }
}

/// 解析私钥文本（OpenSSH / PKCS8 等格式），可选口令解锁。
///
/// russh-keys 的 `load_secret_key` 仅接受文件路径，因此先把文本写入临时文件再加载。
pub fn parse_private_key(private_key: &str, passphrase: &str) -> Result<KeyPair, AppError> {
    let dir = std::env::temp_dir();
    let fname = format!("shelflux_key_{}.pem", uuid::Uuid::new_v4());
    let path = dir.join(fname);
    {
        let mut f = std::fs::File::create(&path).map_err(AppError::Io)?;
        f.write_all(private_key.as_bytes()).map_err(AppError::Io)?;
    }
    let secret = if passphrase.is_empty() {
        None
    } else {
        Some(passphrase)
    };
    let res = russh_keys::load_secret_key(&path, secret);
    let _ = std::fs::remove_file(&path);
    res.map_err(|e| AppError::Ssh(format!("私钥解析失败: {e}")))
}

/// 建立 SSH 连接并完成认证，返回可用作开 channel 的句柄。
pub async fn connect_session(
    server: &ServerConfig,
    key_pair: Option<Arc<KeyPair>>,
) -> Result<client::Handle<ClientHandler>, AppError> {
    connect_session_inner(server, key_pair, None).await
}

/// 同上，但额外接收服务端主动开的远程转发通道
pub async fn connect_session_with_forwarding(
    server: &ServerConfig,
    key_pair: Option<Arc<KeyPair>>,
    forwarded_tx: mpsc::UnboundedSender<ForwardedChannel>,
) -> Result<client::Handle<ClientHandler>, AppError> {
    connect_session_inner(server, key_pair, Some(forwarded_tx)).await
}

/// 测试连接结果（返回给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    /// 是否连接并认证成功
    pub success: bool,
    /// 可读结果说明
    pub message: String,
    /// SSH/SFTP 成功时附带的主机指纹（SHA256:base64），便于用户核对
    pub fingerprint: Option<String>,
}

/// 测试服务器连通性。
///
/// - SSH / SFTP：建立连接、完成主机密钥校验与认证，等价于一次真实连接（不写入连接池，
///   结束后立即关闭该测试连接）。主机指纹（如首次信任）仍会按 TOFU 策略记入 known_hosts，
///   与正式连接行为一致。
/// - Telnet / Rlogin：仅测试底层 TCP 可达（含代理），因这两种协议无认证阶段。
#[tauri::command]
pub async fn test_connection(server: ServerConfig) -> Result<TestConnectionResult, AppError> {
    match server.protocol.as_str() {
        "telnet" | "rlogin" => {
            // 仅验证 TCP 可达（含代理）
            let _stream = proxy::connect_tcp(&server).await?;
            Ok(TestConnectionResult {
                success: true,
                message: format!("TCP 已连通 {}:{}", server.host, server.effective_port()),
                fingerprint: None,
            })
        }
        "ssh" | "sftp" | _ => {
            // 解析私钥（如有）
            let key_pair = if !server.private_key.is_empty() {
                Some(Arc::new(parse_private_key(&server.private_key, &server.passphrase)?))
            } else {
                None
            };
            // 完整连接 + 认证
            let handle = connect_session(&server, key_pair).await?;
            // 读取本次校验到的主机指纹（TOFU 已写入 known_hosts）
            let fingerprint =
                known_hosts::lookup(&server.host, server.effective_port()).map(|e| e.fingerprint);
            // 关闭测试连接（不进入连接池）
            drop(handle);
            Ok(TestConnectionResult {
                success: true,
                message: format!("已连接并认证成功 {}:{}", server.host, server.effective_port()),
                fingerprint,
            })
        }
    }
}

/// 从连接池获取或新建 SSH 连接句柄。
/// Shell 和 SFTP 共用同一池，避免对同一服务器重复建连（TCP + 密钥交换 + 认证）。
///
/// 返回 `Arc<Mutex<Handle>>` 因为 SSH 连接需要在多个 channel 间共享，
/// 每次使用时 lock 获取独占访问来开 channel。
pub async fn get_or_create_ssh_handle(
    app: &tauri::AppHandle,
    server: &ServerConfig,
    key_pair: Option<Arc<KeyPair>>,
) -> Result<Arc<tokio::sync::Mutex<client::Handle<ClientHandler>>>, AppError> {
    use tauri::Manager;
    use crate::state::AppState;

    let state = app.state::<AppState>();

    // 先查池
    {
        let pool = state.ssh_pool.lock().await;
        if let Some(handle) = pool.get(&server.id) {
            // 验证连接仍然有效
            let h = handle.lock().await;
            if !h.is_closed() {
                return Ok(handle.clone());
            }
        }
    }
    // 池中没有或已失效，新建
    let handle = connect_session(server, key_pair).await?;
    let wrapped = Arc::new(tokio::sync::Mutex::new(handle));

    // 存入池
    let mut pool = state.ssh_pool.lock().await;
    pool.insert(server.id.clone(), wrapped.clone());
    drop(pool);

    Ok(wrapped)
}

async fn connect_session_inner(
    server: &ServerConfig,
    key_pair: Option<Arc<KeyPair>>,
    forwarded_tx: Option<mpsc::UnboundedSender<ForwardedChannel>>,
) -> Result<client::Handle<ClientHandler>, AppError> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(15)),
        ..Default::default()
    });

    // 通过代理（如已配置）或直连建立底层 TCP
    let stream = proxy::connect_tcp(server).await?;
    let _ = stream.set_nodelay(true);

    let outcome: Arc<StdMutex<Option<HostKeyOutcome>>> = Arc::new(StdMutex::new(None));
    let mut handler = ClientHandler::new(&server.host, server.effective_port(), outcome.clone());
    if let Some(tx) = forwarded_tx {
        handler = handler.with_forwarded(tx);
    }

    let mut handle = match client::connect_stream(config, stream, handler).await {
        Ok(h) => h,
        Err(e) => {
            // 若失败原因是指纹不匹配，给出可操作的提示
            if let Ok(slot) = outcome.lock() {
                if let Some(o) = slot.as_ref() {
                    if o.verdict == "mismatch" {
                        return Err(AppError::Ssh(format!(
                            "主机密钥已变更，连接已中止！\r\n\
                             主机: {}:{}\r\n\
                             已记录: {}\r\n\
                             本次收到: {} ({})\r\n\
                             如确认服务器确实更换了密钥，请在「设置 → 安全」中删除该主机记录后重连。",
                            server.host,
                            server.effective_port(),
                            o.known_fingerprint.as_deref().unwrap_or("-"),
                            o.fingerprint,
                            o.key_type
                        )));
                    }
                }
            }
            return Err(AppError::Ssh(format!("连接失败: {e}")));
        }
    };

    let auth = if let Some(kp) = key_pair {
        handle
            .authenticate_publickey(server.username.as_str(), kp)
            .await
    } else if !server.password.is_empty() {
        handle
            .authenticate_password(server.username.as_str(), server.password.as_str())
            .await
    } else {
        return Err(AppError::Ssh("未提供密码或私钥".into()));
    };

    match auth {
        Ok(true) => Ok(handle),
        Ok(false) => Err(AppError::Ssh("认证被服务器拒绝".into())),
        Err(e) => Err(AppError::Ssh(format!("认证失败: {e}"))),
    }
}
