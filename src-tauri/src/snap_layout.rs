//! Opens the Windows 11 Snap Layouts flyout for the main window.
//!
//! The title bar is HTML, so Windows never sees the pointer on the maximize button and won't
//! show the flyout by itself. The front end calls `show_snap_layout` when the pointer rests on
//! that button, and this presses Win+Z, the shortcut that opens Snap Layouts for the active window.

use tauri::WebviewWindow;
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
    VIRTUAL_KEY, VK_LWIN,
};

const VK_Z: VIRTUAL_KEY = VIRTUAL_KEY(0x5A);

/// Presses Win+Z when the main window is already in front.
pub fn show(window: &WebviewWindow) -> Result<(), String> {
    // Hovering must never pull Margin in front of the app being used, and Win+Z goes to
    // whichever window is in front: only press it when Margin already is the front window.
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
