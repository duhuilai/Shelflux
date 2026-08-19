// SFTP 命令实现（基于 russh-sftp - 纯 Rust，无需 OpenSSL）
// 使用会话池复用 SSH 连接，避免每次操作都重新建立连接

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use russh_keys::key::KeyPair;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::commands::client_handler::{get_or_create_ssh_handle, parse_private_key};
use crate::error::AppError;
use crate::state::AppState;
use crate::types::{FileEntry, ServerConfig, TransferProgress};
use tokio::sync::Mutex;

/// 从会话池获取 SFTP 会话，不存在则创建。
/// 复用前做健康检查：若底层连接已失效（空闲超时/网络中断），则重建会话，
/// 避免直接用池中失效的会话导致"连不上"。
async fn get_sftp(
    app: &AppHandle,
    server: &ServerConfig,
) -> Result<Arc<Mutex<SftpSession>>, AppError> {
    // 先尝试从池中获取
    let state = app.state::<AppState>();
    let existing = {
        let sessions = state.sftp_sessions.lock().await;
        sessions.get(&server.id).map(|h| h.clone())
    };

    if let Some(handle) = existing {
        // 距上次健康检查超过 5s 才再次探测（缓存），避免每次操作都往返
        let need_check = handle.last_check.elapsed() > Duration::from_secs(5);
        let healthy = if need_check {
            let s = handle.session.lock().await;
            // 用 8s 超时包裹一个轻量 stat("/")：收到响应（无论成功或权限拒绝）即连接活着；
            // 只有超时（连接已死）才判为失效需重建。
            matches!(
                tokio::time::timeout(Duration::from_secs(8), s.metadata("/")).await,
                Ok(_)
            )
        } else {
            true
        };

        if healthy {
            // 更新健康检查时间戳
            let mut sessions = state.sftp_sessions.lock().await;
            if let Some(h) = sessions.get_mut(&server.id) {
                h.last_check = Instant::now();
            }
            drop(sessions);
            return Ok(handle.session.clone());
        }

        // 失效：从池中移除，下面重建
        eprintln!("[sftp] session for {} unhealthy, rebuilding", server.id);
        let mut sessions = state.sftp_sessions.lock().await;
        sessions.remove(&server.id);
        drop(sessions);
    }

    // 创建新会话（会自动复用 SSH 连接池）
    let session = open_sftp_session(app, server).await?;

    // 存入会话池
    let state = app.state::<AppState>();
    let mut sessions = state.sftp_sessions.lock().await;
    sessions.insert(server.id.clone(), session.clone());
    drop(sessions);

    Ok(session.session.clone())
}

/// 打开一个 SFTP 会话（公开入口）
/// 优先从 SSH 连接池复用已有连接，避免重复建连；
/// 首次失败（多为池中 SSH 连接静默断连）会剔除失效连接后自动重试一次。
async fn open_sftp_session(app: &AppHandle, server: &ServerConfig) -> Result<crate::state::SftpHandle, AppError> {
    if !matches!(server.protocol.as_str(), "ssh" | "sftp") {
        return Err(AppError::Protocol(format!(
            "协议 {} 不支持 SFTP",
            server.protocol
        )));
    }
    let key_pair = if !server.private_key.is_empty() {
        Some(Arc::new(parse_private_key(
            &server.private_key,
            &server.passphrase,
        )?))
    } else {
        None
    };
    // 最多尝试两次：首次失败（多为池中静默断连）剔除失效连接后重试
    let mut last_err = None;
    for attempt in 0..2 {
        match open_sftp_session_inner(app, server, key_pair.clone()).await {
            Ok(h) => return Ok(h),
            Err(e) => {
                eprintln!("[sftp] sftp session attempt {} failed: {e}", attempt + 1);
                evict_ssh_handle(app, server).await;
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Sftp("未知的 SFTP 初始化失败".into())))
}

/// 内部实现：在指定 SSH 连接上开 channel + 请求 sftp 子系统。
/// 任何一步失败都直接返回错误，由调用方决定是否剔除失效连接并重试。
async fn open_sftp_session_inner(
    app: &AppHandle,
    server: &ServerConfig,
    key_pair: Option<Arc<KeyPair>>,
) -> Result<crate::state::SftpHandle, AppError> {
    // 从连接池获取或新建 SSH 连接（复用已有连接，避免 TCP+密钥交换+认证）
    let ssh_handle = get_or_create_ssh_handle(app, server, key_pair).await?;

    // 在 SSH 连接上打开 channel 并请求 sftp 子系统
    // 注意：必须用 request_subsystem（让 sshd 直接 fork sftp-server），
    // 不能用 exec("sftp")——后者会在登录 shell 里执行命令，很多环境下会挂起导致 INIT 超时。
    eprintln!("[sftp] opening channel for server {}", server.id);
    let handle = ssh_handle.lock().await;
    let channel = match tokio::time::timeout(Duration::from_secs(25), handle.channel_open_session()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => return Err(AppError::Ssh(format!("打开 channel 失败: {e}"))),
        Err(_) => return Err(AppError::Ssh("打开 channel 超时".into())),
    };

    eprintln!("[sftp] requesting sftp subsystem");
    match tokio::time::timeout(
        Duration::from_secs(25),
        channel.request_subsystem(true, "sftp"),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(AppError::Sftp(format!("请求 SFTP 子系统失败: {e}"))),
        Err(_) => return Err(AppError::Sftp("请求 SFTP 子系统超时".into())),
    }

    // 使用自定义配置：超时 30 秒（默认只有 10 秒，慢网络容易超时）
    let sftp_config = russh_sftp::client::Config {
        request_timeout_secs: 30,
        ..Default::default()
    };
    eprintln!("[sftp] initializing SftpSession (handshake)");
    let sftp = SftpSession::new_with_config(channel.into_stream(), sftp_config)
        .await
        .map_err(|e| {
            eprintln!("[sftp] init failed: {e}");
            AppError::Sftp(format!("初始化 SFTP 失败: {e}"))
        })?;
    eprintln!("[sftp] SftpSession initialized OK");

    // 释放 SSH handle 锁（让其他操作可以复用此连接）
    drop(handle);

    Ok(crate::state::SftpHandle {
        session: Arc::new(Mutex::new(sftp)),
        server: server.clone(),
        last_check: Instant::now(),
    })
}

/// 从 SSH 连接池中剔除指定 server 的失效连接
async fn evict_ssh_handle(app: &AppHandle, server: &ServerConfig) {
    let state = app.state::<AppState>();
    let mut pool = state.ssh_pool.lock().await;
    pool.remove(&server.id);
}

/// 从 SFTP 会话池中剔除指定 server 的会话（超时/错误后调用，强制下次重建）
async fn evict_sftp_session(app: &AppHandle, server: &ServerConfig) {
    let state = app.state::<AppState>();
    let mut sessions = state.sftp_sessions.lock().await;
    if sessions.remove(&server.id).is_some() {
        eprintln!("[sftp] evicted stale session for {}", server.id);
    }
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    server: ServerConfig,
    path: String,
) -> Result<Vec<FileEntry>, AppError> {
    let sftp = get_sftp(&app, &server).await?;

    // read_dir 加 30s 超时：大目录/慢文件系统/网络瞬断时不至于永久挂起
    let read_dir = match tokio::time::timeout(
        Duration::from_secs(30),
        sftp.lock().await.read_dir(path.as_str()),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(AppError::Sftp(format!("读取目录失败: {e}"))),
        Err(_) => {
            // 超时后剔除可能已失效的会话，下次调用会重建连接
            evict_sftp_session(&app, &server).await;
            return Err(AppError::Sftp(format!(
                "读取目录超时 ({}，30s 无响应)",
                path
            )));
        }
    };

    let mut result: Vec<FileEntry> = read_dir
        .map(|entry| {
            let name = entry.file_name();
            let full = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };
            let meta = entry.metadata();
            let ft = entry.file_type();
            let kind = if ft.is_dir() {
                "dir"
            } else if ft.is_symlink() {
                "symlink"
            } else {
                "file"
            };
            FileEntry {
                name,
                path: full,
                kind: kind.to_string(),
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.map(|m| m as i64),
                permissions: meta.permissions,
                is_symlink: ft.is_symlink(),
            }
        })
        .collect();

    result.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") | ("dir", "symlink") => std::cmp::Ordering::Less,
        ("file", "dir") | ("symlink", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(result)
}

#[tauri::command]
pub async fn sftp_stat(
    app: AppHandle,
    server: ServerConfig,
    path: String,
) -> Result<Option<FileEntry>, AppError> {
    let sftp = get_sftp(&app, &server).await?;
    let meta = sftp.lock().await.metadata(path.as_str()).await;
    match meta {
        Ok(meta) => {
            let kind = if meta.is_dir() { "dir" } else { "file" };
            let name = file_name_of(&path);
            Ok(Some(FileEntry {
                name,
                path: path.clone(),
                kind: kind.to_string(),
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.map(|m| m as i64),
                permissions: meta.permissions,
                is_symlink: meta.is_symlink(),
            }))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn sftp_exists(
    app: AppHandle,
    server: ServerConfig,
    path: String,
) -> Result<bool, AppError> {
    let sftp = get_sftp(&app, &server).await?;
    let result = sftp.lock().await.metadata(path.as_str()).await.is_ok();
    Ok(result)
}

#[tauri::command]
pub async fn sftp_mkdir(
    app: AppHandle,
    server: ServerConfig,
    path: String,
) -> Result<(), AppError> {
    let sftp = get_sftp(&app, &server).await?;
    sftp.lock().await
        .create_dir(path.as_str())
        .await
        .map_err(|e| AppError::Sftp(format!("创建目录失败: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_create_file(
    app: AppHandle,
    server: ServerConfig,
    path: String,
) -> Result<(), AppError> {
    let sftp = get_sftp(&app, &server).await?;
    let file = sftp
        .lock().await
        .create(path.as_str())
        .await
        .map_err(|e| AppError::Sftp(format!("创建文件失败: {e}")))?;
    file.close().await.map_err(AppError::Io)?;
    Ok(())
}

/// 递归删除 SFTP 目录（先清空内容，再删目录本身）。
async fn sftp_remove_dir_all(
    sftp: &Arc<Mutex<SftpSession>>,
    path: &str,
) -> Result<(), AppError> {
    let entries = sftp.lock().await
        .read_dir(path)
        .await
        .map_err(|e| AppError::Sftp(format!("读取目录失败（递归删除）: {e}")))?;

    for entry in entries {
        let name = entry.file_name();
        // 跳过 . 和 ..
        if name == "." || name == ".." {
            continue;
        }
        let full = if path.ends_with('/') {
            format!("{path}{name}")
        } else {
            format!("{path}/{name}")
        };
        let ft = entry.file_type();
        if ft.is_dir() {
            Box::pin(sftp_remove_dir_all(sftp, &full)).await?;
        } else {
            sftp.lock().await
                .remove_file(&full)
                .await
                .map_err(|e| AppError::Sftp(format!("删除文件失败: {full}, {e}")))?;
        }
    }

    // 目录已清空，现在可以安全 remove_dir
    sftp.lock().await
        .remove_dir(path)
        .await
        .map_err(|e| AppError::Sftp(format!("删除目录失败: {path}, {e}")))
}

#[tauri::command]
pub async fn sftp_remove(
    app: AppHandle,
    server: ServerConfig,
    path: String,
) -> Result<(), AppError> {
    let sftp = get_sftp(&app, &server).await?;
    let meta = sftp
        .lock().await
        .metadata(path.as_str())
        .await
        .map_err(|_| AppError::NotFound(path.clone()))?;
    if meta.is_dir() {
        sftp_remove_dir_all(&sftp, &path).await?;
    } else {
        sftp.lock().await
            .remove_file(path.as_str())
            .await
            .map_err(|e| AppError::Sftp(format!("删除文件失败: {e}")))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    server: ServerConfig,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let sftp = get_sftp(&app, &server).await?;
    sftp.lock().await
        .rename(from.as_str(), to.as_str())
        .await
        .map_err(|e| AppError::Sftp(format!("重命名失败: {e}")))?;
    Ok(())
}

/// 远端同侧复制：在同一个 SFTP 会话内读出再写入，支持目录递归。
/// 进度通过 `transfer-progress-<taskId>` 事件推送。
#[tauri::command]
pub async fn sftp_copy(
    app: AppHandle,
    server: ServerConfig,
    from: String,
    to: String,
    task_id: String,
) -> Result<(), AppError> {
    let sftp = get_sftp(&app, &server).await?;

    let meta = sftp.lock().await
        .metadata(from.as_str())
        .await
        .map_err(|_| AppError::NotFound(from.clone()))?;

    emit_progress(
        &app,
        &task_id,
        &TransferProgress {
            task_id: task_id.clone(),
            transferred: 0,
            total: meta.size.unwrap_or(0),
            speed: 0,
            status: "running".into(),
            message: Some(format!("复制 {}", file_name_of(&from))),
        },
    );

    let started = Instant::now();
    let mut copied: u64 = 0;

    if meta.is_dir() {
        // 广度优先遍历：(源目录, 目标目录)
        let mut queue: Vec<(String, String)> = vec![(from.clone(), to.clone())];
        while let Some((src_dir, dst_dir)) = queue.pop() {
            if sftp.lock().await.metadata(dst_dir.as_str()).await.is_err() {
                sftp.lock().await
                    .create_dir(dst_dir.as_str())
                    .await
                    .map_err(|e| AppError::Sftp(format!("创建目录 {dst_dir} 失败: {e}")))?;
            }
            let entries = sftp.lock().await
                .read_dir(src_dir.as_str())
                .await
                .map_err(|e| AppError::Sftp(format!("读取目录 {src_dir} 失败: {e}")))?;
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let s = join_remote(&src_dir, &name);
                let d = join_remote(&dst_dir, &name);
                if entry.file_type().is_dir() {
                    queue.push((s, d));
                } else {
                    copied += copy_one(&sftp, &s, &d).await?;
                    emit_progress(
                        &app,
                        &task_id,
                        &TransferProgress {
                            task_id: task_id.clone(),
                            transferred: copied,
                            total: copied,
                            speed: copied / started.elapsed().as_secs().max(1),
                            status: "running".into(),
                            message: Some(name),
                        },
                    );
                }
            }
        }
    } else {
        copied = copy_one(&sftp, &from, &to).await?;
    }

    emit_progress(
        &app,
        &task_id,
        &TransferProgress {
            task_id: task_id.clone(),
            transferred: copied,
            total: copied,
            speed: 0,
            status: "done".into(),
            message: Some(format!("已复制到 {}", to)),
        },
    );
    Ok(())
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

async fn copy_one(
    sftp: &Arc<Mutex<SftpSession>>,
    from: &str,
    to: &str,
) -> Result<u64, AppError> {
    let mut src = sftp.lock().await
        .open(from)
        .await
        .map_err(|e| AppError::Sftp(format!("打开 {from} 失败: {e}")))?;
    let mut dst = sftp.lock().await
        .create(to)
        .await
        .map_err(|e| AppError::Sftp(format!("创建 {to} 失败: {e}")))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = src.read(&mut buf).await.map_err(AppError::Io)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| AppError::Sftp(format!("写入 {to} 失败: {e}")))?;
        total += n as u64;
    }
    dst.close().await.map_err(AppError::Io)?;
    Ok(total)
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    server: ServerConfig,
    remote: String,
    local: String,
    task_id: String,
) -> Result<(), AppError> {
    let sftp = get_sftp(&app, &server).await?;

    // 检查远端路径是否为目录
    let is_dir = sftp.lock().await
        .metadata(remote.as_str())
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);

    if is_dir {
        sftp_download_dir(&app, &sftp, &remote, &local, &task_id).await?;
    } else {
        sftp_download_file(&app, &sftp, &remote, &local, &task_id).await?;
    }
    Ok(())
}

/// 下载单个远端文件到本地
async fn sftp_download_file(
    app: &AppHandle,
    sftp: &Arc<Mutex<SftpSession>>,
    remote: &str,
    local: &str,
    task_id: &str,
) -> Result<(), AppError> {
    let total = sftp.lock().await
        .metadata(remote)
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0);

    let local_path = std::path::Path::new(local);
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::Sftp(format!("创建临时目录失败: {e} ({parent:?})")))?;
    }

    let mut remote_file = sftp.lock().await
        .open(remote)
        .await
        .map_err(|e| AppError::Sftp(format!("打开远端文件失败: {e}")))?;
    let mut local_file = tokio::fs::File::create(local)
        .await
        .map_err(AppError::Io)?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let started = Instant::now();

    emit_progress(
        app, task_id,
        &TransferProgress {
            task_id: task_id.to_string(),
            transferred: 0, total, speed: 0,
            status: "running".into(),
            message: Some(format!("下载 {}", remote)),
        },
    );

    loop {
        let n = match tokio::time::timeout(Duration::from_secs(30), remote_file.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(AppError::Io(e)),
            Err(_) => return Err(AppError::Sftp(format!("下载读取超时: {} (30s 无数据)", remote))),
        };
        if n == 0 { break; }
        local_file.write_all(&buf[..n]).await.map_err(AppError::Io)?;
        done += n as u64;
        let elapsed = started.elapsed().as_secs().max(1);
        emit_progress(app, task_id, &TransferProgress {
            task_id: task_id.to_string(), transferred: done, total, speed: done / elapsed,
            status: "running".into(), message: None,
        });
    }
    local_file.flush().await.map_err(AppError::Io)?;

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: done, total: done.max(total), speed: 0,
        status: "done".into(), message: Some(format!("保存到 {}", local)),
    });
    if let Some(parent) = std::path::Path::new(local).parent() {
        emit_dir_changed(app, "local", &parent.to_string_lossy());
    }
    Ok(())
}

/// 递归下载远端目录到本地
async fn sftp_download_dir(
    app: &AppHandle,
    sftp: &Arc<Mutex<SftpSession>>,
    remote_dir: &str,
    local_dir: &str,
    task_id: &str,
) -> Result<(), AppError> {
    tokio::fs::create_dir_all(local_dir).await.map_err(AppError::Io)?;

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: 0, total: 0, speed: 0,
        status: "running".into(), message: Some(format!("下载目录 {}", remote_dir)),
    });

    let entries = sftp.lock().await
        .read_dir(remote_dir)
        .await
        .map_err(|e| AppError::Sftp(format!("读取远端目录失败: {e}")))?;

    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." { continue; }
        let remote_path = if remote_dir.ends_with('/') {
            format!("{}{}", remote_dir, name)
        } else {
            format!("{}/{}", remote_dir, name)
        };
        let local_path = std::path::Path::new(local_dir).join(&name)
            .to_string_lossy().to_string();

        let ft = entry.file_type();
        if ft.is_dir() {
            Box::pin(sftp_download_dir(app, sftp, &remote_path, &local_path, task_id)).await?;
        } else {
            sftp_download_file(app, sftp, &remote_path, &local_path, task_id).await?;
        }
    }

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: 0, total: 0, speed: 0,
        status: "done".into(), message: Some(format!("目录已下载 {}", local_dir)),
    });
    if let Some(parent) = std::path::Path::new(local_dir).parent() {
        emit_dir_changed(app, "local", &parent.to_string_lossy());
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    server: ServerConfig,
    local: String,
    remote: String,
    task_id: String,
) -> Result<(), AppError> {
    // 检查本地路径是否为目录
    let local_meta = tokio::fs::metadata(local.as_str())
        .await
        .map_err(AppError::Io)?;

    let sftp = get_sftp(&app, &server).await?;

    if local_meta.is_dir() {
        sftp_upload_dir(&app, &sftp, &local, &remote, &task_id).await?;
    } else {
        sftp_upload_file(&app, &sftp, &local, &remote, &task_id).await?;
    }
    Ok(())
}

/// 上传单个本地文件到远端
async fn sftp_upload_file(
    app: &AppHandle,
    sftp: &Arc<Mutex<SftpSession>>,
    local: &str,
    remote: &str,
    task_id: &str,
) -> Result<(), AppError> {
    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(AppError::Io)?;
    let total = local_file.metadata().await.map_err(AppError::Io)?.len();

    let mut remote_file = sftp.lock().await
        .create(remote)
        .await
        .map_err(|e| AppError::Sftp(format!("创建远端文件失败: {e}")))?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let started = Instant::now();

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: 0, total, speed: 0,
        status: "running".into(), message: Some(format!("上传 {}", remote)),
    });

    loop {
        let n = local_file.read(&mut buf).await.map_err(AppError::Io)?;
        if n == 0 { break; }
        match tokio::time::timeout(Duration::from_secs(30), remote_file.write_all(&buf[..n])).await {
            Ok(Ok(())) => {},
            Ok(Err(e)) => return Err(AppError::Sftp(format!("写入失败: {e}"))),
            Err(_) => return Err(AppError::Sftp(format!("上传写入超时: {} (30s 无响应)", remote))),
        };
        done += n as u64;
        let elapsed = started.elapsed().as_secs().max(1);
        emit_progress(app, task_id, &TransferProgress {
            task_id: task_id.to_string(), transferred: done, total, speed: done / elapsed,
            status: "running".into(), message: None,
        });
    }
    remote_file.close().await.map_err(AppError::Io)?;

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: done, total, speed: 0,
        status: "done".into(), message: Some(format!("上传到 {}", remote)),
    });
    if let Some(parent) = std::path::Path::new(remote).parent() {
        emit_dir_changed(app, "remote", &parent.to_string_lossy());
    }
    Ok(())
}

/// 递归上传本地目录到远端
async fn sftp_upload_dir(
    app: &AppHandle,
    sftp: &Arc<Mutex<SftpSession>>,
    local_dir: &str,
    remote_dir: &str,
    task_id: &str,
) -> Result<(), AppError> {
    // 创建远端目录（已存在则忽略）
    let _ = sftp.lock().await.create_dir(remote_dir).await;

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: 0, total: 0, speed: 0,
        status: "running".into(), message: Some(format!("上传目录 {}", local_dir)),
    });

    let mut entries = tokio::fs::read_dir(local_dir)
        .await
        .map_err(AppError::Io)?;

    while let Some(entry) = entries.next_entry().await.map_err(AppError::Io)? {
        let name = entry.file_name().to_string_lossy().to_string();
        let local_path = entry.path().to_string_lossy().to_string();
        let remote_path = if remote_dir.ends_with('/') {
            format!("{}{}", remote_dir, name)
        } else {
            format!("{}/{}", remote_dir, name)
        };

        let file_type = entry.file_type().await.map_err(AppError::Io)?;
        if file_type.is_dir() {
            Box::pin(sftp_upload_dir(app, sftp, &local_path, &remote_path, task_id)).await?;
        } else {
            sftp_upload_file(app, sftp, &local_path, &remote_path, task_id).await?;
        }
    }

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: 0, total: 0, speed: 0,
        status: "done".into(), message: Some(format!("目录已上传 {}", remote_dir)),
    });
    if let Some(parent) = std::path::Path::new(remote_dir).parent() {
        emit_dir_changed(app, "remote", &parent.to_string_lossy());
    }
    Ok(())
}

fn emit_progress(app: &AppHandle, task_id: &str, progress: &TransferProgress) {
    let _ = app.emit(&format!("transfer-progress-{}", task_id), progress.clone());
}

/// 通知前端某个目录的内容发生了变化，提示对应面板刷新列表
fn emit_dir_changed(app: &AppHandle, side: &str, dir: &str) {
    let _ = app.emit(
        "sftp-dir-changed",
        serde_json::json!({ "side": side, "dir": dir }),
    );
}

/// 打开远端文件：下载到本地临时目录 → 用默认程序打开 → 监控本地文件变更自动回传服务器
#[tauri::command]
pub async fn open_remote_file(
    app: AppHandle,
    server: ServerConfig,
    remote: String,
    local: String,
) -> Result<(), AppError> {
    let task_id = uuid::Uuid::new_v4().to_string();
    sftp_download(app.clone(), server.clone(), remote.clone(), local.clone(), task_id).await?;
    crate::commands::system::open_with_default_app(app.clone(), local.clone()).await?;
    spawn_remote_watcher(app.clone(), server, remote, local);
    Ok(())
}

/// 用指定程序打开远端文件并开始监控变更回传
#[tauri::command]
pub async fn open_remote_file_with(
    app: AppHandle,
    server: ServerConfig,
    remote: String,
    local: String,
    program: String,
) -> Result<(), AppError> {
    let task_id = uuid::Uuid::new_v4().to_string();
    sftp_download(app.clone(), server.clone(), remote.clone(), local.clone(), task_id).await?;
    crate::commands::system::open_with_program(app.clone(), local.clone(), program).await?;
    spawn_remote_watcher(app.clone(), server, remote, local);
    Ok(())
}

/// 在后台监控本地临时文件，编辑器保存后自动回传服务器
///
/// 用「内容哈希」检测变更，而非修改时间——因为 VS Code 等编辑器采用
/// 原子保存（写临时文件 + rename），且会保留原文件的 mtime，导致基于
/// 修改时间的检测完全失效。哈希检测能稳定捕获内容变化。
fn spawn_remote_watcher(app: AppHandle, server: ServerConfig, remote: String, local: String) {
    tauri::async_runtime::spawn(async move {
        let mut last_size = file_size(&local).await;
        let mut last_hash = file_sha256(&local).await;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            // 本地临时文件被删除（编辑器清理）→ 停止监控
            let meta = match tokio::fs::metadata(&local).await {
                Ok(m) => m,
                Err(_) => {
                    let _ = app.emit(
                        "remote-file-synced",
                        SyncEvent {
                            name: basename_str(&remote),
                            status: "stopped".into(),
                            message: Some(format!("已停止监控 {}", remote)),
                        },
                    );
                    break;
                }
            };
            let size = meta.len();
            // 仅在大小变化或尚未建立基线时才重新计算哈希（避免无谓读取）
            let hash = if last_hash.is_none() || size != last_size.unwrap_or(0) {
                file_sha256(&local).await
            } else {
                last_hash.clone()
            };
            let changed = match (&last_hash, &hash) {
                (Some(a), Some(b)) => a != b,
                _ => hash.is_some(),
            };
            if changed {
                // 防抖：等待编辑器写完，然后读取稳定后的内容
                tokio::time::sleep(Duration::from_millis(800)).await;
                let settled_size = file_size(&local).await.unwrap_or(size);
                let settled_hash = file_sha256(&local).await;
                let up_id = uuid::Uuid::new_v4().to_string();
                match sftp_upload(app.clone(), server.clone(), local.clone(), remote.clone(), up_id).await {
                    Ok(_) => {
                        last_size = Some(settled_size);
                        last_hash = settled_hash;
                        let _ = app.emit(
                            "remote-file-synced",
                            SyncEvent {
                                name: basename_str(&remote),
                                status: "synced".into(),
                                message: Some(format!("已上传到服务器 {}", remote)),
                            },
                        );
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "remote-file-synced",
                            SyncEvent {
                                name: basename_str(&remote),
                                status: "error".into(),
                                message: Some(format!("上传失败: {}", e)),
                            },
                        );
                        // 不更新基线，下次继续尝试
                    }
                }
            } else {
                last_size = Some(size);
                last_hash = hash;
            }
        }
    });
}

async fn file_size(path: &str) -> Option<u64> {
    tokio::fs::metadata(path).await.ok().map(|m| m.len())
}

async fn file_sha256(path: &str) -> Option<Vec<u8>> {
    use sha2::{Digest, Sha256};
    let data = tokio::fs::read(path).await.ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Some(hasher.finalize().to_vec())
}

fn basename_str(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[derive(Clone, serde::Serialize)]
struct SyncEvent {
    name: String,
    status: String,
    message: Option<String>,
}
