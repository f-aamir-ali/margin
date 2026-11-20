use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::blocking;
use crate::watcher::SelfWrites;

const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const MARKDOWN_EXTENSIONS: [&str; 6] = ["md", "markdown", "mdown", "mkd", "mdx", "mdwn"];
const SKIPPED_FOLDER: &str = "node_modules";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileData {
    path: String,
    name: String,
    content: String,
    mtime_ms: f64,
    size: u64,
    readonly: bool,
    /// WHATWG name of the encoding the bytes were decoded from ("UTF-8", "UTF-16LE", "windows-1252"…).
    encoding: String,
    /// The file started with a byte order mark; saving writes it back.
    bom: bool,
    /// Opened despite looking binary: shown, but never saved over.
    binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    mtime_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_markdown: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    exists: bool,
    mtime_ms: f64,
    size: u64,
    is_dir: bool,
}

/// `encoding` forces a decoding ("Reopen with encoding"); `force` opens a file that looks binary.
#[tauri::command]
pub async fn read_file(
    path: String,
    encoding: Option<String>,
    force: Option<bool>,
) -> Result<FileData, String> {
    blocking(move || read_file_sync(&path, encoding.as_deref(), force.unwrap_or(false))).await
}

/// Writes `content` in `encoding` (default UTF-8), with a byte order mark when `bom` is set.
#[tauri::command]
pub async fn write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    bom: Option<bool>,
    writes: State<'_, SelfWrites>,
) -> Result<WriteResult, String> {
    let writes = writes.inner().clone();
    blocking(move || {
        let label = encoding.as_deref().unwrap_or("UTF-8");
        let bytes = encode_text(&content, label, bom.unwrap_or(false))?;
        write_file_sync(&path, &bytes, &writes)
    })
    .await
}

#[tauri::command]
pub async fn write_binary(path: String, base64: String) -> Result<(), String> {
    blocking(move || write_binary_sync(&path, &base64)).await
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    blocking(move || list_dir_sync(&path)).await
}

#[tauri::command]
pub async fn file_meta(path: String) -> Result<FileMeta, String> {
    blocking(move || file_meta_sync(&path)).await
}

#[tauri::command]
pub async fn reveal_in_explorer(app: AppHandle, path: String) -> Result<(), String> {
    let target = blocking(move || {
        let target = absolute_path(&path)?;
        if target.exists() {
            Ok(target)
        } else {
            Err(format!("{} doesn't exist.", target.display()))
        }
    })
    .await?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|err| format!("Couldn't show {} in Explorer: {err}.", target.display()))
}

#[tauri::command]
pub async fn open_linked_file(app: AppHandle, path: String) -> Result<(), String> {
    let target = blocking(move || {
        let path = Path::new(&path);
        if !is_local_path(path) {
            return Err("This link needs an absolute path on a local drive.".to_owned());
        }
        let target = path
            .canonicalize()
            .map_err(|err| io_message("open", path, &err))?;
        if !is_local_path(&target) {
            return Err("This link needs a file or folder on a local drive.".to_owned());
        }
        if target.is_dir() || is_linked_file_type(&target) {
            Ok(target)
        } else {
            Err(format!(
                "Margin can't open this file type from a link: {}.",
                file_name(&target)
            ))
        }
    })
    .await?;
    let path = path_string(&target);
    // The Windows shell expects a standard DOS path, while canonicalize returns a verbatim one.
    let path = if cfg!(windows) {
        path.strip_prefix(r"\\?\").unwrap_or(&path)
    } else {
        &path
    };
    app.opener().open_path(path, None::<&str>).map_err(|err| {
        format!(
            "Couldn't open {} in its default app: {err}.",
            file_name(&target)
        )
    })
}

#[cfg(windows)]
fn is_local_path(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    let mut components = path.components();
    path.is_absolute()
        && matches!(
            components.next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
        && components.all(|part| !part.as_os_str().to_string_lossy().contains(':'))
}

#[cfg(not(windows))]
fn is_local_path(path: &Path) -> bool {
    path.is_absolute()
}

fn is_linked_file_type(path: &Path) -> bool {
    if is_markdown_path(path) {
        return true;
    }
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    // These formats are opened for viewing. Executables, scripts and shortcuts stay out of the shell.
    let allowed = "pdf xps doc docx odt rtf xls xlsx ods ppt pptx odp epub zip 7z rar \
        txt text log ini cfg conf nfo json jsonc yaml yml toml csv tsv xml html htm \
        apng avif bmp gif ico jpg jpeg jfif png svg webp tif tiff heic heif \
        mp3 wav flac m4a ogg mp4 m4v mov mkv avi webm";
    allowed.split_ascii_whitespace().any(|known| ext.eq_ignore_ascii_case(known))
}

fn read_file_sync(path: &str, encoding: Option<&str>, force: bool) -> Result<FileData, String> {
    let target = absolute_path(path)?;
    let name = file_name(&target);
    let meta = fs::metadata(&target).map_err(|err| io_message("open", &target, &err))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder, not a file.", target.display()));
    }
    check_readable_size(meta.len(), &name)?;
    let bytes = fs::read(&target).map_err(|err| io_message("open", &target, &err))?;
    let binary = looks_binary(&bytes);
    if binary && !force {
        // The frontend recognises this prefix and offers "Open anyway".
        return Err(format!("BINARY: {name} looks like a binary file, not text."));
    }
    let decoded = match encoding {
        Some(label) => decode_as(&bytes, label)?,
        None => decode_text(&bytes),
    };
    Ok(FileData {
        path: path_string(&target),
        name,
        content: decoded.text,
        mtime_ms: modified_ms(&meta),
        size: meta.len(),
        readonly: meta.permissions().readonly() || binary,
        encoding: decoded.encoding,
        bom: decoded.bom,
        binary,
    })
}

fn write_file_sync(path: &str, content: &[u8], writes: &SelfWrites) -> Result<WriteResult, String> {
    let target = absolute_path(path)?;
    if fs::metadata(&target).is_ok_and(|meta| meta.permissions().readonly()) {
        return Err(format!(
            "{} is read-only, so it wasn't saved.",
            file_name(&target)
        ));
    }
    writes.record(&target);
    if let Err(err) = atomic_write(&target, content) {
        writes.forget(&target);
        return Err(err);
    }
    let meta = fs::metadata(&target).map_err(|err| io_message("check", &target, &err))?;
    Ok(WriteResult {
        mtime_ms: modified_ms(&meta),
    })
}

fn write_binary_sync(path: &str, encoded: &str) -> Result<(), String> {
    let target = absolute_path(path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|err| format!("The file data isn't valid base64: {err}."))?;
    if let Some(folder) = target.parent() {
        fs::create_dir_all(folder)
            .map_err(|err| io_message("create the folder for", &target, &err))?;
    }
    atomic_write(&target, &bytes)
}

fn list_dir_sync(path: &str) -> Result<Vec<DirEntry>, String> {
    let folder = absolute_path(path)?;
    if !folder.is_dir() {
        return Err(format!("{} isn't a folder.", folder.display()));
    }
    let read = fs::read_dir(&folder).map_err(|err| io_message("read", &folder, &err))?;
    let mut entries: Vec<DirEntry> = read
        .filter_map(Result::ok)
        .filter_map(|item| {
            let name = item.file_name().to_string_lossy().into_owned();
            // Dot-names cover `.git` and other hidden entries.
            if name.starts_with('.') || name == SKIPPED_FOLDER {
                return None;
            }
            let entry_path = item.path();
            // Follows symlinks; broken links are skipped.
            let meta = fs::metadata(&entry_path).ok()?;
            if has_hidden_attribute(&meta) {
                return None;
            }
            let is_dir = meta.is_dir();
            Some(DirEntry {
                is_markdown: !is_dir && is_markdown_path(&entry_path),
                path: path_string(&entry_path),
                name,
                is_dir,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natord::compare_ignore_case(&a.name, &b.name))
    });
    Ok(entries)
}

fn file_meta_sync(path: &str) -> Result<FileMeta, String> {
    let target = absolute_path(path)?;
    match fs::metadata(&target) {
        Ok(meta) => Ok(FileMeta {
            exists: true,
            mtime_ms: modified_ms(&meta),
            size: meta.len(),
            is_dir: meta.is_dir(),
        }),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(FileMeta {
            exists: false,
            mtime_ms: 0.0,
            size: 0,
            is_dir: false,
        }),
        Err(err) => Err(io_message("check", &target, &err)),
    }
}

/// Writes to a temporary file in the same folder, then renames it over `target`.
pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let folder = target
        .parent()
        .ok_or_else(|| format!("{} has no folder to save into.", target.display()))?;
    let mut temp = tempfile::NamedTempFile::new_in(folder)
        .map_err(|err| io_message("save", target, &err))?;
    temp.write_all(bytes)
        .map_err(|err| io_message("save", target, &err))?;
    temp.as_file()
        .sync_all()
        .map_err(|err| io_message("save", target, &err))?;
    temp.persist(target)
        .map_err(|err| io_message("save", target, &err.error))?;
    Ok(())
}

/// Returns the absolute form of `path`, without touching the disk.
pub(crate) fn absolute_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("No file path was given.".to_owned());
    }
    std::path::absolute(path).map_err(|err| format!("Couldn't resolve {path}: {err}."))
}

/// Case-insensitive on Windows, so paths from the watcher match paths from the frontend.
pub(crate) fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.into_owned()
    }
}

/// Keeps the absolute paths of the existing files among `args`, resolved against `base`.
/// Any file counts, like Notepad: plain text, logs, code and config as well as Markdown.
pub fn file_paths_from_args<I, S>(args: I, base: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .filter(|arg| !arg.as_ref().is_empty() && !arg.as_ref().starts_with("--"))
        .map(|arg| base.join(arg.as_ref()))
        .filter(|candidate| candidate.is_file())
        .filter_map(|candidate| std::path::absolute(candidate).ok())
        .map(|candidate| path_string(&candidate))
        .collect()
}

pub fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        })
}

#[derive(Debug, PartialEq)]
pub struct Decoded {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
}

/// NUL bytes in the first 8 KB mean binary, unless a UTF-16 byte order mark explains them.
fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Decodes any text file and never fails: a byte order mark wins, then strict UTF-8, then the
/// most likely legacy code page (Windows-1252 for most Western text). The BOM is removed.
pub fn decode_text(bytes: &[u8]) -> Decoded {
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
        return Decoded {
            text: text.into_owned(),
            encoding: encoding.name().to_owned(),
            bom: true,
        };
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Decoded {
            text: text.to_owned(),
            encoding: "UTF-8".to_owned(),
            bom: false,
        };
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, false);
    let (text, _) = encoding.decode_without_bom_handling(bytes);
    Decoded {
        text: text.into_owned(),
        encoding: encoding.name().to_owned(),
        bom: false,
    }
}

fn encoding_for(label: &str) -> Result<&'static encoding_rs::Encoding, String> {
    encoding_rs::Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("\"{label}\" isn't an encoding I know."))
}

/// Decodes with a chosen encoding ("Reopen with encoding"). A matching BOM is still stripped.
fn decode_as(bytes: &[u8], label: &str) -> Result<Decoded, String> {
    let encoding = encoding_for(label)?;
    let bom_len = match encoding_rs::Encoding::for_bom(bytes) {
        Some((found, len)) if found == encoding => len,
        _ => 0,
    };
    let (text, _) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
    Ok(Decoded {
        text: text.into_owned(),
        encoding: encoding.name().to_owned(),
        bom: bom_len > 0,
    })
}

/// Encodes for saving. Refuses, rather than writing `&#NNNN;` escapes, when a character can't be
/// represented in a legacy code page.
pub fn encode_text(text: &str, label: &str, bom: bool) -> Result<Vec<u8>, String> {
    let encoding = encoding_for(label)?;
    let mut out = Vec::with_capacity(text.len() + 3);
    if encoding == encoding_rs::UTF_16LE || encoding == encoding_rs::UTF_16BE {
        let le = encoding == encoding_rs::UTF_16LE;
        if bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return Ok(out);
    }
    if encoding == encoding_rs::UTF_8 {
        if bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        out.extend_from_slice(text.as_bytes());
        return Ok(out);
    }
    let (bytes, _, had_errors) = encoding.encode(text);
    if had_errors {
        return Err(format!(
            "UNMAPPABLE: Some characters can't be saved as {}. Save it as UTF-8 instead.",
            encoding.name()
        ));
    }
    out.extend_from_slice(&bytes);
    Ok(out)
}

fn check_readable_size(len: u64, name: &str) -> Result<(), String> {
    if len <= MAX_READ_BYTES {
        return Ok(());
    }
    let megabytes = len as f64 / (1024.0 * 1024.0);
    Err(format!(
        "{name} is {megabytes:.1} MB. Margin opens files up to 50 MB."
    ))
}

pub(crate) fn io_message(action: &str, path: &Path, err: &io::Error) -> String {
    let reason = match err.kind() {
        io::ErrorKind::NotFound => "the file or folder doesn't exist".to_owned(),
        io::ErrorKind::PermissionDenied => "access was denied".to_owned(),
        _ => err.to_string(),
    };
    format!("Couldn't {action} {}: {reason}.", path.display())
}

fn modified_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| path_string(path), |name| name.to_string_lossy().into_owned())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn has_hidden_attribute(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    (meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
}

#[cfg(not(windows))]
fn has_hidden_attribute(_meta: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16_bytes(text: &str, big_endian: bool) -> Vec<u8> {
        let mut bytes = if big_endian {
            vec![0xFE, 0xFF]
        } else {
            vec![0xFF, 0xFE]
        };
        for unit in text.encode_utf16() {
            let pair = if big_endian {
                unit.to_be_bytes()
            } else {
                unit.to_le_bytes()
            };
            bytes.extend_from_slice(&pair);
        }
        bytes
    }

    fn decoded(text: &str, encoding: &str, bom: bool) -> Decoded {
        Decoded {
            text: text.to_owned(),
            encoding: encoding.to_owned(),
            bom,
        }
    }

    #[test]
    fn decodes_plain_utf8() {
        assert_eq!(decode_text("# Hi".as_bytes()), decoded("# Hi", "UTF-8", false));
    }

    #[test]
    fn strips_and_remembers_utf8_bom() {
        let bytes = [&[0xEF, 0xBB, 0xBF][..], "café".as_bytes()].concat();
        assert_eq!(decode_text(&bytes), decoded("café", "UTF-8", true));
        assert_eq!(encode_text("café", "UTF-8", true).expect("encode"), bytes);
    }

    #[test]
    fn utf16_round_trips_both_byte_orders() {
        for big_endian in [false, true] {
            let bytes = utf16_bytes("# Title ✓ x🙂", big_endian);
            let d = decode_text(&bytes);
            assert_eq!(d.text, "# Title ✓ x🙂");
            assert!(d.bom);
            assert_eq!(encode_text(&d.text, &d.encoding, true).expect("encode"), bytes);
        }
    }

    #[test]
    fn legacy_ansi_text_opens_and_saves_back_byte_identical() {
        // "café, naïve – 50 €" in Windows-1252.
        let bytes = b"caf\xe9, na\xefve \x96 50 \x80\r\n".to_vec();
        let d = decode_text(&bytes);
        assert_eq!(d.encoding, "windows-1252");
        assert_eq!(d.text, "café, naïve – 50 €\r\n");
        assert_eq!(encode_text(&d.text, &d.encoding, d.bom).expect("encode"), bytes);
    }

    #[test]
    fn unmappable_characters_refuse_to_save_in_a_legacy_encoding() {
        let err = encode_text("smile 🙂", "windows-1252", false).expect_err("must refuse");
        assert!(err.starts_with("UNMAPPABLE"));
    }

    #[test]
    fn reopen_with_encoding_overrides_detection() {
        let d = decode_as("café".as_bytes(), "windows-1252").expect("decode");
        assert_eq!(d.text, "cafÃ©");
        assert!(decode_as(b"x", "klingon").is_err());
    }

    #[test]
    fn binary_detection() {
        assert!(looks_binary(&[0x4D, 0x5A, 0x00, 0x01]));
        assert!(!looks_binary(b"plain text"));
        assert!(!looks_binary(&utf16_bytes("hi", false)));
    }

    #[test]
    fn rejects_files_over_the_read_limit() {
        assert!(check_readable_size(MAX_READ_BYTES, "a.md").is_ok());
        assert!(check_readable_size(MAX_READ_BYTES + 1, "a.md").is_err());
    }

    #[test]
    fn atomic_write_round_trips_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("note.md");
        atomic_write(&target, "first".as_bytes()).expect("first write");
        atomic_write(&target, "second 🙂".as_bytes()).expect("second write");
        assert_eq!(
            fs::read_to_string(&target).expect("read back"),
            "second 🙂"
        );
        let names: Vec<String> = fs::read_dir(dir.path())
            .expect("list folder")
            .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["note.md".to_owned()]);
    }

    #[test]
    fn list_dir_sorts_folders_first_and_skips_hidden_entries() {
        let dir = tempfile::tempdir().expect("temp dir");
        for folder in ["Zeta", "alpha", "node_modules", ".git"] {
            fs::create_dir(dir.path().join(folder)).expect("create folder");
        }
        for file in ["item10.md", "item2.md", "A.md", "b.md", "notes.txt", ".hidden.md"] {
            fs::write(dir.path().join(file), "text").expect("create file");
        }

        let entries = list_dir_sync(&dir.path().to_string_lossy()).expect("list folder");
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            ["alpha", "Zeta", "A.md", "b.md", "item2.md", "item10.md", "notes.txt"]
        );
        assert!(entries[..2].iter().all(|entry| entry.is_dir && !entry.is_markdown));
        let notes = entries.iter().find(|entry| entry.name == "notes.txt");
        assert!(notes.is_some_and(|entry| !entry.is_markdown));
        let note = entries.iter().find(|entry| entry.name == "A.md");
        assert!(note.is_some_and(|entry| entry.is_markdown));
    }

    #[test]
    fn cli_args_keep_existing_files_of_any_type() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("a.md"), "text").expect("a.md");
        fs::write(dir.path().join("b.txt"), "text").expect("b.txt");
        fs::write(dir.path().join("C.MD"), "text").expect("C.MD");
        fs::create_dir(dir.path().join("folder.md")).expect("folder.md");

        let args = ["--flag", "a.md", "b.txt", "C.MD", "missing.md", "folder.md", ""];
        let found = file_paths_from_args(args, dir.path());
        let names: Vec<String> = found
            .iter()
            .map(|path| file_name(Path::new(path)))
            .collect();

        assert_eq!(
            names,
            vec!["a.md".to_owned(), "b.txt".to_owned(), "C.MD".to_owned()]
        );
        assert!(found.iter().all(|path| Path::new(path).is_absolute()));
    }
}
