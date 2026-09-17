!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove Dubplate settings, encrypted token, downloaded tools, and logs?" /SD IDNO IDNO keepDubplateData
    RMDir /r "$APPDATA\Dubplate"
  keepDubplateData:
!macroend
