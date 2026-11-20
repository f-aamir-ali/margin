# Margin

Margin is a Windows notepad with a Markdown reader and a live Markdown editor. Open the same file in **Read** for a clean page, **Edit** for formatting as you type, or **Source** for the Markdown text. Plain text, logs, and code open as text.

## Install on Windows

1. Open the [latest release](https://github.com/f-aamir-ali/margin/releases/latest) and download the file ending in `_x64-setup.exe` under **Assets**.
2. Run the installer. It installs for your Windows account. You can open Margin from the Start menu or press **Win+R**, type `note`, and press **Enter**.
3. To open Markdown files in Margin by default, right-click a `.md` file, choose **Open with → Choose another app**, select **Margin**, then choose **Always**.

The installer is for 64-bit Windows PCs with an Intel or AMD processor. It uses Microsoft Edge WebView2, which the installer can download if it is missing. The installer is unsigned, so Windows may show an Unknown publisher or SmartScreen warning. A SHA-256 checksum is included on the release page.

## What you can do

- Switch between reading, live editing, and raw Markdown. Render math with KaTeX, Mermaid diagrams, task lists, tables, footnotes, and highlighted code.
- Open files in tabs, search or replace text, and choose the encoding and line endings.
- Export to HTML or use the Windows print dialog to print or save as PDF.
- Close the window and pick up your tabs and saved drafts the next time you open it.

Margin has no account or telemetry. Files and drafts stay on the device. Opening a document with a remote image may fetch that image, and exported HTML can use a remote stylesheet for math. Installing on another PC gives you the app. Bring your Markdown files over separately if you want to read or edit the same notes there. Unsaved drafts are kept in `%APPDATA%\com.faamirali.margin\drafts`.

## Build from source

Use Windows with Node.js 22.12 or later, Rust stable, Microsoft C++ Build Tools with **Desktop development with C++**, and WebView2. The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) explain how to install them.

```powershell
git clone https://github.com/f-aamir-ali/margin.git
cd margin
npm ci
npm run tauri dev
```

Run `npm run tauri build` to create a local Windows installer in `src-tauri/target/release/bundle/nsis`. Use `tools/release/build-windows.ps1` for release builds. It removes machine paths from Rust diagnostics and puts the x64 installer and checksum in `release/`. Run `npx vitest run` and `cargo test --manifest-path src-tauri/Cargo.toml --locked` for the frontend and core tests.

After changing dependencies, regenerate the installer notices with `python tools/release/generate-notices.py` on Windows.

## Licence

Margin is released under the [MIT License](LICENSE). The bundled dependencies have their own licences in [Third-party notices](THIRD_PARTY_NOTICES.txt). See [Architecture](docs/ARCHITECTURE.md) for the app structure and desktop test commands.
