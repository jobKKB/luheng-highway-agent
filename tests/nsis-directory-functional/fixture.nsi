; Independent ordinary Unicode/x86 NSIS fixture. No product payload/uninstaller.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Luheng directory helper functional fixture"
OutFile "fixture.exe"
ShowInstDetails show
AutoCloseWindow true
!include "LogicLib.nsh"
!include "x64.nsh"
!include "MUI2.nsh"
!define APP_GUID "20be089a-e364-59fe-9bf1-70ea22b78d3f"
!define APP_FILENAME "Luheng Office Agent"
!define UNINSTALL_FILENAME "Uninstall Luheng Office Agent.exe"
!define INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define FIXTURE_HELPER_SHA256 "fcfaf03a4f140ced8839cee5f81c6639d52fb2cf0963c48720e5795dae9684c4"
; The complete argument allowlist below rejects delete-app-data/allusers/etc.
; This is the generated flag predicate's fixed-false equivalent, not a bypass.
!define isDeleteAppData '"" != ""'
Var installMode
!include "helper\current-user-install-directory.nsh"
; The exact helper deliberately emits declarations/functions at customHeader.
!insertmacro customHeader
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var fixtureRoot
Var fixtureNonce
Var fixtureMarker
Var fixtureParent
Var fixtureEvidence
Var fixtureGateError
Var fixtureStage
Var fixtureTrace
Var fixtureRootHandle
Var fixtureParentHandle
Var fixtureEvidenceHandle
Var fixtureMarkerHandle
Var fixtureCheckPath
Var fixtureCheckHandle
Var fixtureCheckIdentity
Var fixtureCreatedIdentity
Var fixtureOwnerSid
Var fixtureDaclControl
Var fixtureAceCount
Var fixtureDaclSddl
Var fixtureSecurityError
Var fixtureTokenElevated
Var fixtureTokenElevationType
Var fixtureAccountType
Var fixtureOutcome
Var fixtureCleanup
Var fixtureCleanupError
Var fixtureExit
Var fixtureCurrentProcess
Var fixtureTokenOpenResult
Var fixtureTokenOpenHandle
Var fixtureTokenOpenError
Var fixtureOriginalSizingResult
Var fixtureOriginalSizingLength
Var fixtureOriginalSizingError
Var fixtureTokenSizingResult
Var fixtureTokenSizingLength
Var fixtureTokenSizingError
Var fixtureTokenReadResult
Var fixtureTokenReadLength
Var fixtureTokenReadError

; The unreachable old-registration helper branch must still compile. This
; function is copied from electron-builder 26.15.3 include/installUtil.nsh.
Function GetInQuotes
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
   StrCpy $R2 -1
   IntOp $R2 $R2 + 1
    StrCpy $R3 $R0 1 $R2
    StrCmp $R3 "" 0 +3
     StrCpy $R0 ""
     Goto Done
    StrCmp $R3 '"' 0 -5
   IntOp $R2 $R2 + 1
   StrCpy $R0 $R0 "" $R2
   StrCpy $R2 0
   IntOp $R2 $R2 + 1
    StrCpy $R3 $R0 1 $R2
    StrCmp $R3 "" 0 +3
     StrCpy $R0 ""
     Goto Done
    StrCmp $R3 '"' 0 -5
   StrCpy $R0 $R0 $R2
   Done:
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

; Parse the Windows argv array, rather than partially matching option strings.
; Exactly /S, /ROOT=<fixed temp nonce root>, /NONCE=<32 lowercase hex> allowed.
Function FixtureParseArguments
  System::Store "S"
  StrCpy $fixtureRoot ""
  StrCpy $fixtureNonce ""
  StrCpy $4 0
  System::Call 'kernel32::GetCommandLineW() p .r0'
  System::Call 'shell32::CommandLineToArgvW(p r0, *i 0 r2) p .r1'
  ${If} $1 == 0
  ${OrIf} $2 != 4
    StrCpy $fixtureGateError "Expected exactly /S /ROOT=... /NONCE=..."
    Goto fixture_arguments_done
  ${EndIf}
  StrCpy $3 1
  ${DoWhile} $3 < $2
    IntOp $5 $3 * 4
    IntOp $5 $5 + $1
    System::Call '*$5(p .r6)'
    System::Call 'kernel32::lstrcpynW(w .r7, p r6, i ${NSIS_MAX_STRLEN})'
    StrCpy $8 $7 6
    StrCpy $9 $7 7
    ${If} $7 == "/S"
      IntOp $4 $4 + 1
    ${ElseIf} $8 == "/ROOT="
      ${If} $fixtureRoot != ""
        StrCpy $fixtureGateError "Duplicate ROOT"
      ${EndIf}
      StrCpy $fixtureRoot $7 "" 6
    ${ElseIf} $9 == "/NONCE="
      ${If} $fixtureNonce != ""
        StrCpy $fixtureGateError "Duplicate NONCE"
      ${EndIf}
      StrCpy $fixtureNonce $7 "" 7
    ${Else}
      StrCpy $fixtureGateError "Unknown argument; product/deletion/directory flags are forbidden"
    ${EndIf}
    IntOp $3 $3 + 1
  ${Loop}
  ${If} $4 != 1
  ${OrIf} $fixtureRoot == ""
  ${OrIf} $fixtureNonce == ""
    StrCpy $fixtureGateError "Incomplete fixed argument set"
  ${EndIf}
  StrLen $3 $fixtureNonce
  ${If} $3 != 32
    StrCpy $fixtureGateError "NONCE must contain exactly 32 lowercase hex characters"
  ${Else}
    StrCpy $3 0
    ${DoWhile} $3 < 32
      StrCpy $5 $fixtureNonce 1 $3
      StrCpy $7 0
      StrCpy $8 0
      ${DoWhile} $7 < 16
        StrCpy $9 "0123456789abcdef" 1 $7
        StrCmpS $5 $9 0 +2
          StrCpy $8 1
        IntOp $7 $7 + 1
      ${Loop}
      ${If} $8 != 1
        StrCpy $fixtureGateError "NONCE must contain exactly 32 lowercase hex characters"
      ${EndIf}
      IntOp $3 $3 + 1
    ${Loop}
  ${EndIf}
  fixture_arguments_done:
  ${If} $1 != 0
    System::Call 'kernel32::LocalFree(p r1)'
  ${EndIf}
  System::Store "L"
FunctionEnd

!macro FixtureRejectExistingKey HIVE KEY VIEW
  System::Call 'advapi32::RegOpenKeyExW(p ${HIVE}, w "${KEY}", i 0, i ${VIEW}, *p 0 r0) i .r1'
  ${If} $1 == 0
    System::Call 'advapi32::RegCloseKey(p r0)'
    StrCpy $fixtureGateError "Product registry key exists: ${HIVE}/${VIEW}/${KEY}"
  ${ElseIf} $1 != 2
    StrCpy $fixtureGateError "Cannot establish that product registry key is absent"
  ${EndIf}
!macroend

; Entire key absence, including empty keys, is required in HKCU and HKLM.
; ERROR_ACCESS_DENIED/other failures refuse the test. Nothing writes registry.
Function FixtureRegistryGate
  System::Store "S"
  !insertmacro FixtureRejectExistingKey 0x80000001 "${INSTALL_REGISTRY_KEY}" 0x20219
  !insertmacro FixtureRejectExistingKey 0x80000001 "${UNINSTALL_REGISTRY_KEY}" 0x20219
  !insertmacro FixtureRejectExistingKey 0x80000002 "${INSTALL_REGISTRY_KEY}" 0x20219
  !insertmacro FixtureRejectExistingKey 0x80000002 "${UNINSTALL_REGISTRY_KEY}" 0x20219
  ${If} ${RunningX64}
    !insertmacro FixtureRejectExistingKey 0x80000001 "${INSTALL_REGISTRY_KEY}" 0x20119
    !insertmacro FixtureRejectExistingKey 0x80000001 "${UNINSTALL_REGISTRY_KEY}" 0x20119
    !insertmacro FixtureRejectExistingKey 0x80000002 "${INSTALL_REGISTRY_KEY}" 0x20119
    !insertmacro FixtureRejectExistingKey 0x80000002 "${UNINSTALL_REGISTRY_KEY}" 0x20119
  ${EndIf}
  System::Store "L"
FunctionEnd

!macro FixtureMarker FIELD EXPECTED
  ClearErrors
  ReadINIStr $0 "$fixtureMarker" fixture "${FIELD}"
  ${If} ${Errors}
  ${OrIf} $0 != "${EXPECTED}"
    StrCpy $fixtureGateError "Ownership marker mismatch: ${FIELD}"
  ${EndIf}
!macroend

; Input fixtureCheckPath. Retain a non-delete-sharing no-reparse handle.
; Check attrs/identity from that handle, not only from the pathname.
Function FixtureOpenControlledDirectory
  System::Store "S"
  StrCpy $fixtureCheckHandle 0
  System::Call 'kernel32::CreateFileW(w "$fixtureCheckPath", i 0x20080, i 3, p 0, i 3, i 0x02200000, p 0) p .r0'
  ${If} $0 == -1
  ${OrIf} $0 == 0
    StrCpy $fixtureGateError "Cannot open existing controlled directory"
    Goto fixture_controlled_done
  ${EndIf}
  System::Call '*(i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0) p .r1'
  ${If} $1 == 0
    StrCpy $fixtureGateError "Cannot allocate directory readback"
    System::Call 'kernel32::CloseHandle(p r0)'
    Goto fixture_controlled_done
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r0, p r1) i .r2'
  System::Call '*$1(i .r3)'
  System::Free $1
  IntOp $4 $3 & 0x410
  ${If} $2 == 0
  ${OrIf} $4 <> 0x10
    StrCpy $fixtureGateError "Controlled path is not an ordinary directory"
    System::Call 'kernel32::CloseHandle(p r0)'
  ${Else}
    StrCpy $fixtureCheckHandle $0
  ${EndIf}
  fixture_controlled_done:
  System::Store "L"
FunctionEnd

Function FixturePathAndMarkerGate
  System::Store "S"
  StrCpy $0 "$TEMP\luheng-nsis-functional-$fixtureNonce"
  ${If} $fixtureRoot != $0
    StrCpy $fixtureGateError "ROOT must equal the fixed nonce directory directly beneath this process TEMP"
    Goto fixture_path_gate_done
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$fixtureRoot", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i .r2'
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $1 != $fixtureRoot
    StrCpy $fixtureGateError "ROOT is not a canonical absolute local path"
    Goto fixture_path_gate_done
  ${EndIf}
  StrCpy $0 $fixtureRoot 3
  System::Call 'kernel32::GetDriveTypeW(w r0) i .r1'
  ${If} $1 != 3
    StrCpy $fixtureGateError "ROOT must be on a local fixed drive"
    Goto fixture_path_gate_done
  ${EndIf}
  StrCpy $fixtureParent "$fixtureRoot\parent"
  StrCpy $fixtureEvidence "$fixtureRoot\evidence"
  StrCpy $fixtureMarker "$fixtureRoot\ownership.ini"
  StrCpy $INSTDIR "$fixtureParent\${APP_FILENAME}"
  StrCpy $fixtureCheckPath $fixtureRoot
  Call FixtureOpenControlledDirectory
  StrCpy $fixtureRootHandle $fixtureCheckHandle
  StrCpy $fixtureCheckPath $fixtureParent
  Call FixtureOpenControlledDirectory
  StrCpy $fixtureParentHandle $fixtureCheckHandle
  StrCpy $fixtureCheckPath $fixtureEvidence
  Call FixtureOpenControlledDirectory
  StrCpy $fixtureEvidenceHandle $fixtureCheckHandle
  ${If} $fixtureGateError != ""
    Goto fixture_path_gate_done
  ${EndIf}
  ; Retain the marker with no write/delete sharing while its contents are read.
  System::Call 'kernel32::CreateFileW(w "$fixtureMarker", i 0x80000000, i 1, p 0, i 3, i 0x00200000, p 0) p .r3'
  ${If} $3 == -1
  ${OrIf} $3 == 0
    StrCpy $fixtureGateError "Cannot retain ordinary ownership marker"
    Goto fixture_path_gate_done
  ${EndIf}
  StrCpy $fixtureMarkerHandle $3
  System::Call '*(i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0) p .r1'
  ${If} $1 == 0
    StrCpy $fixtureGateError "Cannot allocate ownership marker readback"
    Goto fixture_path_gate_done
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p $fixtureMarkerHandle, p r1) i .r2'
  System::Call '*$1(i .r0)'
  System::Free $1
  IntOp $0 $0 & 0x410
  ${If} $2 == 0
  ${OrIf} $0 != 0
    StrCpy $fixtureGateError "Ownership marker must be an existing ordinary file"
    Goto fixture_path_gate_done
  ${EndIf}
  !insertmacro FixtureMarker schema "1"
  !insertmacro FixtureMarker nonce "$fixtureNonce"
  !insertmacro FixtureMarker app_guid "${APP_GUID}"
  !insertmacro FixtureMarker app_leaf "${APP_FILENAME}"
  !insertmacro FixtureMarker helper_sha256 "${FIXTURE_HELPER_SHA256}"
  !insertmacro FixtureMarker root "$fixtureRoot"
  !insertmacro FixtureMarker parent "$fixtureParent"
  !insertmacro FixtureMarker target "$INSTDIR"
  !insertmacro FixtureMarker evidence "$fixtureEvidence"
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r1'
  ${If} $1 != -1
    StrCpy $fixtureGateError "Fixed APP leaf already exists; fixture refuses to adopt it"
  ${Else}
    System::Call 'kernel32::GetLastError() i .r2'
    ${If} $2 != 2
      StrCpy $fixtureGateError "Cannot establish fixed APP leaf absence"
    ${EndIf}
  ${EndIf}
  fixture_path_gate_done:
  System::Store "L"
FunctionEnd

; Default token/account diagnostics are read-only. No privilege adjustment.
Function FixtureReadTokenStatus
  System::Store "S"
  StrCpy $fixtureTokenElevated "unknown"
  StrCpy $fixtureTokenElevationType "unknown"
  UserInfo::GetAccountType
  Pop $fixtureAccountType
  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p 0 r1) i .r2'
  ${If} $2 != 0
    System::Call '*(i 0) p .r3'
    ${If} $3 != 0
      System::Call 'advapi32::GetTokenInformation(p r1, i 20, p r3, i 4, *i 0 r4) i .r2'
      ${If} $2 != 0
        System::Call '*$3(i .r4)'
        StrCpy $fixtureTokenElevated $4
      ${EndIf}
      System::Call 'advapi32::GetTokenInformation(p r1, i 18, p r3, i 4, *i 0 r4) i .r2'
      ${If} $2 != 0
        System::Call '*$3(i .r4)'
        StrCpy $fixtureTokenElevationType $4
      ${EndIf}
      System::Free $3
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r1)'
  ${EndIf}
  System::Store "L"
FunctionEnd

; Read-only reproduction of the exact helper TokenUser sizing call. Capture
; the raw System result and Win32 error immediately; never change the token.
Function FixtureProbeTokenUserSizing
  System::Store "S"
  StrCpy $fixtureTokenReadResult "not-attempted"
  StrCpy $fixtureTokenReadLength "not-attempted"
  StrCpy $fixtureTokenReadError "not-attempted"
  StrCpy $fixtureTokenSizingResult "not-attempted"
  StrCpy $fixtureTokenSizingLength "not-attempted"
  StrCpy $fixtureTokenSizingError "not-attempted"
  StrCpy $1 0
  StrCpy $3 0
  StrCpy $4 0
  System::Call 'kernel32::GetCurrentProcess() p .r0'
  StrCpy $fixtureCurrentProcess $0
  System::Call 'advapi32::OpenProcessToken(p r0, i 0x8, *p 0 r1) i .r2 ?e'
  Pop $fixtureTokenOpenError
  StrCpy $fixtureTokenOpenResult $2
  StrCpy $fixtureTokenOpenHandle $1
  ${If} $2 == 0
  ${OrIf} $1 == 0
    Goto fixture_token_probe_done
  ${EndIf}
  ; Original destination syntax on this known valid handle: output ignored.
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p 0, i 0, *i 0 .r3) i .r2 ?e'
  Pop $fixtureOriginalSizingError
  StrCpy $fixtureOriginalSizingResult $2
  StrCpy $fixtureOriginalSizingLength $3
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p 0, i 0, *i 0 r3) i .r2 ?e'
  Pop $fixtureTokenSizingError
  StrCpy $fixtureTokenSizingResult $2
  StrCpy $fixtureTokenSizingLength $3
  ${If} $3 < 8
  ${OrIf} $3 > 65536
    Goto fixture_token_probe_done
  ${EndIf}
  System::Alloc $3
  Pop $4
  ${If} $4 == 0
    StrCpy $fixtureTokenReadResult "allocation-failed"
    Goto fixture_token_probe_done
  ${EndIf}
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p r4, i r3, *i 0 r5) i .r2 ?e'
  Pop $fixtureTokenReadError
  StrCpy $fixtureTokenReadResult $2
  StrCpy $fixtureTokenReadLength $5
  fixture_token_probe_done:
  ${If} $4 != 0
    System::Free $4
  ${EndIf}
  ${If} $1 != 0
    System::Call 'kernel32::CloseHandle(p r1)'
  ${EndIf}
  System::Store "L"
FunctionEnd

; Independent read-only owner/DACL evidence on the helper's held new object.
Function FixtureReadSecurity
  System::Store "S"
  StrCpy $fixtureSecurityError ""
  StrCpy $6 0
  StrCpy $7 0
  StrCpy $8 0
  System::Call 'advapi32::GetSecurityInfo(p $luidOwnedHandle, i 1, i 5, *p 0 r0, p 0, *p 0 r1, p 0, *p 0 r6) i .r2'
  ${If} $2 != 0
  ${OrIf} $0 == 0
  ${OrIf} $1 == 0
  ${OrIf} $6 == 0
    StrCpy $fixtureSecurityError "GetSecurityInfo failed"
    Goto fixture_security_done
  ${EndIf}
  System::Call 'advapi32::ConvertSidToStringSidW(p r0, *p 0 r7) i .r2'
  ${If} $2 != 0
    System::Call 'kernel32::lstrcpynW(w .r3, p r7, i ${NSIS_MAX_STRLEN})'
    StrCpy $fixtureOwnerSid $3
  ${Else}
    StrCpy $fixtureSecurityError "Owner SID conversion failed"
  ${EndIf}
  System::Call 'advapi32::GetSecurityDescriptorControl(p r6, *i 0 r3, *i 0 r4) i .r2'
  ${If} $2 != 0
    StrCpy $fixtureDaclControl $3
  ${Else}
    StrCpy $fixtureSecurityError "DACL control read failed"
  ${EndIf}
  System::Call '*$1(&i1, &i1, &i2, &i2 .r3, &i2)'
  StrCpy $fixtureAceCount $3
  System::Call 'advapi32::ConvertSecurityDescriptorToStringSecurityDescriptorW(p r6, i 1, i 5, *p 0 r8, p 0) i .r2'
  ${If} $2 != 0
    System::Call 'kernel32::lstrcpynW(w .r3, p r8, i ${NSIS_MAX_STRLEN})'
    StrCpy $fixtureDaclSddl $3
  ${Else}
    StrCpy $fixtureSecurityError "DACL SDDL read failed"
  ${EndIf}
  fixture_security_done:
  ${If} $8 != 0
    System::Call 'kernel32::LocalFree(p r8)'
  ${EndIf}
  ${If} $7 != 0
    System::Call 'kernel32::LocalFree(p r7)'
  ${EndIf}
  ${If} $6 != 0
    System::Call 'kernel32::LocalFree(p r6)'
  ${EndIf}
  System::Store "L"
FunctionEnd

Function FixtureEmitStage
  FileWriteUTF16LE $fixtureTrace "[$fixtureStage]$\r$\n"
  FileWriteUTF16LE $fixtureTrace "luidError=$luidError$\r$\nnativeStatus=$luidNativeStatus$\r$\nnativeInformation=$luidNativeInformation$\r$\nnativeHandle=$luidNativeHandle$\r$\n"
  FileWriteUTF16LE $fixtureTrace "checkIdentity=$luidCheckIdentity$\r$\nownedIdentity=$luidOwnedIdentity$\r$\nownedHandle=$luidOwnedHandle$\r$\nready=$luidReady$\r$\n"
  FileWriteUTF16LE $fixtureTrace "currentSID=$luidUserSidText$\r$\nownerSID=$fixtureOwnerSid$\r$\ndaclControl=$fixtureDaclControl$\r$\naceCount=$fixtureAceCount$\r$\nsddl=$fixtureDaclSddl$\r$\nsecurityReadError=$fixtureSecurityError$\r$\n$\r$\n"
FunctionEnd

; Only a known newly-created empty target can be removed. Open relative to
; our retained parent, reject reparse points, compare the exact file identity,
; then request deletion BY HANDLE. Windows refuses a nonempty directory.
; No path Delete/RMDir, recursive delete, or permission changes exist here.
Function FixtureCleanupCreatedEmptyDirectory
  System::Store "S"
  StrCpy $fixtureCleanup "left-unproven-identity"
  StrCpy $fixtureCleanupError ""
  ${If} $fixtureCreatedIdentity == ""
    Goto fixture_cleanup_done
  ${EndIf}
  StrCpy $luidNativeRoot $fixtureParentHandle
  StrCpy $luidNativeName "${APP_FILENAME}"
  StrCpy $luidNativeAccess 0x130080
  StrCpy $luidNativeDisposition 1
  StrCpy $luidNativeOptions 0x200021
  StrCpy $luidNativeSd 0
  Call luhengNativeDirectory
  ${If} $luidNativeStatus < 0
  ${OrIf} $luidNativeHandle == 0
    StrCpy $fixtureCleanupError "Cannot reopen created directory relative to retained parent"
    Goto fixture_cleanup_done
  ${EndIf}
  System::Call '*(i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0) p .r1'
  ${If} $1 == 0
    StrCpy $fixtureCleanupError "Cannot allocate identity readback"
    Goto fixture_cleanup_close
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p $luidNativeHandle, p r1) i .r0'
  System::Call '*$1(i .r2,i,i,i,i,i,i,i .r3,i,i,i,i .r4,i .r5)'
  System::Free $1
  IntOp $6 $2 & 0x410
  StrCpy $fixtureCheckIdentity "$3/$4/$5"
  ${If} $0 == 0
  ${OrIf} $6 <> 0x10
  ${OrIf} $fixtureCheckIdentity != $fixtureCreatedIdentity
    StrCpy $fixtureCleanupError "Created directory identity is uncertain or changed; left in place"
    Goto fixture_cleanup_close
  ${EndIf}
  System::Call '*(i 1) p .r1'
  ${If} $1 == 0
    StrCpy $fixtureCleanupError "Cannot allocate delete disposition"
    Goto fixture_cleanup_close
  ${EndIf}
  ; FileDispositionInfo=4, FILE_DISPOSITION_INFO BOOL DeleteFile=TRUE.
  System::Call 'kernel32::SetFileInformationByHandle(p $luidNativeHandle, i 4, p r1, i 4) i .r0'
  System::Call 'kernel32::GetLastError() i .r2'
  System::Free $1
  ${If} $0 == 0
    StrCpy $fixtureCleanup "left-delete-refused"
    StrCpy $fixtureCleanupError "Windows refused empty-directory disposition; Win32=$2"
  ${Else}
    StrCpy $fixtureCleanup "empty-directory-delete-pending-close"
  ${EndIf}
  fixture_cleanup_close:
  System::Call 'kernel32::CloseHandle(p $luidNativeHandle) i .r0'
  StrCpy $luidNativeHandle 0
  ${If} $0 == 0
    StrCpy $fixtureCleanup "left-close-unconfirmed"
    StrCpy $fixtureCleanupError "Directory cleanup handle close failed"
  ${ElseIf} $fixtureCleanup == "empty-directory-delete-pending-close"
    StrCpy $fixtureCleanup "removed-known-empty-directory-by-handle"
  ${EndIf}
  fixture_cleanup_done:
  System::Store "L"
FunctionEnd

Function FixtureCloseOwnedHandles
  ${If} $fixtureTrace != 0
  ${AndIf} $fixtureTrace != ""
    FileClose $fixtureTrace
    StrCpy $fixtureTrace 0
  ${EndIf}
  ${If} $fixtureMarkerHandle != 0
  ${AndIf} $fixtureMarkerHandle != ""
    System::Call 'kernel32::CloseHandle(p $fixtureMarkerHandle)'
    StrCpy $fixtureMarkerHandle 0
  ${EndIf}
  ${If} $fixtureEvidenceHandle != 0
  ${AndIf} $fixtureEvidenceHandle != ""
    System::Call 'kernel32::CloseHandle(p $fixtureEvidenceHandle)'
    StrCpy $fixtureEvidenceHandle 0
  ${EndIf}
  ${If} $fixtureParentHandle != 0
  ${AndIf} $fixtureParentHandle != ""
    System::Call 'kernel32::CloseHandle(p $fixtureParentHandle)'
    StrCpy $fixtureParentHandle 0
  ${EndIf}
  ${If} $fixtureRootHandle != 0
  ${AndIf} $fixtureRootHandle != ""
    System::Call 'kernel32::CloseHandle(p $fixtureRootHandle)'
    StrCpy $fixtureRootHandle 0
  ${EndIf}
FunctionEnd

Function .onInit
  StrCpy $fixtureGateError ""
  StrCpy $fixtureTrace 0
  StrCpy $fixtureRootHandle 0
  StrCpy $fixtureParentHandle 0
  StrCpy $fixtureEvidenceHandle 0
  StrCpy $fixtureMarkerHandle 0
  StrCpy $installMode "CurrentUser"
  Call FixtureParseArguments
  ${If} $fixtureGateError == ""
    Call FixtureRegistryGate
  ${EndIf}
  ${If} $fixtureGateError == ""
    Call FixturePathAndMarkerGate
  ${EndIf}
  ${If} $fixtureGateError != ""
    DetailPrint "$fixtureGateError"
    Call FixtureCloseOwnedHandles
    SetErrorLevel 20
    Quit
  ${EndIf}
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    SetRegView 32
  ${EndIf}
  ; CREATE_NEW: evidence must also be fresh. Raw Windows handles are NSIS's
  ; FileWrite/FileClose handle representation. Evidence stays out of plugins.
  System::Call 'kernel32::CreateFileW(w "$fixtureEvidence\trace.ini", i 0x40000000, i 0, p 0, i 1, i 0x80, p 0) p .r0'
  ${If} $0 == -1
  ${OrIf} $0 == 0
    Call FixtureCloseOwnedHandles
    SetErrorLevel 21
    Quit
  ${EndIf}
  StrCpy $fixtureTrace $0
  FileWriteByte $fixtureTrace 255
  FileWriteByte $fixtureTrace 254
  Call FixtureReadTokenStatus
  Call FixtureProbeTokenUserSizing
  FileWriteUTF16LE $fixtureTrace "[meta]$\r$\nschema=1$\r$\nnonce=$fixtureNonce$\r$\nhelperSHA256=${FIXTURE_HELPER_SHA256}$\r$\nappGUID=${APP_GUID}$\r$\nappLeaf=${APP_FILENAME}$\r$\n"
  FileWriteUTF16LE $fixtureTrace "root=$fixtureRoot$\r$\nparent=$fixtureParent$\r$\ntarget=$INSTDIR$\r$\nevidence=$fixtureEvidence$\r$\n"
  FileWriteUTF16LE $fixtureTrace "accountType=$fixtureAccountType$\r$\ntokenElevated=$fixtureTokenElevated$\r$\ntokenElevationType=$fixtureTokenElevationType$\r$\nregistryGate=all-product-keys-absent-in-both-views$\r$\nglobalSemantics=post-return-snapshot$\r$\n$\r$\n"
  FileWriteUTF16LE $fixtureTrace "originalSizingResult=$fixtureOriginalSizingResult$\r$\noriginalSizingLength=$fixtureOriginalSizingLength$\r$\noriginalSizingError=$fixtureOriginalSizingError$\r$\n"
  FileWriteUTF16LE $fixtureTrace "currentProcess=$fixtureCurrentProcess$\r$\ntokenOpenResult=$fixtureTokenOpenResult$\r$\ntokenOpenHandle=$fixtureTokenOpenHandle$\r$\ntokenOpenError=$fixtureTokenOpenError$\r$\ntokenSizingResult=$fixtureTokenSizingResult$\r$\ntokenSizingLength=$fixtureTokenSizingLength$\r$\ntokenSizingError=$fixtureTokenSizingError$\r$\ntokenReadResult=$fixtureTokenReadResult$\r$\ntokenReadLength=$fixtureTokenReadLength$\r$\ntokenReadError=$fixtureTokenReadError$\r$\n$\r$\n"
FunctionEnd

Section "Actual helper flow"
  StrCpy $fixtureExit 1
  StrCpy $fixtureOutcome "preflight-failed"
  StrCpy $fixtureCreatedIdentity ""
  StrCpy $fixtureStage "preflight_enter"
  Call FixtureEmitStage
  Call luhengPreflightDirectory
  StrCpy $fixtureStage "preflight_exit"
  Call FixtureEmitStage
  ${If} $luidError != ""
    Goto fixture_flow_done
  ${EndIf}
  StrCpy $fixtureStage "create_enter"
  Call FixtureEmitStage
  Call luhengCreateDirectory
  ${If} $luidOwnedHandle != 0
  ${AndIf} $luidOwnedHandle != ""
    Call FixtureReadSecurity
  ${EndIf}
  StrCpy $fixtureStage "create_exit"
  Call FixtureEmitStage
  StrCpy $fixtureOutcome "create-failed"
  ${If} $luidError != ""
    Goto fixture_flow_done
  ${EndIf}
  StrCpy $fixtureCreatedIdentity $luidOwnedIdentity
  StrCpy $fixtureStage "finish_enter"
  Call FixtureEmitStage
  Call luhengFinishDirectory
  StrCpy $fixtureStage "finish_exit"
  Call FixtureEmitStage
  StrCpy $fixtureOutcome "finish-failed"
  ${If} $luidError == ""
    ${If} $fixtureSecurityError == ""
    ${AndIf} $fixtureOwnerSid == $luidUserSidText
    ${AndIf} $fixtureAceCount == 3
    ${AndIf} $fixtureCreatedIdentity != ""
      StrCpy $fixtureOutcome "helper-flow-succeeded"
      StrCpy $fixtureExit 0
    ${Else}
      StrCpy $fixtureOutcome "independent-readback-failed"
    ${EndIf}
  ${EndIf}
  fixture_flow_done:
  ; Preserve the native and error observations before cleanup overwrites them.
  StrCpy $fixtureStage "flow_final"
  Call FixtureEmitStage
  Call luhengCloseDirectoryResources
  Call FixtureCleanupCreatedEmptyDirectory
  FileWriteUTF16LE $fixtureTrace "[result]$\r$\noutcome=$fixtureOutcome$\r$\ncleanup=$fixtureCleanup$\r$\ncleanupError=$fixtureCleanupError$\r$\ncreatedIdentity=$fixtureCreatedIdentity$\r$\ncleanupIdentity=$fixtureCheckIdentity$\r$\nexitCode=$fixtureExit$\r$\n"
  ${If} $fixtureExit == 0
  ${AndIf} $fixtureCleanup != "removed-known-empty-directory-by-handle"
    StrCpy $fixtureExit 2
    FileWriteUTF16LE $fixtureTrace "cleanupExitCode=2$\r$\n"
  ${EndIf}
  Call FixtureCloseOwnedHandles
  SetErrorLevel $fixtureExit
SectionEnd
