// 更新命令 - 检查 GitHub 最新版本、下载、安装
//
// 流程（由前端 Settings → 关于 驱动）：
//   1. check_update    → 调 GitHub Releases API，比较版本，挑出当前平台对应的安装包
//   2. download_update → 把安装包下载到系统临时目录，返回本地路径
//   3. install_update  → 用系统默认程序打开安装包（Windows 跑 setup / macOS 挂 dmg），随后退出当前进程

use std::process::Command;
use tauri::AppHandle;
use serde::Serialize;

use crate::error::AppError;

const REPO_API: &str = "https://api.github.com/repos/duhuilai/Shelflux/releases/latest";

#[derive(Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_notes: String,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
    pub size: Option<u64>,
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, AppError> {
    let current = app.package_info().version.to_string();

    let client = reqwest::Client::builder()
        .user_agent("Shelflux")
        .build()
        .map_err(|e| AppError::Other(format!("创建请求客户端失败: {e}")))?;

    let resp = client
        .get(REPO_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Other(format!("无法连接更新服务器: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Other(format!("检查更新失败，状态码 {}", resp.status())));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("解析更新信息失败: {e}")))?;

    let tag = json["tag_name"].as_str().unwrap_or("").to_string();
    let latest = tag.trim_start_matches('v').to_string();
    let release_notes = json["body"].as_str().unwrap_or("").to_string();

    // 挑出当前平台对应的资源
    let mut download_url: Option<String> = None;
    let mut asset_name: Option<String> = None;
    let mut size: Option<u64> = None;
    if let Some(assets) = json["assets"].as_array() {
        for a in assets {
            let name = a["name"].as_str().unwrap_or("").to_string();
            if asset_matches_current_platform(&name) {
                download_url = a["browser_download_url"].as_str().map(|s| s.to_string());
                asset_name = Some(name);
                size = a["size"].as_u64();
                break;
            }
        }
    }

    let has_update = is_newer(&current, &latest) && download_url.is_some();

    let latest_version = if latest.is_empty() {
        current.clone()
    } else {
        latest
    };

    Ok(UpdateInfo {
        current_version: current,
        latest_version,
        has_update,
        release_notes,
        download_url,
        asset_name,
        size,
    })
}

#[tauri::command]
pub async fn download_update(download_url: String) -> Result<String, AppError> {
    let client = reqwest::Client::builder()
        .user_agent("Shelflux")
        .build()
        .map_err(|e| AppError::Other(format!("创建请求客户端失败: {e}")))?;

    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("下载失败: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Other(format!("下载失败，状态码 {}", resp.status())));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Other(format!("读取下载数据失败: {e}")))?;

    let file_name = download_url
        .rsplit('/')
        .next()
        .unwrap_or("shelflux-update")
        .to_string();
    let dir = std::env::temp_dir().join("shelflux-update");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(AppError::Io)?;
    let path = dir.join(&file_name);
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(AppError::Io)?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn install_update(_app: AppHandle, path: String) -> Result<(), AppError> {
    // 用系统默认程序打开安装包：Windows 启动 setup.exe / .msi，macOS 挂载 .dmg
    open_with_default_handler(&path)?;
    // 等安装程序真正起来后再退出当前进程
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    std::process::exit(0);
}

/// 按操作系统用原生方式打开文件（不依赖 plugin-opener 的 scope 限制）
fn open_with_default_handler(path: &str) -> Result<(), AppError> {
    let result = {
        #[cfg(target_os = "windows")]
        {
            // cmd /c start "" "path" —— 第一个引号参数是窗口标题，其后才是文件
            Command::new("cmd")
                .args(["/c", "start", "", path])
                .spawn()
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("open").arg(path).spawn()
        }
        #[cfg(target_os = "linux")]
        {
            Command::new("xdg-open").arg(path).spawn()
        }
    };
    result.map_err(|e| AppError::Other(format!("启动安装程序失败: {e}")))?;
    Ok(())
}

/// 判断资源名是否对应当前运行平台
fn asset_matches_current_platform(name: &str) -> bool {
    let lower = name.to_lowercase();
    #[cfg(target_os = "windows")]
    {
        if lower.contains("setup") && lower.ends_with(".exe") {
            return true;
        }
        if lower.ends_with(".exe") {
            return true;
        }
        if lower.ends_with(".msi") {
            return true;
        }
        false
    }
    #[cfg(target_os = "macos")]
    {
        lower.contains("dmg")
    }
    #[cfg(target_os = "linux")]
    {
        lower.ends_with(".appimage") || lower.ends_with(".deb") || lower.contains("linux")
    }
}

/// 语义化版本比较：latest 是否比 current 新
fn parse_version(v: &str) -> Vec<u32> {
    v.trim_start_matches('v')
        .split('.')
        .filter_map(|p| p.parse::<u32>().ok())
        .collect()
}

fn is_newer(current: &str, latest: &str) -> bool {
    let c = parse_version(current);
    let l = parse_version(latest);
    if c.is_empty() || l.is_empty() {
        return false;
    }
    let n = c.len().max(l.len());
    for i in 0..n {
        let a = *c.get(i).unwrap_or(&0);
        let b = *l.get(i).unwrap_or(&0);
        if b > a {
            return true;
        }
        if b < a {
            return false;
        }
    }
    false
}
