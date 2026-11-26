//! Several windows, like Chrome: a tab dragged out of the tab bar becomes its own window, and a
//! tab dropped on another window's tab bar joins it.
//!
//! Every window runs its own copy of the page, so the pieces that must be shared live here:
//! which window restores the saved session (only the first one of a process), which window
//! holds each file (a file is open in one window at a time), and where each window's tab bar is
//! on screen (so a dragged tab knows which window it was dropped on).

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent,
};

use crate::files::{absolute_path, path_key};

/// Height of the tab bar in CSS pixels (match --titlebar-h in tokens.css), plus a little slack
/// below it so a drop just under the tabs still counts.
const TAB_BAR_HEIGHT: f64 = 56.0;

#[derive(Default)]
pub struct WindowState {
    restored: AtomicBool,
    next: AtomicU32,
    /// Path key → label of the window that has the file open.
    owners: Mutex<HashMap<String, String>>,
    /// Labels in the order they were last focused, most recent last.
    focus: Mutex<Vec<String>>,
}

impl WindowState {
    /// The window a later launch (Win+R `note`, an Explorer double-click) should open into.
    pub fn target(&self, app: &AppHandle) -> Option<WebviewWindow> {
        let windows = app.webview_windows();
        let focus = self.focus.lock().ok()?;
        focus
            .iter()
            .rev()
            .find_map(|label| windows.get(label).cloned())
            .or_else(|| windows.get("main").cloned())
            .or_else(|| windows.values().next().cloned())
    }

    pub fn on_window_event(&self, window: &Window, event: &WindowEvent) {
        let label = window.label().to_owned();
        match event {
            WindowEvent::Focused(true) => {
                if let Ok(mut focus) = self.focus.lock() {
                    focus.retain(|l| l != &label);
                    focus.push(label);
                }
            }
            WindowEvent::Destroyed => {
                if let Ok(mut owners) = self.owners.lock() {
                    owners.retain(|_, owner| owner != &label);
                }
                if let Ok(mut focus) = self.focus.lock() {
                    focus.retain(|l| l != &label);
                }
            }
            _ => {}
        }
    }
}

/// True for the first window of the process to ask: it restores the saved tabs of every window
/// into itself. Windows opened later (torn-off tabs) start with just the tab they were given.
#[tauri::command]
pub fn claim_restore(state: State<'_, WindowState>) -> bool {
    !state.restored.swap(true, Ordering::SeqCst)
}

/// Marks `path` as open in the calling window. Returns the label of another window that already
/// has it open (nothing is claimed then), or null.
#[tauri::command]
pub fn claim_path(
    path: String,
    window: WebviewWindow,
    state: State<'_, WindowState>,
) -> Result<Option<String>, String> {
    let key = path_key(&absolute_path(&path)?);
    let me = window.label().to_owned();
    let live = window.app_handle().webview_windows();
    let mut owners = state.owners.lock().map_err(|_| "Window list unavailable.")?;
    if let Some(owner) = owners.get(&key)
        && owner != &me
        && live.contains_key(owner)
    {
        return Ok(Some(owner.clone()));
    }
    owners.insert(key, me);
    Ok(None)
}

#[tauri::command]
pub fn release_path(
    path: String,
    window: WebviewWindow,
    state: State<'_, WindowState>,
) -> Result<(), String> {
    let key = path_key(&absolute_path(&path)?);
    let mut owners = state.owners.lock().map_err(|_| "Window list unavailable.")?;
    if owners.get(&key).is_some_and(|owner| owner == window.label()) {
        owners.remove(&key);
    }
    Ok(())
}

/// Brings `label` to the front and asks it to show the tab for `path`.
#[tauri::command]
pub fn focus_path_in(app: AppHandle, label: String, path: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or("That window is closed.")?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    window
        .emit_to(label.as_str(), "activate-path", path)
        .map_err(|err| err.to_string())
}

/// Opens a new window for torn-off tabs, the size of the calling window, with its top-left
/// corner at (`x`, `y`) in physical screen pixels. `adopt` lists the draft ids it should open.
/// Async: creating a window from a synchronous command can deadlock on Windows.
#[tauri::command]
pub async fn open_tab_window(
    window: WebviewWindow,
    adopt: Vec<String>,
    x: f64,
    y: f64,
    state: State<'_, WindowState>,
) -> Result<String, String> {
    if adopt.iter().any(|id| crate::store::validate_key(id).is_err()) {
        return Err("A tab id isn't valid.".to_owned());
    }
    let app = window.app_handle().clone();
    let label = format!("w{}", state.next.fetch_add(1, Ordering::SeqCst) + 1);
    let size = window
        .outer_size()
        .unwrap_or(PhysicalSize::new(1180, 780));
    let scale = window.scale_factor().unwrap_or(1.0);
    let url = format!("index.html?adopt={}", adopt.join(","));
    let created = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Margin")
        .decorations(false)
        .visible(true)
        // Focus stays with the window running the drag until the tab is dropped.
        .focused(false)
        .min_inner_size(560.0, 400.0)
        .inner_size(f64::from(size.width) / scale, f64::from(size.height) / scale)
        .background_color(tauri::window::Color(11, 11, 12, 255))
        .build()
        .map_err(|err| format!("Couldn't open a new window: {err}."))?;
    let _ = created.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    #[cfg(windows)]
    {
        crate::window_corner::let_close_receive_mouse(&created);
        crate::spell_menu::install(&created);
    }
    Ok(label)
}

/// Moves a window so its top-left corner is at (`x`, `y`) in physical screen pixels.
#[tauri::command]
pub fn move_window(app: AppHandle, label: String, x: f64, y: f64) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or("That window is closed.")?;
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|err| err.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropTarget {
    label: String,
    /// Where the pointer is across that window, in its CSS pixels.
    client_x: f64,
}

/// The Margin window whose tab bar is under (`x`, `y`) (physical screen pixels), skipping the
/// windows in `exclude`. When windows overlap, the one focused most recently wins.
#[tauri::command]
pub fn tab_drop_target(
    app: AppHandle,
    x: f64,
    y: f64,
    exclude: Vec<String>,
    state: State<'_, WindowState>,
) -> Option<DropTarget> {
    let windows = app.webview_windows();
    let mut order: Vec<String> = state.focus.lock().ok()?.iter().rev().cloned().collect();
    for label in windows.keys() {
        if !order.contains(label) {
            order.push(label.clone());
        }
    }
    order.into_iter().find_map(|label| {
        if exclude.contains(&label) {
            return None;
        }
        let window = windows.get(&label)?;
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
            return None;
        }
        let pos = window.inner_position().ok()?;
        let size = window.inner_size().ok()?;
        let scale = window.scale_factor().ok()?;
        let (left, top) = (f64::from(pos.x), f64::from(pos.y));
        let inside_x = x >= left && x < left + f64::from(size.width);
        let inside_bar = y >= top - 8.0 * scale && y < top + TAB_BAR_HEIGHT * scale;
        (inside_x && inside_bar).then(|| DropTarget {
            label: label.clone(),
            client_x: (x - left) / scale,
        })
    })
}
