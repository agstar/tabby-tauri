#[cfg(windows)]
mod windows_credentials {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use std::slice;

    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_ENTERPRISE,
        CRED_TYPE_GENERIC,
    };

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    pub(super) fn legacy_keytar_target(service: &str, account: &str) -> String {
        format!("{service}/{account}")
    }

    fn last_error_message(action: &str, target: &str) -> String {
        format!(
            "{action} failed for Windows credential target {target:?}: OS error {}",
            unsafe { GetLastError() }
        )
    }

    pub fn get_password(service: &str, account: &str) -> Result<Option<String>, String> {
        let target = legacy_keytar_target(service, account);
        let target_wide = to_wide(&target);
        let mut credential: *mut CREDENTIALW = null_mut();
        let ok = unsafe { CredReadW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(last_error_message("CredReadW", &target));
        }

        if credential.is_null() {
            return Ok(None);
        }

        let password_bytes = unsafe {
            let credential_ref = &*credential;
            let password = if credential_ref.CredentialBlobSize == 0 {
                Vec::new()
            } else {
                slice::from_raw_parts(
                    credential_ref.CredentialBlob,
                    credential_ref.CredentialBlobSize as usize,
                )
                .to_vec()
            };
            CredFree(credential.cast());
            password
        };
        let password = String::from_utf8(password_bytes)
            .map_err(|error| format!("Windows credential payload is not UTF-8: {error}"))?;
        Ok(Some(password))
    }

    pub fn set_password(service: &str, account: &str, password: &str) -> Result<(), String> {
        let target = legacy_keytar_target(service, account);
        let mut target_wide = to_wide(&target);
        let mut account_wide = to_wide(account);
        let mut password_bytes = password.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target_wide.as_mut_ptr(),
            UserName: account_wide.as_mut_ptr(),
            CredentialBlobSize: password_bytes.len() as u32,
            CredentialBlob: password_bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_ENTERPRISE,
            ..Default::default()
        };
        let ok = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 {
            return Err(last_error_message("CredWriteW", &target));
        }
        Ok(())
    }

    pub fn delete_password(service: &str, account: &str) -> Result<bool, String> {
        let target = legacy_keytar_target(service, account);
        let target_wide = to_wide(&target);
        let ok = unsafe { CredDeleteW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok != 0 {
            return Ok(true);
        }
        let code = unsafe { GetLastError() };
        if code == ERROR_NOT_FOUND {
            return Ok(false);
        }
        Err(last_error_message("CredDeleteW", &target))
    }

    #[cfg(test)]
    mod tests {
        use super::legacy_keytar_target;

        #[test]
        fn builds_legacy_keytar_target_name() {
            assert_eq!(
                legacy_keytar_target("ssh@10.1.4.126:22", "devops"),
                "ssh@10.1.4.126:22/devops"
            );
        }
    }
}

#[cfg(not(windows))]
mod windows_credentials {
    pub fn get_password(_service: &str, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    pub fn set_password(_service: &str, _account: &str, _password: &str) -> Result<(), String> {
        Err("Windows Credential Manager is only available on Windows".to_owned())
    }

    pub fn delete_password(_service: &str, _account: &str) -> Result<bool, String> {
        Ok(false)
    }
}

pub fn credential_get_password(service: &str, account: &str) -> Result<Option<String>, String> {
    validate_credential_name("service", service)?;
    validate_credential_name("account", account)?;
    windows_credentials::get_password(service, account)
}

pub fn credential_set_password(service: &str, account: &str, password: &str) -> Result<(), String> {
    validate_credential_name("service", service)?;
    validate_credential_name("account", account)?;
    windows_credentials::set_password(service, account, password)
}

pub fn credential_delete_password(service: &str, account: &str) -> Result<bool, String> {
    validate_credential_name("service", service)?;
    validate_credential_name("account", account)?;
    windows_credentials::delete_password(service, account)
}

fn validate_credential_name(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("Windows credential {label} must not be empty"));
    }
    if value.contains('\0') {
        return Err(format!("Windows credential {label} must not contain NUL"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_credential_name;

    #[test]
    fn rejects_empty_credential_names() {
        assert!(validate_credential_name("service", "").is_err());
        assert!(validate_credential_name("account", "   ").is_err());
    }

    #[test]
    fn rejects_nul_in_credential_names() {
        assert!(validate_credential_name("service", "ssh@host\0devops").is_err());
    }
}
