// 本地文件系统命令

use std::fs::{self, File};
use std::path::Path;

use crate::error::AppError;
use crate::types::FileEntry;

#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<FileEntry>, AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<FileEntry>, AppError> {
        let entries = fs::read_dir(&path)?;
        let mut result: Vec<FileEntry> = Vec::new();
        for entry in entries {
            let entry = entry?;
            let meta = entry.metadata().ok();
            let file_type = entry.file_type().ok();
            let name = entry.file_name().to_string_lossy().to_string();
            let full = entry.path().to_string_lossy().to_string();
            let (kind, is_symlink) = if file_type.as_ref().map(|f| f.is_symlink()).unwrap_or(false) {
                ("symlink".to_string(), true)
            } else if meta.as_ref().map(|m| m.is_dir()).unwrap_or(false) {
                ("dir".to_string(), false)
            } else {
                ("file".to_string(), false)
            };
            result.push(FileEntry {
                name,
                path: full,
                kind,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64),
                permissions: {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        meta.as_ref().map(|m| m.permissions().mode())
                    }
                    #[cfg(not(unix))]
                    {
                        None
                    }
                },
                is_symlink,
            });
        }
        result.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") | ("dir", "symlink") => std::cmp::Ordering::Less,
            ("file", "dir") | ("symlink", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(result)
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn local_home() -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, AppError> {
        Ok(dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Windows: 返回所有盘符；Unix: 返回 "/" 和 home
#[tauri::command]
pub async fn local_drives() -> Result<Vec<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, AppError> {
        #[cfg(windows)]
        {
            let mut drives = Vec::new();
            for letter in b'A'..=b'Z' {
                let path = format!("{}:\\", letter as char);
                if Path::new(&path).exists() {
                    drives.push(path);
                }
            }
            Ok(drives)
        }
        #[cfg(not(windows))]
        {
            let mut roots = vec!["/".to_string()];
            if let Some(home) = dirs::home_dir() {
                roots.push(home.to_string_lossy().to_string());
            }
            Ok(roots)
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        fs::create_dir_all(&path)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn local_create_file(path: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        File::create(&path)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// 将字节写入本地文件（供从系统资源管理器拖入本地面板时使用，浏览器不暴露真实路径）。
#[tauri::command]
pub async fn local_write_file(path: String, data: Vec<u8>) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        if let Some(parent) = Path::new(&path).parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, &data)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn local_remove(path: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let p = Path::new(&path);
        if p.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn local_rename(from: String, to: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        fs::rename(&from, &to)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// 本地同侧复制（文件或整个目录）
#[tauri::command]
pub async fn local_copy(from: String, to: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let src = Path::new(&from);
        if !src.exists() {
            return Err(AppError::NotFound(from.clone()));
        }
        if src.is_dir() {
            copy_dir_recursive(src, Path::new(&to))?;
        } else {
            if let Some(parent) = Path::new(&to).parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&from, &to)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn local_exists(path: String) -> Result<bool, AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, AppError> {
        Ok(Path::new(&path).exists())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn local_stat(path: String) -> Result<Option<FileEntry>, AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<FileEntry>, AppError> {
        let p = Path::new(&path);
        if !p.exists() {
            return Ok(None);
        }
        let meta = fs::metadata(&path)?;
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let kind = if meta.is_dir() { "dir" } else { "file" };
        Ok(Some(FileEntry {
            name,
            path: path.clone(),
            kind: kind.to_string(),
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64),
            permissions: {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    Some(meta.permissions().mode())
                }
                #[cfg(not(unix))]
                {
                    None
                }
            },
            is_symlink: false,
        }))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

