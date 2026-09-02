// SFTP 命令实现（基于 russh-sftp - 纯 Rust，无需 OpenSSL）
// 使用会话池复用 SSH 连接，避免每次操作都重新建立连接

use std::io::SeekFrom;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use russh_keys::key::KeyPair;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::commands::client_handler::{get_or_create_ssh_handle, parse_private_key};
use crate::error::AppError;
use crate::state::AppState;
use crate::types::{FileEntry, ServerConfig, TransferProgress};
use tokio::sync::Mutex;

/// 连接池空闲 TTL：超过该时长无任何操作（秒）则下次复用时重建连接，回收空闲资源。
const IDLE_TTL_SECS: u64 = 300;

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
            // 连接池空闲 TTL 回收：超过阈值且无操作则剔除底层连接，下次重建
            if handle.last_used.elapsed() > Duration::from_secs(IDLE_TTL_SECS) {
                eprintln!(
                    "[sftp] session for {} idle > {}s, recycling",
                    server.id, IDLE_TTL_SECS
                );
                {
                    let mut sessions = state.sftp_sessions.lock().await;
                    sessions.remove(&server.id);
                }
                evict_ssh_handle(app, server).await;
                // 继续下方重建逻辑
            } else {
                // 更新健康检查与时间戳
                let mut sessions = state.sftp_sessions.lock().await;
                if let Some(h) = sessions.get_mut(&server.id) {
                    h.last_check = Instant::now();
                    h.last_used = Instant::now();
                }
                drop(sessions);
                return Ok(handle.session.clone());
            }
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
        last_used: Instant::now(),
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

/// 请求取消一个正在进行的传输任务（按 task_id 标记，由 IO 循环轮询判定）
#[tauri::command]
pub async fn cancel_transfer(app: AppHandle, task_id: String) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    state.cancelled_transfers.lock().await.insert(task_id);
    Ok(())
}

/// 判定指定 task_id 是否已被请求取消
async fn is_cancelled(app: &AppHandle, task_id: &str) -> bool {
    let state = app.state::<AppState>();
    state.cancelled_transfers.lock().await.contains(task_id)
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
    // 内部函数：执行实际的 read_dir 操作，返回结果或错误描述字符串
    // 注意：必须是具名 async fn（而非闭包返回 async 块），否则会触发
    // "lifetime may not live long enough"——闭包返回的 future 无法约束捕获引用的生命周期。
    async fn do_read_dir(
        sftp: &Arc<Mutex<SftpSession>>,
        p: &str,
    ) -> Result<russh_sftp::client::fs::ReadDir, String> {
        match tokio::time::timeout(
            Duration::from_secs(30),
            sftp.lock().await.read_dir(p),
        )
        .await
        {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("读取目录超时 (30s 无响应)".to_string()),
        }
    }

    // 第一次尝试
    let sftp = get_sftp(&app, &server).await?;
    match do_read_dir(&sftp, path.as_str()).await {
        Ok(entries) => return Ok(build_file_list(&sftp, entries, &path).await),
        Err(e) => {
            let err_msg = e.to_string();
            eprintln!("[sftp] read_dir failed on first attempt: {err_msg}");

            // 检测是否是连接/会话失效类错误（这些可以重试）
            let is_session_err = err_msg.contains("session closed")
                || err_msg.contains("connection closed")
                || err_msg.contains("broken pipe")
                || err_msg.contains("EOF")
                || err_msg.contains("reset by peer");

            if is_session_err {
                eprintln!("[sftp] session error detected, evicting and retrying...");
                // 剔除失效的 SFTP session 和底层 SSH 连接
                evict_sftp_session(&app, &server).await;
                evict_ssh_handle(&app, &server).await;

                // 重建连接后重试一次
                match get_sftp(&app, &server).await {
                    Ok(sftp2) => {
                        eprintln!("[sftp] retrying read_dir after reconnect");
                        match do_read_dir(&sftp2, path.as_str()).await {
                            Ok(entries) => return Ok(build_file_list(&sftp2, entries, &path).await),
                            Err(e2) => {
                                eprintln!("[sftp] read_dir also failed on retry: {e2}");
                                evict_sftp_session(&app, &server).await;
                                return Err(AppError::Sftp(format!(
                                    "读取目录失败（已重试）: {e2}\n\n提示：请检查服务器 SFTP 配置和用户权限"
                                )));
                            }
                        }
                    }
                    Err(e2) => return Err(AppError::Sftp(format!("重建连接失败: {e2}"))),
                }
            }

            // 非 session 类错误，直接返回
            Err(AppError::Sftp(format!("读取目录失败: {e}")))
        }
    }
}

/// 从 SFTP 目录条目构建 FileEntry 列表
///
/// 注意：部分 SFTP 服务端在 READDIR 响应中不返回权限位，会使
/// `entry.file_type()` 退化为 Other，从而把子目录误判为文件、在 UI 上显示为
/// 「文件」图标（用户易漏选）或在递归传输/删除时整棵子树被遗漏。因此对「非明确
/// 文件」的条目一律用 stat 兜底确认真实类型；正常服务端（OpenSSH 等）返回了权限位，
/// 走 is_dir/is_symlink/is_file 分支，零额外往返开销。
async fn build_file_list(
    sftp: &Arc<Mutex<SftpSession>>,
    entries: russh_sftp::client::fs::ReadDir,
    path: &str,
) -> Vec<FileEntry> {
    let mut result: Vec<FileEntry> = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let full = if path.ends_with('/') {
            format!("{}{}", path, name)
        } else {
            format!("{}/{}", path, name)
        };
        let meta = entry.metadata();
        let ft = entry.file_type();
        let (kind, is_symlink) = if ft.is_dir() {
            ("dir", false)
        } else if ft.is_symlink() {
            ("symlink", true)
        } else if ft.is_file() {
            ("file", false)
        } else {
            // 权限位缺失导致类型退化：stat 兜底确认
            let is_dir = sftp
                .lock()
                .await
                .metadata(&full)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if is_dir {
                ("dir", false)
            } else {
                ("file", false)
            }
        };
        result.push(FileEntry {
            name,
            path: full,
            kind: kind.to_string(),
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.map(|m| m as i64),
            permissions: meta.permissions,
            uid: None,
            gid: None,
            is_symlink,
        });
    }

    result.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") | ("dir", "symlink") => std::cmp::Ordering::Less,
        ("file", "dir") | ("symlink", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    result
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
                uid: meta.uid,
                gid: meta.gid,
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
    create_dir_all_remote(&sftp, &path).await?;
    Ok(())
}

/// 递归创建远端目录（多级路径一次创建，已存在的部分忽略）。
/// 直接复用底层连接，避免为每层目录重复建连。
async fn create_dir_all_remote(
    sftp: &Arc<Mutex<SftpSession>>,
    path: &str,
) -> Result<(), AppError> {
    let normalized = path.trim_end_matches('/');
    if normalized.is_empty() {
        return Ok(());
    }
    let mut cur = String::new();
    for part in normalized.split('/') {
        if part.is_empty() {
            continue;
        }
        if cur.is_empty() {
            cur = part.to_string();
        } else {
            cur.push('/');
            cur.push_str(part);
        }
        // 已存在则忽略（create_dir 在目录已存在时会报错）
        if sftp.lock().await.create_dir(&cur).await.is_err() {
            // 仅当该路径确实不是目录时才向上抛错
            let is_dir = sftp
                .lock()
                .await
                .metadata(cur.as_str())
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if !is_dir {
                return Err(AppError::Sftp(format!("创建目录失败: {cur}")));
            }
        }
    }
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
        let is_dir = if ft.is_dir() {
            true
        } else if ft.is_file() {
            false
        } else {
            // 权限位缺失导致类型退化：stat 兜底确认，避免子目录被当文件遗漏
            sftp.lock()
                .await
                .metadata(&full)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
        };
        if is_dir {
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

/// 修改远端文件/目录权限（chmod）。
/// mode 为 Unix 权限位（如 0o755 = 493）。仅设置权限位，不影响其余属性。
#[tauri::command]
pub async fn sftp_chmod(
    app: AppHandle,
    server: ServerConfig,
    path: String,
    mode: u32,
) -> Result<(), AppError> {
    let sftp = get_sftp(&app, &server).await?;
    let mut attrs = FileAttributes::default();
    attrs.permissions = Some(mode);
    sftp.lock()
        .await
        .set_metadata(path.as_str(), attrs)
        .await
        .map_err(|e| AppError::Sftp(format!("修改权限失败: {e}")))?;
    Ok(())
}

/// 创建远端符号链接：在 link_path 处创建指向 target 的链接。
#[tauri::command]
pub async fn sftp_symlink(
    app: AppHandle,
    server: ServerConfig,
    target: String,
    link_path: String,
) -> Result<(), AppError> {
    let sftp = get_sftp(&app, &server).await?;
    sftp.lock()
        .await
        .symlink(link_path.as_str(), target.as_str())
        .await
        .map_err(|e| AppError::Sftp(format!("创建符号链接失败: {e}")))?;
    Ok(())
}

/// 读取符号链接指向的目标路径（供前端“属性”展示）。
#[tauri::command]
pub async fn sftp_readlink(
    app: AppHandle,
    server: ServerConfig,
    path: String,
) -> Result<String, AppError> {
    let sftp = get_sftp(&app, &server).await?;
    let target = sftp
        .lock()
        .await
        .read_link(path.as_str())
        .await
        .map_err(|e| AppError::Sftp(format!("读取链接失败: {e}")))?;
    Ok(target)
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
                let ft = entry.file_type();
                let is_dir = if ft.is_dir() {
                    true
                } else if ft.is_file() {
                    false
                } else {
                    sftp.lock()
                        .await
                        .metadata(&s)
                        .await
                        .map(|m| m.is_dir())
                        .unwrap_or(false)
                };
                if is_dir {
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
    offset: Option<u64>,
) -> Result<(), AppError> {
    let offset = offset.unwrap_or(0);
    // 传输失败且原因为 session closed 时，剔除失效会话后自动重试一次
    let mut last_err = None;
    for attempt in 0..2 {
        let sftp = get_sftp(&app, &server).await?;

        // 检查远端路径是否为目录
        let is_dir = sftp.lock().await
            .metadata(remote.as_str())
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false);

        let result = if is_dir {
            sftp_download_dir(&app, &sftp, &remote, &local, &task_id, offset).await
        } else {
            sftp_download_file(&app, &sftp, &remote, &local, &task_id, offset).await
        };
        match result {
            Ok(_) => return Ok(()),
            Err(e) => {
                let err_msg = e.to_string();
                let is_session_err = err_msg.contains("session closed")
                    || err_msg.contains("connection closed")
                    || err_msg.contains("broken pipe")
                    || err_msg.contains("EOF")
                    || err_msg.contains("reset by peer");
                if is_session_err && attempt == 0 {
                    eprintln!("[sftp] download session lost, retrying after eviction...");
                    evict_sftp_session(&app, &server).await;
                    evict_ssh_handle(&app, &server).await;
                    last_err = Some(e);
                    continue;
                }
                return Err(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Sftp("下载重试失败".into())))
}

/// 下载单个远端文件到本地。返回实际传输字节数（供目录传输累计进度）。
/// offset>0 时断点续传：远端文件 seek 到 offset 跳过已传部分，本地文件以 append 模式续写。
async fn sftp_download_file(
    app: &AppHandle,
    sftp: &Arc<Mutex<SftpSession>>,
    remote: &str,
    local: &str,
    task_id: &str,
    offset: u64,
) -> Result<u64, AppError> {
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
    // 断点续传：跳过远端已传部分
    if offset > 0 {
        remote_file
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(AppError::Io)?;
    }

    let mut local_file = if offset > 0 {
        tokio::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(local)
            .await
            .map_err(AppError::Io)?
    } else {
        tokio::fs::File::create(local).await.map_err(AppError::Io)?
    };

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = offset;
    let started = Instant::now();

    emit_progress(
        app, task_id,
        &TransferProgress {
            task_id: task_id.to_string(),
            transferred: done, total, speed: 0,
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
        // 取消判定：命中则提前结束并标记 cancelled
        if is_cancelled(app, task_id).await {
            emit_progress(
                app,
                task_id,
                &TransferProgress {
                    task_id: task_id.to_string(),
                    transferred: done,
                    total: done.max(total),
                    speed: 0,
                    status: "cancelled".into(),
                    message: Some("已取消".into()),
                },
            );
            {
                let state = app.state::<AppState>();
                state.cancelled_transfers.lock().await.remove(task_id);
            }
            return Err(AppError::Sftp("TRANSFER_CANCELLED".into()));
        }
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
    Ok(done)
}

/// 递归下载远端目录到本地。返回实际传输字节数；累计真实总大小用于进度展示（B4）。
/// offset 仅用于目录内首个普通文件的断点续传（目录级续传为近似实现）。
async fn sftp_download_dir(
    app: &AppHandle,
    sftp: &Arc<Mutex<SftpSession>>,
    remote_dir: &str,
    local_dir: &str,
    task_id: &str,
    offset: u64,
) -> Result<u64, AppError> {
    tokio::fs::create_dir_all(local_dir).await.map_err(AppError::Io)?;

    let mut total: u64 = 0;
    let mut done: u64 = 0;
    let mut first_offset = offset; // 仅首个普通文件续传

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

        // 判定条目类型：部分 SFTP 服务端在 READDIR 响应中不返回权限位，会使
        // file_type() 退化为 Other，从而把子目录误判为普通文件、整棵子树被静默遗漏。
        // 因此仅对「明确为文件」的条目跳过 stat，其余（目录/符号链接/未知）一律用
        // stat 兜底确认，确保子目录被正确递归。
        let ft = entry.file_type();
        let is_dir = if ft.is_dir() {
            true
        } else if ft.is_file() {
            false
        } else {
            sftp.lock()
                .await
                .metadata(&remote_path)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
        };

        if is_dir {
            done += Box::pin(sftp_download_dir(app, sftp, &remote_path, &local_path, task_id, 0)).await?;
        } else {
            let sz = sftp.lock().await
                .metadata(&remote_path)
                .await
                .ok()
                .and_then(|m| m.size)
                .unwrap_or(0);
            total += sz;
            emit_progress(app, task_id, &TransferProgress {
                task_id: task_id.to_string(), transferred: done, total, speed: 0,
                status: "running".into(), message: Some(name.to_string()),
            });
            let n = sftp_download_file(app, sftp, &remote_path, &local_path, task_id, first_offset).await?;
            first_offset = 0;
            done += n;
            emit_progress(app, task_id, &TransferProgress {
                task_id: task_id.to_string(), transferred: done, total, speed: 0,
                status: "running".into(), message: None,
            });
        }
    }

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: done, total: total.max(done), speed: 0,
        status: "done".into(), message: Some(format!("目录已下载 {}", local_dir)),
    });
    if let Some(parent) = std::path::Path::new(local_dir).parent() {
        emit_dir_changed(app, "local", &parent.to_string_lossy());
    }
    Ok(done)
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    server: ServerConfig,
    local: String,
    remote: String,
    task_id: String,
    offset: Option<u64>,
    preserve_mtime: Option<bool>,
) -> Result<(), AppError> {
    let offset = offset.unwrap_or(0);
    let preserve = preserve_mtime.unwrap_or(false);
    // 检查本地路径是否为目录
    let local_meta = tokio::fs::metadata(local.as_str())
        .await
        .map_err(AppError::Io)?;

    // 传输失败且原因为 session closed 时，剔除失效会话后自动重试一次
    let mut last_err = None;
    for attempt in 0..2 {
        let sftp = get_sftp(&app, &server).await?;
        let result = if local_meta.is_dir() {
            sftp_upload_dir(&app, &sftp, &local, &remote, &task_id, offset, preserve).await
        } else {
            sftp_upload_file(&app, &sftp, &local, &remote, &task_id, offset, preserve).await
        };
        match result {
            Ok(_) => return Ok(()),
            Err(e) => {
                let err_msg = e.to_string();
                let is_session_err = err_msg.contains("session closed")
                    || err_msg.contains("connection closed")
                    || err_msg.contains("broken pipe")
                    || err_msg.contains("EOF")
                    || err_msg.contains("reset by peer");
                if is_session_err && attempt == 0 {
                    eprintln!("[sftp] upload session lost, retrying after eviction...");
                    evict_sftp_session(&app, &server).await;
                    evict_ssh_handle(&app, &server).await;
                    last_err = Some(e);
                    continue;
                }
                return Err(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Sftp("上传重试失败".into())))
}

/// 上传单个本地文件到远端。返回实际传输字节数（供目录累计进度）。
/// offset>0 时断点续传：本地文件 seek 到 offset，远端以 append 模式续写。
/// preserve_mtime=true 时上传完成后用本地修改时间回写远端 mtime（B6）。
async fn sftp_upload_file(
    app: &AppHandle,
    sftp: &Arc<Mutex<SftpSession>>,
    local: &str,
    remote: &str,
    task_id: &str,
    offset: u64,
    preserve_mtime: bool,
) -> Result<u64, AppError> {
    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(AppError::Io)?;
    let total = local_file.metadata().await.map_err(AppError::Io)?.len();

    // 断点续传：远端以 append 模式打开（保留已传内容），本地跳过已传部分
    let mut remote_file = if offset > 0 {
        sftp.lock().await
            .open_with_flags(remote, OpenFlags::WRITE | OpenFlags::APPEND | OpenFlags::CREATE)
            .await
            .map_err(|e| AppError::Sftp(format!("打开远端文件失败: {e}")))?
    } else {
        sftp.lock().await
            .create(remote)
            .await
            .map_err(|e| AppError::Sftp(format!("创建远端文件失败: {e}")))?
    };
    if offset > 0 {
        local_file
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(AppError::Io)?;
    }

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = offset;
    let started = Instant::now();

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: done, total, speed: 0,
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
        // 取消判定：命中则提前结束并标记 cancelled
        if is_cancelled(app, task_id).await {
            emit_progress(
                app,
                task_id,
                &TransferProgress {
                    task_id: task_id.to_string(),
                    transferred: done,
                    total: done.max(total),
                    speed: 0,
                    status: "cancelled".into(),
                    message: Some("已取消".into()),
                },
            );
            {
                let state = app.state::<AppState>();
                state.cancelled_transfers.lock().await.remove(task_id);
            }
            return Err(AppError::Sftp("TRANSFER_CANCELLED".into()));
        }
        let elapsed = started.elapsed().as_secs().max(1);
        emit_progress(app, task_id, &TransferProgress {
            task_id: task_id.to_string(), transferred: done, total, speed: done / elapsed,
            status: "running".into(), message: None,
        });
    }
    remote_file.close().await.map_err(AppError::Io)?;

    // 保留修改时间（仅 mtime，避免把本地临时文件权限误写到服务器）
    if preserve_mtime {
        if let Ok(meta) = tokio::fs::metadata(local).await {
            if let Ok(modified) = meta.modified() {
                if let Ok(secs) = modified.duration_since(UNIX_EPOCH) {
                    let mut attrs = FileAttributes::default();
                    attrs.mtime = Some(secs.as_secs() as u32);
                    let _ = sftp.lock().await.set_metadata(remote, attrs).await;
                }
            }
        }
    }

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: done, total, speed: 0,
        status: "done".into(), message: Some(format!("上传到 {}", remote)),
    });
    if let Some(parent) = std::path::Path::new(remote).parent() {
        emit_dir_changed(app, "remote", &parent.to_string_lossy());
    }
    Ok(done)
}

/// 递归上传本地目录到远端。返回实际传输字节数；累计真实总大小（B4）。
async fn sftp_upload_dir(
    app: &AppHandle,
    sftp: &Arc<Mutex<SftpSession>>,
    local_dir: &str,
    remote_dir: &str,
    task_id: &str,
    offset: u64,
    preserve_mtime: bool,
) -> Result<u64, AppError> {
    // 创建远端目录（已存在则忽略）
    let _ = sftp.lock().await.create_dir(remote_dir).await;

    let mut total: u64 = 0;
    let mut done: u64 = 0;
    let mut first_offset = offset;

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

        // 本地 FS 的 file_type 通常可靠，但符号链接/特殊文件可能退化；对「非明确文件」
        // 的条目用本地 metadata 兜底，确保链接指向的目录也能被正确递归上传。
        let file_type = entry.file_type().await.map_err(AppError::Io)?;
        let is_dir = if file_type.is_dir() {
            true
        } else if file_type.is_file() {
            false
        } else {
            tokio::fs::metadata(&local_path)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
        };

        if is_dir {
            done += Box::pin(sftp_upload_dir(app, sftp, &local_path, &remote_path, task_id, 0, preserve_mtime)).await?;
        } else {
            let sz = entry.metadata().await.map_err(AppError::Io)?.len();
            total += sz;
            emit_progress(app, task_id, &TransferProgress {
                task_id: task_id.to_string(), transferred: done, total, speed: 0,
                status: "running".into(), message: Some(name),
            });
            let n = sftp_upload_file(app, sftp, &local_path, &remote_path, task_id, first_offset, preserve_mtime).await?;
            first_offset = 0;
            done += n;
            emit_progress(app, task_id, &TransferProgress {
                task_id: task_id.to_string(), transferred: done, total, speed: 0,
                status: "running".into(), message: None,
            });
        }
    }

    emit_progress(app, task_id, &TransferProgress {
        task_id: task_id.to_string(), transferred: done, total: total.max(done), speed: 0,
        status: "done".into(), message: Some(format!("目录已上传 {}", remote_dir)),
    });
    if let Some(parent) = std::path::Path::new(remote_dir).parent() {
        emit_dir_changed(app, "remote", &parent.to_string_lossy());
    }
    Ok(done)
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
    sftp_download(app.clone(), server.clone(), remote.clone(), local.clone(), task_id, None).await?;
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
    sftp_download(app.clone(), server.clone(), remote.clone(), local.clone(), task_id, None).await?;
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
                match sftp_upload(app.clone(), server.clone(), local.clone(), remote.clone(), up_id, None, Some(true)).await {
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
