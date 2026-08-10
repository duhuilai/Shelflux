// SSH 端口转发
//
// 支持三种模式：
//   local   本地转发  ssh -L  bind_addr:bind_port -> dest_host:dest_port（经服务端出网）
//   remote  远程转发  ssh -R  服务端 bind_addr:bind_port -> 本机可达的 dest_host:dest_port
//   dynamic 动态转发  ssh -D  在本地起一个 SOCKS5 代理，流量经服务端出网
//
// 每条规则独占一个 SSH 会话，便于单独启停；运行态通过 `forward-status`
// 事件推送给前端。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};

use crate::commands::client_handler::{
    connect_session, connect_session_with_forwarding, parse_private_key, ClientHandler,
};
use crate::error::AppError;
use crate::state::AppState;
use crate::types::{ForwardRuntime, PortForwardConfig, ServerConfig};

pub struct ForwardHandle {
    pub server_id: String,
    pub config: PortForwardConfig,
    pub conns: Arc<AtomicU32>,
    pub stop: Arc<Notify>,
    pub join: tokio::task::JoinHandle<()>,
}

fn runtime_of(h: &ForwardHandle, active: bool, error: Option<String>) -> ForwardRuntime {
    ForwardRuntime {
        id: h.config.id.clone(),
        server_id: h.server_id.clone(),
        config: h.config.clone(),
        active,
        connections: h.conns.load(Ordering::Relaxed),
        error,
    }
}

fn emit_status(app: &AppHandle, rt: &ForwardRuntime) {
    let _ = app.emit("forward-status", rt.clone());
}

fn emit_simple(
    app: &AppHandle,
    id: &str,
    server_id: &str,
    config: &PortForwardConfig,
    active: bool,
    conns: u32,
    error: Option<String>,
) {
    let _ = app.emit(
        "forward-status",
        ForwardRuntime {
            id: id.to_string(),
            server_id: server_id.to_string(),
            config: config.clone(),
            active,
            connections: conns,
            error,
        },
    );
}

async fn build_key(server: &ServerConfig) -> Result<Option<Arc<russh_keys::key::KeyPair>>, AppError> {
    if server.private_key.is_empty() {
        return Ok(None);
    }
    Ok(Some(Arc::new(parse_private_key(
        &server.private_key,
        &server.passphrase,
    )?)))
}

/// 启动一条转发规则
#[tauri::command]
pub async fn forward_start(
    app: AppHandle,
    state: State<'_, AppState>,
    server: ServerConfig,
    config: PortForwardConfig,
) -> Result<ForwardRuntime, AppError> {
    if !matches!(server.protocol.as_str(), "ssh" | "sftp") {
        return Err(AppError::Protocol("仅 SSH/SFTP 连接支持端口转发".into()));
    }
    let mut cfg = config;
    if cfg.id.is_empty() {
        cfg.id = uuid::Uuid::new_v4().to_string();
    }
    if cfg.bind_addr.is_empty() {
        cfg.bind_addr = "127.0.0.1".to_string();
    }

    // 已存在同 id 的规则先停掉
    {
        let mut map = state.forwards.lock().await;
        if let Some(h) = map.remove(&cfg.id) {
            h.stop.notify_waiters();
            h.join.abort();
        }
    }

    let conns = Arc::new(AtomicU32::new(0));
    let stop = Arc::new(Notify::new());
    let key = build_key(&server).await?;

    let join = match cfg.kind.as_str() {
        "local" | "dynamic" => {
            if cfg.kind == "local" && (cfg.dest_host.is_empty() || cfg.dest_port == 0) {
                return Err(AppError::Other("本地转发必须指定目标主机与端口".into()));
            }
            // 先绑定，端口冲突可以立即反馈给用户
            let listener = TcpListener::bind((cfg.bind_addr.as_str(), cfg.bind_port))
                .await
                .map_err(|e| {
                    AppError::Other(format!(
                        "监听 {}:{} 失败: {e}",
                        cfg.bind_addr, cfg.bind_port
                    ))
                })?;
            let handle = Arc::new(connect_session(&server, key).await?);

            let app2 = app.clone();
            let cfg2 = cfg.clone();
            let sid = server.id.clone();
            let conns2 = conns.clone();
            let stop2 = stop.clone();
            tokio::spawn(async move {
                run_listener(app2, handle, listener, cfg2, sid, conns2, stop2).await;
            })
        }
        "remote" => {
            if cfg.dest_host.is_empty() || cfg.dest_port == 0 {
                return Err(AppError::Other("远程转发必须指定回连的目标主机与端口".into()));
            }
            let (tx, rx) = mpsc::unbounded_channel();
            let mut handle = connect_session_with_forwarding(&server, key, tx).await?;
            let bound = handle
                .tcpip_forward(cfg.bind_addr.clone(), cfg.bind_port as u32)
                .await
                .map_err(|e| {
                    AppError::Ssh(format!(
                        "服务端拒绝监听 {}:{}（可能需要 GatewayPorts 或端口被占用）: {e}",
                        cfg.bind_addr, cfg.bind_port
                    ))
                })?;
            if cfg.bind_port == 0 && bound != 0 {
                cfg.bind_port = bound as u16;
            }
            let handle = Arc::new(handle);

            let app2 = app.clone();
            let cfg2 = cfg.clone();
            let sid = server.id.clone();
            let conns2 = conns.clone();
            let stop2 = stop.clone();
            tokio::spawn(async move {
                run_remote(app2, handle, rx, cfg2, sid, conns2, stop2).await;
            })
        }
        other => return Err(AppError::Other(format!("未知的转发类型: {other}"))),
    };

    let h = ForwardHandle {
        server_id: server.id.clone(),
        config: cfg.clone(),
        conns,
        stop,
        join,
    };
    let rt = runtime_of(&h, true, None);
    state.forwards.lock().await.insert(cfg.id.clone(), h);
    emit_status(&app, &rt);
    Ok(rt)
}

/// 停止一条转发规则
#[tauri::command]
pub async fn forward_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let mut map = state.forwards.lock().await;
    if let Some(h) = map.remove(&id) {
        h.stop.notify_waiters();
        h.join.abort();
        emit_simple(&app, &id, &h.server_id, &h.config, false, 0, None);
    }
    Ok(())
}

/// 列出全部转发规则的运行态
#[tauri::command]
pub async fn forward_list(state: State<'_, AppState>) -> Result<Vec<ForwardRuntime>, AppError> {
    let map = state.forwards.lock().await;
    Ok(map.values().map(|h| runtime_of(h, true, None)).collect())
}

/// 关闭某个服务器下的全部转发
#[tauri::command]
pub async fn forward_stop_all(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: Option<String>,
) -> Result<(), AppError> {
    let mut map = state.forwards.lock().await;
    let ids: Vec<String> = map
        .iter()
        .filter(|(_, h)| server_id.as_ref().map(|s| &h.server_id == s).unwrap_or(true))
        .map(|(k, _)| k.clone())
        .collect();
    for id in ids {
        if let Some(h) = map.remove(&id) {
            h.stop.notify_waiters();
            h.join.abort();
            emit_simple(&app, &id, &h.server_id, &h.config, false, 0, None);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// local / dynamic：本地监听
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn run_listener(
    app: AppHandle,
    handle: Arc<russh::client::Handle<ClientHandler>>,
    listener: TcpListener,
    cfg: PortForwardConfig,
    server_id: String,
    conns: Arc<AtomicU32>,
    stop: Arc<Notify>,
) {
    let dynamic = cfg.kind == "dynamic";
    loop {
        tokio::select! {
            _ = stop.notified() => break,
            accepted = listener.accept() => {
                let (sock, peer) = match accepted {
                    Ok(v) => v,
                    Err(e) => {
                        emit_simple(&app, &cfg.id, &server_id, &cfg, false, conns.load(Ordering::Relaxed), Some(format!("accept 失败: {e}")));
                        break;
                    }
                };
                let _ = sock.set_nodelay(true);
                let handle = handle.clone();
                let cfg = cfg.clone();
                let app = app.clone();
                let server_id = server_id.clone();
                let conns = conns.clone();
                tokio::spawn(async move {
                    conns.fetch_add(1, Ordering::Relaxed);
                    emit_simple(&app, &cfg.id, &server_id, &cfg, true, conns.load(Ordering::Relaxed), None);

                    let result = if dynamic {
                        handle_socks_conn(handle, sock, peer).await
                    } else {
                        handle_direct_conn(handle, sock, peer, &cfg.dest_host, cfg.dest_port).await
                    };
                    if let Err(e) = result {
                        emit_simple(&app, &cfg.id, &server_id, &cfg, true, conns.load(Ordering::Relaxed), Some(e.to_string()));
                    }

                    conns.fetch_sub(1, Ordering::Relaxed);
                    emit_simple(&app, &cfg.id, &server_id, &cfg, true, conns.load(Ordering::Relaxed), None);
                });
            }
        }
    }
    emit_simple(&app, &cfg.id, &server_id, &cfg, false, 0, None);
}

async fn handle_direct_conn(
    handle: Arc<russh::client::Handle<ClientHandler>>,
    mut sock: TcpStream,
    peer: std::net::SocketAddr,
    dest_host: &str,
    dest_port: u16,
) -> Result<(), AppError> {
    let channel = handle
        .channel_open_direct_tcpip(
            dest_host.to_string(),
            dest_port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开转发通道失败 ({dest_host}:{dest_port}): {e}")))?;
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// dynamic：本地充当 SOCKS5 服务端
// ---------------------------------------------------------------------------

async fn handle_socks_conn(
    handle: Arc<russh::client::Handle<ClientHandler>>,
    mut sock: TcpStream,
    peer: std::net::SocketAddr,
) -> Result<(), AppError> {
    // 1) 方法协商（只支持 NO AUTH）
    let mut head = [0u8; 2];
    sock.read_exact(&mut head)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS 握手失败: {e}")))?;
    if head[0] != 0x05 {
        let _ = sock.write_all(&[0x05, 0xFF]).await;
        return Err(AppError::Other("仅支持 SOCKS5".into()));
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS 握手失败: {e}")))?;
    if !methods.contains(&0x00) {
        let _ = sock.write_all(&[0x05, 0xFF]).await;
        return Err(AppError::Other("客户端不支持免认证".into()));
    }
    sock.write_all(&[0x05, 0x00])
        .await
        .map_err(|e| AppError::Other(format!("SOCKS 响应失败: {e}")))?;

    // 2) 请求
    let mut req = [0u8; 4];
    sock.read_exact(&mut req)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS 请求读取失败: {e}")))?;
    if req[1] != 0x01 {
        let _ = sock
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err(AppError::Other("仅支持 CONNECT".into()));
    }
    let dest_host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await.map_err(AppError::Io)?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        0x03 => {
            let mut l = [0u8; 1];
            sock.read_exact(&mut l).await.map_err(AppError::Io)?;
            let mut d = vec![0u8; l[0] as usize];
            sock.read_exact(&mut d).await.map_err(AppError::Io)?;
            String::from_utf8_lossy(&d).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await.map_err(AppError::Io)?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            let _ = sock
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err(AppError::Other("不支持的地址类型".into()));
        }
    };
    let mut pb = [0u8; 2];
    sock.read_exact(&mut pb).await.map_err(AppError::Io)?;
    let dest_port = u16::from_be_bytes(pb);

    // 3) 经 SSH 打开通道
    let channel = match handle
        .channel_open_direct_tcpip(
            dest_host.clone(),
            dest_port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await
    {
        Ok(c) => c,
        Err(e) => {
            // 0x05 = 连接被拒绝
            let _ = sock
                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err(AppError::Ssh(format!(
                "SOCKS 目标 {dest_host}:{dest_port} 连接失败: {e}"
            )));
        }
    };

    sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| AppError::Other(format!("SOCKS 响应失败: {e}")))?;

    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// remote：服务端监听，回连到本地可达地址
// ---------------------------------------------------------------------------

/// 注意：回连目标是**本机**可达的地址，因此始终直连，
/// 不复用服务器的代理设置（那是用于抵达 SSH 服务端的），与 OpenSSH `-R` 行为一致。
async fn run_remote(
    app: AppHandle,
    handle: Arc<russh::client::Handle<ClientHandler>>,
    mut rx: mpsc::UnboundedReceiver<crate::commands::client_handler::ForwardedChannel>,
    cfg: PortForwardConfig,
    server_id: String,
    conns: Arc<AtomicU32>,
    stop: Arc<Notify>,
) {
    loop {
        tokio::select! {
            _ = stop.notified() => break,
            item = rx.recv() => {
                let Some(fc) = item else { break };
                // 一条规则独占一个 SSH 会话，仍按监听端口过滤以防串扰
                if cfg.bind_port != 0 && fc.connected_port != cfg.bind_port as u32 {
                    continue;
                }
                let origin = format!(
                    "{}:{} → {}:{}",
                    fc.originator_address, fc.originator_port,
                    fc.connected_address, fc.connected_port
                );
                let cfg = cfg.clone();
                let app = app.clone();
                let server_id = server_id.clone();
                let conns = conns.clone();
                tokio::spawn(async move {
                    conns.fetch_add(1, Ordering::Relaxed);
                    emit_simple(&app, &cfg.id, &server_id, &cfg, true, conns.load(Ordering::Relaxed), None);

                    match TcpStream::connect((cfg.dest_host.as_str(), cfg.dest_port)).await {
                        Ok(mut local) => {
                            let mut stream = fc.channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut local, &mut stream).await;
                        }
                        Err(e) => {
                            emit_simple(&app, &cfg.id, &server_id, &cfg, true, conns.load(Ordering::Relaxed), Some(format!("{origin} 回连失败: {e}")));
                        }
                    }

                    conns.fetch_sub(1, Ordering::Relaxed);
                    emit_simple(&app, &cfg.id, &server_id, &cfg, true, conns.load(Ordering::Relaxed), None);
                });
            }
        }
    }
    // 显式持有到循环结束：Handle 被 drop 后 SSH 会话即断开
    drop(handle);
    emit_simple(&app, &cfg.id, &server_id, &cfg, false, 0, None);
}

/// 供 AppState 初始化使用
pub fn new_map() -> HashMap<String, ForwardHandle> {
    HashMap::new()
}
