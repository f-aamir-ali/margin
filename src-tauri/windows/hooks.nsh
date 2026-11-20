; Margin installer hooks (Tauri NSIS). Everything is per-user (HKCU): no admin rights needed,
; and the uninstaller removes exactly what is added here.
;
; - Win+R -> "note" opens Margin (App Paths).
; - Margin appears under "Open with" for every text-like file, and for common code files.
; - Right-click any file -> "Edit with Margin" (Windows 11: under "Show more options").
; - Margin is listed in Settings > Apps > Default apps, so it can be made the .txt default there.
;
; Default handlers for .md/.txt/.log/config files come from bundle.fileAssociations in tauri.conf.json.
; Code and script files are only offered under "Open with", never made the default: double-clicking
; a .bat or .ps1 must keep running it.

!define MARGIN_EXE "margin.exe"
!define MARGIN_APP "Software\Classes\Applications\${MARGIN_EXE}"
!define MARGIN_CAPS "Software\Margin\Capabilities"

!macro MARGIN_OPEN_WITH EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithList\${MARGIN_EXE}" "" ""
!macroend

!macro MARGIN_OPEN_WITH_REMOVE EXT
  DeleteRegKey HKCU "Software\Classes\.${EXT}\OpenWithList\${MARGIN_EXE}"
!macroend

!macro MARGIN_CAP EXT PROGID
  WriteRegStr HKCU "${MARGIN_CAPS}\FileAssociations" ".${EXT}" "${PROGID}"
!macroend

; The types Margin is a full handler for (bundle.fileAssociations) also list its ProgID under
; OpenWithProgids, so Margin shows by name in "Open with" and the "Select an app" prompt.
!macro MARGIN_PROGID EXT PROGID
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
!macroend

!macro MARGIN_PROGID_REMOVE EXT PROGID
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
!macroend

!macro MARGIN_HANDLED_TYPES MACRO
  !insertmacro ${MACRO} "md" "Margin.Markdown"
  !insertmacro ${MACRO} "markdown" "Margin.Markdown"
  !insertmacro ${MACRO} "mdown" "Margin.Markdown"
  !insertmacro ${MACRO} "mkd" "Margin.Markdown"
  !insertmacro ${MACRO} "mdx" "Margin.Markdown"
  !insertmacro ${MACRO} "mdwn" "Margin.Markdown"
  !insertmacro ${MACRO} "txt" "Margin.Text"
  !insertmacro ${MACRO} "text" "Margin.Text"
  !insertmacro ${MACRO} "log" "Margin.Text"
  !insertmacro ${MACRO} "ini" "Margin.Config"
  !insertmacro ${MACRO} "cfg" "Margin.Config"
  !insertmacro ${MACRO} "conf" "Margin.Config"
  !insertmacro ${MACRO} "nfo" "Margin.Config"
  !insertmacro ${MACRO} "json" "Margin.Config"
  !insertmacro ${MACRO} "jsonc" "Margin.Config"
  !insertmacro ${MACRO} "yaml" "Margin.Config"
  !insertmacro ${MACRO} "yml" "Margin.Config"
  !insertmacro ${MACRO} "toml" "Margin.Config"
  !insertmacro ${MACRO} "env" "Margin.Config"
  !insertmacro ${MACRO} "properties" "Margin.Config"
!macroend

; One list for install and uninstall, so they can't drift apart.
!macro MARGIN_CODE_TYPES MACRO
  !insertmacro ${MACRO} "xml"
  !insertmacro ${MACRO} "csv"
  !insertmacro ${MACRO} "tsv"
  !insertmacro ${MACRO} "html"
  !insertmacro ${MACRO} "htm"
  !insertmacro ${MACRO} "css"
  !insertmacro ${MACRO} "scss"
  !insertmacro ${MACRO} "js"
  !insertmacro ${MACRO} "mjs"
  !insertmacro ${MACRO} "cjs"
  !insertmacro ${MACRO} "ts"
  !insertmacro ${MACRO} "tsx"
  !insertmacro ${MACRO} "jsx"
  !insertmacro ${MACRO} "py"
  !insertmacro ${MACRO} "java"
  !insertmacro ${MACRO} "c"
  !insertmacro ${MACRO} "h"
  !insertmacro ${MACRO} "cpp"
  !insertmacro ${MACRO} "hpp"
  !insertmacro ${MACRO} "cs"
  !insertmacro ${MACRO} "go"
  !insertmacro ${MACRO} "rs"
  !insertmacro ${MACRO} "rb"
  !insertmacro ${MACRO} "php"
  !insertmacro ${MACRO} "sh"
  !insertmacro ${MACRO} "ps1"
  !insertmacro ${MACRO} "psm1"
  !insertmacro ${MACRO} "bat"
  !insertmacro ${MACRO} "cmd"
  !insertmacro ${MACRO} "vbs"
  !insertmacro ${MACRO} "sql"
  !insertmacro ${MACRO} "reg"
  !insertmacro ${MACRO} "inf"
  !insertmacro ${MACRO} "srt"
  !insertmacro ${MACRO} "svg"
  !insertmacro ${MACRO} "lua"
  !insertmacro ${MACRO} "kt"
  !insertmacro ${MACRO} "swift"
  !insertmacro ${MACRO} "dart"
  !insertmacro ${MACRO} "gradle"
  !insertmacro ${MACRO} "lock"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Win+R -> note
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\note.exe" "" "$INSTDIR\${MARGIN_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\note.exe" "Path" "$INSTDIR"

  ; The application itself, for "Open with" lists
  WriteRegStr HKCU "${MARGIN_APP}" "FriendlyAppName" "Margin"
  WriteRegStr HKCU "${MARGIN_APP}\DefaultIcon" "" "$INSTDIR\${MARGIN_EXE},0"
  WriteRegStr HKCU "${MARGIN_APP}\shell\open\command" "" '"$INSTDIR\${MARGIN_EXE}" "%1"'
  WriteRegStr HKCU "${MARGIN_APP}\shell\edit\command" "" '"$INSTDIR\${MARGIN_EXE}" "%1"'

  ; Every file Windows considers text (PerceivedType=text) offers Margin under "Open with"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\text\OpenWithList\${MARGIN_EXE}" "" ""
  !insertmacro MARGIN_CODE_TYPES MARGIN_OPEN_WITH
  !insertmacro MARGIN_HANDLED_TYPES MARGIN_PROGID

  ; Right-click any file -> Edit with Margin
  WriteRegStr HKCU "Software\Classes\*\shell\EditWithMargin" "" "Edit with Margin"
  WriteRegStr HKCU "Software\Classes\*\shell\EditWithMargin" "Icon" "$INSTDIR\${MARGIN_EXE},0"
  WriteRegStr HKCU "Software\Classes\*\shell\EditWithMargin\command" "" '"$INSTDIR\${MARGIN_EXE}" "%1"'

  ; Settings > Default apps > Margin
  WriteRegStr HKCU "${MARGIN_CAPS}" "ApplicationName" "Margin"
  WriteRegStr HKCU "${MARGIN_CAPS}" "ApplicationDescription" "A notepad that never loses a note, with live Markdown."
  !insertmacro MARGIN_CAP "md" "Margin.Markdown"
  !insertmacro MARGIN_CAP "markdown" "Margin.Markdown"
  !insertmacro MARGIN_CAP "txt" "Margin.Text"
  !insertmacro MARGIN_CAP "text" "Margin.Text"
  !insertmacro MARGIN_CAP "log" "Margin.Text"
  !insertmacro MARGIN_CAP "ini" "Margin.Config"
  !insertmacro MARGIN_CAP "json" "Margin.Config"
  !insertmacro MARGIN_CAP "yaml" "Margin.Config"
  !insertmacro MARGIN_CAP "yml" "Margin.Config"
  !insertmacro MARGIN_CAP "toml" "Margin.Config"
  WriteRegStr HKCU "Software\RegisteredApplications" "Margin" "${MARGIN_CAPS}"

  ; Tell Explorer the associations changed (SHCNE_ASSOCCHANGED)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\note.exe"
  DeleteRegKey HKCU "${MARGIN_APP}"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\text\OpenWithList\${MARGIN_EXE}"
  !insertmacro MARGIN_CODE_TYPES MARGIN_OPEN_WITH_REMOVE
  !insertmacro MARGIN_HANDLED_TYPES MARGIN_PROGID_REMOVE
  DeleteRegKey HKCU "Software\Classes\*\shell\EditWithMargin"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Margin"
  DeleteRegKey HKCU "Software\Margin"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
