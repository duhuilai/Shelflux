// 系统命令 - 打开文件、剪贴板、版本信息

use tauri::AppHandle;
use tauri::Manager;
use arboard::Clipboard as ArboardClipboard;

use crate::error::AppError;
use crate::types::{AppInfo, OpenWithApp};

#[cfg(target_os = "windows")]
use winreg::RegKey;

#[tauri::command]
pub async fn open_with_default_app(
    _app: AppHandle,
    path: String,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        #[cfg(target_os = "windows")]
        {
            // Windows: 用 ShellExecuteW 以系统默认程序打开文件
            // 绕过 plugin-opener 的 scope 限制（.shelflux-cache 等路径不在默认允许列表中）
            use std::os::windows::ffi::OsStrExt;
            let wide_path: Vec<u16> =
                std::ffi::OsStr::new(&path).encode_wide().chain(std::iter::once(0)).collect();
            let wide_dir: Vec<u16> =
                if let Some(p) = std::path::Path::new(&path).parent() {
                    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
                } else {
                    vec![0]
                };

            let result = unsafe {
                winapi::um::shellapi::ShellExecuteW(
                    std::ptr::null_mut(),
                    std::ptr::null(),           // 默认操作 "open"
                    wide_path.as_ptr(),         // 文件路径（lpFile）
                    std::ptr::null(),           // 无参数
                    wide_dir.as_ptr(),          // 工作目录
                    winapi::um::winuser::SW_SHOWNORMAL,
                )
            };
            if result as i32 <= 32 {
                return Err(AppError::Other(format!(
                    "无法打开文件 {} (错误码: {})",
                    path, result as i32
                )));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            #[cfg(target_os = "macos")]
            let result = std::process::Command::new("open").arg(&path).spawn();
            #[cfg(target_os = "linux")]
            let result = std::process::Command::new("xdg-open").arg(&path).spawn();
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            result.map_err(|e| AppError::Other(format!("打开文件失败: {e}")))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("任务执行失败: {e}")))?
}

/// 用指定的程序打开文件
#[tauri::command]
pub async fn open_with_program(
    _app: AppHandle,
    file_path: String,
    program_path: String,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        #[cfg(target_os = "windows")]
        {
            // Windows: 用 ShellExecuteW 打开，这样能正确处理含空格的路径、URL 等
            use std::os::windows::ffi::OsStrExt;
            let wide_file: Vec<u16> =
                std::ffi::OsStr::new(&file_path).encode_wide().chain(std::iter::once(0)).collect();
            let wide_prog: Vec<u16> = std::ffi::OsStr::new(&program_path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let wide_dir: Vec<u16> = if let Some(p) = std::path::Path::new(&file_path).parent() {
                p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
            } else {
                vec![0]
            };

            // 若程序路径只是文件名（不含分隔符，如旧设置存的 "Notepad--.exe"），
            // 无法可靠定位该程序，退回用系统默认程序打开文件
            if !program_path.contains('\\') && !program_path.contains('/') {
                let result = unsafe {
                    winapi::um::shellapi::ShellExecuteW(
                        std::ptr::null_mut(),
                        std::ptr::null(),
                        wide_file.as_ptr(),
                        std::ptr::null(),
                        wide_dir.as_ptr(),
                        winapi::um::winuser::SW_SHOWNORMAL,
                    )
                };
                if result as i32 <= 32 {
                    return Err(AppError::Other(format!(
                        "无法打开文件 {} (错误码: {})",
                        file_path, result as i32
                    )));
                }
                return Ok(());
            }

            let result = unsafe {
                winapi::um::shellapi::ShellExecuteW(
                    std::ptr::null_mut(),
                    std::ptr::null(),           // 默认操作 "open"
                    wide_prog.as_ptr(),          // 程序路径（lpFile）
                    wide_file.as_ptr(),          // 文件路径作为参数（lpParameters）
                    wide_dir.as_ptr(),           // 工作目录
                    winapi::um::winuser::SW_SHOWNORMAL,
                )
            };
            if result as i32 <= 32 {
                return Err(AppError::Other(format!(
                    "无法用 {} 打开文件 {} (错误码: {})",
                    program_path, file_path, result as i32
                )));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::process::Command::new(&program_path)
                .arg(&file_path)
                .spawn()
                .map_err(|e| AppError::Other(format!("打开文件失败: {e}")))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("任务执行失败: {e}")))?
}

/// 调用系统"打开方式"对话框，让用户选择程序打开文件。
/// Windows 用 Shell 的 SHOpenWithDialog（比 rundll32 OpenAs_RunDLL 可靠：
/// 直接以 UTF-16 指针传路径，不依赖命令行解析，天然支持含空格的路径；
/// 也不会被 CREATE_NO_WINDOW 之类标志抑制窗口）。
#[cfg(target_os = "windows")]
#[repr(C)]
struct OpenAsInfo {
    file: *const u16,
    class: *const u16,
    flags: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "shell32")]
extern "system" {
    fn SHOpenWithDialog(hwnd_parent: *mut std::ffi::c_void, info: *const OpenAsInfo) -> i32;
}

#[tauri::command]
pub async fn open_with_dialog(path: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use std::ptr;

            // 路径转 UTF-16（以 null 结尾），直接作为指针传入，避免命令行解析出错
            let wide: Vec<u16> = std::ffi::OsStr::new(&path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            const OAIF_ALLOW_REGISTRATION: u32 = 0x0000_0001;
            const OAIF_EXEC: u32 = 0x0000_0004;

            let info = OpenAsInfo {
                file: wide.as_ptr(),
                class: ptr::null(),
                flags: OAIF_ALLOW_REGISTRATION | OAIF_EXEC,
            };

            unsafe {
                SHOpenWithDialog(ptr::null_mut(), &info);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            // macOS / Linux 回退到系统打开命令
            #[cfg(target_os = "macos")]
            let result = std::process::Command::new("open").arg(&path).spawn();
            #[cfg(target_os = "linux")]
            let result = std::process::Command::new("xdg-open").arg(&path).spawn();
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            result.map_err(|e| AppError::Other(format!("打开文件失败: {e}")))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("任务执行失败: {e}")))?
}

#[tauri::command]
pub async fn copy_to_clipboard(_app: AppHandle, text: String) -> Result<(), AppError> {
    let mut cb = ArboardClipboard::new()
        .map_err(|e| AppError::Other(format!("创建剪贴板失败: {e}")))?;
    cb.set_text(text)
        .map_err(|e| AppError::Other(format!("写入剪贴板失败: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn read_from_clipboard(_app: AppHandle) -> Result<String, AppError> {
    let mut cb = ArboardClipboard::new()
        .map_err(|e| AppError::Other(format!("创建剪贴板失败: {e}")))?;
    let text = cb.get_text()
        .map_err(|e| AppError::Other(format!("读取剪贴板失败: {e}")))?;
    Ok(text)
}

#[tauri::command]
pub async fn get_app_info(app: AppHandle) -> Result<AppInfo, AppError> {
    let pkg = app.package_info();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("获取数据目录失败: {e}")))?;
    let home_dir = dirs::home_dir();

    Ok(AppInfo {
        version: pkg.version.to_string(),
        name: pkg.name.to_string(),
        data_dir,
        home_dir,
    })
}

/// 返回系统已安装的可用于"打开方式"的程序列表（仿 xftp 的打开方式对话框）。
/// Windows 从注册表 HKCR\Applications 枚举；并根据扩展名的 OpenWithList 把常用程序排前面。
#[tauri::command]
pub async fn get_open_with_apps(
    _app: AppHandle,
    extension: String,
) -> Result<Vec<OpenWithApp>, AppError> {
    #[cfg(target_os = "windows")]
    {
        let mut apps = read_installed_apps();
        if let Some(rec) = recommended_for_ext(&extension) {
            apps.sort_by_key(|a| {
                if rec
                    .iter()
                    .any(|r| a.path.to_lowercase().contains(r) || a.name.to_lowercase().contains(r))
                {
                    0
                } else {
                    1
                }
            });
        }
        Ok(apps)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = extension;
        Ok(vec![])
    }
}

#[cfg(target_os = "windows")]
fn read_installed_apps() -> Vec<OpenWithApp> {
    use std::collections::HashSet;
    let mut result: Vec<OpenWithApp> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let hkcr = RegKey::predef(winreg::enums::HKEY_CLASSES_ROOT);
    let apps_key = match hkcr.open_subkey("Applications") {
        Ok(k) => k,
        Err(_) => return result,
    };

    for subkey_name in apps_key.enum_keys().filter_map(|s| s.ok()) {
        // 只处理 .exe 子键
        if !subkey_name.to_lowercase().ends_with(".exe") {
            continue;
        }

        let app_key = match apps_key.open_subkey(&subkey_name) {
            Ok(k) => k,
            Err(_) => continue,
        };

        // 策略 1: Application\ExePath（最可靠）
        let mut exe_path: String = app_key
            .open_subkey("Application")
            .ok()
            .and_then(|ak| ak.get_value::<String, _>("ExePath").ok())
            .filter(|p| !p.is_empty() && std::path::Path::new(p).exists())
            .unwrap_or_default();

        // 策略 2: shell\open\command 的默认值（系统记事本等用这种方式注册）
        if exe_path.is_empty() {
            if let Ok(open_cmd) = app_key
                .open_subkey("shell\\open\\command")
                .and_then(|c| c.get_value::<String, _>(""))
            {
                if let Some(parsed) = parse_command_exe_path(&open_cmd) {
                    if std::path::Path::new(&parsed).exists() {
                        exe_path = parsed;
                    }
                }
            }
        }

        // 如果两种方式都拿不到有效路径，跳过
        if exe_path.is_empty() {
            continue;
        }

        let canon = exe_path.to_lowercase();
        if !seen.insert(canon) {
            continue;
        }

        // 获取友好显示名（按优先级尝试）
        let name = resolve_app_display_name(&app_key, &exe_path, &subkey_name);

        result.push(OpenWithApp { name, path: exe_path });
    }

    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    result
}

/// 解析应用程序的友好显示名：
/// 1. 从 exe 文件的 VERSIONINFO 取 FileDescription > ProductName（最可靠）
/// 2. 注册表 FriendlyAppName 值（跳过 @ 间接字符串格式）
/// 3. 回退: 去掉 .exe 的键名
#[cfg(target_os = "windows")]
fn resolve_app_display_name(
    app_key: &winreg::RegKey,
    exe_path: &str,
    subkey_name: &str,
) -> String {
    // 优先级 1: exe 版本信息（FileDescription / ProductName）—— 最可靠
    if let Some(ver_name) = get_exe_file_description(exe_path) {
        return ver_name;
    }

    // 优先级 2: FriendlyAppName（跳过间接字符串引用和路径值）
    if let Ok(raw) = app_key.get_value::<String, _>("FriendlyAppName") {
        if is_friendly_name(&raw) {
            return raw;
        }
    }

    // 优先级 3: 默认值（跳过间接字符串引用和路径值）
    if let Ok(raw) = app_key.get_value::<String, _>("") {
        if is_friendly_name(&raw) {
            return raw;
        }
    }

    // 回退: 去掉 .exe 的键名
    subkey_name.trim_end_matches(".exe").to_string()
}

/// 判断注册表值是否是可读的友好名称（不是间接字符串引用、不是文件路径）
#[cfg(target_os = "windows")]
fn is_friendly_name(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('@') && !s.starts_with('%')
        && !s.contains('\\') && s.len() < 100
}

/// 从 shell\open\command 的命令字符串中提取 exe 路径。
/// 支持格式：
///   - `%SystemRoot%\system32\NOTEPAD.EXE %1`
///   - `"C:\Program Files\Code\Code.exe" "%1"`
///   - `notepad++.exe "%1"`
/// 返回展开环境变量后的纯路径（不含参数），解析失败返回 None
#[cfg(target_os = "windows")]
fn parse_command_exe_path(cmd: &str) -> Option<String> {
    let cmd = cmd.trim();

    // 展开环境变量（%SystemRoot% → C:\Windows 等）
    let expanded = std::env::var_os("OS")
        .map(|_| {
            // 用 Windows API 展开 %VAR%
            let wide: Vec<u16> = cmd
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let buf_len: u32 = 0;
            unsafe {
                winapi::um::processenv::ExpandEnvironmentStringsW(
                    wide.as_ptr(),
                    std::ptr::null_mut(),
                    0,
                );
            }
            if buf_len == 0 {
                return cmd.to_string();
            }
            let mut buf: Vec<u16> = vec![0; buf_len as usize];
            let written = unsafe {
                winapi::um::processenv::ExpandEnvironmentStringsW(
                    wide.as_ptr(),
                    buf.as_mut_ptr(),
                    buf_len,
                )
            };
            if written == 0 || written > buf_len {
                cmd.to_string()
            } else {
                // 截断到实际长度（含 null terminator）
                buf.truncate(written as usize);
                String::from_utf16_lossy(&buf[..(written as usize - 1)])
            }
        })
        .unwrap_or_else(|| cmd.to_string());

    let expanded = expanded.trim();

    // 如果整个命令被引号包裹，提取引号内内容
    if expanded.starts_with('"') {
        if let Some(end) = expanded[1..].find('"') {
            let path = &expanded[1..=end];
            return Some(path.to_string());
        }
        return None;
    }

    // 无引号：取第一个空格/制表符之前的部分作为路径
    let path_end = expanded
        .find(|c: char| c.is_whitespace())
        .unwrap_or(expanded.len());
    let path = &expanded[..path_end];

    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// 从 exe 文件的 VERSIONINFO 资源中提取 FileDescription 或 ProductName
#[cfg(target_os = "windows")]
fn get_exe_file_description(exe_path: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = std::path::Path::new(exe_path)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let size = unsafe {
        winapi::um::winver::GetFileVersionInfoSizeW(wide.as_ptr(), std::ptr::null_mut())
    };
    if size == 0 {
        return None;
    }

    let mut buf: Vec<u8> = vec![0; size as usize];
    let ok = unsafe {
        winapi::um::winver::GetFileVersionInfoW(
            wide.as_ptr(),
            0,
            size,
            buf.as_mut_ptr() as *mut _,
        )
    };
    if ok == 0 {
        return None;
    }

    // 查询语言代码页
    let mut cp: *mut winapi::ctypes::c_void = std::ptr::null_mut();
    let mut cp_len: u32 = 0;
    let trans_str: Vec<u16> = "\\VarFileInfo\\Translation"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        winapi::um::winver::VerQueryValueW(
            buf.as_ptr() as *const _,
            trans_str.as_ptr(),
            &mut cp,
            &mut cp_len,
        );
    }

    // 构造子块路径: \StringFileInfo\<lang_cp>\FileDescription
    let lang_hex = if cp_len >= 4 {
        let val = cp as u32;
        format!("{:04x}{:04x}", val & 0xFFFF, (val >> 16) & 0xFFFF)
    } else {
        "040904b0".to_string()
    };

    for prop in ["FileDescription", "ProductName"] {
        let sub_block = format!("\\StringFileInfo\\{}\\{}", lang_hex, prop);
        let sub_wide: Vec<u16> = sub_block
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut value_ptr: *mut winapi::ctypes::c_void = std::ptr::null_mut();
        let mut value_len: u32 = 0;

        unsafe {
            let ok = winapi::um::winver::VerQueryValueW(
                buf.as_ptr() as *const _,
                sub_wide.as_ptr(),
                &mut value_ptr,
                &mut value_len,
            );

            if ok != 0 && value_len > 0 && !value_ptr.is_null() {
                let ptr = value_ptr as *const u16;
                let slice = std::slice::from_raw_parts(ptr, (value_len as usize) - 1);
                let desc = String::from_utf16_lossy(slice);
                if !desc.is_empty() {
                    return Some(desc);
                }
            }
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn recommended_for_ext(ext: &str) -> Option<Vec<String>> {
    let ext = if ext.starts_with('.') {
        ext.to_string()
    } else {
        format!(".{}", ext)
    };
    let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let key_path = format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\{}",
        ext
    );
    let fe_key = hkcu.open_subkey(&key_path).ok()?;
    let mut rec: Vec<String> = Vec::new();

    // OpenWithList 的 MRUList 给出推荐顺序
    if let Ok(owl) = fe_key.open_subkey("OpenWithList") {
        if let Ok(mru) = owl.get_value::<String, _>("MRUList") {
            for ch in mru.chars() {
                if let Ok(val) = owl.get_value::<String, _>(&ch.to_string()) {
                    rec.push(val.to_lowercase());
                }
            }
        }
    }
    // OpenWithProgids 也给出关联的 progid
    if let Ok(owp) = fe_key.open_subkey("OpenWithProgids") {
        for name in owp.enum_values().filter_map(|v| v.ok()).map(|(n, _)| n) {
            rec.push(name.to_lowercase());
        }
    }

    if rec.is_empty() {
        None
    } else {
        Some(rec)
    }
}
