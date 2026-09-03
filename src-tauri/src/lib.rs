// Shelflux 后端入口
// 仅在 lib 中导出 run()，main.rs 简单地调用它。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;

mod commands;
mod error;
mod state;
mod types;

pub use error::AppError;
pub use state::AppState;
pub use types::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            shells: Arc::new(Mutex::new(HashMap::new())),
            forwards: Arc::new(Mutex::new(commands::forward::new_map())),
            sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            ssh_pool: Arc::new(Mutex::new(HashMap::new())),
            cancelled_transfers: Arc::new(Mutex::new(HashSet::new())),
        })
        .setup(|app| {
            // known_hosts 持久化目录：<app_data_dir>/known_hosts.json
            use tauri::Manager;
            if let Ok(dir) = app.path().app_data_dir() {
                commands::known_hosts::init(dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::client_handler::test_connection,
            commands::ssh::ssh_shell_connect,
            commands::ssh::ssh_shell_write,
            commands::ssh::ssh_shell_resize,
            commands::ssh::ssh_shell_close,
            commands::sftp::sftp_list,
            commands::sftp::sftp_download,
            commands::sftp::sftp_upload,
            commands::sftp::cancel_transfer,
            commands::sftp::open_remote_file,
            commands::sftp::open_remote_file_with,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_chmod,
            commands::sftp::sftp_symlink,
            commands::sftp::sftp_readlink,
            commands::sftp::sftp_create_file,
            commands::sftp::sftp_exists,
            commands::sftp::sftp_stat,
            commands::sftp::sftp_copy,
            commands::local::local_list,
            commands::local::local_home,
            commands::local::local_drives,
            commands::local::local_mkdir,
            commands::local::local_remove,
            commands::local::local_rename,
            commands::local::local_create_file,
            commands::local::local_write_file,
            commands::local::local_exists,
            commands::local::local_stat,
            commands::local::local_copy,
            commands::known_hosts::known_hosts_list,
            commands::known_hosts::known_hosts_remove,
            commands::known_hosts::known_hosts_clear,
            commands::known_hosts::known_hosts_trust,
            commands::forward::forward_start,
            commands::forward::forward_stop,
            commands::forward::forward_list,
            commands::forward::forward_stop_all,
            commands::system::open_with_default_app,
            commands::system::open_with_program,
            commands::system::open_with_dialog,
            commands::system::get_open_with_apps,
            commands::system::copy_to_clipboard,
            commands::system::read_from_clipboard,
            commands::system::get_app_info,
            commands::update::check_update,
            commands::update::download_update,
            commands::update::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Shelflux");
}
