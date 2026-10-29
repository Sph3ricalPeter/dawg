; NSIS hooks for the Tauri installer (bundle.windows.nsis.installerHooks).
;
; PRODUCTNAME, MAINBINARYNAME and BUNDLEID come from Tauri's installer
; template, so the same file serves the release app ("dawg") and local test
; builds ("dawg dev") without their Explorer entries clashing.

!define DAWG_VERB_KEY "Software\Classes\SystemFileAssociations\.wav\shell\${BUNDLEID}"
!define DAWG_MP3_VERB_KEY "Software\Classes\SystemFileAssociations\.mp3\shell\${BUNDLEID}"
; .dawg projects open in dawg on double-click.
!define DAWG_PROGID "${BUNDLEID}.project"
!define DAWG_PROGID_KEY "Software\Classes\${DAWG_PROGID}"
!define DAWG_EXT_KEY "Software\Classes\.dawg"

!macro NSIS_HOOK_PREINSTALL
  ; Claude Desktop and other MCP clients keep dawg-cli.exe running as the MCP
  ; server, and Windows won't replace a running exe. The client restarts it
  ; on next use.
  nsExec::Exec 'taskkill /F /IM dawg-cli.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Per-user "Edit in dawg" entry on .wav and .mp3 files (classic menu on
  ; Windows 11).
  WriteRegStr HKCU "${DAWG_VERB_KEY}" "" "Edit in ${PRODUCTNAME}"
  WriteRegStr HKCU "${DAWG_VERB_KEY}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${DAWG_VERB_KEY}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "${DAWG_MP3_VERB_KEY}" "" "Edit in ${PRODUCTNAME}"
  WriteRegStr HKCU "${DAWG_MP3_VERB_KEY}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${DAWG_MP3_VERB_KEY}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; .dawg projects. Both apps offer themselves under Open with; the
  ; released app takes the double-click, and "dawg dev" only when nothing
  ; else has it.
  WriteRegStr HKCU "${DAWG_PROGID_KEY}" "" "${PRODUCTNAME} project"
  WriteRegStr HKCU "${DAWG_PROGID_KEY}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "${DAWG_PROGID_KEY}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "${DAWG_EXT_KEY}\OpenWithProgids" "${DAWG_PROGID}" ""
  ReadRegStr $0 HKCU "${DAWG_EXT_KEY}" ""
  StrCmp $0 "" dawg_claim_ext
  StrCmp "${BUNDLEID}" "com.sph3ricalpeter.dawg" dawg_claim_ext dawg_ext_done
  dawg_claim_ext:
    WriteRegStr HKCU "${DAWG_EXT_KEY}" "" "${DAWG_PROGID}"
  dawg_ext_done:
  ; SHCNE_ASSOCCHANGED, so Explorer picks up the icon now.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "${DAWG_VERB_KEY}"
  DeleteRegKey HKCU "${DAWG_MP3_VERB_KEY}"
  DeleteRegKey HKCU "${DAWG_PROGID_KEY}"
  DeleteRegValue HKCU "${DAWG_EXT_KEY}\OpenWithProgids" "${DAWG_PROGID}"
  ReadRegStr $0 HKCU "${DAWG_EXT_KEY}" ""
  StrCmp $0 "${DAWG_PROGID}" 0 dawg_ext_kept
    DeleteRegValue HKCU "${DAWG_EXT_KEY}" ""
  dawg_ext_kept:
!macroend
