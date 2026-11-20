"""Regenerate third-party notices from the locked Windows release dependencies."""

from collections import defaultdict
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[2]
LICENSES = Path(__file__).resolve().parent / "licenses"
WINDOWS = "x86_64-pc-windows-msvc"
NOTICE_NAME = re.compile(
    r"^(licen[cs]es?|licen[cs]e[-_.].*|copying[._-]?.*|notice[._-]?.*|"
    r"copyright[._-]?.*|ofl[._-]?.*|unlicense[._-]?.*)$",
    re.IGNORECASE,
)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def notice_files(folder):
    return sorted(path for path in folder.iterdir() if path.is_file() and NOTICE_NAME.match(path.name))


def npm_dependencies():
    for entry, locked in read_json(ROOT / "package-lock.json")["packages"].items():
        manifest = ROOT / entry / "package.json"
        if not entry or locked.get("dev"):
            continue
        if not manifest.is_file() and locked.get("optional"):
            continue
        metadata = read_json(manifest)
        name, version = metadata["name"], metadata["version"]
        files = notice_files(manifest.parent)
        if (name, version) == ("remark-math", "6.0.0") and not files:
            files = [LICENSES / "remark-math.txt"]
        licence = "MIT" if (name, version) == ("khroma", "2.1.0") else metadata.get("license")
        if name == "elkjs":
            licence = "EPL-2.0 (chosen from EPL-2.0 OR GPL-3.0-or-later)"
        if name == "dompurify":
            licence = "Apache-2.0 (chosen from MPL-2.0 OR Apache-2.0)"
        yield f"npm {name} {version}", licence, locked["resolved"], files


def cargo(*options):
    return subprocess.check_output(
        ["cargo", options[0], "--manifest-path", "src-tauri/Cargo.toml", "--locked", *options[1:]],
        cwd=ROOT,
        encoding="utf-8",
    )


def rust_dependencies():
    packages = json.loads(cargo("metadata", "--format-version", "1", "--filter-platform", WINDOWS))["packages"]
    tree = cargo("tree", "--target", WINDOWS, "-e", "normal", "--prefix", "none", "--format", "{p}")
    versions = {tuple(line.split()[:2]) for line in tree.splitlines()}
    fallbacks = {
        ("alloc-stdlib", "0.3.0"): LICENSES / "alloc-stdlib.txt",
        ("webview2-com", "0.39.1"): LICENSES / "webview2-rs.txt",
        ("webview2-com-macros", "0.8.1"): LICENSES / "webview2-com-macros.txt",
        ("webview2-com-sys", "0.39.1"): LICENSES / "webview2-rs.txt",
    }
    mpl = next(Path(p["manifest_path"]).parent / "LICENSE" for p in packages if p["name"] == "cssparser")
    fallbacks[("selectors", "0.38.0")] = mpl
    for package in packages:
        name, version = package["name"], package["version"]
        if not package["source"] or (name, f"v{version}") not in versions:
            continue
        folder = Path(package["manifest_path"]).parent
        files = notice_files(folder)
        if package["license_file"]:
            files = sorted(set(files + [folder / package["license_file"]]))
        if not files and (name, version) in fallbacks:
            files = [fallbacks[name, version]]
        archive = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
        yield f"Rust {name} {version}", package["license"] or "See the licence below", archive, files


def main():
    notes = {}
    notice_ids = {}
    for label, licence, source, files in sorted([*npm_dependencies(), *rust_dependencies()]):
        if not licence or not files:
            raise ValueError(f"No licence metadata or notice for {label}")
        index = []
        for path in files:
            contents = path.read_text(encoding="utf-8-sig").strip()
            if contents:
                index.append(notice_ids.setdefault(contents, len(notice_ids) + 1))
        if not index:
            raise ValueError(f"Empty licence notices for {label}")
        location = ", ".join(str(number) for number in sorted(set(index)))
        notes[label] = f"{label}\n  Licence: {licence}\n  Package archive: {source}\n  Notice(s): {location}"

    header = """Third-party notices for Margin (Windows x64)

Margin's own code is covered by the MIT License in LICENSE. The components
listed below are distributed under their respective terms. Each entry gives
the exact dependency archive and the corresponding licence or notice text.
The source code for the MPL-covered Rust dependencies is in their linked
crate archives. Recipients can obtain it under the MPL terms below.

ELK layout is distributed under the Eclipse Public License 2.0. The ELK
JavaScript source and build instructions are available at
https://github.com/kieler/elkjs/tree/624ae90aa37110033a8af59c5ccbb292708b4317
The ELK upstream sources are available at https://github.com/eclipse-elk/elk
The exact npm archive below includes both the unminified and bundled JavaScript.

Microsoft Edge WebView2 is a separate Windows runtime and is subject to
Microsoft's terms. The installer can obtain it from Microsoft as needed.

Dependency index
"""
    full_notices = "\n\n".join(f"===== Notice {number} =====\n\n{text}" for text, number in notice_ids.items())
    output = header + "\n" + "\n\n".join(notes.values()) + "\n\n" + full_notices + "\n"
    (ROOT / "THIRD_PARTY_NOTICES.txt").write_text(output, encoding="utf-8", newline="\n")
    print(f"Wrote notices for {len(notes)} dependencies ({len(notice_ids)} unique texts).")


if __name__ == "__main__":
    main()
