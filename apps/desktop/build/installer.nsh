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

; WP409：装之前另一种安装范围（按用户 / 按机器）登记的安装位置（见下面第 4 节）。只有安装程序用得着。
!ifndef BUILD_UNINSTALLER
  Var agentswsUserDir
  Var agentswsMachineDir
!endif

; ── 2. 只摆不装 ────────────────────────────────────────────────────────────
!macro customInit
  ; WP409：electron-builder 换成按机器装时会先卸掉按用户那一份（连登记一起删），所以在那之前先记下它在哪
  ReadRegStr $agentswsUserDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $agentswsMachineDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
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
      ; WP427（决策 1273 ②）：服务进程的 Node 改从不随版本变的 <安装目录>\node\node.exe 起，防火墙的「允许」
      ; 一次一直有效。这里把这一版自带的那份拷过去（按机器装时只有安装程序有权限写）；拷不成不挡安装，
      ; 应用启动时会按「大小 + 哈希」再核对、同步一遍。更新前卸旧版那一步不删这个目录（只有真卸载才删）。
      ${If} ${FileExists} "$R8\resources\node\node.exe"
        CreateDirectory "$INSTDIR\node"
        ClearErrors
        CopyFiles /SILENT "$R8\resources\node\*.*" "$INSTDIR\node"
        ${If} ${Errors}
          DetailPrint "agentsws: could not refresh $INSTDIR\node (the app retries on start)"
        ${EndIf}
      ${EndIf}
      ; WP422：防火墙按真实路径（app-<版本>\resources\node\node.exe）记「允许」，换一版就又问一次。
      ; 用户对旧版点过允许 → 给这一版的 Node 加一条「Agents 工坊（局域网发现）」允许规则，并删掉指向已经不在的
      ; 旧版本的规则；从没点过的不加。按用户装没有管理员权限 → 只记一句、不弹 UAC。失败不挡安装（脚本总是退 0）。
      ${If} ${FileExists} "$R8\resources\node\node.exe"
      ${AndIf} ${FileExists} "$R8\resources\app\dist\firewall-cli.js"
        ; WP427：--node 是服务进程真正跑的那份（不随版本变）；以前对版本目录里 Node 点过的允许带到它身上
        nsExec::ExecToLog /TIMEOUT=90000 '"$R8\resources\node\node.exe" "$R8\resources\app\dist\firewall-cli.js" --root "$INSTDIR" --dir "$R8" --node "$INSTDIR\node\node.exe"'
        Pop $R7
        DetailPrint "agentsws: firewall carry-over finished ($R7)"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !insertmacro agentswsOtherScope
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
    ; WP422：真卸载时把我们加过的防火墙规则一起删（按名字认；按用户装没有管理员权限就删不了，也不挡卸载）
    nsExec::ExecToLog /TIMEOUT=30000 '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Agents 工坊（局域网发现）"'
    Pop $R0
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${EndIf}
!macroend

; ── 4. WP409（内测真机 10-18 #2）：换了安装范围时收拾另一份 ─────────────────────
; 现象：旧版按用户装在 %LOCALAPPDATA%\Programs\agentsws，手动装新版时选了「所有用户」装到 Program Files。
; electron-builder 会用 `--updated` 静默卸掉按用户那一份——可我们的卸载在 `--updated` 下只删 `current` 联接
; （同一目录里升级要留上一版回滚），于是旧的 app-<版本>\、卸载程序都留着，开始菜单里 Electron 补的 agentsws.lnk
; 还指着已经不在的 current\agentsws.exe，点了打不开。
;   按机器装：按用户那一份已不在登记里 → 把它留下的版本目录 / 平铺文件 / 卸载程序删掉（只删认得出是我们的），
;             再删按用户那几个快捷方式（新的都在「所有用户」开始菜单里，指 current）。数据目录不碰。
;   按用户装：机器上还有一份按机器装的 → 问一句要不要卸（静默装默认不卸），要卸就交给它自己的卸载程序
;             （会要管理员确认；只卸程序，数据不动）。
!macro agentswsRemoveFromOld NAME
  RMDir /r "$R1\${NAME}"
  Delete "$R1\${NAME}"
!macroend

!macro agentswsOtherScope
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  ${If} $installMode == "all"
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R0 == ""
      SetShellVarContext current
      StrCpy $R1 $agentswsUserDir
      ${If} $R1 == ""
        StrCpy $R1 "$LOCALAPPDATA\Programs\${APP_FILENAME}"
      ${EndIf}
      ${If} $R1 != $INSTDIR
      ${AndIf} ${FileExists} "$R1\*.*"
        DetailPrint "agentsws: removing the per-user copy left in $R1"
        RMDir "$R1\current"
        FindFirst $R2 $R3 "$R1\app-*"
        ${DoWhile} $R3 != ""
          ${If} ${FileExists} "$R1\$R3\${APP_EXECUTABLE_FILENAME}"
            RMDir /r "$R1\$R3"
          ${EndIf}
          FindNext $R2 $R3
        ${Loop}
        FindClose $R2
        ; 更早的平铺安装：确认根上真是我们的 exe 才按条目删
        ${If} ${FileExists} "$R1\${APP_EXECUTABLE_FILENAME}"
          !insertmacro agentswsAppEntries agentswsRemoveFromOld
        ${EndIf}
        ; WP427：按用户那一份不随版本变的 Node（认得出是我们的才删）
        ${If} ${FileExists} "$R1\node\.agentsws-node.json"
          RMDir /r "$R1\node"
        ${EndIf}
        Delete "$R1\${UNINSTALL_FILENAME}"
        Delete "$R1\agentsws-install.txt"
        Delete "$R1\uninstallerIcon.ico"
        RMDir "$R1"
      ${EndIf}
      Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
      SetShellVarContext all
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  ${Else}
    StrCpy $R0 $agentswsMachineDir
    ${If} $R0 != ""
    ${AndIf} $R0 != $INSTDIR
    ${AndIf} ${FileExists} "$R0\${UNINSTALL_FILENAME}"
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "这台电脑上还有一份给「所有用户」装的 Agents 工坊（$R0），开始菜单里会有两个入口。要现在卸掉那一份吗？只卸程序，你的数据和设置都在（可能要管理员确认）。$\r$\n$\r$\nAnother copy of Agents Workshop is installed for all users ($R0). Uninstall it now? Only the program is removed; your data and settings stay." /SD IDNO IDYES`
        InitPluginsDir
        CopyFiles /SILENT "$R0\${UNINSTALL_FILENAME}" "$PLUGINSDIR\agentsws-other-uninstaller.exe"
        ExecWait '"$PLUGINSDIR\agentsws-other-uninstaller.exe" /S /allusers _?=$R0' $R2
        DetailPrint "agentsws: the all-users copy's uninstaller returned $R2"
      ${Else}
        DetailPrint "agentsws: keeping the all-users copy in $R0"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
