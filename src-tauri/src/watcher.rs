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
use crate::files::{absolute_path, path_key, version_of};

const DEBOUNCE: Duration = Duration::from_millis(150);
/// How long a write in progress (no version known yet) hides events for its path.
const WRITING_WINDOW: Duration = Duration::from_secs(2);
/// How long a finished write is remembered at all.
const WRITTEN_WINDOW: Duration = Duration::from_secs(30);
const FILE_CHANGED: &str = "file-changed";

struct SelfWrite {
    at: Instant,
    /// The version Margin wrote, once the write has finished.
    version: Option<String>,
}

/// Files this app has just written. Their watcher events are ignored only while the file is
/// still exactly the version Margin wrote, so another program's edit right after a save is
/// still reported.
#[derive(Clone, Default)]
pub struct SelfWrites(Arc<Mutex<HashMap<String, SelfWrite>>>);

impl SelfWrites {
    /// A write to `path` is about to start.
    pub fn record(&self, path: &Path) {
        if let Ok(mut written) = self.0.lock() {
            written.insert(
                path_key(path),
                SelfWrite {
                    at: Instant::now(),
                    version: None,
                },
            );
        }
    }

    /// The write to `path` finished and left the file at `version`.
    pub fn written(&self, path: &Path, version: &str) {
        if let Ok(mut written) = self.0.lock() {
            written.insert(
                path_key(path),
                SelfWrite {
                    at: Instant::now(),
                    version: Some(version.to_owned()),
                },
            );
        }
    }

    pub fn forget(&self, path: &Path) {
        if let Ok(mut written) = self.0.lock() {
            written.remove(&path_key(path));
        }
    }

    /// True when an event for `path` comes from Margin's own write.
    fn is_own(&self, path: &Path) -> bool {
        let Ok(mut written) = self.0.lock() else {
            return false;
        };
        written.retain(|_, write| match write.version {
            None => write.at.elapsed() < WRITING_WINDOW,
            Some(_) => write.at.elapsed() < WRITTEN_WINDOW,
        });
        let key = path_key(path);
        let own = match written.get(&key) {
            None => false,
            Some(SelfWrite { version: None, .. }) => true,
            Some(SelfWrite {
                version: Some(version),
                ..
            }) => std::fs::metadata(path).is_ok_and(|meta| &version_of(&meta) == version),
        };
        if !own {
            // The file moved on from Margin's write: report this and every later change.
            written.remove(&key);
        }
        own
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
                if writes.is_own(target) {
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
    fn writes_in_progress_are_suppressed() {
        let writes = SelfWrites::default();
        let path = Path::new("C:\\notes\\a.md");
        assert!(!writes.is_own(path));
        writes.record(path);
        assert!(writes.is_own(path));
        writes.forget(path);
        assert!(!writes.is_own(path));
    }

    #[test]
    fn an_edit_by_another_program_after_a_save_is_reported() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("a.md");
        std::fs::write(&path, "saved by margin").expect("write");
        let writes = SelfWrites::default();
        let version = version_of(&std::fs::metadata(&path).expect("meta"));
        writes.written(&path, &version);
        // The event for Margin's own write is ignored, however often it repeats.
        assert!(writes.is_own(&path));
        assert!(writes.is_own(&path));
        // Another program writes different bytes straight after.
        std::fs::write(&path, "changed by another program").expect("write");
        assert!(!writes.is_own(&path));
        assert!(!writes.is_own(&path), "later changes keep being reported");
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
