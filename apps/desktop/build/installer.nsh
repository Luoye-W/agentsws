; 本文件带 UTF-8 BOM（makensis 才按 UTF-8 读）。
; WP327（决策 630 / 730）：Windows 安装目录改成「版本目录 + 目录联接」，更新时旧版开着就把新版摆到旁边，
; 点「重启并更新」只切联接（空窗从几分钟降到秒级）。electron-builder 按 `build/installer.nsh` 自动 include 本文件。
;
;   <安装目录>\
;     current\            目录联接（junction）→ 下面某一版；快捷方式 / 开机启动 / 卸载登记都指它
;     app-<版本>\         一版一整套（agentsws.exe + resources\ …）
;     Uninstall Agents 工坊.exe
;
; 三件事：
; 1. 首次安装 / 走安装程序的更新（含从老的平铺布局迁移）：NSIS 照常把文件解到安装目录根上，`customInstall`
;    再把这一版的文件挪进 `app-<版本>\`、建 `current` 联接、把快捷方式 / 任务栏固定 / 卸载登记的图标改指
;    `current\agentsws.exe`。联接建不出来（FAT32 / 网络盘）就挪回去，照旧平铺——应用按平铺走老更新路。
; 2. 「只摆不装」（`Setup.exe /S --agentsws-stage /D=<安装目录>`）：旧版开着时由应用在后台低优先级跑，
;    只把这一版解到 `<安装目录>\app-<版本>\`，不结束任何进程、不卸旧版、不动登记与快捷方式。
; 3. 卸载：先删 `current` 联接再删整个目录；作为「更新前卸旧版」被调用时只删联接（旧版本目录留给应用清理，
;    也就是保留上一版用来回滚）。
;
; `agentsws-app-entries.nsh` 由 afterPack 按这一版 win-unpacked 根上的条目生成（只挪我们自己的文件）。

!include "agentsws-app-entries.nsh"

; ── 2. 只摆不装 ────────────────────────────────────────────────────────────
!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--agentsws-stage" $R1
  ${IfNot} ${Errors}
    InitPluginsDir
    StrCpy $R2 "$INSTDIR\app-${VERSION}"
    StrCpy $R3 "$INSTDIR\app-${VERSION}.part"
    RMDir /r "$R3"
    CreateDirectory "$R3"
    SetOutPath "$R3"
    !ifdef COMPRESS
      SetCompress off
    !endif
    File /oname=$PLUGINSDIR\app-64.${COMPRESSION_METHOD} "${APP_64}"
    !ifdef COMPRESS
      SetCompress "${COMPRESS}"
    !endif
    Nsis7z::Extract "$PLUGINSDIR\app-64.${COMPRESSION_METHOD}"
    SetOutPath "$TEMP"
    ${If} ${FileExists} "$R3\${APP_EXECUTABLE_FILENAME}"
      RMDir /r "$R2"
      ClearErrors
      Rename "$R3" "$R2"
      ${If} ${Errors}
        SetErrorLevel 3
      ${Else}
        FileOpen $R4 "$R2\.agentsws-staged" w
        FileWrite $R4 "${VERSION}"
        FileClose $R4
        SetErrorLevel 0
      ${EndIf}
    ${Else}
      RMDir /r "$R3"
      SetErrorLevel 2
    ${EndIf}
    Quit
  ${EndIf}
!macroend

; ── 1. 首次安装 / 安装程序更新：挪进版本目录、建联接、改快捷方式 ─────────────────
!macro agentswsMoveIn NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}"
    ClearErrors
    Rename "$INSTDIR\${NAME}" "$R8\${NAME}"
    ${If} ${Errors}
      StrCpy $R9 "fail"
    ${EndIf}
  ${EndIf}
!macroend

!macro agentswsMoveBack NAME
  ${If} ${FileExists} "$R8\${NAME}"
    Rename "$R8\${NAME}" "$INSTDIR\${NAME}"
  ${EndIf}
!macroend

!macro agentswsRelink LINK
  ${If} ${FileExists} "${LINK}"
    CreateShortCut "${LINK}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"
  ${EndIf}
!macroend

!macro customInstall
  StrCpy $R8 "$INSTDIR\app-${VERSION}"
  StrCpy $R9 ""
  ${If} ${FileExists} "$R8\*.*"
    RMDir /r "$R8"
  ${EndIf}
  CreateDirectory "$R8"
  !insertmacro agentswsAppEntries agentswsMoveIn
  ${If} $R9 == "fail"
    !insertmacro agentswsAppEntries agentswsMoveBack
    RMDir "$R8"
    DetailPrint "agentsws: cannot move files into the version folder, keeping the flat layout"
  ${Else}
    RMDir "$INSTDIR\current"
    nsExec::ExecToLog '"$SYSDIR\cmd.exe" /d /c mklink /J "$INSTDIR\current" "$R8"'
    Pop $R7
    ${IfNot} ${FileExists} "$INSTDIR\current\${APP_EXECUTABLE_FILENAME}"
      RMDir "$INSTDIR\current"
      !insertmacro agentswsAppEntries agentswsMoveBack
      RMDir "$R8"
      DetailPrint "agentsws: no junction support on this drive ($R7), keeping the flat layout"
    ${Else}
      StrCpy $appExe "$INSTDIR\current\${APP_EXECUTABLE_FILENAME}"
      !insertmacro agentswsRelink "$newStartMenuLink"
      !insertmacro agentswsRelink "$newDesktopLink"
      !insertmacro agentswsRelink "$QUICKLAUNCH\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
      ; Electron 为系统通知在开始菜单补的那一个（按产品名，老版本建时指平铺的 exe）
      !insertmacro agentswsRelink "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
      !ifndef UNINSTALLER_ICON
        WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$appExe,0"
      !endif
      ${If} ${FileExists} "$newStartMenuLink"
        StrCpy $launchLink "$newStartMenuLink"
      ${Else}
        StrCpy $launchLink "$appExe"
      ${EndIf}
      ; 应用切版本后要改「已安装的版本号」：告诉它卸载登记在哪
      FileOpen $R6 "$INSTDIR\agentsws-install.txt" w
      ${If} $installMode == "all"
        FileWrite $R6 "HKLM$\r$\n"
      ${Else}
        FileWrite $R6 "HKCU$\r$\n"
      ${EndIf}
      FileWrite $R6 "${UNINSTALL_REGISTRY_KEY}$\r$\n"
      FileClose $R6
    ${EndIf}
  ${EndIf}
!macroend

; ── 3. 卸载 ────────────────────────────────────────────────────────────────
!macro agentswsRemoveEntry NAME
  RMDir /r "$INSTDIR\${NAME}"
  Delete "$INSTDIR\${NAME}"
!macroend

!macro customRemoveFiles
  ; 联接本身先删（删联接不碰它指向的目录）
  RMDir "$INSTDIR\current"
  ${If} ${isUpdated}
    ; 安装程序更新前卸旧版：版本目录不动（新版的安装程序摆 app-<新版本>，旧的留作上一版，应用之后清理）；
    ; 平铺布局（联接建不了的盘）照旧把这一版的文件删掉
    !insertmacro agentswsAppEntries agentswsRemoveEntry
  ${Else}
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${EndIf}
!macroend
