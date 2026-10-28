; NSIS hooks for the Tauri installer (bundle.windows.nsis.installerHooks).
;
; PRODUCTNAME, MAINBINARYNAME and BUNDLEID come from Tauri's installer
; template, so the same file serves the release app ("dawg") and local test
; builds ("dawg dev") without their Explorer entries clashing.

!define DAWG_VERB_KEY "Software\Classes\SystemFileAssociations\.wav\shell\${BUNDLEID}"

!macro NSIS_HOOK_PREINSTALL
  ; Claude Desktop and other MCP clients keep dawg-cli.exe running as the MCP
  ; server, and Windows won't replace a running exe. The client restarts it
  ; on next use.
  nsExec::Exec 'taskkill /F /IM dawg-cli.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Per-user "Edit in dawg" entry on .wav files (classic menu on Windows 11).
  WriteRegStr HKCU "${DAWG_VERB_KEY}" "" "Edit in ${PRODUCTNAME}"
  WriteRegStr HKCU "${DAWG_VERB_KEY}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${DAWG_VERB_KEY}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "${DAWG_VERB_KEY}"
!macroend
