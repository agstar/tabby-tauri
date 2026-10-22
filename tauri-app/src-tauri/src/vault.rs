use aes::Aes256;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use pbkdf2::pbkdf2_hmac;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::Sha512;

const PBKDF_ITERATIONS: u32 = 100_000;
const PBKDF_SALT_LENGTH: usize = 64 / 8;
const CRYPT_KEY_LENGTH: usize = 256 / 8;
const CRYPT_IV_LENGTH: usize = 128 / 8;

type Aes256CbcEncryptor = cbc::Encryptor<Aes256>;
type Aes256CbcDecryptor = cbc::Decryptor<Aes256>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVault {
    pub version: u8,
    pub contents: String,
    pub key_salt: String,
    pub iv: String,
}

pub fn vault_random_bytes(length: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; length];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "failed to generate vault random bytes".to_owned())?;
    Ok(bytes)
}

pub fn vault_encrypt(content_json: String, passphrase: String) -> Result<StoredVault, String> {
    let key_salt = vault_random_bytes(PBKDF_SALT_LENGTH)?;
    let iv = vault_random_bytes(CRYPT_IV_LENGTH)?;
    let key = derive_key(&passphrase, &key_salt);
    let encrypted = Aes256CbcEncryptor::new_from_slices(&key, &iv)
        .map_err(|error| format!("failed to initialize vault cipher: {error}"))?
        .encrypt_padded_vec_mut::<Pkcs7>(content_json.as_bytes());

    Ok(StoredVault {
        version: 1,
        contents: BASE64.encode(encrypted),
        key_salt: hex::encode(key_salt),
        iv: hex::encode(iv),
    })
}

pub fn vault_decrypt(vault: StoredVault, passphrase: String) -> Result<String, String> {
    if vault.version != 1 {
        return Err(format!(
            "Unsupported vault format version {}",
            vault.version
        ));
    }

    let key_salt =
        hex::decode(&vault.key_salt).map_err(|error| format!("invalid vault key salt: {error}"))?;
    let iv = hex::decode(&vault.iv).map_err(|error| format!("invalid vault iv: {error}"))?;
    let encrypted = BASE64
        .decode(&vault.contents)
        .map_err(|error| format!("invalid vault contents: {error}"))?;
    let key = derive_key(&passphrase, &key_salt);
    let decrypted = Aes256CbcDecryptor::new_from_slices(&key, &iv)
        .map_err(|error| format!("failed to initialize vault cipher: {error}"))?
        .decrypt_padded_vec_mut::<Pkcs7>(&encrypted)
        .map_err(|_| "BAD_DECRYPT: vault decryption failed".to_owned())?;

    String::from_utf8(decrypted).map_err(|error| format!("vault plaintext is not UTF-8: {error}"))
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; CRYPT_KEY_LENGTH] {
    let mut key = [0u8; CRYPT_KEY_LENGTH];
    pbkdf2_hmac::<Sha512>(passphrase.as_bytes(), salt, PBKDF_ITERATIONS, &mut key);
    key
}

#[cfg(test)]
mod tests {
    use super::{vault_decrypt, vault_encrypt, vault_random_bytes, StoredVault};

    const NODE_FIXTURE_PASSPHRASE: &str = "correct horse battery staple";
    const NODE_FIXTURE_PLAINTEXT: &str = r#"{"config":{"theme":"dark"},"secrets":[{"type":"ssh","key":{"host":"fixture.example"},"value":"fixture-secret"}]}"#;

    fn node_fixture() -> StoredVault {
        StoredVault {
            version: 1,
            contents: "8uKwUqLrWIB71bWyPizO1ai47Z34ohRM0Qdo6ux65owihB7ICylFhqgzjpTRLzTBJMP4Xk1j/0t/Hq1cbcYUR5fnwXhLrfes1qt7cXkpMTcybUZzZThCXdvEb+pelCVv/pDfZ5eGb0G/l34FpGd5BQCUr1VcreqiojavO087YeA=".to_owned(),
            key_salt: "0001020304050607".to_owned(),
            iv: "101112131415161718191a1b1c1d1e1f".to_owned(),
        }
    }

    #[test]
    fn decrypts_node_produced_vault_fixture() {
        let plaintext = vault_decrypt(node_fixture(), NODE_FIXTURE_PASSPHRASE.to_owned()).unwrap();
        assert_eq!(plaintext, NODE_FIXTURE_PLAINTEXT);
    }

    #[test]
    fn encrypts_and_decrypts_vault_payloads() {
        let encrypted = vault_encrypt(
            NODE_FIXTURE_PLAINTEXT.to_owned(),
            NODE_FIXTURE_PASSPHRASE.to_owned(),
        )
        .unwrap();
        let decrypted = vault_decrypt(encrypted, NODE_FIXTURE_PASSPHRASE.to_owned()).unwrap();
        assert_eq!(decrypted, NODE_FIXTURE_PLAINTEXT);
    }

    #[test]
    fn rejects_incorrect_passphrases_without_plaintext_leakage() {
        let error = vault_decrypt(node_fixture(), "wrong".to_owned()).unwrap_err();
        assert!(error.contains("BAD_DECRYPT"));
        assert!(!error.contains("fixture-secret"));
    }

    #[test]
    fn returns_requested_random_byte_count() {
        assert_eq!(vault_random_bytes(32).unwrap().len(), 32);
    }
}
