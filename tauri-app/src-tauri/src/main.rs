#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tabby_tauri::credential::{
    credential_delete_password as credential_delete_password_at,
    credential_get_password as credential_get_password_at,
    credential_set_password as credential_set_password_at,
};
use tabby_tauri::native_files::{
    access_path as native_fs_access_at, create_directory as native_create_directory_at,
    create_directory_in_directory as native_create_directory_in_directory_at,
    mkdir as native_fs_mkdir_at, pick_directory as native_pick_directory_at,
    pick_files as native_pick_files_at, pick_save_file as native_pick_save_file_at,
    prepare_download_directory as native_prepare_download_directory_at,
    prepare_download_file as native_prepare_download_file_at,
    prepare_download_file_in_directory as native_prepare_download_file_in_directory_at,
    read_file_chunk as native_read_file_chunk_at, read_text as native_fs_read_text_at,
    readdir as native_fs_readdir_at, realpath as native_fs_realpath_at,
    stat_path as native_stat_path_at, unlink as native_fs_unlink_at,
    upload_directory_tree as native_upload_directory_tree_at,
    write_file_chunk as native_write_file_chunk_at, write_text as native_fs_write_text_at,
    NativeFileMetadata, NativeUploadEntry,
};
use tabby_tauri::pty::{
    PtyChildProcess, PtyData, PtyManager, PtySizeSpec, PtySpawnRequest, PtySpawnResponse,
};
use tabby_tauri::session::{SessionKind, SessionRegistry, SessionSnapshot};
use tabby_tauri::ssh::{
    ssh_known_host_forget_at, ssh_known_host_get_at,
    ssh_known_host_mismatch_report as build_ssh_known_host_mismatch_report,
    ssh_known_host_trust_at, ssh_known_hosts_list_at, SftpDirectoryPlan, SftpFileEntry,
    SftpOpenFileResponse, SshConnectRequest, SshConnectResponse, SshData,
    SshDynamicPortForwardRequest, SshDynamicPortForwardResponse, SshHostKeyScanRequest,
    SshHostKeyScanResponse, SshKeepaliveProbeRequest, SshKeepaliveReport,
    SshKeyboardInteractivePromptEvent, SshKeyboardInteractiveResponseRequest, SshKnownHostEntry,
    SshKnownHostForgetRequest, SshKnownHostMismatchReport, SshKnownHostTrustRequest,
    SshLocalPortForwardRequest, SshLocalPortForwardResponse, SshManager,
    SshRemotePortForwardRequest, SshRemotePortForwardResponse, SshShellSize,
};
use tabby_tauri::tcp::{TcpConnectRequest, TcpConnectResponse, TcpData, TcpManager};
use tabby_tauri::vault::{
    vault_decrypt as vault_decrypt_at, vault_encrypt as vault_encrypt_at,
    vault_random_bytes as vault_random_bytes_at, StoredVault,
};
use tauri::Manager;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GlobalFree, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, HWND,
};
#[cfg(windows)]
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
#[cfg(windows)]
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
#[cfg(windows)]
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
#[cfg(windows)]
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumValueW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CLASSES_ROOT,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_DWORD, REG_EXPAND_SZ, REG_SZ,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOW,
};
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::ShellExecuteW;
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

#[derive(Serialize)]
struct BootstrapData {
    platform: &'static str,
    bootstrap_component: &'static str,
    purpose: &'static str,
    environment: BTreeMap<String, String>,
    os_release: String,
    app_version: String,
    winscp_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NativeShellEntry {
    id: String,
    name: String,
    command: String,
    env: BTreeMap<String, String>,
}

#[derive(Serialize)]
struct PerfScenario {
    test_tabs: u16,
    source: &'static str,
}

#[derive(Deserialize, Serialize)]
struct PerfAutomationReport {
    requested_tabs: u16,
    opened_tabs: u16,
    source: String,
    errors: Vec<String>,
}

#[tauri::command]
fn bootstrap_data(app: tauri::AppHandle) -> BootstrapData {
    BootstrapData {
        platform: "windows",
        bootstrap_component: "TauriTabbyBootstrapComponent",
        purpose: "tabby-tauri-angular-runtime",
        environment: std::env::vars().collect(),
        os_release: platform_os_release(),
        app_version: app.package_info().version.to_string(),
        winscp_path: detect_winscp_path(),
    }
}

#[tauri::command]
fn shell_list() -> Vec<NativeShellEntry> {
    detect_windows_shells()
}

fn detect_windows_shells() -> Vec<NativeShellEntry> {
    let system_root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("WINDIR"))
        .unwrap_or_else(|_| "C:\\Windows".to_owned());
    let program_files = std::env::var("ProgramW6432")
        .or_else(|_| std::env::var("ProgramFiles"))
        .unwrap_or_else(|_| "C:\\Program Files".to_owned());
    vec![
        native_shell_entry(
            "powershell",
            "Windows PowerShell",
            PathBuf::from(&system_root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        ),
        native_shell_entry(
            "pwsh",
            "PowerShell",
            PathBuf::from(&program_files)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe"),
        ),
        native_shell_entry(
            "cmd",
            "Command Prompt",
            PathBuf::from(&system_root).join("System32").join("cmd.exe"),
        ),
    ]
}

fn native_shell_entry(id: &str, name: &str, command: PathBuf) -> NativeShellEntry {
    NativeShellEntry {
        id: id.to_owned(),
        name: name.to_owned(),
        command: command.to_string_lossy().to_string(),
        env: BTreeMap::new(),
    }
}

fn parse_test_tabs_from_args(args: &[String]) -> Option<u16> {
    for (index, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix("--test-tabs=") {
            return value.parse::<u16>().ok();
        }
        if arg == "--test-tabs" {
            return args
                .get(index + 1)
                .and_then(|value| value.parse::<u16>().ok());
        }
    }
    None
}

#[tauri::command]
fn perf_scenario() -> PerfScenario {
    if let Ok(value) = std::env::var("TABBY_TAURI_TEST_TABS") {
        if let Ok(test_tabs) = value.parse::<u16>() {
            return PerfScenario {
                test_tabs,
                source: "env",
            };
        }
    }

    let args: Vec<String> = std::env::args().collect();
    if let Some(test_tabs) = parse_test_tabs_from_args(&args) {
        return PerfScenario {
            test_tabs,
            source: "argv",
        };
    }

    PerfScenario {
        test_tabs: 0,
        source: "none",
    }
}

#[tauri::command]
fn record_perf_automation(report: PerfAutomationReport) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!(
        "tabby-tauri-perf-automation-{}.json",
        std::process::id()
    ));
    let payload = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    std::fs::write(&path, payload).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .or_else(|_| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("Tabby Tauri"))
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "LOCALAPPDATA is not set")
                })
        })
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("config.yaml"))
}

fn known_hosts_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .or_else(|_| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("Tabby Tauri"))
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "LOCALAPPDATA is not set")
                })
        })
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("ssh-known-hosts.json"))
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<String, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, content: String) -> Result<(), String> {
    std::fs::write(config_path(&app)?, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn credential_get_password(service: String, account: String) -> Result<Option<String>, String> {
    credential_get_password_at(&service, &account)
}

#[tauri::command]
fn credential_set_password(
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    credential_set_password_at(&service, &account, &password)
}

#[tauri::command]
fn credential_delete_password(service: String, account: String) -> Result<bool, String> {
    credential_delete_password_at(&service, &account)
}

#[tauri::command]
fn vault_encrypt(content_json: String, passphrase: String) -> Result<StoredVault, String> {
    vault_encrypt_at(content_json, passphrase)
}

#[tauri::command]
fn vault_decrypt(vault: StoredVault, passphrase: String) -> Result<String, String> {
    vault_decrypt_at(vault, passphrase)
}

#[tauri::command]
fn vault_random_bytes(length: usize) -> Result<Vec<u8>, String> {
    vault_random_bytes_at(length)
}

fn fallback_fonts() -> Vec<String> {
    vec![
        "Cascadia Mono".to_owned(),
        "Cascadia Code".to_owned(),
        "Consolas".to_owned(),
        "Courier New".to_owned(),
    ]
}

fn parse_windows_font_name(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("HKEY_") {
        return None;
    }

    let value_name = trimmed
        .find("REG_")
        .map(|index| &trimmed[..index])
        .unwrap_or(trimmed)
        .trim();
    if value_name.is_empty() {
        return None;
    }
    let font_name = value_name
        .split(" (")
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    Some(font_name.to_owned())
}

const WINDOWS_FONT_REGISTRY_SUBKEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";

#[cfg(windows)]
fn platform_font_names() -> Vec<String> {
    let mut fonts = Vec::new();
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        fonts.extend(query_windows_font_registry(root));
    }
    fonts
}

#[cfg(not(windows))]
fn platform_font_names() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn query_windows_font_registry(root: HKEY) -> Vec<String> {
    use std::ptr::{null, null_mut};

    let subkey = wide_null_terminated(WINDOWS_FONT_REGISTRY_SUBKEY);
    let mut key: HKEY = null_mut();
    let open_status =
        unsafe { RegOpenKeyExW(root, subkey.as_ptr(), 0, KEY_READ, &mut key as *mut HKEY) };
    if open_status != ERROR_SUCCESS {
        return Vec::new();
    }

    let mut fonts = Vec::new();
    let mut index = 0u32;
    loop {
        let mut name = vec![0u16; 256];
        loop {
            let mut name_len = name.len() as u32;
            let status = unsafe {
                RegEnumValueW(
                    key,
                    index,
                    name.as_mut_ptr(),
                    &mut name_len,
                    null(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            match status {
                ERROR_SUCCESS => {
                    if let Some(font) = parse_windows_font_name(&String::from_utf16_lossy(
                        &name[..name_len as usize],
                    )) {
                        fonts.push(font);
                    }
                    break;
                }
                ERROR_MORE_DATA => {
                    name.resize(name.len().saturating_mul(2), 0);
                }
                ERROR_NO_MORE_ITEMS => {
                    unsafe {
                        RegCloseKey(key);
                    }
                    return fonts;
                }
                _ => {
                    break;
                }
            }
        }
        index = index.saturating_add(1);
    }
}

#[cfg(windows)]
fn wide_null_terminated(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn registry_string(root: HKEY, subkey: &str, value_name: Option<&str>) -> Option<String> {
    use std::ptr::{null, null_mut};

    let subkey = wide_null_terminated(subkey);
    let mut key: HKEY = null_mut();
    let open_status =
        unsafe { RegOpenKeyExW(root, subkey.as_ptr(), 0, KEY_READ, &mut key as *mut HKEY) };
    if open_status != ERROR_SUCCESS {
        return None;
    }

    let value_name = value_name.map(wide_null_terminated);
    let value_name_ptr = value_name
        .as_ref()
        .map(|value| value.as_ptr())
        .unwrap_or(null());
    let mut value_type = 0u32;
    let mut bytes = 0u32;
    let size_status = unsafe {
        RegQueryValueExW(
            key,
            value_name_ptr,
            null_mut(),
            &mut value_type,
            null_mut(),
            &mut bytes,
        )
    };
    if size_status != ERROR_SUCCESS || !matches!(value_type, REG_SZ | REG_EXPAND_SZ) || bytes == 0 {
        unsafe {
            RegCloseKey(key);
        }
        return None;
    }

    let mut buffer = vec![0u16; (bytes as usize).saturating_add(1) / 2];
    let query_status = unsafe {
        RegQueryValueExW(
            key,
            value_name_ptr,
            null_mut(),
            &mut value_type,
            buffer.as_mut_ptr() as *mut u8,
            &mut bytes,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if query_status != ERROR_SUCCESS {
        return None;
    }

    Some(
        String::from_utf16_lossy(&buffer)
            .trim_end_matches('\0')
            .trim()
            .to_owned(),
    )
    .filter(|value| !value.is_empty())
}

#[cfg(windows)]
fn registry_dword(root: HKEY, subkey: &str, value_name: &str) -> Option<u32> {
    use std::ptr::null_mut;

    let subkey = wide_null_terminated(subkey);
    let value_name = wide_null_terminated(value_name);
    let mut key: HKEY = null_mut();
    let open_status =
        unsafe { RegOpenKeyExW(root, subkey.as_ptr(), 0, KEY_READ, &mut key as *mut HKEY) };
    if open_status != ERROR_SUCCESS {
        return None;
    }

    let mut value_type = 0u32;
    let mut data = 0u32;
    let mut bytes = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            null_mut(),
            &mut value_type,
            &mut data as *mut u32 as *mut u8,
            &mut bytes,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if status == ERROR_SUCCESS && value_type == REG_DWORD {
        Some(data)
    } else {
        None
    }
}

#[cfg(windows)]
const WINDOWS_VERSION_REGISTRY_SUBKEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

#[cfg(windows)]
fn format_windows_release(
    product_name: Option<String>,
    display_version: Option<String>,
    build_number: Option<String>,
    ubr: Option<u32>,
) -> String {
    let product_name = product_name.unwrap_or_else(|| "Windows".to_owned());
    let mut release = product_name;
    if let Some(display_version) = display_version.filter(|value| !value.is_empty()) {
        release.push(' ');
        release.push_str(&display_version);
    }
    if let Some(build_number) = build_number.filter(|value| !value.is_empty()) {
        release.push_str(" (build ");
        release.push_str(&build_number);
        if let Some(ubr) = ubr {
            release.push('.');
            release.push_str(&ubr.to_string());
        }
        release.push(')');
    }
    release
}

#[cfg(windows)]
fn platform_os_release() -> String {
    format_windows_release(
        registry_string(
            HKEY_LOCAL_MACHINE,
            WINDOWS_VERSION_REGISTRY_SUBKEY,
            Some("ProductName"),
        ),
        registry_string(
            HKEY_LOCAL_MACHINE,
            WINDOWS_VERSION_REGISTRY_SUBKEY,
            Some("DisplayVersion"),
        )
        .or_else(|| {
            registry_string(
                HKEY_LOCAL_MACHINE,
                WINDOWS_VERSION_REGISTRY_SUBKEY,
                Some("ReleaseId"),
            )
        }),
        registry_string(
            HKEY_LOCAL_MACHINE,
            WINDOWS_VERSION_REGISTRY_SUBKEY,
            Some("CurrentBuildNumber"),
        ),
        registry_dword(HKEY_LOCAL_MACHINE, WINDOWS_VERSION_REGISTRY_SUBKEY, "UBR"),
    )
}

#[cfg(not(windows))]
fn platform_os_release() -> String {
    std::env::consts::OS.to_owned()
}

fn parse_winscp_default_icon(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split('"').next().unwrap_or_default()
    } else {
        trimmed.split(',').next().unwrap_or_default().trim()
    };
    (!path.is_empty()).then(|| path.to_owned())
}

#[cfg(windows)]
fn detect_winscp_path() -> Option<String> {
    registry_string(HKEY_CLASSES_ROOT, r"WinSCP.Url\DefaultIcon", None)
        .and_then(|value| parse_winscp_default_icon(&value))
}

#[cfg(not(windows))]
fn detect_winscp_path() -> Option<String> {
    None
}

#[tauri::command]
fn list_fonts() -> Vec<String> {
    let mut fonts = BTreeSet::new();
    fonts.extend(platform_font_names());

    if fonts.is_empty() {
        return fallback_fonts();
    }

    fonts.into_iter().collect()
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    open_external_target(&url)
}

#[tauri::command]
fn open_path_allowlisted(path: String) -> Result<(), String> {
    open_path_allowlisted_target(&path)
}

#[derive(Debug, PartialEq, Eq)]
enum ExecAllowlistMode {
    WinScpKeygen,
    WinScpLaunch,
}

#[tauri::command]
fn exec_allowlisted(app: String, argv: Vec<String>) -> Result<(), String> {
    let mode = validate_exec_allowlist(&app, &argv)?;
    run_allowlisted_process(&app, &argv, mode)
}

fn validate_exec_allowlist(app: &str, argv: &[String]) -> Result<ExecAllowlistMode, String> {
    validate_exec_allowlist_with_winscp(app, argv, detect_winscp_path().as_deref())
}

fn validate_exec_allowlist_with_winscp(
    app: &str,
    argv: &[String],
    winscp_path: Option<&str>,
) -> Result<ExecAllowlistMode, String> {
    validate_exec_arg("app", app)?;
    for arg in argv {
        validate_exec_arg("argument", arg)?;
    }

    let winscp_path = winscp_path.ok_or_else(|| {
        "exec_allowlisted rejected command: WinSCP path is unavailable".to_owned()
    })?;
    let winscp_com = winscp_com_path(winscp_path).ok_or_else(|| {
        "exec_allowlisted rejected command: WinSCP CLI path is unavailable".to_owned()
    })?;

    if paths_match_for_allowlist(app, &winscp_com) {
        validate_winscp_keygen_args(argv)?;
        return Ok(ExecAllowlistMode::WinScpKeygen);
    }

    if paths_match_for_allowlist(app, winscp_path) {
        validate_winscp_launch_args(argv)?;
        return Ok(ExecAllowlistMode::WinScpLaunch);
    }

    Err("exec_allowlisted rejected unsupported command".to_owned())
}

fn validate_exec_arg(name: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("exec {name} must not be empty"));
    }
    if value.contains('\0') {
        return Err(format!("exec {name} must not contain NUL"));
    }
    Ok(())
}

fn winscp_com_path(winscp_path: &str) -> Option<String> {
    let mut path = PathBuf::from(winscp_path);
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return None;
    }
    path.set_extension("com");
    Some(path.to_string_lossy().to_string())
}

fn paths_match_for_allowlist(left: &str, right: &str) -> bool {
    normalize_allowlist_path(left) == normalize_allowlist_path(right)
}

fn normalize_allowlist_path(value: &str) -> String {
    value.trim().replace('/', "\\").to_ascii_lowercase()
}

fn validate_winscp_keygen_args(argv: &[String]) -> Result<(), String> {
    if argv.len() != 6
        || !argv[0].eq_ignore_ascii_case("/keygen")
        || argv[2] != "-o"
        || argv[4] != "--old-passphrase"
    {
        return Err("exec_allowlisted rejected WinSCP key conversion arguments".to_owned());
    }
    Ok(())
}

fn validate_winscp_launch_args(argv: &[String]) -> Result<(), String> {
    let Some(uri) = argv.first() else {
        return Err("exec_allowlisted rejected WinSCP launch without a session URI".to_owned());
    };
    let lower_uri = uri.to_ascii_lowercase();
    if !lower_uri.starts_with("scp://") && !lower_uri.starts_with("sftp://") {
        return Err("exec_allowlisted rejected WinSCP launch URI".to_owned());
    }
    if argv
        .iter()
        .skip(1)
        .any(|arg| !arg.starts_with("/privatekey=") && !arg.starts_with("/passphrase="))
    {
        return Err("exec_allowlisted rejected WinSCP launch argument".to_owned());
    }
    Ok(())
}

fn build_windows_command_line(app: &str, argv: &[String]) -> String {
    std::iter::once(app.to_owned())
        .chain(argv.iter().cloned())
        .map(|arg| quote_windows_command_arg(&arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_windows_command_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return arg.to_owned();
    }

    let mut quoted = String::from("\"");
    let mut pending_backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => pending_backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(pending_backslashes * 2 + 1));
                quoted.push('"');
                pending_backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(pending_backslashes));
                pending_backslashes = 0;
                quoted.push(ch);
            }
        }
    }
    quoted.push_str(&"\\".repeat(pending_backslashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(windows)]
fn run_allowlisted_process(
    app: &str,
    argv: &[String],
    mode: ExecAllowlistMode,
) -> Result<(), String> {
    let mut command_line = wide_null_terminated(&build_windows_command_line(app, argv));
    let mut startup_info: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            std::ptr::null(),
            command_line.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null(),
            &startup_info,
            &mut process_info,
        )
    };
    if created == 0 {
        return Err(format!(
            "failed to start allowlisted process: {}",
            std::io::Error::last_os_error()
        ));
    }

    unsafe {
        CloseHandle(process_info.hThread);
    }

    match mode {
        ExecAllowlistMode::WinScpKeygen => {
            unsafe {
                WaitForSingleObject(process_info.hProcess, u32::MAX);
            }
            let mut exit_code = 1u32;
            let got_exit_code =
                unsafe { GetExitCodeProcess(process_info.hProcess, &mut exit_code as *mut u32) };
            unsafe {
                CloseHandle(process_info.hProcess);
            }
            if got_exit_code != 0 && exit_code == 0 {
                Ok(())
            } else {
                Err(format!(
                    "WinSCP key conversion failed with exit code {exit_code}"
                ))
            }
        }
        ExecAllowlistMode::WinScpLaunch => {
            unsafe {
                CloseHandle(process_info.hProcess);
            }
            Ok(())
        }
    }
}

#[cfg(not(windows))]
fn run_allowlisted_process(
    _app: &str,
    _argv: &[String],
    _mode: ExecAllowlistMode,
) -> Result<(), String> {
    Err("exec_allowlisted is only available on Windows".to_owned())
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    read_clipboard_text_native()
}

#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    write_clipboard_text_native(&text)
}

#[tauri::command]
fn native_pick_files(multiple: bool) -> Result<Option<Vec<String>>, String> {
    native_pick_files_at(multiple)
}

#[tauri::command]
fn native_pick_directory(title: Option<String>) -> Result<Option<String>, String> {
    native_pick_directory_at(title)
}

#[tauri::command]
fn native_pick_save_file(default_name: String) -> Result<Option<String>, String> {
    native_pick_save_file_at(default_name)
}

#[tauri::command]
fn native_stat_path(path: String) -> Result<NativeFileMetadata, String> {
    native_stat_path_at(path)
}

#[tauri::command]
fn native_path_exists(path: String) -> bool {
    native_fs_access_at(path).is_ok()
}

#[tauri::command]
fn native_read_file_chunk(path: String, offset: u64, length: u32) -> Result<Vec<u8>, String> {
    native_read_file_chunk_at(path, offset, length)
}

#[tauri::command]
fn native_prepare_download_file(
    path: String,
    mode: u32,
    size: u64,
) -> Result<NativeFileMetadata, String> {
    native_prepare_download_file_at(path, mode, size)
}

#[tauri::command]
fn native_write_file_chunk(path: String, offset: u64, bytes: Vec<u8>) -> Result<u64, String> {
    native_write_file_chunk_at(path, offset, bytes)
}

#[tauri::command]
fn native_upload_directory_tree(path: String) -> Result<NativeUploadEntry, String> {
    native_upload_directory_tree_at(path)
}

#[tauri::command]
fn native_prepare_download_directory(
    parent: String,
    name: String,
) -> Result<NativeFileMetadata, String> {
    native_prepare_download_directory_at(parent, name)
}

#[tauri::command]
fn native_create_directory(path: String) -> Result<(), String> {
    native_create_directory_at(path)
}

#[tauri::command]
fn native_prepare_download_file_in_directory(
    base_path: String,
    relative_path: String,
    mode: u32,
    size: u64,
) -> Result<NativeFileMetadata, String> {
    native_prepare_download_file_in_directory_at(base_path, relative_path, mode, size)
}

#[tauri::command]
fn native_create_directory_in_directory(
    base_path: String,
    relative_path: String,
) -> Result<(), String> {
    native_create_directory_in_directory_at(base_path, relative_path)
}

#[tauri::command]
fn native_fs_stat(path: String) -> Result<NativeFileMetadata, String> {
    native_stat_path_at(path)
}

#[tauri::command]
fn native_fs_readdir(path: String) -> Result<Vec<NativeFileMetadata>, String> {
    native_fs_readdir_at(path)
}

#[tauri::command]
fn native_fs_read_text(path: String) -> Result<String, String> {
    native_fs_read_text_at(path)
}

#[tauri::command]
fn native_fs_write_text(path: String, content: String) -> Result<(), String> {
    native_fs_write_text_at(path, content)
}

#[tauri::command]
fn native_fs_mkdir(path: String, recursive: bool) -> Result<(), String> {
    native_fs_mkdir_at(path, recursive)
}

#[tauri::command]
fn native_fs_access(path: String) -> Result<(), String> {
    native_fs_access_at(path)
}

#[tauri::command]
fn native_fs_realpath(path: String) -> Result<String, String> {
    native_fs_realpath_at(path)
}

#[tauri::command]
fn native_fs_unlink(path: String) -> Result<(), String> {
    native_fs_unlink_at(path)
}

fn validate_external_target(target: &str) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("open_external target must not be empty".to_owned());
    }
    if target.contains('\0') {
        return Err("open_external target must not contain NUL".to_owned());
    }
    Ok(())
}

fn validate_open_path_target(target: &str) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("open_path target must not be empty".to_owned());
    }
    if target.contains('\0') {
        return Err("open_path target must not contain NUL".to_owned());
    }
    if target.eq_ignore_ascii_case("sndvol.exe") {
        return Ok(());
    }

    let path = PathBuf::from(target);
    if !path.is_absolute() {
        return Err("open_path target must be an absolute file or directory path".to_owned());
    }
    let metadata = std::fs::metadata(&path).map_err(|error| {
        format!(
            "open_path target is not accessible: {} ({error})",
            path.to_string_lossy()
        )
    })?;
    if metadata.is_dir() {
        return Ok(());
    }
    if is_executable_like_path(&path) {
        return Err("open_path refuses executable/script paths".to_owned());
    }
    Ok(())
}

fn is_executable_like_path(path: &std::path::Path) -> bool {
    const EXECUTABLE_EXTENSIONS: &[&str] = &[
        "bat", "cmd", "com", "cpl", "exe", "js", "jse", "lnk", "msi", "msp", "ps1", "scr", "vbe",
        "vbs", "wsf", "wsh",
    ];

    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            EXECUTABLE_EXTENSIONS
                .iter()
                .any(|blocked| extension.eq_ignore_ascii_case(blocked))
        })
        .unwrap_or(false)
}

fn validate_clipboard_text(text: &str) -> Result<(), String> {
    if text.contains('\0') {
        return Err("clipboard text must not contain NUL".to_owned());
    }
    Ok(())
}

#[cfg(windows)]
fn read_clipboard_text_native() -> Result<String, String> {
    let opened = unsafe { OpenClipboard(std::ptr::null_mut::<std::ffi::c_void>() as HWND) };
    if opened == 0 {
        return Err("failed to open Windows clipboard".to_owned());
    }

    let result = (|| {
        let available = unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT as u32) };
        if available == 0 {
            return Ok(String::new());
        }
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT as u32) };
        if handle.is_null() {
            return Err("failed to read text from Windows clipboard".to_owned());
        }
        let pointer = unsafe { GlobalLock(handle) } as *const u16;
        if pointer.is_null() {
            return Err("failed to lock Windows clipboard text".to_owned());
        }
        let mut len = 0usize;
        while unsafe { *pointer.add(len) } != 0 {
            len = len.saturating_add(1);
            if len > 16 * 1024 * 1024 {
                unsafe {
                    GlobalUnlock(handle);
                }
                return Err("clipboard text is too large".to_owned());
            }
        }
        let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, len) });
        unsafe {
            GlobalUnlock(handle);
        }
        Ok(text)
    })();

    unsafe {
        CloseClipboard();
    }
    result
}

#[cfg(not(windows))]
fn read_clipboard_text_native() -> Result<String, String> {
    Err("read_clipboard_text is only implemented for the Windows Tauri host".to_owned())
}

#[cfg(windows)]
fn write_clipboard_text_native(text: &str) -> Result<(), String> {
    validate_clipboard_text(text)?;
    let wide = wide_null_terminated(text);
    let byte_len = wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| "clipboard text is too large".to_owned())?;

    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_len) };
    if handle.is_null() {
        return Err("failed to allocate Windows clipboard memory".to_owned());
    }
    let pointer = unsafe { GlobalLock(handle) } as *mut u16;
    if pointer.is_null() {
        unsafe {
            GlobalFree(handle);
        }
        return Err("failed to lock Windows clipboard memory".to_owned());
    }
    unsafe {
        std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
        GlobalUnlock(handle);
    }

    let opened = unsafe { OpenClipboard(std::ptr::null_mut::<std::ffi::c_void>() as HWND) };
    if opened == 0 {
        unsafe {
            GlobalFree(handle);
        }
        return Err("failed to open Windows clipboard".to_owned());
    }

    let result = (|| {
        let emptied = unsafe { EmptyClipboard() };
        if emptied == 0 {
            return Err("failed to empty Windows clipboard".to_owned());
        }
        let stored = unsafe { SetClipboardData(CF_UNICODETEXT as u32, handle) };
        if stored.is_null() {
            return Err("failed to write text to Windows clipboard".to_owned());
        }
        Ok(())
    })();

    unsafe {
        CloseClipboard();
    }
    if result.is_err() {
        unsafe {
            GlobalFree(handle);
        }
    }
    result
}

#[cfg(not(windows))]
fn write_clipboard_text_native(_text: &str) -> Result<(), String> {
    Err("write_clipboard_text is only implemented for the Windows Tauri host".to_owned())
}

#[cfg(windows)]
fn to_wide(value: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn open_external_target(target: &str) -> Result<(), String> {
    validate_external_target(target)?;
    shell_execute_open_target(target)
}

#[cfg(windows)]
fn open_path_allowlisted_target(target: &str) -> Result<(), String> {
    validate_open_path_target(target)?;
    shell_execute_open_target(target)
}

#[cfg(windows)]
fn shell_execute_open_target(target: &str) -> Result<(), String> {
    let operation = to_wide("open");
    let target = to_wide(target);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = result as isize;
    if code <= 32 {
        return Err(format!("ShellExecuteW failed with code {code}"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_external_target(target: &str) -> Result<(), String> {
    validate_external_target(target)?;
    Err("open_external is only implemented for the Windows Tauri host".to_owned())
}

#[cfg(not(windows))]
fn open_path_allowlisted_target(target: &str) -> Result<(), String> {
    validate_open_path_target(target)?;
    Err("open_path is only implemented for the Windows Tauri host".to_owned())
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0)
}

struct AppState {
    sessions: Arc<Mutex<SessionRegistry>>,
    pty: PtyManager,
    ssh: SshManager,
    tcp: TcpManager,
}

#[tauri::command]
fn session_create_local(state: tauri::State<'_, AppState>) -> Result<SessionSnapshot, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "session registry lock poisoned".to_owned())
        .map(|mut sessions| sessions.create(SessionKind::Local))
}

#[tauri::command]
fn pty_spawn(
    request: PtySpawnRequest,
    state: tauri::State<'_, AppState>,
) -> Result<PtySpawnResponse, String> {
    state.pty.spawn(request)
}

#[tauri::command]
fn pty_restore(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<PtySpawnResponse>, String> {
    state.pty.restore(&session_id)
}

#[tauri::command]
fn pty_write(
    session_id: String,
    bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.pty.write(&session_id, &bytes)
}

#[tauri::command]
fn pty_resize(
    session_id: String,
    size: PtySizeSpec,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.pty.resize(&session_id, size)
}

#[tauri::command]
fn pty_kill(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.pty.kill(&session_id)
}

#[tauri::command]
fn pty_exists(session_id: String, state: tauri::State<'_, AppState>) -> Result<bool, String> {
    state.pty.exists(&session_id)
}

#[tauri::command]
fn pty_get_pid(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<u32>, String> {
    state.pty.get_pid(&session_id)
}

#[tauri::command]
fn pty_ack(
    session_id: String,
    length: u64,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.pty.ack(&session_id, length)
}

#[tauri::command]
fn pty_cwd(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    state.pty.cwd(&session_id)
}

#[tauri::command]
fn pty_true_pid(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<u32>, String> {
    state.pty.true_pid(&session_id)
}

#[tauri::command]
fn pty_children(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PtyChildProcess>, String> {
    state.pty.children(&session_id)
}

#[tauri::command]
fn pty_stream(
    session_id: String,
    channel: tauri::ipc::Channel<PtyData>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.pty.stream(session_id, channel)
}

#[tauri::command]
fn ssh_prepare_connect(
    request: SshConnectRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshConnectResponse, String> {
    state.ssh.prepare_connect(request)
}

#[tauri::command]
async fn ssh_scan_host_key(
    request: SshHostKeyScanRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshHostKeyScanResponse, String> {
    state.ssh.scan_host_key(request).await
}

#[tauri::command]
fn ssh_connect(
    request: SshConnectRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshConnectResponse, String> {
    state.ssh.connect(request)
}

#[tauri::command]
async fn ssh_connect_transport(
    request: SshConnectRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshConnectResponse, String> {
    state.ssh.connect_transport(request).await
}

#[tauri::command]
async fn ssh_connect_transport_interactive(
    request: SshConnectRequest,
    channel: tauri::ipc::Channel<SshKeyboardInteractivePromptEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<SshConnectResponse, String> {
    state
        .ssh
        .connect_transport_interactive(request, channel)
        .await
}

#[tauri::command]
fn ssh_keyboard_interactive_respond(
    request: SshKeyboardInteractiveResponseRequest,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.respond_keyboard_interactive(request)
}

#[tauri::command]
async fn ssh_start_local_port_forward(
    request: SshLocalPortForwardRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshLocalPortForwardResponse, String> {
    state.ssh.start_local_port_forward(request).await
}

#[tauri::command]
async fn ssh_start_dynamic_port_forward(
    request: SshDynamicPortForwardRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshDynamicPortForwardResponse, String> {
    state.ssh.start_dynamic_port_forward(request).await
}

#[tauri::command]
async fn ssh_start_remote_port_forward(
    request: SshRemotePortForwardRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshRemotePortForwardResponse, String> {
    state.ssh.start_remote_port_forward(request).await
}

#[tauri::command]
async fn ssh_stop_port_forward(
    forward_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.stop_port_forward(&forward_id).await
}

#[tauri::command]
async fn ssh_sftp_connect_transport(
    request: SshConnectRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshConnectResponse, String> {
    state.ssh.connect_sftp_transport(request).await
}

#[tauri::command]
async fn ssh_sftp_readdir(
    session_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SftpFileEntry>, String> {
    state.ssh.sftp_readdir(&session_id, path).await
}

#[tauri::command]
async fn ssh_sftp_directory_plan(
    session_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<SftpDirectoryPlan, String> {
    state.ssh.sftp_directory_plan(&session_id, path).await
}

#[tauri::command]
async fn ssh_sftp_readlink(
    session_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state.ssh.sftp_readlink(&session_id, path).await
}

#[tauri::command]
async fn ssh_sftp_realpath(
    session_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state.ssh.sftp_realpath(&session_id, path).await
}

#[tauri::command]
async fn ssh_sftp_stat(
    session_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<SftpFileEntry, String> {
    state.ssh.sftp_stat(&session_id, path).await
}

#[tauri::command]
async fn ssh_sftp_open(
    session_id: String,
    path: String,
    mode: u32,
    state: tauri::State<'_, AppState>,
) -> Result<SftpOpenFileResponse, String> {
    state.ssh.sftp_open(&session_id, path, mode).await
}

#[tauri::command]
async fn ssh_sftp_read_file_chunk(
    handle_id: String,
    length: u32,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    state.ssh.sftp_read_file_chunk(&handle_id, length).await
}

#[tauri::command]
async fn ssh_sftp_write_file_chunk(
    handle_id: String,
    bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.sftp_write_file_chunk(&handle_id, bytes).await
}

#[tauri::command]
async fn ssh_sftp_close_file(
    handle_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.sftp_close_file(&handle_id).await
}

#[tauri::command]
async fn ssh_sftp_mkdir(
    session_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.sftp_mkdir(&session_id, path).await
}

#[tauri::command]
async fn ssh_sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.sftp_rename(&session_id, old_path, new_path).await
}

#[tauri::command]
async fn ssh_sftp_unlink(
    session_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.sftp_unlink(&session_id, path).await
}

#[tauri::command]
async fn ssh_sftp_rmdir(
    session_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.sftp_rmdir(&session_id, path).await
}

#[tauri::command]
async fn ssh_sftp_chmod(
    session_id: String,
    path: String,
    mode: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.ssh.sftp_chmod(&session_id, path, mode).await
}

#[tauri::command]
async fn ssh_sftp_close(
    session_id: String,
    reason: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.close_sftp_transport(&session_id, reason).await
}

#[tauri::command]
fn ssh_open_shell(
    session_id: String,
    size: SshShellSize,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.open_shell(&session_id, size)
}

#[tauri::command]
async fn ssh_open_shell_transport(
    session_id: String,
    size: SshShellSize,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.open_shell_transport(&session_id, size).await
}

#[tauri::command]
fn ssh_write(
    session_id: String,
    bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.write(&session_id, &bytes)
}

#[tauri::command]
async fn ssh_write_transport(
    session_id: String,
    bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.write_transport(&session_id, bytes).await
}

#[tauri::command]
fn ssh_resize(
    session_id: String,
    size: SshShellSize,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.resize(&session_id, size)
}

#[tauri::command]
async fn ssh_resize_transport(
    session_id: String,
    size: SshShellSize,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.resize_transport(&session_id, size).await
}

#[tauri::command]
fn ssh_ack(
    session_id: String,
    length: u64,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.ack(&session_id, length)
}

#[tauri::command]
fn ssh_keepalive(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.keepalive(&session_id)
}

#[tauri::command]
async fn ssh_keepalive_transport(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.keepalive_transport(&session_id).await
}

#[tauri::command]
async fn ssh_keepalive_evaluator(
    session_id: String,
    request: SshKeepaliveProbeRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshKeepaliveReport, String> {
    state.ssh.keepalive_evaluator(&session_id, request).await
}

#[tauri::command]
async fn ssh_keepalive_evaluator_transport(
    session_id: String,
    request: SshKeepaliveProbeRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshKeepaliveReport, String> {
    state
        .ssh
        .keepalive_evaluator_transport(&session_id, request)
        .await
}

#[tauri::command]
fn ssh_close(
    session_id: String,
    reason: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.close(&session_id, reason)
}

#[tauri::command]
async fn ssh_close_transport(
    session_id: String,
    reason: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.close_transport(&session_id, reason).await
}

#[tauri::command]
fn ssh_state(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SessionSnapshot>, String> {
    state.ssh.state(&session_id)
}

#[tauri::command]
fn ssh_stream(
    session_id: String,
    _channel: tauri::ipc::Channel<SshData>,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.start_stream(&session_id)
}

#[tauri::command]
async fn ssh_stream_transport(
    session_id: String,
    channel: tauri::ipc::Channel<SshData>,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.start_stream_transport(session_id, channel).await
}

#[tauri::command]
async fn native_tcp_connect(
    request: TcpConnectRequest,
    state: tauri::State<'_, AppState>,
) -> Result<TcpConnectResponse, String> {
    state.tcp.connect(request).await
}

#[tauri::command]
async fn native_tcp_stream(
    session_id: String,
    channel: tauri::ipc::Channel<TcpData>,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.tcp.stream(session_id, channel).await
}

#[tauri::command]
async fn native_tcp_write(
    session_id: String,
    bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.tcp.write(&session_id, bytes).await
}

#[tauri::command]
fn native_tcp_ack(
    session_id: String,
    length: u64,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.tcp.ack(&session_id, length)
}

#[tauri::command]
async fn native_tcp_close(
    session_id: String,
    reason: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.tcp.close(&session_id, reason).await
}

#[tauri::command]
fn ssh_forced_disconnect_test(
    session_id: String,
    reason: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state.ssh.forced_disconnect_test(&session_id, reason)
}

#[tauri::command]
fn ssh_known_host_get(
    app: tauri::AppHandle,
    request: SshKnownHostForgetRequest,
) -> Result<Option<SshKnownHostEntry>, String> {
    ssh_known_host_get_at(&known_hosts_path(&app)?, request)
}

#[tauri::command]
fn ssh_known_host_trust(
    app: tauri::AppHandle,
    request: SshKnownHostTrustRequest,
) -> Result<SshKnownHostEntry, String> {
    ssh_known_host_trust_at(&known_hosts_path(&app)?, request)
}

#[tauri::command]
fn ssh_known_host_forget(
    app: tauri::AppHandle,
    request: SshKnownHostForgetRequest,
) -> Result<bool, String> {
    ssh_known_host_forget_at(&known_hosts_path(&app)?, request)
}

#[tauri::command]
fn ssh_known_hosts_list(app: tauri::AppHandle) -> Result<Vec<SshKnownHostEntry>, String> {
    ssh_known_hosts_list_at(&known_hosts_path(&app)?)
}

#[tauri::command]
fn ssh_known_host_mismatch_report(
    stored: SshKnownHostEntry,
    scanned_sha256: String,
) -> Result<SshKnownHostMismatchReport, String> {
    build_ssh_known_host_mismatch_report(&stored, &scanned_sha256)
}

#[tauri::command]
fn session_state(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SessionSnapshot>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "session registry lock poisoned".to_owned())
        .map(|sessions| sessions.get(&session_id).cloned())
}

#[tauri::command]
fn session_close(
    session_id: String,
    reason: String,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "session registry lock poisoned".to_owned())?
        .close(&session_id, reason)
        .map_err(|error| format!("{error:?}"))
}

fn main() {
    let sessions = Arc::new(Mutex::new(SessionRegistry::default()));
    let pty = PtyManager::new(sessions.clone());
    let ssh = SshManager::new(sessions.clone());
    let tcp = TcpManager::new(sessions.clone());

    tauri::Builder::default()
        .manage(AppState {
            sessions,
            pty,
            ssh,
            tcp,
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_data,
            shell_list,
            perf_scenario,
            record_perf_automation,
            load_config,
            save_config,
            credential_get_password,
            credential_set_password,
            credential_delete_password,
            vault_encrypt,
            vault_decrypt,
            vault_random_bytes,
            list_fonts,
            open_external,
            open_path_allowlisted,
            exec_allowlisted,
            read_clipboard_text,
            write_clipboard_text,
            native_pick_files,
            native_pick_directory,
            native_pick_save_file,
            native_stat_path,
            native_path_exists,
            native_read_file_chunk,
            native_prepare_download_file,
            native_write_file_chunk,
            native_upload_directory_tree,
            native_prepare_download_directory,
            native_create_directory,
            native_prepare_download_file_in_directory,
            native_create_directory_in_directory,
            native_fs_stat,
            native_fs_readdir,
            native_fs_read_text,
            native_fs_write_text,
            native_fs_mkdir,
            native_fs_access,
            native_fs_realpath,
            native_fs_unlink,
            quit,
            session_create_local,
            session_state,
            session_close,
            pty_spawn,
            pty_restore,
            pty_write,
            pty_resize,
            pty_kill,
            pty_exists,
            pty_get_pid,
            pty_ack,
            pty_cwd,
            pty_true_pid,
            pty_children,
            pty_stream,
            ssh_prepare_connect,
            ssh_scan_host_key,
            ssh_connect,
            ssh_connect_transport,
            ssh_connect_transport_interactive,
            ssh_keyboard_interactive_respond,
            ssh_start_dynamic_port_forward,
            ssh_start_local_port_forward,
            ssh_start_remote_port_forward,
            ssh_stop_port_forward,
            ssh_sftp_connect_transport,
            ssh_sftp_readdir,
            ssh_sftp_directory_plan,
            ssh_sftp_readlink,
            ssh_sftp_realpath,
            ssh_sftp_stat,
            ssh_sftp_open,
            ssh_sftp_read_file_chunk,
            ssh_sftp_write_file_chunk,
            ssh_sftp_close_file,
            ssh_sftp_mkdir,
            ssh_sftp_rename,
            ssh_sftp_unlink,
            ssh_sftp_rmdir,
            ssh_sftp_chmod,
            ssh_sftp_close,
            ssh_open_shell,
            ssh_open_shell_transport,
            ssh_write,
            ssh_write_transport,
            ssh_resize,
            ssh_resize_transport,
            ssh_ack,
            ssh_keepalive,
            ssh_keepalive_transport,
            ssh_keepalive_evaluator,
            ssh_keepalive_evaluator_transport,
            ssh_close,
            ssh_close_transport,
            ssh_state,
            ssh_stream,
            ssh_stream_transport,
            native_tcp_connect,
            native_tcp_stream,
            native_tcp_write,
            native_tcp_ack,
            native_tcp_close,
            ssh_forced_disconnect_test,
            ssh_known_host_get,
            ssh_known_host_trust,
            ssh_known_host_forget,
            ssh_known_hosts_list,
            ssh_known_host_mismatch_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tabby Tauri host");
}

#[cfg(test)]
mod tests {
    use super::{
        fallback_fonts, format_windows_release, parse_test_tabs_from_args, parse_windows_font_name,
        parse_winscp_default_icon, validate_clipboard_text, validate_exec_allowlist_with_winscp,
        validate_external_target, validate_open_path_target, winscp_com_path, ExecAllowlistMode,
    };

    #[test]
    fn parses_test_tabs_from_equals_argument() {
        let args = vec!["tabby-tauri".to_owned(), "--test-tabs=20".to_owned()];
        assert_eq!(parse_test_tabs_from_args(&args), Some(20));
    }

    #[test]
    fn parses_test_tabs_from_split_argument() {
        let args = vec![
            "tabby-tauri".to_owned(),
            "--test-tabs".to_owned(),
            "6".to_owned(),
        ];
        assert_eq!(parse_test_tabs_from_args(&args), Some(6));
    }

    #[test]
    fn ignores_invalid_test_tabs_argument() {
        let args = vec!["tabby-tauri".to_owned(), "--test-tabs=nope".to_owned()];
        assert_eq!(parse_test_tabs_from_args(&args), None);
    }

    #[test]
    fn parses_windows_font_registry_rows() {
        assert_eq!(
            parse_windows_font_name("    Cascadia Mono (TrueType)    REG_SZ    CascadiaMono.ttf"),
            Some("Cascadia Mono".to_owned())
        );
        assert_eq!(parse_windows_font_name("HKEY_LOCAL_MACHINE\\Fonts"), None);
        assert_eq!(parse_windows_font_name(""), None);
    }

    #[test]
    fn fallback_font_list_contains_tabby_defaults() {
        let fonts = fallback_fonts();
        assert!(fonts.contains(&"Cascadia Mono".to_owned()));
        assert!(fonts.contains(&"Consolas".to_owned()));
    }

    #[test]
    fn validates_external_targets_before_native_open() {
        assert!(validate_external_target("https://tabby.sh").is_ok());
        assert!(validate_external_target("   ").is_err());
        assert!(validate_external_target("https://tabby.sh\0ignored").is_err());
    }

    #[test]
    fn validates_open_path_allowlist() {
        assert!(validate_open_path_target("sndvol.exe").is_ok());
        assert!(validate_open_path_target("powershell.exe").is_err());
        assert!(validate_open_path_target(r".\relative.txt").is_err());

        let temp_dir = std::env::temp_dir();
        assert!(validate_open_path_target(&temp_dir.to_string_lossy()).is_ok());

        let text_path = temp_dir.join("tabby-tauri-open-path-test.txt");
        std::fs::write(&text_path, "open me").expect("write text fixture");
        assert!(validate_open_path_target(&text_path.to_string_lossy()).is_ok());
        std::fs::remove_file(&text_path).ok();

        let exe_path = temp_dir.join("tabby-tauri-open-path-test.exe");
        std::fs::write(&exe_path, "do not execute").expect("write exe fixture");
        assert!(validate_open_path_target(&exe_path.to_string_lossy()).is_err());
        std::fs::remove_file(&exe_path).ok();
    }

    #[test]
    fn validates_native_clipboard_input() {
        assert!(validate_clipboard_text("copy me").is_ok());
        assert!(validate_clipboard_text("bad\0copy").is_err());
    }

    #[test]
    fn parses_winscp_registry_icon_path() {
        assert_eq!(
            parse_winscp_default_icon(r#""C:\Program Files\WinSCP\WinSCP.exe",0"#),
            Some(r"C:\Program Files\WinSCP\WinSCP.exe".to_owned())
        );
        assert_eq!(
            parse_winscp_default_icon(r"C:\Tools\WinSCP.exe,0"),
            Some(r"C:\Tools\WinSCP.exe".to_owned())
        );
        assert_eq!(parse_winscp_default_icon("  "), None);
    }

    #[test]
    fn validates_winscp_allowlisted_exec_calls() {
        let winscp = r"C:\Program Files\WinSCP\WinSCP.exe";
        let winscp_com = winscp_com_path(winscp).expect("winscp com path");
        let keygen_args = vec![
            "/keygen".to_owned(),
            r"C:\Temp\key.pem".to_owned(),
            "-o".to_owned(),
            r"C:\Temp\key.ppk".to_owned(),
            "--old-passphrase".to_owned(),
            "redacted".to_owned(),
        ];
        assert_eq!(
            validate_exec_allowlist_with_winscp(&winscp_com, &keygen_args, Some(winscp)),
            Ok(ExecAllowlistMode::WinScpKeygen)
        );

        let launch_args = vec![
            "scp://devops@example.test:22/".to_owned(),
            r"/privatekey=C:\Temp\key.ppk".to_owned(),
            "/passphrase=redacted".to_owned(),
        ];
        assert_eq!(
            validate_exec_allowlist_with_winscp(winscp, &launch_args, Some(winscp)),
            Ok(ExecAllowlistMode::WinScpLaunch)
        );
    }

    #[test]
    fn rejects_unknown_exec_calls() {
        let winscp = r"C:\Program Files\WinSCP\WinSCP.exe";
        let powershell_args = vec![
            "-NoProfile".to_owned(),
            "-Command".to_owned(),
            "whoami".to_owned(),
        ];
        assert!(validate_exec_allowlist_with_winscp(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            &powershell_args,
            Some(winscp),
        )
        .is_err());

        let bad_winscp_args = vec!["/script=malicious.txt".to_owned()];
        assert!(
            validate_exec_allowlist_with_winscp(winscp, &bad_winscp_args, Some(winscp)).is_err()
        );
    }

    #[test]
    fn formats_windows_release_metadata() {
        assert_eq!(
            format_windows_release(
                Some("Windows 11 Pro".to_owned()),
                Some("23H2".to_owned()),
                Some("22631".to_owned()),
                Some(3593),
            ),
            "Windows 11 Pro 23H2 (build 22631.3593)"
        );
    }
}
