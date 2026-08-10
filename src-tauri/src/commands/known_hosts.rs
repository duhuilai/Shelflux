// 主机指纹（known_hosts）管理
//
// 采用 TOFU（Trust On First Use）策略：
//   * 首次连接某主机 -> 记录其公钥指纹并放行
//   * 之后连接指纹一致 -> 放行
//   * 指纹变化        -> 拒绝连接，并给出明确的错误提示，用户需在
//                        「设置 → 安全」中移除旧记录后才能重新信任
//
// 记录以 JSON 数组保存在应用数据目录的 known_hosts.json。
// 由于 `connect_session` 拿不到 AppHandle，这里用一个进程级 OnceLock
// 保存路径，在 tauri setup 阶段注入。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::error::AppError;
use crate::types::KnownHostEntry;

static STORE_PATH: OnceLock<PathBuf> = OnceLock::new();
/// 进程内缓存 + 写入串行化
static CACHE: OnceLock<Mutex<Vec<KnownHostEntry>>> = OnceLock::new();

/// 在应用启动时调用，注入数据目录
pub fn init(data_dir: PathBuf) {
    let path = data_dir.join("known_hosts.json");
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = STORE_PATH.set(path.clone());
    let list = read_from_disk(&path);
    let _ = CACHE.set(Mutex::new(list));
}

fn read_from_disk(path: &PathBuf) -> Vec<KnownHostEntry> {
    match std::fs::read_to_string(path) {
        Ok(txt) => serde_json::from_str::<Vec<KnownHostEntry>>(&txt).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn cache() -> &'static Mutex<Vec<KnownHostEntry>> {
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn flush(list: &[KnownHostEntry]) {
    if let Some(path) = STORE_PATH.get() {
        if let Ok(txt) = serde_json::to_string_pretty(list) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, txt);
        }
    }
}

fn key_of(host: &str, port: u16) -> (String, u16) {
    (host.to_lowercase(), port)
}

/// 查询已记录的指纹
pub fn lookup(host: &str, port: u16) -> Option<KnownHostEntry> {
    let (h, p) = key_of(host, port);
    let guard = cache().lock().ok()?;
    guard
        .iter()
        .find(|e| e.host.to_lowercase() == h && e.port == p)
        .cloned()
}

/// 新增或覆盖一条记录
pub fn upsert(host: &str, port: u16, key_type: &str, fingerprint: &str) {
    let (h, p) = key_of(host, port);
    let entry = KnownHostEntry {
        host: host.to_string(),
        port,
        key_type: key_type.to_string(),
        fingerprint: fingerprint.to_string(),
        added_at: now_secs(),
    };
    if let Ok(mut guard) = cache().lock() {
        if let Some(slot) = guard
            .iter_mut()
            .find(|e| e.host.to_lowercase() == h && e.port == p)
        {
            *slot = entry;
        } else {
            guard.push(entry);
        }
        flush(&guard);
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn known_hosts_list() -> Result<Vec<KnownHostEntry>, AppError> {
    let mut list = cache()
        .lock()
        .map(|g| g.clone())
        .map_err(|_| AppError::Other("读取 known_hosts 失败".into()))?;
    list.sort_by_key(|e| (e.host.to_lowercase(), e.port));
    Ok(list)
}

#[tauri::command]
pub async fn known_hosts_remove(host: String, port: u16) -> Result<(), AppError> {
    let (h, p) = key_of(&host, port);
    let mut guard = cache()
        .lock()
        .map_err(|_| AppError::Other("写入 known_hosts 失败".into()))?;
    guard.retain(|e| !(e.host.to_lowercase() == h && e.port == p));
    flush(&guard);
    Ok(())
}

#[tauri::command]
pub async fn known_hosts_clear() -> Result<(), AppError> {
    let mut guard = cache()
        .lock()
        .map_err(|_| AppError::Other("写入 known_hosts 失败".into()))?;
    guard.clear();
    flush(&guard);
    Ok(())
}

/// 手动信任（例如服务端合法更换了密钥）
#[tauri::command]
pub async fn known_hosts_trust(
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
) -> Result<(), AppError> {
    upsert(&host, port, &key_type, &fingerprint);
    Ok(())
}
