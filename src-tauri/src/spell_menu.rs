//! Spelling suggestions on right-click.
//!
//! Margin draws its own context menu in the page. WebView2 doesn't tell a custom menu what the
//! spelling suggestions are (their labels come through blank), so when the right-click lands on
//! a misspelled word the native menu is shown instead, trimmed to the spelling and editing items.
//! Every other right-click is handled here (no native menu) and the page is told to draw its own.

use serde::Serialize;
use tauri::{Emitter, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_11, ICoreWebView2ContextMenuItemCollection,
    ICoreWebView2ContextMenuRequestedEventArgs,
};
use webview2_com::{ContextMenuRequestedEventHandler, take_pwstr};
use windows::core::{Interface, PWSTR};

/// Sent for every right-click so the page knows whether to draw its own menu.
const ROUTE: &str = "context-menu-route";

/// Native items that make no sense in a notepad (browser navigation, printing, developer tools).
const DROPPED: [&str; 18] = [
    "back",
    "forward",
    "reload",
    "saveAs",
    "print",
    "createQrCode",
    "inspectElement",
    "emoji",
    "share",
    "webCapture",
    "openLinkInNewWindow",
    "saveLinkAs",
    "copyLinkLocation",
    "saveImageAs",
    "copyImage",
    "copyImageLocation",
    "openLinkInProfile",
    "openLinkInNewTab",
];

#[derive(Clone, Serialize)]
struct Route {
    native: bool,
}

pub fn install(window: &WebviewWindow) {
    let emitter = window.clone();
    let _ = window.with_webview(move |webview| {
        // SAFETY: COM calls on the WebView2 controller, made on the thread that owns it.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(core) = core.cast::<ICoreWebView2_11>() else {
                return;
            };
            let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let native = route(&args).unwrap_or(false);
                if !native {
                    args.SetHandled(true)?;
                }
                let _ = emitter.emit(ROUTE, Route { native });
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_ContextMenuRequested(&handler, &mut token);
        }
    });
}

/// True when the native menu should show: the click is on a misspelled word.
unsafe fn route(args: &ICoreWebView2ContextMenuRequestedEventArgs) -> windows::core::Result<bool> {
    let items = unsafe { args.MenuItems()? };
    let names = unsafe { item_names(&items)? };
    // The runtime calls them "spellcheck"; the documentation says "spellCheck".
    if !names.iter().any(|name| name.eq_ignore_ascii_case("spellcheck")) {
        return Ok(false);
    }
    // Remove from the end so indices stay valid.
    for (index, name) in names.iter().enumerate().rev() {
        if DROPPED.contains(&name.as_str()) {
            unsafe { items.RemoveValueAtIndex(index as u32)? };
        }
    }
    Ok(true)
}

unsafe fn item_names(items: &ICoreWebView2ContextMenuItemCollection) -> windows::core::Result<Vec<String>> {
    let mut count = 0u32;
    unsafe { items.Count(&mut count)? };
    let mut names = Vec::with_capacity(count as usize);
    for index in 0..count {
        let item = unsafe { items.GetValueAtIndex(index)? };
        let mut name = PWSTR::null();
        unsafe { item.Name(&mut name)? };
        names.push(take_pwstr(name));
    }
    Ok(names)
}
