# electron-builder 26.x assisted install: force the established current-user
# template, and refuse a command-line request for the unsupported all-user mode.
!macro customInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "This installer supports the current user only."
    Quit
  ${EndIf}
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceMachineInstall "0"
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend
