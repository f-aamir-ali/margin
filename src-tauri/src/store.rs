use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::blocking;
use crate::files::{atomic_write, io_message};

pub(crate) fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|err| format!("Couldn't find the settings folder: {err}."))
}

#[tauri::command]
pub async fn store_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let dir = config_dir(&app)?;
    blocking(move || store_get_sync(&dir, &key)).await
}

#[tauri::command]
pub async fn store_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let dir = config_dir(&app)?;
    blocking(move || store_set_sync(&dir, &key, &value)).await
}

fn store_get_sync(dir: &Path, key: &str) -> Result<Option<Value>, String> {
    validate_key(key)?;
    let file = store_file(dir, key);
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(io_message("read", &file, &err)),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|err| format!("The saved settings for {key} are damaged: {err}."))
}

fn store_set_sync(dir: &Path, key: &str, value: &Value) -> Result<(), String> {
    validate_key(key)?;
    fs::create_dir_all(dir).map_err(|err| io_message("create", dir, &err))?;
    let text = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Couldn't turn the settings for {key} into JSON: {err}."))?;
    atomic_write(&store_file(dir, key), text.as_bytes())
}

fn store_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.json"))
}

/// Keys become file names, so only lowercase letters, digits, `_` and `-` are allowed.
pub fn validate_key(key: &str) -> Result<(), String> {
    let allowed = !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'));
    if !allowed {
        return Err(format!(
            "Store key \"{key}\" may only contain lowercase letters, digits, '_' and '-'."
        ));
    }
    if is_reserved_device_name(key) {
        return Err(format!(
            "\"{key}\" is a reserved Windows name and can't be used as a store key."
        ));
    }
    Ok(())
}

/// Windows reserves these names even with an extension, so `con.json` is a device, not a file.
fn is_reserved_device_name(key: &str) -> bool {
    let numbered = |prefix: &str| {
        key.strip_prefix(prefix)
            .is_some_and(|number| matches!(number.as_bytes(), [b'1'..=b'9']))
    };
    matches!(key, "con" | "prn" | "aux" | "nul") || numbered("com") || numbered("lpt")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_plain_store_keys() {
        assert!(validate_key("settings").is_ok());
        assert!(validate_key("recent-files_2").is_ok());
        assert!(validate_key("com10").is_ok());
    }

    #[test]
    fn rejects_unsafe_or_reserved_store_keys() {
        for key in ["", "Settings", "../secrets", "a b", "a.b", "con", "nul", "com1", "lpt9"] {
            assert!(validate_key(key).is_err(), "{key:?} should be rejected");
        }
    }

    #[test]
    fn store_round_trips_json_and_reports_missing_or_damaged_keys() {
        let dir = tempfile::tempdir().expect("temp dir");
        let folder = dir.path().join("config");
        assert_eq!(store_get_sync(&folder, "prefs").expect("missing key"), None);

        let value = json!({ "theme": "dark", "zoom": 1.25 });
        store_set_sync(&folder, "prefs", &value).expect("set");
        assert_eq!(store_get_sync(&folder, "prefs").expect("get"), Some(value));

        fs::write(folder.join("broken.json"), "{ not json").expect("write damaged file");
        assert!(store_get_sync(&folder, "broken").is_err());
    }
}
