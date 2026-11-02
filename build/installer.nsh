LangString DeleteDataPrompt 1033 "Do you want to delete ElectronLark user data?"
LangString DeleteDataPrompt 2052 "卸载时是否删除用户数据？"

!macro customUnInstall
  ; MB_DEFBUTTON2: 默认选中"否"，避免误按回车删除用户数据
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(DeleteDataPrompt)" IDYES delete_data IDNO keep_data
  delete_data:
    RMDir /r "$APPDATA\ElectronLark"
  keep_data:
!macroend
