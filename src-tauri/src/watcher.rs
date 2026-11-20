use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::blocking;
use crate::files::{absolute_path, path_key};

const DEBOUNCE: Duration = Duration::from_millis(150);
const SELF_WRITE_WINDOW: Duration = Duration::from_secs(1);
const FILE_CHANGED: &str = "file-changed";

/// Paths this app has just written, so their watcher events are ignored.
#[derive(Clone, Default)]
pub struct SelfWrites(Arc<Mutex<HashMap<String, Instant>>>);

impl SelfWrites {
    pub fn record(&self, path: &Path) {
        if let Ok(mut written) = self.0.lock() {
            written.insert(path_key(path), Instant::now());
        }
    }

    pub fn forget(&self, path: &Path) {
        if let Ok(mut written) = self.0.lock() {
            written.remove(&path_key(path));
        }
    }

    fn is_recent(&self, path: &Path) -> bool {
        let Ok(mut written) = self.0.lock() else {
            return false;
        };
        written.retain(|_, at| at.elapsed() < SELF_WRITE_WINDOW);
        written.contains_key(&path_key(path))
    }
}

type FolderWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Watches individual files by watching their folders and filtering the events.
#[derive(Clone)]
pub struct Watcher {
    watched: Arc<Mutex<HashMap<String, PathBuf>>>,
    folders: Arc<Mutex<FolderWatcher>>,
}

impl Watcher {
    pub fn new(app: AppHandle, writes: SelfWrites) -> notify::Result<Self> {
        let watched: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();
        let handler_watched = Arc::clone(&watched);
        let folders = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
            if let Ok(events) = result {
                dispatch(&app, &handler_watched, &writes, &events);
            }
        })?;
        Ok(Self {
            watched,
            folders: Arc::new(Mutex::new(folders)),
        })
    }

    pub fn watch(&self, raw_path: &str) -> Result<(), String> {
        let path = absolute_path(raw_path)?;
        let folder = folder_of(&path)?;
        let key = path_key(&path);
        let mut watched = lock(&self.watched)?;
        if watched.contains_key(&key) {
            return Ok(());
        }
        if !watches_folder(&watched, folder) {
            lock(&self.folders)?
                .watch(folder, RecursiveMode::NonRecursive)
                .map_err(|err| format!("Couldn't watch {}: {err}.", folder.display()))?;
        }
        watched.insert(key, path);
        Ok(())
    }

    pub fn unwatch(&self, raw_path: &str) -> Result<(), String> {
        let key = path_key(&absolute_path(raw_path)?);
        let mut watched = lock(&self.watched)?;
        let Some(removed) = watched.remove(&key) else {
            return Ok(());
        };
        if let Ok(folder) = folder_of(&removed)
            && !watches_folder(&watched, folder)
        {
            // The folder may already be gone, which leaves nothing to stop.
            // The file is untracked either way, so this error is ignored.
            let _ = lock(&self.folders)?.unwatch(folder);
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn watch_file(path: String, watcher: State<'_, Watcher>) -> Result<(), String> {
    let watcher = watcher.inner().clone();
    blocking(move || watcher.watch(&path)).await
}

#[tauri::command]
pub async fn unwatch_file(path: String, watcher: State<'_, Watcher>) -> Result<(), String> {
    let watcher = watcher.inner().clone();
    blocking(move || watcher.unwatch(&path)).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChanged {
    path: String,
    kind: &'static str,
}

fn dispatch(
    app: &AppHandle,
    watched: &Mutex<HashMap<String, PathBuf>>,
    writes: &SelfWrites,
    events: &[DebouncedEvent],
) {
    let changes: Vec<FileChanged> = {
        let Ok(watched) = watched.lock() else {
            return;
        };
        events
            .iter()
            .flat_map(|event| event.paths.iter().map(move |path| (event, path)))
            .filter_map(|(event, path)| {
                let target = watched.get(&path_key(path))?;
                if writes.is_recent(target) {
                    return None;
                }
                let kind = change_kind(&event.kind, target.exists())?;
                Some(FileChanged {
                    path: target.to_string_lossy().into_owned(),
                    kind,
                })
            })
            .collect()
    };
    for change in changes {
        let _ = app.emit(FILE_CHANGED, change);
    }
}

fn change_kind(kind: &EventKind, exists: bool) -> Option<&'static str> {
    match (kind, exists) {
        (EventKind::Access(_), _) => None,
        (_, true) => Some("modified"),
        (EventKind::Modify(ModifyKind::Name(_)), false) => Some("renamed"),
        (_, false) => Some("removed"),
    }
}

fn folder_of(path: &Path) -> Result<&Path, String> {
    path.parent()
        .ok_or_else(|| format!("{} has no folder to watch.", path.display()))
}

fn watches_folder(watched: &HashMap<String, PathBuf>, folder: &Path) -> bool {
    let folder_key = path_key(folder);
    watched.values().any(|file| {
        file.parent()
            .is_some_and(|parent| path_key(parent) == folder_key)
    })
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "The file watcher stopped unexpectedly. Restart Margin.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_made_by_the_app_are_suppressed_for_one_second() {
        let writes = SelfWrites::default();
        let path = Path::new("C:\\notes\\a.md");
        assert!(!writes.is_recent(path));
        writes.record(path);
        assert!(writes.is_recent(path));
        writes.forget(path);
        assert!(!writes.is_recent(path));
    }

    #[test]
    fn access_events_are_not_reported() {
        assert_eq!(change_kind(&EventKind::Access(notify::event::AccessKind::Any), true), None);
    }

    #[test]
    fn removed_and_renamed_files_are_reported_by_kind() {
        let rename = EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::From));
        assert_eq!(change_kind(&rename, false), Some("renamed"));
        assert_eq!(change_kind(&EventKind::Remove(notify::event::RemoveKind::File), false), Some("removed"));
        assert_eq!(change_kind(&EventKind::Remove(notify::event::RemoveKind::File), true), Some("modified"));
    }
}
