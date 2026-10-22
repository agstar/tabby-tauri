use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

const DEFAULT_UPLOAD_MODE: u32 = 0o644;
const DEFAULT_DIRECTORY_MODE: u32 = 0o755;
const MAX_TRANSFER_CHUNK: u32 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFileMetadata {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mode: u32,
    pub is_directory: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUploadEntry {
    pub name: String,
    pub path: Option<String>,
    pub size: u64,
    pub mode: u32,
    pub is_directory: bool,
    pub children: Vec<NativeUploadEntry>,
}

pub fn pick_files(multiple: bool) -> Result<Option<Vec<String>>, String> {
    pick_files_native(multiple)
}

pub fn pick_directory(title: Option<String>) -> Result<Option<String>, String> {
    pick_directory_native(title.as_deref())
}

pub fn pick_save_file(default_name: String) -> Result<Option<String>, String> {
    validate_file_name_hint(&default_name)?;
    pick_save_file_native(&default_name)
}

pub fn stat_path(path: String) -> Result<NativeFileMetadata, String> {
    stat_path_native(&PathBuf::from(validate_absolute_path(&path)?))
}

pub fn read_file_chunk(path: String, offset: u64, length: u32) -> Result<Vec<u8>, String> {
    if length > MAX_TRANSFER_CHUNK {
        return Err(format!(
            "native_read_file_chunk length must not exceed {MAX_TRANSFER_CHUNK} bytes"
        ));
    }
    let path = PathBuf::from(validate_absolute_path(&path)?);
    let metadata = path
        .metadata()
        .map_err(|error| format!("failed to stat upload file: {error}"))?;
    if metadata.is_dir() {
        return Err("native_read_file_chunk requires a file path, not a directory".to_owned());
    }
    let mut file =
        File::open(&path).map_err(|error| format!("failed to open upload file: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("failed to seek upload file: {error}"))?;
    let mut buffer = vec![0u8; length as usize];
    let read = file
        .read(&mut buffer)
        .map_err(|error| format!("failed to read upload file: {error}"))?;
    buffer.truncate(read);
    Ok(buffer)
}

pub fn prepare_download_file(
    path: String,
    mode: u32,
    size: u64,
) -> Result<NativeFileMetadata, String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    prepare_download_parent(&path)?;
    if path.exists() && path.is_dir() {
        return Err("download destination is an existing directory".to_owned());
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("failed to create download file: {error}"))?;
    file.set_len(size)
        .map_err(|error| format!("failed to preallocate download file: {error}"))?;
    drop(file);
    metadata_for_path(&path, false, mode, size)
}

pub fn write_file_chunk(path: String, offset: u64, bytes: Vec<u8>) -> Result<u64, String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|error| format!("failed to open download file: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("failed to seek download file: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("failed to write download file: {error}"))?;
    Ok(offset.saturating_add(bytes.len() as u64))
}

pub fn upload_directory_tree(path: String) -> Result<NativeUploadEntry, String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    if !path.is_dir() {
        return Err("native_upload_directory_tree requires a directory path".to_owned());
    }
    build_upload_entry(&path)
}

pub fn prepare_download_directory(
    parent: String,
    name: String,
) -> Result<NativeFileMetadata, String> {
    let parent = PathBuf::from(validate_absolute_path(&parent)?);
    let target = safe_child_path(&parent, &name)?;
    std::fs::create_dir_all(&target)
        .map_err(|error| format!("failed to create download directory: {error}"))?;
    metadata_for_path(&target, true, DEFAULT_DIRECTORY_MODE, 0)
}

pub fn create_directory(path: String) -> Result<(), String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    std::fs::create_dir_all(path).map_err(|error| format!("failed to create directory: {error}"))
}

pub fn access_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    path.metadata()
        .map(|_| ())
        .map_err(|error| format!("failed to access native path: {error}"))
}

pub fn readdir(path: String) -> Result<Vec<NativeFileMetadata>, String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    let metadata = path
        .metadata()
        .map_err(|error| format!("failed to stat native directory: {error}"))?;
    if !metadata.is_dir() {
        return Err("native_fs_readdir requires a directory path".to_owned());
    }
    let entries = std::fs::read_dir(path)
        .map_err(|error| format!("failed to read native directory: {error}"))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to read native directory entry: {error}"))?;
        result.push(stat_path_native(&entry.path())?);
    }
    result.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(result)
}

pub fn read_text(path: String) -> Result<String, String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    let metadata = path
        .metadata()
        .map_err(|error| format!("failed to stat native text file: {error}"))?;
    if metadata.is_dir() {
        return Err("native_fs_read_text requires a file path, not a directory".to_owned());
    }
    std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read native text file: {error}"))
}

pub fn write_text(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    if path.exists() && path.is_dir() {
        return Err("native_fs_write_text requires a file path, not a directory".to_owned());
    }
    std::fs::write(path, content)
        .map_err(|error| format!("failed to write native text file: {error}"))
}

pub fn mkdir(path: String, recursive: bool) -> Result<(), String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    if recursive {
        std::fs::create_dir_all(path)
    } else {
        std::fs::create_dir(path)
    }
    .map_err(|error| format!("failed to create native directory: {error}"))
}

pub fn unlink(path: String) -> Result<(), String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    if path.exists() && path.is_dir() {
        return Err("native_fs_unlink requires a file path, not a directory".to_owned());
    }
    std::fs::remove_file(path).map_err(|error| format!("failed to remove native file: {error}"))
}

pub fn realpath(path: String) -> Result<String, String> {
    let path = PathBuf::from(validate_absolute_path(&path)?);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize native path: {error}"))?;
    Ok(path_to_string(&canonical))
}

pub fn prepare_download_file_in_directory(
    base_path: String,
    relative_path: String,
    mode: u32,
    size: u64,
) -> Result<NativeFileMetadata, String> {
    let base = PathBuf::from(validate_absolute_path(&base_path)?);
    let path = safe_child_path(&base, &relative_path)?;
    prepare_download_file(path_to_string(&path), mode, size)
}

pub fn create_directory_in_directory(
    base_path: String,
    relative_path: String,
) -> Result<(), String> {
    let base = PathBuf::from(validate_absolute_path(&base_path)?);
    let path = safe_child_path(&base, &relative_path)?;
    create_directory(path_to_string(&path))
}

fn prepare_download_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "download destination must have a parent directory".to_owned())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create download parent directory: {error}"))
}

fn stat_path_native(path: &Path) -> Result<NativeFileMetadata, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("failed to stat native path: {error}"))?;
    metadata_for_path(
        path,
        metadata.is_dir(),
        if metadata.is_dir() {
            DEFAULT_DIRECTORY_MODE
        } else {
            DEFAULT_UPLOAD_MODE
        },
        metadata.len(),
    )
}

fn metadata_for_path(
    path: &Path,
    is_directory: bool,
    mode: u32,
    size: u64,
) -> Result<NativeFileMetadata, String> {
    Ok(NativeFileMetadata {
        path: path_to_string(path),
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_owned(),
        size,
        mode,
        is_directory,
    })
}

fn build_upload_entry(path: &Path) -> Result<NativeUploadEntry, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("failed to stat upload entry: {error}"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_owned();
    if metadata.is_dir() {
        let mut children = Vec::new();
        let entries = std::fs::read_dir(path)
            .map_err(|error| format!("failed to read upload directory: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read upload entry: {error}"))?;
            children.push(build_upload_entry(&entry.path())?);
        }
        children.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(NativeUploadEntry {
            name,
            path: None,
            size: 0,
            mode: DEFAULT_DIRECTORY_MODE,
            is_directory: true,
            children,
        })
    } else {
        Ok(NativeUploadEntry {
            name,
            path: Some(path_to_string(path)),
            size: metadata.len(),
            mode: DEFAULT_UPLOAD_MODE,
            is_directory: false,
            children: Vec::new(),
        })
    }
}

fn validate_file_name_hint(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("download file name must not be empty".to_owned());
    }
    if name.contains('\0') {
        return Err("download file name must not contain NUL".to_owned());
    }
    Ok(())
}

fn validate_absolute_path(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("native file path must not be empty".to_owned());
    }
    if path.contains('\0') {
        return Err("native file path must not contain NUL".to_owned());
    }
    let candidate = PathBuf::from(path);
    if !candidate.is_absolute() {
        return Err("native file path must be absolute".to_owned());
    }
    Ok(path.to_owned())
}

fn safe_child_path(base: &Path, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() {
        return Err("relative path must not be empty".to_owned());
    }
    if relative_path.contains('\0') {
        return Err("relative path must not contain NUL".to_owned());
    }
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err("relative path must not be absolute".to_owned());
    }
    let mut result = base.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => result.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(
                    "relative path must stay inside the selected download directory".to_owned(),
                )
            }
        }
    }
    Ok(result)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn parse_open_file_dialog_selection(buffer: &[u16]) -> Vec<String> {
    let parts = split_double_nul_utf16(buffer);
    if parts.len() <= 1 {
        return parts;
    }
    let directory = PathBuf::from(&parts[0]);
    parts[1..]
        .iter()
        .map(|name| path_to_string(&directory.join(name)))
        .collect()
}

fn split_double_nul_utf16(buffer: &[u16]) -> Vec<String> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    for (index, value) in buffer.iter().enumerate() {
        if *value == 0 {
            if index == start {
                break;
            }
            parts.push(String::from_utf16_lossy(&buffer[start..index]));
            start = index + 1;
        }
    }
    parts
}

#[cfg(windows)]
fn to_wide(value: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    OsStr::new(value).encode_wide().collect()
}

#[cfg(windows)]
fn wide_null_terminated(value: &str) -> Vec<u16> {
    let mut wide = to_wide(value);
    wide.push(0);
    wide
}

#[cfg(windows)]
fn wide_double_null(value: &str) -> Vec<u16> {
    let mut wide = to_wide(value);
    wide.push(0);
    wide.push(0);
    wide
}

#[cfg(windows)]
fn pick_files_native(multiple: bool) -> Result<Option<Vec<String>>, String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, OFN_ALLOWMULTISELECT, OFN_ENABLESIZING, OFN_EXPLORER, OFN_FILEMUSTEXIST,
        OFN_HIDEREADONLY, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    let mut buffer = vec![0u16; 65536];
    let filter = wide_double_null("All files\0*.*");
    let mut flags = OFN_EXPLORER
        | OFN_FILEMUSTEXIST
        | OFN_PATHMUSTEXIST
        | OFN_NOCHANGEDIR
        | OFN_HIDEREADONLY
        | OFN_ENABLESIZING;
    if multiple {
        flags |= OFN_ALLOWMULTISELECT;
    }

    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: std::ptr::null_mut::<std::ffi::c_void>() as HWND,
        lpstrFile: buffer.as_mut_ptr(),
        nMaxFile: buffer.len() as u32,
        lpstrFilter: filter.as_ptr(),
        Flags: flags,
        ..Default::default()
    };

    let selected = unsafe { GetOpenFileNameW(&mut ofn) };
    if selected == 0 {
        return Ok(None);
    }
    let paths = parse_open_file_dialog_selection(&buffer);
    Ok(Some(paths))
}

#[cfg(not(windows))]
fn pick_files_native(_multiple: bool) -> Result<Option<Vec<String>>, String> {
    Err("native_pick_files is only implemented for the Windows Tauri host".to_owned())
}

#[cfg(windows)]
fn pick_save_file_native(default_name: &str) -> Result<Option<String>, String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetSaveFileNameW, OFN_ENABLESIZING, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    let mut buffer = vec![0u16; 32768];
    let default_name_wide = to_wide(default_name);
    let copy_len = default_name_wide.len().min(buffer.len().saturating_sub(1));
    buffer[..copy_len].copy_from_slice(&default_name_wide[..copy_len]);
    let filter = wide_double_null("All files\0*.*");

    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: std::ptr::null_mut::<std::ffi::c_void>() as HWND,
        lpstrFile: buffer.as_mut_ptr(),
        nMaxFile: buffer.len() as u32,
        lpstrFilter: filter.as_ptr(),
        Flags: OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_ENABLESIZING,
        ..Default::default()
    };

    let selected = unsafe { GetSaveFileNameW(&mut ofn) };
    if selected == 0 {
        return Ok(None);
    }
    Ok(split_double_nul_utf16(&buffer).into_iter().next())
}

#[cfg(not(windows))]
fn pick_save_file_native(_default_name: &str) -> Result<Option<String>, String> {
    Err("native_pick_save_file is only implemented for the Windows Tauri host".to_owned())
}

#[cfg(windows)]
fn pick_directory_native(title: Option<&str>) -> Result<Option<String>, String> {
    use windows_sys::Win32::Foundation::{HWND, MAX_PATH};
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        SHBrowseForFolderW, SHGetPathFromIDListW, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS,
        BROWSEINFOW,
    };

    let mut display_name = vec![0u16; MAX_PATH as usize];
    let mut path = vec![0u16; 32768];
    let title_wide = title.map(wide_null_terminated);
    let browse_info = BROWSEINFOW {
        hwndOwner: std::ptr::null_mut::<std::ffi::c_void>() as HWND,
        pidlRoot: std::ptr::null_mut(),
        pszDisplayName: display_name.as_mut_ptr(),
        lpszTitle: title_wide
            .as_ref()
            .map(|value| value.as_ptr())
            .unwrap_or(std::ptr::null()),
        ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
        lpfn: None,
        lParam: 0,
        iImage: 0,
    };

    let pidl = unsafe { SHBrowseForFolderW(&browse_info) };
    if pidl.is_null() {
        return Ok(None);
    }
    let result = unsafe {
        if SHGetPathFromIDListW(pidl, path.as_mut_ptr()) == 0 {
            Err("failed to resolve selected folder path".to_owned())
        } else {
            Ok(split_double_nul_utf16(&path).into_iter().next())
        }
    };
    unsafe {
        CoTaskMemFree(pidl as *const std::ffi::c_void);
    }
    result
}

#[cfg(not(windows))]
fn pick_directory_native(_title: Option<&str>) -> Result<Option<String>, String> {
    Err("native_pick_directory is only implemented for the Windows Tauri host".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        access_path, mkdir, parse_open_file_dialog_selection, read_text, readdir, realpath,
        safe_child_path, stat_path, unlink, upload_directory_tree, write_text, DEFAULT_UPLOAD_MODE,
    };
    use std::path::{Path, PathBuf};

    fn utf16_dialog_buffer(parts: &[&str]) -> Vec<u16> {
        let mut out = Vec::new();
        for part in parts {
            out.extend(part.encode_utf16());
            out.push(0);
        }
        out.push(0);
        out
    }

    #[test]
    fn parses_single_file_dialog_selection() {
        let paths = parse_open_file_dialog_selection(&utf16_dialog_buffer(&[r"C:\Temp\a.txt"]));
        assert_eq!(paths, vec![r"C:\Temp\a.txt"]);
    }

    #[test]
    fn parses_multiselect_dialog_selection() {
        let paths =
            parse_open_file_dialog_selection(&utf16_dialog_buffer(&[r"C:\Temp", "a.txt", "b.txt"]));
        assert_eq!(paths, vec![r"C:\Temp\a.txt", r"C:\Temp\b.txt"]);
    }

    #[test]
    fn rejects_relative_escape_for_directory_downloads() {
        let base = PathBuf::from(r"C:\Downloads\folder");
        assert!(safe_child_path(&base, r"..\evil.txt").is_err());
        assert!(safe_child_path(&base, r"C:\Windows\system.ini").is_err());
        assert!(safe_child_path(&base, r"nested\ok.txt").is_ok());
    }

    #[test]
    fn builds_upload_directory_tree() {
        let root = std::env::temp_dir().join(format!(
            "tabby-tauri-upload-tree-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("nested").join("file.txt"), b"hello").unwrap();

        let tree = upload_directory_tree(root.to_string_lossy().to_string()).unwrap();

        assert!(tree.is_directory);
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].name, "nested");
        assert_eq!(tree.children[0].children[0].name, "file.txt");
        assert_eq!(tree.children[0].children[0].mode, DEFAULT_UPLOAD_MODE);
        assert_eq!(tree.children[0].children[0].size, 5);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fs_provider_roundtrips_text_metadata_and_directory_entries() {
        let root = std::env::temp_dir().join(format!(
            "tabby-tauri-fs-provider-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        mkdir(path_to_string_for_test(&root), true).unwrap();

        let file = root.join("example.txt");
        write_text(path_to_string_for_test(&file), "hello".to_owned()).unwrap();

        access_path(path_to_string_for_test(&file)).unwrap();
        assert_eq!(read_text(path_to_string_for_test(&file)).unwrap(), "hello");

        let metadata = stat_path(path_to_string_for_test(&file)).unwrap();
        assert_eq!(metadata.name, "example.txt");
        assert_eq!(metadata.size, 5);
        assert!(!metadata.is_directory);

        let entries = readdir(path_to_string_for_test(&root)).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "example.txt");

        let canonical = realpath(path_to_string_for_test(&file)).unwrap();
        assert!(canonical.ends_with("example.txt"));

        unlink(path_to_string_for_test(&file)).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fs_provider_rejects_relative_and_wrong_kind_paths() {
        assert!(stat_path("relative.txt".to_owned()).is_err());
        assert!(read_text("relative.txt".to_owned()).is_err());

        let root = std::env::temp_dir().join(format!(
            "tabby-tauri-fs-provider-kind-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        assert!(read_text(path_to_string_for_test(&root)).is_err());
        assert!(unlink(path_to_string_for_test(&root)).is_err());

        std::fs::remove_dir_all(root).unwrap();
    }

    fn path_to_string_for_test(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }
}
