//! Hot exit: every open tab's unsaved text lives in `<config>/drafts/<id>.json`, written within a
//! second of typing. Closing the window, a crash or a shutdown can then never lose a note.
//! One file per document, so a crash mid-write can only ever cost that one draft.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::blocking;
use crate::files::{atomic_write, io_message};
use crate::store::{config_dir, validate_key};

const DRAFTS: &str = "drafts";

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftList {
    drafts: Vec<Value>,
    /// Draft files that couldn't be read; renamed to `.bad` so they are kept but skipped.
    quarantined: Vec<String>,
}

fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(DRAFTS))
}

#[tauri::command]
pub async fn draft_write(app: AppHandle, id: String, value: Value) -> Result<(), String> {
    let dir = drafts_dir(&app)?;
    blocking(move || draft_write_sync(&dir, &id, &value)).await
}

#[tauri::command]
pub async fn draft_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = drafts_dir(&app)?;
    blocking(move || draft_delete_sync(&dir, &id)).await
}

#[tauri::command]
pub async fn draft_list(app: AppHandle) -> Result<DraftList, String> {
    let dir = drafts_dir(&app)?;
    blocking(move || draft_list_sync(&dir)).await
}

/// One draft, or null when there is none (a tab handed to another window reads its text here).
#[tauri::command]
pub async fn draft_read(app: AppHandle, id: String) -> Result<Option<Value>, String> {
    let dir = drafts_dir(&app)?;
    blocking(move || {
        validate_key(&id)?;
        let file = dir.join(format!("{id}.json"));
        match fs::read_to_string(&file) {
            Ok(text) => Ok(serde_json::from_str::<Value>(&text).ok().filter(|v| is_valid_draft(v, &id))),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(io_message("read", &file, &err)),
        }
    })
    .await
}

fn draft_write_sync(dir: &Path, id: &str, value: &Value) -> Result<(), String> {
    validate_key(id)?;
    fs::create_dir_all(dir).map_err(|err| io_message("create", dir, &err))?;
    let text = serde_json::to_string(value)
        .map_err(|err| format!("Couldn't turn draft {id} into JSON: {err}."))?;
    atomic_write(&dir.join(format!("{id}.json")), text.as_bytes())
}

fn draft_delete_sync(dir: &Path, id: &str) -> Result<(), String> {
    validate_key(id)?;
    let file = dir.join(format!("{id}.json"));
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(io_message("delete", &file, &err)),
    }
}

fn draft_list_sync(dir: &Path) -> Result<DraftList, String> {
    let mut list = DraftList {
        drafts: Vec::new(),
        quarantined: Vec::new(),
    };
    let read = match fs::read_dir(dir) {
        Ok(read) => read,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(list),
        Err(err) => return Err(io_message("read", dir, &err)),
    };
    let mut files: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    for file in files {
        let text = match fs::read_to_string(&file) {
            Ok(text) => text,
            // Locked or unreadable right now (antivirus, sync client): leave it for next time
            // instead of calling a healthy draft damaged.
            Err(err) if err.kind() != io::ErrorKind::InvalidData => continue,
            Err(_) => String::new(),
        };
        let stem = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        match serde_json::from_str::<Value>(&text) {
            Ok(value) if is_valid_draft(&value, &stem) => list.drafts.push(value),
            _ => {
                let name = file
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let _ = fs::rename(&file, file.with_extension("json.bad"));
                list.quarantined.push(name);
            }
        }
    }
    Ok(list)
}

/// A draft the frontend can restore: an object whose `id` matches its file name and whose
/// `content` is text. Anything else is kept aside rather than allowed to break startup.
fn is_valid_draft(value: &Value, stem: &str) -> bool {
    let id_ok = value.get("id").and_then(Value::as_str) == Some(stem);
    let content_ok = value.get("content").is_some_and(Value::is_string);
    let path_ok = value
        .get("path")
        .is_none_or(|path| path.is_null() || path.is_string());
    value.is_object() && id_ok && content_ok && path_ok
}

/// The app was renamed from MD Viewer. On the first launch under the new identifier, copy the old
/// settings, session and drafts across (the old folder is left untouched).
pub fn migrate_from_old_identifier(app: &AppHandle, old_identifier: &str) {
    let Ok(new_dir) = config_dir(app) else { return };
    let Some(old_dir) = new_dir.parent().map(|parent| parent.join(old_identifier)) else {
        return;
    };
    let done = new_dir.join(MIGRATED_MARKER);
    let started = new_dir.join(MIGRATING_MARKER);
    if done.exists() || !old_dir.is_dir() {
        return;
    }
    // A profile that ran under the new name before these markers existed finished long ago:
    // copying again would bring back drafts that were closed since.
    if !started.exists() && new_dir.join("settings.json").exists() {
        let _ = fs::write(done, old_identifier);
        return;
    }
    if fs::create_dir_all(&new_dir).is_err() || fs::write(&started, old_identifier).is_err() {
        return;
    }
    // The copy never overwrites, so an interrupted one simply carries on at the next launch.
    if copy_dir(&old_dir, &new_dir).is_ok() && fs::write(&done, old_identifier).is_ok() {
        let _ = fs::remove_file(started);
    }
}

/// Written once the settings of the old MD Viewer identifier have been fully copied.
const MIGRATED_MARKER: &str = "migrated-from-mdviewer";
/// Present while a copy is under way, so an interrupted copy is resumed.
const MIGRATING_MARKER: &str = "migrating-from-mdviewer";

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            // WebView2's cache lives under EBWebView: not worth copying.
            if entry.file_name() != "EBWebView" {
                copy_dir(&entry.path(), &target)?;
            }
        } else if !target.exists() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn drafts_round_trip_and_delete() {
        let dir = tempfile::tempdir().expect("temp dir");
        let folder = dir.path().join("drafts");
        assert_eq!(draft_list_sync(&folder).expect("empty").drafts.len(), 0);

        draft_write_sync(&folder, "d1", &json!({ "id": "d1", "content": "hello" })).expect("write");
        draft_write_sync(&folder, "d2", &json!({ "id": "d2", "content": "🙂" })).expect("write");
        let list = draft_list_sync(&folder).expect("list");
        assert_eq!(list.drafts.len(), 2);
        assert_eq!(list.drafts[1]["content"], "🙂");

        draft_delete_sync(&folder, "d1").expect("delete");
        draft_delete_sync(&folder, "d1").expect("deleting twice is fine");
        assert_eq!(draft_list_sync(&folder).expect("list").drafts.len(), 1);
    }

    #[test]
    fn damaged_drafts_are_quarantined_not_fatal() {
        let dir = tempfile::tempdir().expect("temp dir");
        let folder = dir.path().join("drafts");
        draft_write_sync(&folder, "good", &json!({ "id": "good", "content": "" })).expect("write");
        fs::write(folder.join("half.json"), "{ \"id\": \"ha").expect("write damaged");
        let list = draft_list_sync(&folder).expect("list");
        assert_eq!(list.drafts.len(), 1);
        assert_eq!(list.quarantined, vec!["half.json".to_owned()]);
        assert!(folder.join("half.json.bad").exists());
    }

    #[test]
    fn drafts_without_text_or_a_matching_id_are_quarantined() {
        let dir = tempfile::tempdir().expect("temp dir");
        let folder = dir.path().join("drafts");
        draft_write_sync(&folder, "ok", &json!({ "id": "ok", "content": "", "path": null })).expect("write");
        draft_write_sync(&folder, "nocontent", &json!({ "id": "nocontent", "path": "C:\\a.md" })).expect("write");
        draft_write_sync(&folder, "wrongid", &json!({ "id": "other", "content": "x" })).expect("write");
        draft_write_sync(&folder, "badpath", &json!({ "id": "badpath", "content": "x", "path": 3 })).expect("write");
        let list = draft_list_sync(&folder).expect("list");
        assert_eq!(list.drafts.len(), 1);
        assert_eq!(list.drafts[0]["id"], "ok");
        assert_eq!(list.quarantined.len(), 3);
    }

    #[test]
    fn draft_ids_are_validated() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(draft_write_sync(dir.path(), "../evil", &json!({})).is_err());
        assert!(draft_delete_sync(dir.path(), "a.b").is_err());
    }

    #[test]
    fn copy_dir_copies_files_and_folders_without_overwriting() {
        let dir = tempfile::tempdir().expect("temp dir");
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        fs::create_dir_all(old.join("drafts")).expect("mk");
        fs::create_dir_all(old.join("EBWebView")).expect("mk");
        fs::write(old.join("settings.json"), "{}").expect("w");
        fs::write(old.join("drafts").join("d1.json"), "{}").expect("w");
        fs::create_dir_all(&new).expect("mk");
        fs::write(new.join("zoom.json"), "2").expect("w");
        fs::write(old.join("zoom.json"), "1").expect("w");
        copy_dir(&old, &new).expect("copy");
        assert!(new.join("settings.json").exists());
        assert!(new.join("drafts").join("d1.json").exists());
        assert!(!new.join("EBWebView").exists());
        assert_eq!(fs::read_to_string(new.join("zoom.json")).expect("r"), "2");
    }
}
