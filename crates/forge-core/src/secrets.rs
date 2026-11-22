//! API keys live in the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service), never in
//! a file or in the webview's local storage.

const SERVICE: &str = "dev.forge.editor";

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    entry(name)?.set_password(value).map_err(|e| e.to_string())
}

pub fn get(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_overwrite_and_delete() {
        let name = format!("test-{}", std::process::id());
        assert_eq!(get(&name).unwrap(), None);
        set(&name, "first").unwrap();
        assert_eq!(get(&name).unwrap().as_deref(), Some("first"));
        set(&name, "second-with-unicode-é").unwrap();
        assert_eq!(get(&name).unwrap().as_deref(), Some("second-with-unicode-é"));
        delete(&name).unwrap();
        assert_eq!(get(&name).unwrap(), None);
        delete(&name).unwrap(); // idempotent
    }
}
