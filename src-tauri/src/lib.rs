mod drafts;
mod files;
#[cfg(windows)]
mod snap_layout;
#[cfg(windows)]
mod spell_menu;
mod store;
mod watcher;
#[cfg(windows)]
mod window_corner;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Theme};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use watcher::{SelfWrites, Watcher};

const MAIN_WINDOW: &str = "main";
/// Tells the window that a second launch queued files (or a blank note) for it.
const OPEN_FILES: &str = "open-files";
/// The settings folder used before the app was renamed from MD Viewer to Margin.
const OLD_IDENTIFIER: &str = "com.faamirali.mdviewer";

/// Files given on the command line at startup, handed out once by `launch_files`.
#[derive(Default)]
struct LaunchFiles(Mutex<Vec<String>>);

/// Requests from later launches (Explorer double-clicks, Win+R `note`), each a list of files
/// (empty for a blank note). They wait here until the window collects them, so a launch that
/// arrives while the window is still starting up is never lost.
#[derive(Default)]
struct PendingOpens(Mutex<Vec<Vec<String>>>);

#[tauri::command]
fn take_open_requests(pending: State<'_, PendingOpens>) -> Vec<Vec<String>> {
    pending
        .0
        .lock()
        .map(|mut queue| std::mem::take(&mut *queue))
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    config_dir: String,
    tauri_version: String,
}

#[tauri::command]
fn launch_files(launch: State<'_, LaunchFiles>) -> Vec<String> {
    launch
        .0
        .lock()
        .map(|mut files| std::mem::take(&mut *files))
        .unwrap_or_default()
}

#[tauri::command]
fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        config_dir: store::config_dir(&app)?.to_string_lossy().into_owned(),
        tauri_version: tauri::VERSION.to_owned(),
    })
}

#[tauri::command]
fn set_window_theme(app: AppHandle, dark: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("The main window isn't open.")?;
    let theme = if dark { Theme::Dark } else { Theme::Light };
    window
        .set_theme(Some(theme))
        .map_err(|err| format!("Couldn't set the window theme: {err}."))
}

/// Opens Snap Layouts when the pointer rests on the maximize button. Only Windows has the flyout.
#[tauri::command]
fn show_snap_layout(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        snap_layout::show(&app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !is_allowed_external_url(&url) {
        return Err("Only http, https and mailto links can be opened.".to_owned());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("Couldn't open the link: {err}."))
}

fn is_allowed_external_url(url: &str) -> bool {
    let lowercase = url.to_ascii_lowercase();
    let scheme_allowed = ["https://", "http://", "mailto:"]
        .iter()
        .any(|scheme| lowercase.starts_with(scheme));
    scheme_allowed && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Runs blocking work off the async runtime. A failed join becomes an error string.
async fn blocking<T, F>(task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("A background task failed: {err}."))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second launch with no files (Win+R `note` while Margin is open) sends an empty
            // list, which the window answers with a fresh note.
            let files = files::file_paths_from_args(args.iter().skip(1), Path::new(&cwd));
            if let Ok(mut queue) = app.state::<PendingOpens>().0.lock() {
                queue.push(files);
            }
            let _ = app.emit(OPEN_FILES, ());
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // VISIBLE is left out on purpose: restoring it would show the window before the
        // frontend has painted and calls `show`.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                window_corner::let_close_receive_mouse(&window);
                spell_menu::install(&window);
            }
            drafts::migrate_from_old_identifier(app.handle(), OLD_IDENTIFIER);
            let cwd = std::env::current_dir().unwrap_or_default();
            let args = std::env::args_os()
                .skip(1)
                .map(|arg| arg.to_string_lossy().into_owned());
            let launch = files::file_paths_from_args(args, &cwd);
            app.manage(LaunchFiles(Mutex::new(launch)));
            app.manage(PendingOpens::default());

            let writes = SelfWrites::default();
            app.manage(writes.clone());
            app.manage(Watcher::new(app.handle().clone(), writes)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::read_file,
            files::write_file,
            files::write_binary,
            files::list_dir,
            files::list_files,
            files::file_meta,
            files::reveal_in_explorer,
            files::open_linked_file,
            watcher::watch_file,
            watcher::unwatch_file,
            store::store_get,
            store::store_set,
            drafts::draft_write,
            drafts::draft_delete,
            drafts::draft_list,
            launch_files,
            take_open_requests,
            app_info,
            set_window_theme,
            show_snap_layout,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links_are_limited_to_web_and_mail() {
        assert!(is_allowed_external_url("https://example.com/a?b=c"));
        assert!(is_allowed_external_url("HTTP://example.com"));
        assert!(is_allowed_external_url("mailto:someone@example.com"));
        assert!(!is_allowed_external_url("file:///C:/Windows/system.ini"));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
        assert!(!is_allowed_external_url("ftp://example.com"));
        assert!(!is_allowed_external_url("https://example.com/with space"));
        assert!(!is_allowed_external_url(""));
    }
}
