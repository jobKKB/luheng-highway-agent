; Native directory initialization for the pinned electron-builder 26.15.3
; x86 Unicode NSIS installer. This never changes an existing owner or DACL.
; FILE_CREATE, not FILE_OPEN_IF, is the only directory-creation disposition.
; The normal electron-builder uninstaller is generated and signed as usual.
;
; References: Microsoft NtCreateFile / GetSecurityInfo / TOKEN_USER and
; https://nsis.sourceforge.io/Docs/System/System.html (packed x86 structures).
!ifndef LUHENG_CURRENT_USER_INSTALL_DIRECTORY_INCLUDED
!define LUHENG_CURRENT_USER_INSTALL_DIRECTORY_INCLUDED
!include LogicLib.nsh
!define /ifndef SYSTYPE_PTR p
; Modern UI owns .onUserAbort. Install its documented custom callback before
; MUI_LANGUAGE emits that function; preserve the stock uninstaller callbacks.
!ifndef BUILD_UNINSTALLER
  !ifdef MUI_CUSTOMFUNCTION_ABORT
    !error "The pinned directory helper requires its current-user abort callback."
  !endif
  !define MUI_CUSTOMFUNCTION_ABORT luhengDirectoryUserAbort
!endif

!macro luhengPreflightInstallDirectory
  Call luhengPreflightDirectory
  ${If} $luidError != ""
    Call luhengCloseDirectoryResources
    MessageBox MB_OK|MB_ICONSTOP "$luidError$\r$\n$\r$\n未开始卸载旧版本。请先正常卸载旧应用并保留应用数据，再选择一个尚不存在的应用专属目录。不要修改用户目录或系统目录的权限。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro luhengCreateInstallDirectory
  Call luhengCreateDirectory
  ${If} $luidError != ""
    Call luhengCloseDirectoryResources
    MessageBox MB_OK|MB_ICONSTOP "$luidError$\r$\n$\r$\n旧版本可能已经卸载，安装没有自动回滚。原应用数据仍保留在原位置；请手动重新安装。若本次创建了空目录，请确认它为空后手动删除，再重试。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro luhengFinishInstallDirectory
  Call luhengFinishDirectory
  ${If} $luidError != ""
    Call luhengCloseDirectoryResources
    MessageBox MB_OK|MB_ICONSTOP "$luidError$\r$\n$\r$\n安装目录最终检查失败，未自动回滚。请保留原应用数据，正常卸载本次应用后手动重新安装。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro luhengCloseInstallDirectory
  Call luhengCloseDirectoryResources
!macroend

; The custom include precedes common.nsh/multiUser.nsh. Delay declarations
; until customHeader, when installMode and the app's registry keys exist.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !insertmacro luhengInstallDirectoryHeader
  !endif
!macroend

!macro luhengInstallDirectoryHeader
  !if ${NSIS_CHAR_SIZE} != 2
    !error "The current-user directory helper requires Unicode NSIS."
  !endif
  !ifdef NSIS_PTR_SIZE
    !if ${NSIS_PTR_SIZE} != 4
      !error "The pinned directory helper requires the x86 NSIS stub."
    !endif
  !endif

  Var luidError
  Var luidTarget
  Var luidParentPath
  Var luidParentHandle
  Var luidAncestorHead
  Var luidOwnedHandle
  Var luidOwnedIdentity
  Var luidTokenData
  Var luidUserSid
  Var luidUserSidText
  Var luidSystemSid
  Var luidAdminsSid
  Var luidCreateSd
  Var luidReady
  Var luidOldPath
  Var luidOldUninstaller
  Var luidCheckPath
  Var luidCheckParent
  Var luidWalkParentHandle
  Var luidCheckHandle
  Var luidVerifyAcl
  Var luidCheckIdentity
  Var luidNativeRoot
  Var luidNativeName
  Var luidNativeAccess
  Var luidNativeDisposition
  Var luidNativeOptions
  Var luidNativeSd
  Var luidNativeHandle
  Var luidNativeStatus
  Var luidNativeInformation

  Function luhengCloseDirectoryResources
    System::Store "S"
    ${If} $luidNativeHandle != 0
    ${AndIf} $luidNativeHandle != ""
      System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidNativeHandle)'
    ${EndIf}
    StrCpy $luidNativeHandle 0
    ${If} $luidOwnedHandle != 0
    ${AndIf} $luidOwnedHandle != ""
      System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidOwnedHandle)'
    ${EndIf}
    StrCpy $luidOwnedHandle 0
    ${Do}
      ${If} $luidAncestorHead == 0
      ${OrIf} $luidAncestorHead == ""
        ${Break}
      ${EndIf}
      StrCpy $0 $luidAncestorHead
      System::Call '*$0(${SYSTYPE_PTR} .r1, ${SYSTYPE_PTR} .r2)'
      StrCpy $luidAncestorHead $1
      System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} r2)'
      System::Free $0
    ${Loop}
    StrCpy $luidAncestorHead 0
    ${If} $luidCreateSd != 0
    ${AndIf} $luidCreateSd != ""
      System::Call 'kernel32::LocalFree(${SYSTYPE_PTR} $luidCreateSd)'
    ${EndIf}
    ${If} $luidSystemSid != 0
    ${AndIf} $luidSystemSid != ""
      System::Call 'kernel32::LocalFree(${SYSTYPE_PTR} $luidSystemSid)'
    ${EndIf}
    ${If} $luidAdminsSid != 0
    ${AndIf} $luidAdminsSid != ""
      System::Call 'kernel32::LocalFree(${SYSTYPE_PTR} $luidAdminsSid)'
    ${EndIf}
    ${If} $luidTokenData != 0
    ${AndIf} $luidTokenData != ""
      System::Free $luidTokenData
    ${EndIf}
    StrCpy $luidCreateSd 0
    StrCpy $luidSystemSid 0
    StrCpy $luidAdminsSid 0
    StrCpy $luidTokenData 0
    StrCpy $luidUserSid 0
    StrCpy $luidParentHandle 0
    StrCpy $luidReady 0
    System::Store "L"
  FunctionEnd

  ; Read TokenUser, never TokenOwner (an administrator token can have BA as
  ; TokenOwner). New-object ownership is explicitly the actual TokenUser SID.
  Function luhengReadCurrentUser
    System::Store "S"
    StrCpy $1 0
    StrCpy $4 0
    System::Call 'kernel32::GetCurrentProcess() ${SYSTYPE_PTR} .r0'
    System::Call 'advapi32::OpenProcessToken(${SYSTYPE_PTR} r0, i 0x8, *${SYSTYPE_PTR} 0 .r1) i .r2'
    ${If} $2 == 0
      StrCpy $luidError "无法读取当前用户的安全令牌。"
      Goto luid_token_done
    ${EndIf}
    System::Call 'advapi32::GetTokenInformation(${SYSTYPE_PTR} r1, i 1, ${SYSTYPE_PTR} 0, i 0, *i 0 .r3) i .r2'
    ${If} $3 < 8
    ${OrIf} $3 > 65536
      StrCpy $luidError "当前用户 SID 缓冲区长度无效。"
      Goto luid_token_done
    ${EndIf}
    System::Alloc $3
    Pop $luidTokenData
    ${If} $luidTokenData == 0
      StrCpy $luidError "无法分配当前用户 SID 缓冲区。"
      Goto luid_token_done
    ${EndIf}
    System::Call 'advapi32::GetTokenInformation(${SYSTYPE_PTR} r1, i 1, ${SYSTYPE_PTR} $luidTokenData, i r3, *i 0 .r5) i .r2'
    ${If} $2 == 0
      StrCpy $luidError "读取当前用户 SID 失败。"
      Goto luid_token_done
    ${EndIf}
    System::Call '*$luidTokenData(${SYSTYPE_PTR} .r0)'
    StrCpy $luidUserSid $0
    System::Call 'advapi32::IsValidSid(${SYSTYPE_PTR} r0) i .r2'
    ${If} $2 == 0
      StrCpy $luidError "当前用户 SID 无效。"
      Goto luid_token_done
    ${EndIf}
    System::Call 'advapi32::ConvertSidToStringSidW(${SYSTYPE_PTR} r0, *${SYSTYPE_PTR} 0 .r4) i .r2'
    ${If} $2 == 0
      StrCpy $luidError "转换当前用户 SID 失败。"
      Goto luid_token_done
    ${EndIf}
    System::Call 'kernel32::lstrcpynW(w .r0, ${SYSTYPE_PTR} r4, i ${NSIS_MAX_STRLEN})'
    StrCpy $luidUserSidText $0
    ; Exactly three protected inheritable FullControl allow ACEs. No broad
    ; Users/Everyone trustee, privileges, or changes to any existing object.
    ; SDDL must contain no separator between the owner and DACL sections.
    StrCpy $0 "O:$luidUserSidText"
    StrCpy $6 "D:P(A;OICI;FA;;;$luidUserSidText)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
    StrCpy $0 "$0$6"
    System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w r0, i 1, *${SYSTYPE_PTR} 0 .r5, ${SYSTYPE_PTR} 0) i .r2'
    StrCpy $luidCreateSd $5
    ${If} $2 == 0
    ${OrIf} $5 == 0
      StrCpy $luidError "无法准备新应用目录的安全描述符。"
      Goto luid_token_done
    ${EndIf}
    System::Call 'advapi32::ConvertStringSidToSidW(w "S-1-5-18", *${SYSTYPE_PTR} 0 .r5) i .r2'
    StrCpy $luidSystemSid $5
    ${If} $2 == 0
      StrCpy $luidError "无法准备 SYSTEM SID。"
      Goto luid_token_done
    ${EndIf}
    System::Call 'advapi32::ConvertStringSidToSidW(w "S-1-5-32-544", *${SYSTYPE_PTR} 0 .r5) i .r2'
    StrCpy $luidAdminsSid $5
    ${If} $2 == 0
      StrCpy $luidError "无法准备 Administrators SID。"
    ${EndIf}
    luid_token_done:
    ${If} $4 != 0
      System::Call 'kernel32::LocalFree(${SYSTYPE_PTR} r4)'
    ${EndIf}
    ${If} $1 != 0
      System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} r1)'
    ${EndIf}
    System::Store "L"
  FunctionEnd

  ; Input luidCheckPath. Output its parent in luidCheckParent. Restrict to
  ; canonical local drive paths with the exact APP_FILENAME final component.
  Function luhengCheckCanonicalAppPath
    System::Store "S"
    StrCpy $luidCheckParent ""
    StrLen $0 $luidCheckPath
    ${If} $0 < 4
    ${OrIf} $0 >= 248
      StrCpy $luidError "应用目录必须是长度小于 248 个字符的完整本地路径。"
      Goto luid_path_done
    ${EndIf}
    StrCpy $1 $luidCheckPath 2 1
    StrCpy $2 $luidCheckPath 1
    System::Call 'shlwapi::PathGetDriveNumberW(w "$luidCheckPath") i .r3'
    ${If} $1 != ":\"
    ${OrIf} $3 < 0
      StrCpy $luidError "请选择盘符开头的完整本地应用目录，不能使用网络路径或设备路径。"
      Goto luid_path_done
    ${EndIf}
    StrCpy $2 $luidCheckPath 3
    System::Call 'kernel32::GetDriveTypeW(w r2) i .r3'
    ${If} $3 != 3
      StrCpy $luidError "应用目录必须位于本地固定磁盘。"
      Goto luid_path_done
    ${EndIf}
    System::Call 'kernel32::GetFullPathNameW(w "$luidCheckPath", i ${NSIS_MAX_STRLEN}, w .r1, ${SYSTYPE_PTR} 0) i .r2'
    ${If} $2 == 0
    ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
    ${OrIf} $1 != $luidCheckPath
      StrCpy $luidError "应用目录路径不规范；请移除相对路径、重复分隔符或尾部分隔符。"
      Goto luid_path_done
    ${EndIf}
    StrCpy $2 3
    StrCpy $3 3
    ${DoWhile} $2 < $0
      StrCpy $4 $luidCheckPath 1 $2
      ${If} $4 == "/"
      ${OrIf} $4 == ":"
      ${OrIf} $4 == "*"
      ${OrIf} $4 == "?"
      ${OrIf} $4 == '$\"'
      ${OrIf} $4 == "<"
      ${OrIf} $4 == ">"
      ${OrIf} $4 == "|"
        StrCpy $luidError "应用目录包含不支持的路径字符。"
        Goto luid_path_done
      ${EndIf}
      ${If} $4 == "\"
        ${If} $2 == $3
          StrCpy $luidError "应用目录包含空路径组件。"
          Goto luid_path_done
        ${EndIf}
        IntOp $5 $2 - 1
        StrCpy $6 $luidCheckPath 1 $5
        ${If} $6 == " "
        ${OrIf} $6 == "."
          StrCpy $luidError "应用目录组件不能以空格或句点结尾。"
          Goto luid_path_done
        ${EndIf}
        IntOp $3 $2 + 1
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
    StrCpy $4 $luidCheckPath "" $3
    ${If} $4 != "${APP_FILENAME}"
      StrCpy $luidError "应用目录最后一层必须为 ${APP_FILENAME}，请选择应用专属目录。"
      Goto luid_path_done
    ${EndIf}
    IntOp $3 $3 - 1
    ${If} $3 == 2
      StrCpy $luidCheckParent $luidCheckPath 3
    ${Else}
      StrCpy $luidCheckParent $luidCheckPath $3
    ${EndIf}
    luid_path_done:
    System::Store "L"
  FunctionEnd

  ; Native open/create relative to an already-held parent. x86 layouts:
  ; UNICODE_STRING = USHORT/USHORT/pointer (8); OBJECT_ATTRIBUTES = 24;
  ; IO_STATUS_BLOCK = pointer-sized status union + ULONG_PTR (8).
  ; Every pointer and handle uses SYSTYPE_PTR, never an integer-sized cast.
  Function luhengNativeDirectory
    System::Store "S"
    StrCpy $luidNativeHandle 0
    StrCpy $luidNativeStatus -1
    StrCpy $luidNativeInformation 0
    StrCpy $1 0
    StrCpy $2 0
    StrCpy $3 0
    StrCpy $4 0
    StrLen $0 $luidNativeName
    IntOp $5 $0 + 1
    System::StrAlloc $5
    Pop $1
    ${If} $1 == 0
      Goto luid_native_done
    ${EndIf}
    System::Call 'kernel32::lstrcpyW(${SYSTYPE_PTR} r1, w "$luidNativeName")'
    IntOp $0 $0 * 2
    IntOp $5 $5 * 2
    System::Call '*(&i2 r0, &i2 r5, ${SYSTYPE_PTR} r1) ${SYSTYPE_PTR} .r2'
    ${If} $2 == 0
      Goto luid_native_done
    ${EndIf}
    System::Call '*(i 24, ${SYSTYPE_PTR} $luidNativeRoot, ${SYSTYPE_PTR} r2, i 0x40, ${SYSTYPE_PTR} $luidNativeSd, ${SYSTYPE_PTR} 0) ${SYSTYPE_PTR} .r3'
    System::Call '*(${SYSTYPE_PTR} 0, ${SYSTYPE_PTR} 0) ${SYSTYPE_PTR} .r4'
    ${If} $3 == 0
    ${OrIf} $4 == 0
      Goto luid_native_done
    ${EndIf}
    ; Share read/write, never delete. FILE_CREATE=2 must return FILE_CREATED=2.
    System::Call 'ntdll::NtCreateFile(*${SYSTYPE_PTR} 0 .r6, i $luidNativeAccess, ${SYSTYPE_PTR} r3, ${SYSTYPE_PTR} r4, ${SYSTYPE_PTR} 0, i 0x80, i 3, i $luidNativeDisposition, i $luidNativeOptions, ${SYSTYPE_PTR} 0, i 0) i .r7'
    StrCpy $luidNativeHandle $6
    StrCpy $luidNativeStatus $7
    System::Call '*$4(${SYSTYPE_PTR}, ${SYSTYPE_PTR} .r8)'
    StrCpy $luidNativeInformation $8
    luid_native_done:
    ${If} $4 != 0
      System::Free $4
    ${EndIf}
    ${If} $3 != 0
      System::Free $3
    ${EndIf}
    ${If} $2 != 0
      System::Free $2
    ${EndIf}
    ${If} $1 != 0
      System::Free $1
    ${EndIf}
    System::Store "L"
  FunctionEnd

  ; Input luidCheckHandle; output luidCheckIdentity. Read attrs/identity from
  ; the handle, then actual owner. Existing directories only need owner checks;
  ; newly-created directories also require the exact protected three-ACE DACL.
  Function luhengVerifyDirectoryHandle
    System::Store "S"
    StrCpy $luidCheckIdentity ""
    StrCpy $9 0
    System::Call '*(i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0) ${SYSTYPE_PTR} .r1'
    ${If} $1 == 0
      StrCpy $luidError "无法分配目录身份检查缓冲区。"
      Goto luid_verify_done
    ${EndIf}
    System::Call 'kernel32::GetFileInformationByHandle(${SYSTYPE_PTR} $luidCheckHandle, ${SYSTYPE_PTR} r1) i .r0'
    ${If} $0 == 0
      StrCpy $luidError "无法读取应用目录的文件身份。"
      Goto luid_verify_done
    ${EndIf}
    System::Call '*$1(i .r2,i,i,i,i,i,i,i .r3,i,i,i,i .r4,i .r5)'
    IntOp $0 $2 & 0x400
    IntOp $6 $2 & 0x10
    ${If} $0 != 0
    ${OrIf} $6 == 0
      StrCpy $luidError "应用路径必须是普通目录，不能是链接或重解析点。"
      Goto luid_verify_done
    ${EndIf}
    StrCpy $luidCheckIdentity "$3/$4/$5"
    System::Call 'advapi32::GetSecurityInfo(${SYSTYPE_PTR} $luidCheckHandle, i 1, i 5, *${SYSTYPE_PTR} 0 .r2, ${SYSTYPE_PTR} 0, *${SYSTYPE_PTR} 0 .r3, ${SYSTYPE_PTR} 0, *${SYSTYPE_PTR} 0 .r9) i .r0'
    ${If} $0 != 0
    ${OrIf} $2 == 0
    ${OrIf} $9 == 0
      StrCpy $luidError "无法读取应用目录的所有者。"
      Goto luid_verify_done
    ${EndIf}
    System::Call 'advapi32::EqualSid(${SYSTYPE_PTR} r2, ${SYSTYPE_PTR} $luidUserSid) i .r0'
    ${If} $0 == 0
      StrCpy $luidError "应用目录所有者不是当前用户，不能接管或修改此目录。"
      Goto luid_verify_done
    ${EndIf}
    ${If} $luidVerifyAcl == 1
      ${If} $3 == 0
        StrCpy $luidError "新应用目录未返回有效 DACL。"
        Goto luid_verify_done
      ${EndIf}
      System::Call 'advapi32::GetSecurityDescriptorControl(${SYSTYPE_PTR} r9, *i 0 .r4, *i 0 .r5) i .r0'
      IntOp $4 $4 & 0x1004
      ${If} $0 == 0
      ${OrIf} $4 <> 0x1004
        StrCpy $luidError "新应用目录的 DACL 未受到保护。"
        Goto luid_verify_done
      ${EndIf}
      System::Call '*$3(&i1, &i1, &i2, &i2 .r4, &i2)'
      ${If} $4 != 3
        StrCpy $luidError "新应用目录的访问控制项数量不符合要求。"
        Goto luid_verify_done
      ${EndIf}
      StrCpy $4 0
      StrCpy $5 0
      ${DoWhile} $4 < 3
        System::Call 'advapi32::GetAce(${SYSTYPE_PTR} r3, i r4, *${SYSTYPE_PTR} 0 .r6) i .r0'
        ${If} $0 == 0
        ${OrIf} $6 == 0
          StrCpy $luidError "无法读取新应用目录访问控制项。"
          Goto luid_verify_done
        ${EndIf}
        System::Call '*$6(&i1 .r0, &i1 .r7, &i2 .r8, i .R0)'
        ${If} $0 != 0
        ${OrIf} $7 != 3
        ${OrIf} $R0 <> 0x1f01ff
        ${OrIf} $8 < 16
          StrCpy $luidError "新应用目录的访问控制权限不符合要求。"
          Goto luid_verify_done
        ${EndIf}
        IntOp $6 $6 + 8
        System::Call 'advapi32::EqualSid(${SYSTYPE_PTR} r6, ${SYSTYPE_PTR} $luidUserSid) i .r0'
        ${If} $0 != 0
          IntOp $5 $5 | 1
        ${Else}
          System::Call 'advapi32::EqualSid(${SYSTYPE_PTR} r6, ${SYSTYPE_PTR} $luidSystemSid) i .r0'
          ${If} $0 != 0
            IntOp $5 $5 | 2
          ${Else}
            System::Call 'advapi32::EqualSid(${SYSTYPE_PTR} r6, ${SYSTYPE_PTR} $luidAdminsSid) i .r0'
            ${If} $0 != 0
              IntOp $5 $5 | 4
            ${Else}
              StrCpy $luidError "新应用目录包含非预期访问者。"
              Goto luid_verify_done
            ${EndIf}
          ${EndIf}
        ${EndIf}
        IntOp $4 $4 + 1
      ${Loop}
      ${If} $5 != 7
        StrCpy $luidError "新应用目录必须只允许当前用户、SYSTEM 和 Administrators 完全控制。"
      ${EndIf}
    ${EndIf}
    luid_verify_done:
    ${If} $9 != 0
      System::Call 'kernel32::LocalFree(${SYSTYPE_PTR} r9)'
    ${EndIf}
    ${If} $1 != 0
      System::Free $1
    ${EndIf}
    System::Store "L"
  FunctionEnd

  ; Save an ancestor handle in a linked list for deterministic error cleanup.
  ; Existing ancestors are opened read-only; owner/DACL are never changed.
  Function luhengRetainAncestor
    System::Store "S"
    System::Call '*(${SYSTYPE_PTR} $luidAncestorHead, ${SYSTYPE_PTR} $luidNativeHandle) ${SYSTYPE_PTR} .r0'
    ${If} $0 == 0
      System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidNativeHandle)'
      StrCpy $luidError "无法保留父目录检查句柄。"
    ${Else}
      StrCpy $luidAncestorHead $0
      StrCpy $luidWalkParentHandle $luidNativeHandle
    ${EndIf}
    StrCpy $luidNativeHandle 0
    System::Store "L"
  FunctionEnd

  ; Input luidCheckParent. Open the drive root and each component relative to
  ; the preceding held handle. Reject absent parents and all reparse points.
  ; Never request WRITE_DAC/WRITE_OWNER or enable a privilege on ancestors.
  Function luhengHoldAncestors
    System::Store "S"
    StrCpy $luidWalkParentHandle 0
    StrCpy $0 $luidCheckParent 3
    System::Call 'kernel32::CreateFileW(w r0, i 0x80, i 3, ${SYSTYPE_PTR} 0, i 3, i 0x02200000, ${SYSTYPE_PTR} 0) ${SYSTYPE_PTR} .r1'
    ${If} $1 == -1
    ${OrIf} $1 == 0
      StrCpy $luidError "无法打开应用目录所在磁盘。"
      Goto luid_ancestors_done
    ${EndIf}
    StrCpy $luidNativeHandle $1
    StrCpy $2 3
    StrLen $3 $luidCheckParent
    ; Attribute readback for each handle; root ownership is intentionally not
    ; constrained, because system/user ancestor ownership is not being changed.
    luid_ancestor_verify:
    System::Call '*(i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0) ${SYSTYPE_PTR} .r4'
    ${If} $4 == 0
      StrCpy $luidError "无法分配父目录检查缓冲区。"
      Goto luid_ancestor_failed
    ${EndIf}
    System::Call 'kernel32::GetFileInformationByHandle(${SYSTYPE_PTR} $luidNativeHandle, ${SYSTYPE_PTR} r4) i .r5'
    System::Call '*$4(i .r6)'
    System::Free $4
    IntOp $7 $6 & 0x400
    IntOp $6 $6 & 0x10
    ${If} $5 == 0
    ${OrIf} $7 != 0
    ${OrIf} $6 == 0
      StrCpy $luidError "应用目录的父路径包含链接、重解析点或非目录。"
      Goto luid_ancestor_failed
    ${EndIf}
    Call luhengRetainAncestor
    ${If} $luidError != ""
      Goto luid_ancestors_done
    ${EndIf}
    ${If} $2 >= $3
      Goto luid_ancestors_done
    ${EndIf}
    StrCpy $4 $2
    ${DoWhile} $2 < $3
      StrCpy $5 $luidCheckParent 1 $2
      ${If} $5 == "\"
        ${Break}
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
    IntOp $5 $2 - $4
    StrCpy $luidNativeName $luidCheckParent $5 $4
    IntOp $2 $2 + 1
    StrCpy $luidNativeRoot $luidWalkParentHandle
    StrCpy $luidNativeAccess 0x100080
    StrCpy $luidNativeDisposition 1
    StrCpy $luidNativeOptions 0x200021
    StrCpy $luidNativeSd 0
    Call luhengNativeDirectory
    ${If} $luidNativeStatus < 0
    ${OrIf} $luidNativeHandle == 0
      StrCpy $luidError "父目录不存在或无法读取。请先选择一个已存在的父目录，再使用尚不存在的 ${APP_FILENAME} 子目录。"
      Goto luid_ancestor_failed
    ${EndIf}
    Goto luid_ancestor_verify
    luid_ancestor_failed:
    ${If} $luidNativeHandle != 0
      System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidNativeHandle)'
      StrCpy $luidNativeHandle 0
    ${EndIf}
    luid_ancestors_done:
    System::Store "L"
  FunctionEnd

  Function luhengPreflightDirectory
    System::Store "S"
    Call luhengCloseDirectoryResources
    StrCpy $luidError ""
    ${If} $installMode != "CurrentUser"
      StrCpy $luidError "此安装程序仅支持当前用户安装。"
      Goto luid_preflight_done
    ${EndIf}
    ${If} ${isDeleteAppData}
      StrCpy $luidError "此更新安装程序必须保留原应用数据，不支持 --delete-app-data 参数。"
      Goto luid_preflight_done
    ${EndIf}
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $1 == ""
        ReadRegStr $1 HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
    !endif
    ${If} $0 != ""
    ${OrIf} $1 != ""
      StrCpy $luidError "检测到此应用的全用户安装，请先正常卸载后再安装当前用户版本。"
      Goto luid_preflight_done
    ${EndIf}
    ; On x64 Windows, also inspect the other machine registry view. Restore
    ; the template-selected view before all HKCU reads and installer writes.
    ${If} ${RunningX64}
      SetRegView 32
      ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
      !ifdef UNINSTALL_REGISTRY_KEY_2
        ${If} $1 == ""
          ReadRegStr $1 HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
        ${EndIf}
      !endif
      SetRegView lastused
      ${If} $0 != ""
      ${OrIf} $1 != ""
        StrCpy $luidError "检测到此应用的全用户安装，请先正常卸载后再安装当前用户版本。"
        Goto luid_preflight_done
      ${EndIf}
    ${EndIf}
    Call luhengReadCurrentUser
    ${If} $luidError != ""
      Goto luid_preflight_done
    ${EndIf}
    StrCpy $luidTarget $INSTDIR
    StrCpy $luidCheckPath $luidTarget
    Call luhengCheckCanonicalAppPath
    ${If} $luidError != ""
      Goto luid_preflight_done
    ${EndIf}
    StrCpy $luidParentPath $luidCheckParent
    Call luhengHoldAncestors
    ${If} $luidError != ""
      Goto luid_preflight_done
    ${EndIf}
    StrCpy $luidParentHandle $luidWalkParentHandle
    ReadRegStr $luidOldPath HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $luidOldUninstaller HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $luidOldUninstaller == ""
        ReadRegStr $luidOldUninstaller HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
    !endif
    ${If} $luidOldPath == ""
      ${If} $luidOldUninstaller != ""
        StrCpy $luidError "旧安装记录缺少可信的应用目录，无法安全卸载。"
        Goto luid_preflight_done
      ${EndIf}
    ${Else}
      ; A new install cannot be nested inside the old app directory: retaining
      ; that directory as a new-parent ancestor would prevent normal uninstall.
      StrLen $0 $luidOldPath
      IntOp $0 $0 + 1
      StrCpy $1 $luidTarget $0
      ${If} $1 == "$luidOldPath\"
        StrCpy $luidError "新应用目录不能位于旧应用目录之内，请选择其他已存在的父目录。"
        Goto luid_preflight_done
      ${EndIf}
      StrCpy $luidCheckPath $luidOldPath
      Call luhengCheckCanonicalAppPath
      ${If} $luidError != ""
        Goto luid_preflight_done
      ${EndIf}
      Call luhengHoldAncestors
      ${If} $luidError != ""
        Goto luid_preflight_done
      ${EndIf}
      StrCpy $luidNativeRoot $luidWalkParentHandle
      StrCpy $luidNativeName "${APP_FILENAME}"
      StrCpy $luidNativeAccess 0x120080
      StrCpy $luidNativeDisposition 1
      StrCpy $luidNativeOptions 0x200021
      StrCpy $luidNativeSd 0
      Call luhengNativeDirectory
      ${If} $luidNativeStatus < 0
      ${OrIf} $luidNativeHandle == 0
        StrCpy $luidError "旧安装记录中的目录无法打开，请先正常卸载旧应用。"
        Goto luid_preflight_old_close
      ${EndIf}
      StrCpy $luidCheckHandle $luidNativeHandle
      StrCpy $luidVerifyAcl 0
      Call luhengVerifyDirectoryHandle
      luid_preflight_old_close:
      ${If} $luidNativeHandle != 0
        System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidNativeHandle)'
        StrCpy $luidNativeHandle 0
      ${EndIf}
      ${If} $luidError != ""
        Goto luid_preflight_done
      ${EndIf}
      Push $luidOldUninstaller
      Call GetInQuotes
      Pop $0
      ${If} $luidOldUninstaller == ""
      ${OrIf} $0 != "$luidOldPath\${UNINSTALL_FILENAME}"
        StrCpy $luidError "旧应用卸载程序记录不符合预期，请先手动正常卸载。"
        Goto luid_preflight_done
      ${EndIf}
      System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
      IntOp $2 $1 & 0x410
      ${If} $1 == -1
      ${OrIf} $2 != 0
        StrCpy $luidError "旧应用卸载程序缺失或不是普通文件，请先手动正常卸载。"
        Goto luid_preflight_done
      ${EndIf}
    ${EndIf}
    ; A pre-existing destination is allowed only for this exact HKCU app
    ; registration whose owner was just verified. It is never adopted/reowned.
    StrCpy $luidNativeRoot $luidParentHandle
    StrCpy $luidNativeName "${APP_FILENAME}"
    StrCpy $luidNativeAccess 0x120080
    StrCpy $luidNativeDisposition 1
    StrCpy $luidNativeOptions 0x200021
    StrCpy $luidNativeSd 0
    Call luhengNativeDirectory
    ${If} $luidNativeStatus >= 0
      ${If} $luidTarget != $luidOldPath
        StrCpy $luidError "目标目录已经存在且不是此应用的当前用户安装目录，不能接管。"
      ${EndIf}
      ${If} $luidNativeHandle != 0
        System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidNativeHandle)'
        StrCpy $luidNativeHandle 0
      ${EndIf}
    ${ElseIf} $luidNativeStatus != -1073741772
      StrCpy $luidError "无法确认目标应用目录是否不存在。"
    ${EndIf}
    ${If} $luidError != ""
      Goto luid_preflight_done
    ${EndIf}
    ; An unpredictable, FILE_CREATE-only empty sibling probe proves that this
    ; token/filesystem can create and read back this exact owner + DACL before
    ; the destructive old-uninstall step. DELETE_ON_CLOSE removes only it.
    System::Call '*(&g16) ${SYSTYPE_PTR} .r0'
    ${If} $0 == 0
      StrCpy $luidError "无法准备新目录创建检查。"
      Goto luid_preflight_done
    ${EndIf}
    System::Call 'ole32::CoCreateGuid(${SYSTYPE_PTR} r0) i .r1'
    ${If} $1 != 0
      System::Free $0
      StrCpy $luidError "无法生成目录检查的唯一名称。"
      Goto luid_preflight_done
    ${EndIf}
    System::Call 'ole32::StringFromGUID2(${SYSTYPE_PTR} r0, w .r1, i 64) i .r2'
    System::Free $0
    ${If} $2 == 0
      StrCpy $luidError "无法生成目录检查的唯一名称。"
      Goto luid_preflight_done
    ${EndIf}
    StrCpy $luidNativeName ".luheng-install-probe-$1"
    StrCpy $luidNativeRoot $luidParentHandle
    StrCpy $luidNativeAccess 0x130080
    StrCpy $luidNativeDisposition 2
    StrCpy $luidNativeOptions 0x201021
    StrCpy $luidNativeSd $luidCreateSd
    Call luhengNativeDirectory
    ${If} $luidNativeStatus < 0
    ${OrIf} $luidNativeHandle == 0
    ${OrIf} $luidNativeInformation != 2
      StrCpy $luidError "新目录创建检查失败；当前权限或文件系统不支持当前用户专属目录。"
    ${Else}
      StrCpy $luidCheckHandle $luidNativeHandle
      StrCpy $luidVerifyAcl 1
      Call luhengVerifyDirectoryHandle
    ${EndIf}
    ${If} $luidNativeHandle != 0
      System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidNativeHandle) i .r0'
      StrCpy $luidNativeHandle 0
      ${If} $0 == 0
        StrCpy $luidError "目录创建检查句柄无法关闭。"
      ${EndIf}
    ${EndIf}
    ${If} $luidError == ""
      StrCpy $luidReady 1
    ${EndIf}
    luid_preflight_done:
    System::Store "L"
  FunctionEnd

  Function luhengCreateDirectory
    System::Store "S"
    StrCpy $luidError ""
    ${If} $luidReady != 1
    ${OrIf} $INSTDIR != $luidTarget
    ${OrIf} $luidParentHandle == 0
      StrCpy $luidError "应用目录检查结果已失效，请重新运行安装。"
      Goto luid_create_done
    ${EndIf}
    ; Old-uninstall must actually remove the directory. No delete/repair here.
    StrCpy $luidNativeRoot $luidParentHandle
    StrCpy $luidNativeName "${APP_FILENAME}"
    StrCpy $luidNativeAccess 0x120080
    StrCpy $luidNativeDisposition 1
    StrCpy $luidNativeOptions 0x200021
    StrCpy $luidNativeSd 0
    Call luhengNativeDirectory
    ${If} $luidNativeHandle != 0
      System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidNativeHandle)'
      StrCpy $luidNativeHandle 0
    ${EndIf}
    ${If} $luidNativeStatus != -1073741772
      StrCpy $luidError "卸载后目标目录仍存在或无法确认其已移除；不能复用或接管。"
      Goto luid_create_done
    ${EndIf}
    StrCpy $luidNativeDisposition 2
    StrCpy $luidNativeSd $luidCreateSd
    Call luhengNativeDirectory
    ${If} $luidNativeStatus < 0
    ${OrIf} $luidNativeHandle == 0
    ${OrIf} $luidNativeInformation != 2
      ${If} $luidNativeHandle != 0
        System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} $luidNativeHandle)'
        StrCpy $luidNativeHandle 0
      ${EndIf}
      StrCpy $luidError "原子创建新应用目录失败，目标可能在检查后被占用。"
      Goto luid_create_done
    ${EndIf}
    StrCpy $luidOwnedHandle $luidNativeHandle
    StrCpy $luidNativeHandle 0
    StrCpy $luidCheckHandle $luidOwnedHandle
    StrCpy $luidVerifyAcl 1
    Call luhengVerifyDirectoryHandle
    ${If} $luidError == ""
      StrCpy $luidOwnedIdentity $luidCheckIdentity
    ${EndIf}
    luid_create_done:
    System::Store "L"
  FunctionEnd

  Function luhengFinishDirectory
    System::Store "S"
    StrCpy $luidError ""
    ${If} $luidReady != 1
    ${OrIf} $luidOwnedHandle == 0
    ${OrIf} $INSTDIR != $luidTarget
      StrCpy $luidError "安装目录检查句柄或路径已失效。"
      Goto luid_finish_done
    ${EndIf}
    StrCpy $luidCheckHandle $luidOwnedHandle
    StrCpy $luidVerifyAcl 1
    Call luhengVerifyDirectoryHandle
    ${If} $luidError != ""
      Goto luid_finish_done
    ${EndIf}
    ${If} $luidCheckIdentity != $luidOwnedIdentity
      StrCpy $luidError "安装目录文件身份发生变化。"
      Goto luid_finish_done
    ${EndIf}
    ; Read back the actual extraction path as well as the held native object.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 0x20080, i 3, ${SYSTYPE_PTR} 0, i 3, i 0x02200000, ${SYSTYPE_PTR} 0) ${SYSTYPE_PTR} .r0'
    ${If} $0 == -1
    ${OrIf} $0 == 0
      StrCpy $luidError "无法读取实际安装路径。"
      Goto luid_finish_done
    ${EndIf}
    StrCpy $luidCheckHandle $0
    Call luhengVerifyDirectoryHandle
    System::Call 'kernel32::CloseHandle(${SYSTYPE_PTR} r0)'
    ${If} $luidError == ""
    ${AndIf} $luidCheckIdentity != $luidOwnedIdentity
      StrCpy $luidError "实际安装路径与创建的应用目录身份不一致。"
    ${EndIf}
    luid_finish_done:
    Call luhengCloseDirectoryResources
    System::Store "L"
  FunctionEnd

  Function .onInstFailed
    Call luhengCloseDirectoryResources
  FunctionEnd

  Function luhengDirectoryUserAbort
    Call luhengCloseDirectoryResources
  FunctionEnd

  Function .onGUIEnd
    Call luhengCloseDirectoryResources
  FunctionEnd
!macroend
!endif
