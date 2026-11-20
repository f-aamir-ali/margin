use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        UI::{
            HiDpi::GetDpiForWindow,
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                FindWindowExW, GetWindowRect, HTTRANSPARENT, WM_NCDESTROY, WM_NCHITTEST,
            },
        },
    },
    core::w,
};

// Match --window-control-width in tokens.css.
const CLOSE_WIDTH_DIP: i32 = 44;
const TITLEBAR_HEIGHT_DIP: i32 = 46;
const SUBCLASS_ID: usize = 1;

/// Tauri places a resize window over the top strip of an undecorated window on Windows.
/// Let the webview handle the strip above Close so the rest of the border still resizes.
pub fn let_close_receive_mouse(window: &tauri::WebviewWindow) {
    let Ok(parent) = window.hwnd() else { return };
    // Tauri creates this child before setup. If a future runtime omits it, the webview
    // already receives the pointer and doesn't need a subclass.
    let Ok(resize) = (unsafe {
        FindWindowExW(
            Some(parent),
            None,
            w!("TAURI_DRAG_RESIZE_BORDERS"),
            w!("TAURI_DRAG_RESIZE_WINDOW"),
        )
    }) else {
        return;
    };
    // Setup runs on the same UI thread as the window.
    let _ = unsafe { SetWindowSubclass(resize, Some(allow_close_hit), SUBCLASS_ID, 0) };
}

unsafe extern "system" fn allow_close_hit(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass: usize,
    _: usize,
) -> LRESULT {
    if message == WM_NCHITTEST {
        let mut bounds = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut bounds) }.is_ok() {
            let x = lparam.0 as i16 as i32;
            let y = (lparam.0 >> 16) as i16 as i32;
            let dpi = unsafe { GetDpiForWindow(hwnd) } as i32;
            let button_width = (CLOSE_WIDTH_DIP * dpi + 95) / 96;
            let button_bottom = bounds
                .bottom
                .min(bounds.top + (TITLEBAR_HEIGHT_DIP * dpi + 95) / 96);
            if (bounds.right - button_width..bounds.right).contains(&x)
                && (bounds.top..button_bottom).contains(&y)
            {
                return LRESULT(HTTRANSPARENT as isize);
            }
        }
    } else if message == WM_NCDESTROY {
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(allow_close_hit), subclass) };
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
