; Root Record Business Manager — Inno Setup 6
; Version is passed from scripts/build-installer.cjs: /DAppVersion=...
; If in-place upgrades from an older shipped Inno build fail to detect the same product, replace [Setup] AppId with the GUID from your production installer.iss.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define MyAppName "Root Record Business Manager"
#define MyAppPublisher "Root Record"
#define MyAppExeName "RootRecordBusinessManager.exe"
#define PackagedDir "..\\dist\\RootRecordBusinessManager-win32-x64"

[Setup]
AppId={{B4E8C1A2-9F3D-4E6B-8C7D-1A2B3C4D5E6F}}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\RootRecord\Business Manager
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=Unsigned-{#MyAppName}-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PackagedDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
