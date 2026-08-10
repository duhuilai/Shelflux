// SSH / Telnet / Rlogin Shell 命令实现
// - SSH 基于 russh（纯 Rust，无需 OpenSSL）
// - Telnet / Rlogin 基于裸 TCP（tokio::net::TcpStream），与 SSH 统一到
//   Box<dyn AsyncRead + Unpin + Send> / Arc<Mutex<Box<dyn AsyncWrite + Unpin + Send>>>
//   的字节流抽象上，复用同一套事件（ssh-output / ssh-closed）与命令通道。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

use crate::commands::client_handler::{connect_session, parse_private_key};
use crate::commands::proxy;
use crate::error::AppError;
use crate::state::{AppState, ShellCommand, ShellHandle};
use crate::types::ServerConfig;

/// 会话读端：SSH ChannelStream 与裸 TCP 统一为同一个 trait object
type Reader = Box<dyn AsyncRead + Unpin + Send>;
/// 会话写端：需要在读循环与命令循环之间共享，故加锁
type Writer = Arc<Mutex<Box<dyn AsyncWrite + Unpin + Send>>>;

/// 一条会话的读写两端
struct SessionIo {
    reader: Reader,
    writer: Writer,
}

/// 启动一个 Shell 会话，返回 session_id，后续通过事件 `ssh-output` 接收输出。
#[tauri::command]
pub async fn ssh_shell_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    server: ServerConfig,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, AppError> {
    let protocol = server.protocol.clone();
    if !matches!(protocol.as_str(), "ssh" | "sftp" | "telnet" | "rlogin") {
        return Err(AppError::Protocol(format!(
            "协议 {} 不支持 shell",
            server.protocol
        )));
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<ShellCommand>();

    let session_id_for_task = session_id.clone();
    let app_for_task = app.clone();
    let server_for_task = server.clone();

    // tokio 任务：连接 + 维持 Shell / 裸 TCP 会话
    let join = tokio::spawn(async move {
        // reader/writer 统一为 trait object，使 SSH 与 Telnet/Rlogin 共用一套读写循环
        let (reader, writer): (Reader, Writer) = match protocol.as_str() {
            "ssh" | "sftp" => {
                // 解析私钥（如有）
                let key_pair = if !server_for_task.private_key.is_empty() {
                    match parse_private_key(&server_for_task.private_key, &server_for_task.passphrase)
                    {
                        Ok(k) => Some(Arc::new(k)),
                        Err(e) => {
                            emit_error(
                                &app_for_task,
                                &session_id_for_task,
                                format!("私钥解析失败: {e}"),
                            );
                            emit_closed(&app_for_task, &session_id_for_task);
                            return;
                        }
                    }
                } else {
                    None
                };

                let handle = match connect_session(&server_for_task, key_pair).await {
                    Ok(h) => h,
                    Err(e) => {
                        emit_error(&app_for_task, &session_id_for_task, e.to_string());
                        emit_closed(&app_for_task, &session_id_for_task);
                        return;
                    }
                };

                let channel = match handle.channel_open_session().await {
                    Ok(c) => c,
                    Err(e) => {
                        emit_error(
                            &app_for_task,
                            &session_id_for_task,
                            format!("打开 channel 失败: {e}"),
                        );
                        emit_closed(&app_for_task, &session_id_for_task);
                        return;
                    }
                };
                let cols = cols.unwrap_or(80);
                let rows = rows.unwrap_or(24);
                if let Err(e) = channel
                    .request_pty(
                        true,
                        "xterm-256color",
                        cols as u32,
                        rows as u32,
                        0,
                        0,
                        &[] as &[(russh::Pty, u32)],
                    )
                    .await
                {
                    emit_error(
                        &app_for_task,
                        &session_id_for_task,
                        format!("请求 PTY 失败: {e}"),
                    );
                    emit_closed(&app_for_task, &session_id_for_task);
                    return;
                }
                if let Err(e) = channel.request_shell(true).await {
                    emit_error(
                        &app_for_task,
                        &session_id_for_task,
                        format!("启动 shell 失败: {e}"),
                    );
                    emit_closed(&app_for_task, &session_id_for_task);
                    return;
                }

                emit_data(
                    &app_for_task,
                    &session_id_for_task,
                    "\x1b[90m已连接 (SSH)\x1b[0m\r\n".to_string(),
                );

                // russh ChannelStream 同时实现 AsyncRead + AsyncWrite，拆分为独立半边
                let stream = channel.into_stream();
                let (read_half, write_half) = tokio::io::split(stream);
                let r: Box<dyn AsyncRead + Unpin + Send> = Box::new(read_half);
                let w: Box<dyn AsyncWrite + Unpin + Send> = Box::new(write_half);
                (r, Arc::new(Mutex::new(w)))
            }
            "telnet" | "rlogin" => {
                // 走代理（若配置），否则直连
                let mut stream = match proxy::connect_tcp(&server_for_task).await {
                    Ok(s) => s,
                    Err(e) => {
                        emit_error(&app_for_task, &session_id_for_task, e.to_string());
                        emit_closed(&app_for_task, &session_id_for_task);
                        return;
                    }
                };

                // Rlogin 初始握手：<0x00><本地用户>\0<远端用户>\0<终端类型/波特率>\0
                if protocol == "rlogin" {
                    let user = if server_for_task.username.is_empty() {
                        "user"
                    } else {
                        server_for_task.username.as_str()
                    };
                    let handshake = format!("\0{user}\0{user}\0xterm-256color/38400\0");
                    if let Err(e) = stream.write_all(handshake.as_bytes()).await {
                        emit_error(
                            &app_for_task,
                            &session_id_for_task,
                            format!("Rlogin 握手失败: {e}"),
                        );
                        emit_closed(&app_for_task, &session_id_for_task);
                        return;
                    }
                    // 握手后立刻上报初始窗口尺寸
                    let ws = rlogin_window_size(cols.unwrap_or(80), rows.unwrap_or(24));
                    let _ = stream.write_all(&ws).await;
                    let _ = stream.flush().await;
                }

                emit_data(
                    &app_for_task,
                    &session_id_for_task,
                    format!("\x1b[90m已连接 ({})\x1b[0m\r\n", protocol.to_uppercase()),
                );

                // 拆分为独立的读写半边
                let (read_half, write_half) = stream.into_split();
                let r: Box<dyn AsyncRead + Unpin + Send> = Box::new(read_half);
                let w: Box<dyn AsyncWrite + Unpin + Send> = Box::new(write_half);
                (r, Arc::new(Mutex::new(w)))
            }
            _ => {
                emit_error(
                    &app_for_task,
                    &session_id_for_task,
                    format!("协议 {} 不支持 shell", protocol),
                );
                emit_closed(&app_for_task, &session_id_for_task);
                return;
            }
        };

        run_session(
            app_for_task,
            session_id_for_task,
            server_for_task,
            cmd_rx,
            SessionIo { reader, writer },
            cols.unwrap_or(80),
            rows.unwrap_or(24),
        )
        .await;
    });

    // 注册会话
    let handle = ShellHandle {
        cmd_tx,
        join: Some(join),
        server,
    };
    state.shells.lock().await.insert(session_id.clone(), handle);

    Ok(session_id)
}

/// 统一的读写循环：从 reader 读取远端数据（Telnet 做 IAC 处理）并emit；
/// 从 cmd_rx 接收前端写/调整尺寸/关闭命令。
async fn run_session(
    app: AppHandle,
    sid: String,
    server: ServerConfig,
    mut cmd_rx: mpsc::UnboundedReceiver<ShellCommand>,
    io: SessionIo,
    cols: u16,
    rows: u16,
) {
    let SessionIo {
        mut reader,
        writer,
    } = io;
    let is_telnet = server.protocol == "telnet";
    let is_rlogin = server.protocol == "rlogin";
    let mut codec = TelnetCodec::new(cols, rows);
    let mut resp_buf = Vec::with_capacity(64);
    let mut buf = vec![0u8; 4096];

    // Telnet：主动发起选项协商（终端类型 / 窗口尺寸 / 抑制 GA）
    if is_telnet {
        let init = codec.initial_negotiation();
        let mut w = writer.lock().await;
        let _ = w.write_all(&init).await;
        let _ = w.flush().await;
    }

    loop {
        tokio::select! {
            // 处理前端命令
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(ShellCommand::Write(data)) => {
                        // Telnet：转义数据中的 0xFF（IAC），避免被当成命令
                        let out = if is_telnet { escape_iac(&data) } else { data };
                        let mut w = writer.lock().await;
                        if w.write_all(&out).await.is_err() {
                            break;
                        }
                        let _ = w.flush().await;
                    }
                    Some(ShellCommand::Resize { cols, rows }) => {
                        codec.set_size(cols, rows);
                        // Telnet: IAC SB NAWS <cols> <rows> IAC SE（需服务端已 DO NAWS）
                        // Rlogin: RFC 1282 的窗口尺寸控制序列
                        let payload = if is_telnet {
                            codec.naws_subnegotiation()
                        } else if is_rlogin {
                            Some(rlogin_window_size(cols, rows))
                        } else {
                            None
                        };
                        if let Some(p) = payload {
                            let mut w = writer.lock().await;
                            if w.write_all(&p).await.is_err() {
                                break;
                            }
                            let _ = w.flush().await;
                        }
                    }
                    Some(ShellCommand::Close) | None => {
                        let mut w = writer.lock().await;
                        let _ = w.shutdown().await;
                        break;
                    }
                }
            }
            // 读取远端输出
            result = reader.read(&mut buf) => {
                match result {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        if is_telnet {
                            let mut out = Vec::with_capacity(n);
                            resp_buf.clear();
                            codec.process(&buf[..n], &mut out, &mut resp_buf);
                            // 将协商回应写回对端
                            if !resp_buf.is_empty() {
                                let mut w = writer.lock().await;
                                let _ = w.write_all(&resp_buf).await;
                                let _ = w.flush().await;
                            }
                            if !out.is_empty() {
                                emit_data(&app, &sid, String::from_utf8_lossy(&out).to_string());
                            }
                        } else {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            emit_data(&app, &sid, data);
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    emit_closed(&app, &sid);
}

// ---------------------------------------------------------------------------
// Telnet IAC（Interpret As Command, RFC 854）处理
// 已实现的选项：
//   ECHO(1) / SGA(3) / TERMINAL-TYPE(24, RFC 1091) / NAWS(31, RFC 1073)
// ---------------------------------------------------------------------------

const IAC: u8 = 255;
const SE: u8 = 240;
const SB: u8 = 250;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;

const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;
const TERM_NAME: &[u8] = b"xterm-256color";

#[derive(Clone, Copy, PartialEq)]
enum TelnetState {
    /// 普通数据
    Data,
    /// 刚读到 IAC (0xFF)
    Iac,
    /// IAC 之后读到协商动词（WILL/WON'T/DO/DON'T），等待选项字节
    Negotiate(u8),
    /// 子选项（IAC SB ... IAC SE）
    Suboption,
    /// 子选项中读到 IAC，等待 SE 或再次 IAC
    SuboptionIac,
}

struct TelnetCodec {
    state: TelnetState,
    sub_buf: Vec<u8>,
    cols: u16,
    rows: u16,
    /// 服务端已 DO NAWS，可以发送窗口尺寸
    naws_ok: bool,
    /// 记录对每个选项最后发出的动词，避免协商回环
    sent: std::collections::HashMap<u8, u8>,
}

impl TelnetCodec {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            state: TelnetState::Data,
            sub_buf: Vec::with_capacity(64),
            cols: cols.max(1),
            rows: rows.max(1),
            naws_ok: false,
            sent: std::collections::HashMap::new(),
        }
    }

    fn set_size(&mut self, cols: u16, rows: u16) {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
    }

    /// 连接建立后主动发出的协商
    fn initial_negotiation(&mut self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16);
        for (verb, opt) in [
            (WILL, OPT_TTYPE),
            (WILL, OPT_NAWS),
            (WILL, OPT_SGA),
            (DO, OPT_SGA),
            (DO, OPT_ECHO),
        ] {
            out.extend_from_slice(&[IAC, verb, opt]);
            self.sent.insert(opt, verb);
        }
        out
    }

    /// 生成 IAC SB NAWS <cols:u16> <rows:u16> IAC SE（尚未协商成功时返回 None）
    fn naws_subnegotiation(&self) -> Option<Vec<u8>> {
        if !self.naws_ok {
            return None;
        }
        let mut v = vec![IAC, SB, OPT_NAWS];
        // 尺寸字节同样需要转义 0xFF
        for b in self
            .cols
            .to_be_bytes()
            .into_iter()
            .chain(self.rows.to_be_bytes())
        {
            if b == IAC {
                v.push(IAC);
            }
            v.push(b);
        }
        v.extend_from_slice(&[IAC, SE]);
        Some(v)
    }

    /// 仅在动词发生变化时才回应，避免与对端无限往返
    fn respond(&mut self, resp: &mut Vec<u8>, verb: u8, opt: u8) {
        if self.sent.get(&opt) == Some(&verb) {
            return;
        }
        self.sent.insert(opt, verb);
        resp.extend_from_slice(&[IAC, verb, opt]);
    }

    /// 处理一批 Telnet 字节：剥除 IAC 命令，输出纯数据到 `out`，
    /// 需要回应的协商字节写入 `resp`（调用方负责写回对端）。
    fn process(&mut self, input: &[u8], out: &mut Vec<u8>, resp: &mut Vec<u8>) {
        for &b in input {
            match self.state {
                TelnetState::Data => {
                    if b == IAC {
                        self.state = TelnetState::Iac;
                    } else {
                        out.push(b);
                    }
                }
                TelnetState::Iac => match b {
                    IAC => {
                        // 转义的 0xFF 数据字节
                        out.push(IAC);
                        self.state = TelnetState::Data;
                    }
                    SB => {
                        self.sub_buf.clear();
                        self.state = TelnetState::Suboption;
                    }
                    WILL | WONT | DO | DONT => {
                        self.state = TelnetState::Negotiate(b);
                    }
                    _ => {
                        // 其它 IAC 命令（IP/NOP/DM 等）直接忽略
                        self.state = TelnetState::Data;
                    }
                },
                TelnetState::Negotiate(verb) => {
                    self.handle_negotiate(verb, b, resp);
                    self.state = TelnetState::Data;
                }
                TelnetState::Suboption => {
                    if b == IAC {
                        self.state = TelnetState::SuboptionIac;
                    } else {
                        self.sub_buf.push(b);
                    }
                }
                TelnetState::SuboptionIac => {
                    if b == SE {
                        self.handle_suboption(resp);
                        self.state = TelnetState::Data;
                    } else if b == IAC {
                        self.sub_buf.push(IAC); // 子选项内转义的 0xFF
                        self.state = TelnetState::Suboption;
                    } else {
                        self.state = TelnetState::Suboption;
                    }
                }
            }
        }
    }

    fn handle_negotiate(&mut self, verb: u8, opt: u8, resp: &mut Vec<u8>) {
        match (verb, opt) {
            // 服务端同意我们发送窗口尺寸
            (DO, OPT_NAWS) => {
                self.respond(resp, WILL, OPT_NAWS);
                self.naws_ok = true;
                if let Some(sub) = self.naws_subnegotiation() {
                    resp.extend_from_slice(&sub);
                }
            }
            (DONT, OPT_NAWS) => {
                self.naws_ok = false;
                self.respond(resp, WONT, OPT_NAWS);
            }
            // 终端类型
            (DO, OPT_TTYPE) => self.respond(resp, WILL, OPT_TTYPE),
            (DONT, OPT_TTYPE) => self.respond(resp, WONT, OPT_TTYPE),
            // 抑制 Go-Ahead：双向都接受
            (DO, OPT_SGA) => self.respond(resp, WILL, OPT_SGA),
            (WILL, OPT_SGA) => self.respond(resp, DO, OPT_SGA),
            (DONT, OPT_SGA) => self.respond(resp, WONT, OPT_SGA),
            (WONT, OPT_SGA) => self.respond(resp, DONT, OPT_SGA),
            // 回显由服务端负责
            (WILL, OPT_ECHO) => self.respond(resp, DO, OPT_ECHO),
            (WONT, OPT_ECHO) => self.respond(resp, DONT, OPT_ECHO),
            (DO, OPT_ECHO) => self.respond(resp, WONT, OPT_ECHO),
            // 其它一律拒绝
            (DO, o) => self.respond(resp, WONT, o),
            (WILL, o) => self.respond(resp, DONT, o),
            _ => {}
        }
    }

    fn handle_suboption(&mut self, resp: &mut Vec<u8>) {
        if self.sub_buf.len() >= 2
            && self.sub_buf[0] == OPT_TTYPE
            && self.sub_buf[1] == TTYPE_SEND
        {
            resp.extend_from_slice(&[IAC, SB, OPT_TTYPE, TTYPE_IS]);
            resp.extend_from_slice(TERM_NAME);
            resp.extend_from_slice(&[IAC, SE]);
        }
        self.sub_buf.clear();
    }
}

/// Rlogin 窗口尺寸变更（RFC 1282）：
/// 0xFF 0xFF 's' 's' <rows> <cols> <xpixels> <ypixels>，各为大端 u16。
fn rlogin_window_size(cols: u16, rows: u16) -> Vec<u8> {
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&[0xFF, 0xFF, b's', b's']);
    v.extend_from_slice(&rows.to_be_bytes());
    v.extend_from_slice(&cols.to_be_bytes());
    v.extend_from_slice(&0u16.to_be_bytes());
    v.extend_from_slice(&0u16.to_be_bytes());
    v
}

/// 发送数据时对 0xFF 字节做转义（0xFF -> 0xFF 0xFF）。
fn escape_iac(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        if b == 0xFF {
            out.push(0xFF);
            out.push(0xFF);
        } else {
            out.push(b);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 事件分发
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct SshOutputEvent {
    session_id: String,
    kind: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct SshClosedEvent {
    session_id: String,
}

fn emit_data(app: &AppHandle, sid: &str, data: String) {
    let _ = app.emit(
        "ssh-output",
        SshOutputEvent {
            session_id: sid.to_string(),
            kind: "data".into(),
            data,
        },
    );
}

fn emit_error(app: &AppHandle, sid: &str, data: String) {
    let _ = app.emit(
        "ssh-output",
        SshOutputEvent {
            session_id: sid.to_string(),
            kind: "error".into(),
            data,
        },
    );
}

fn emit_closed(app: &AppHandle, sid: &str) {
    let _ = app.emit(
        "ssh-closed",
        SshClosedEvent {
            session_id: sid.to_string(),
        },
    );
}

#[tauri::command]
pub async fn ssh_shell_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    let shells = state.shells.lock().await;
    let handle = shells
        .get(&session_id)
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    handle
        .cmd_tx
        .send(ShellCommand::Write(data.into_bytes()))
        .map_err(|e| AppError::Other(format!("发送失败: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_shell_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let shells = state.shells.lock().await;
    let handle = shells
        .get(&session_id)
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    handle
        .cmd_tx
        .send(ShellCommand::Resize { cols, rows })
        .map_err(|e| AppError::Other(format!("发送失败: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_shell_close(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let mut shells = state.shells.lock().await;
    if let Some(mut handle) = shells.remove(&session_id) {
        let _ = handle.cmd_tx.send(ShellCommand::Close);
        if let Some(join) = handle.join.take() {
            join.abort();
        }
    }
    Ok(())
}
