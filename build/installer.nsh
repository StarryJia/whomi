!macro customRemoveFiles
  SetOutPath "$TEMP"
  ${If} ${isUpdated}
    ; 升级沿用 electron-builder 的文件暂存和回滚，保留同级的日志目录。
    CreateDirectory "$PLUGINSDIR\old-install"
    FindFirst $R4 $R5 "$INSTDIR\*.*"
    ${DoWhile} $R5 != ""
      ${If} $R5 != "."
      ${AndIf} $R5 != ".."
      ${AndIf} $R5 != "logs"
        ${If} ${FileExists} "$INSTDIR\$R5\*.*"
          CreateDirectory "$PLUGINSDIR\old-install\$R5"
          Push "\$R5"
          Call un.atomicRMDir
          Pop $R0
        ${Else}
          StrCpy $R0 0
          ClearErrors
          Rename "$INSTDIR\$R5" "$PLUGINSDIR\old-install\$R5"
          ${If} ${Errors}
          ${AndIf} $R5 != "${UNINSTALL_FILENAME}"
            StrCpy $R0 "$INSTDIR\$R5"
          ${EndIf}
        ${EndIf}
        ${If} $R0 != 0
          FindClose $R4
          Push ""
          Call un.restoreFiles
          Pop $R0
          Abort "请关闭 Whomi 后重新安装。"
        ${EndIf}
      ${EndIf}
      FindNext $R4 $R5
    ${Loop}
    FindClose $R4
  ${Else}
    RMDir /r "$INSTDIR"
  ${EndIf}
!macroend
