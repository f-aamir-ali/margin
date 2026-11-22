//! Opens the Windows 11 Snap Layouts flyout for the main window.
//!
//! The title bar is HTML, so Windows never sees the pointer on the maximize button and won't
//! show the flyout by itself. The front end calls `show_snap_layout` when the pointer rests on
//! that button, and this presses Win+Z, the shortcut that opens Snap Layouts for the active window.

use tauri::{AppHandle, Manager};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
    VIRTUAL_KEY, VK_LWIN,
};

const MAIN_WINDOW: &str = "main";
const VK_Z: VIRTUAL_KEY = VIRTUAL_KEY(0x5A);

/// Focuses the main window, then presses Win+Z.
pub fn show(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("The main window isn't open.")?;
    // Win+Z goes to whichever window is in front, so don't press it if focusing failed.
    window
        .set_focus()
        .map_err(|err| format!("Couldn't focus the window: {err}."))?;
    // Never send Win+Z to another app: only press it when Margin really is the front window.
    let hwnd = window.hwnd().map_err(|err| format!("No window handle: {err}."))?;
    if unsafe { GetForegroundWindow() } != hwnd {
        return Err("Margin isn't the front window.".to_owned());
    }
    press_win_z()
}

fn press_win_z() -> Result<(), String> {
    let chord = [
        key(VK_LWIN, false),
        key(VK_Z, false),
        key(VK_Z, true),
        key(VK_LWIN, true),
    ];
    let size = std::mem::size_of::<INPUT>() as i32;
    let sent = unsafe { SendInput(&chord, size) };
    if sent as usize == chord.len() {
        return Ok(());
    }
    // Only part of the chord went in, so Win may still be held down. Release it on its own.
    let _ = unsafe { SendInput(&[key(VK_LWIN, true)], size) };
    Err("Windows didn't accept the Snap Layouts key press.".to_owned())
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    let flags = if up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
