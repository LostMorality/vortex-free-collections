; VortexFree Collections Patch - Inno Setup installer
;
; Patches an installed Vortex 2.9.1 so FREE Nexus accounts get hands-off collection downloads
; (the behaviour Nexus sells as Premium "Auto-download all"). It swaps the renderer bundle inside
; the app; the signed Vortex.exe is never modified. Fully reversible via the uninstaller.
;
; The actual file work is done by patch.js, run through the user's own Vortex.exe as Node
; (ELECTRON_RUN_AS_NODE=1), so this installer ships no Node runtime and no npm dependencies.

#define MyName "Vortex Free Collections Patch"
#define MyVersion "1.1.0"
#define TargetVortex "2.9.1"

[Setup]
AppId={{B7E6B4B1-9C3E-4E2A-9E7A-VORTEXFREE01}}
AppName={#MyName}
AppVersion={#MyVersion}
AppPublisher=VortexFree
VersionInfoDescription={#MyName}
VersionInfoVersion={#MyVersion}
DefaultDirName={code:GetVortexDir}
DisableDirPage=no
DirExistsWarning=no
AppendDefaultDirName=no
DefaultGroupName={#MyName}
DisableProgramGroupPage=yes
UninstallFilesDir={app}\vortexfree
OutputDir=out
OutputBaseFilename=VortexFreeCollections-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
; support files live in a subfolder of the Vortex install so the uninstaller can revert later
Source: "build\patch.js";    DestDir: "{app}\vortexfree"; Flags: ignoreversion
Source: "build\renderer.js"; DestDir: "{app}\vortexfree"; Flags: ignoreversion
Source: "build\README.txt";  DestDir: "{app}\vortexfree"; Flags: ignoreversion isreadme

[Messages]
WelcomeLabel2=This will patch your Vortex install so collections download automatically on a FREE Nexus account - no per-mod pop-ups, no browser.%n%nIt only changes Vortex's app files (the signed Vortex.exe is untouched) and can be fully undone from Add/Remove Programs.

[Code]
const
  SUPPORTED = '{#TargetVortex}';

{ Pull the first quoted path out of a registry command string like  "C:\x\Vortex.exe" -d "%1" }
function ExtractQuotedPath(const s: String): String;
var
  i, j: Integer;
begin
  Result := '';
  i := Pos('"', s);
  if i > 0 then
  begin
    j := Pos('"', Copy(s, i + 1, Length(s)));
    if j > 0 then
      Result := Copy(s, i + 1, j - 1);
  end
  else
  begin
    j := Pos(' ', s);
    if j > 0 then
      Result := Copy(s, 1, j - 1)
    else
      Result := s;
  end;
end;

{ Given a path to Vortex.exe (or its uninstaller), return the install dir if Vortex.exe is there. }
function DirOfVortexExe(const exePath: String): String;
var
  dir: String;
begin
  Result := '';
  if exePath <> '' then
  begin
    dir := ExtractFileDir(exePath);
    if (dir <> '') and FileExists(AddBackslash(dir) + 'Vortex.exe') then
      Result := RemoveBackslashUnlessRoot(dir);
  end;
end;

{ Most reliable source: every Vortex install registers the nxm:// protocol handler at its own exe. }
function FindVortexFromNxm: String;
var
  cmd: String;
begin
  Result := '';
  if RegQueryStringValue(HKCR, 'nxm\shell\open\command', '', cmd) then
    Result := DirOfVortexExe(ExtractQuotedPath(cmd));
  if Result = '' then
    if RegQueryStringValue(HKCU, 'Software\Classes\nxm\shell\open\command', '', cmd) then
      Result := DirOfVortexExe(ExtractQuotedPath(cmd));
end;

{ Fallback: the uninstall registry entry (InstallLocation, else the UninstallString's folder). }
function FindVortexFromUninstall(RootKey: Integer; const SubKeyBase: String): String;
var
  Keys: TArrayOfString;
  i: Integer;
  dn, loc, uns: String;
begin
  Result := '';
  if RegGetSubkeyNames(RootKey, SubKeyBase, Keys) then
  begin
    for i := 0 to GetArrayLength(Keys) - 1 do
    begin
      if RegQueryStringValue(RootKey, SubKeyBase + '\' + Keys[i], 'DisplayName', dn) then
      begin
        if Pos('Vortex', dn) = 1 then
        begin
          if RegQueryStringValue(RootKey, SubKeyBase + '\' + Keys[i], 'InstallLocation', loc) then
            if (loc <> '') and FileExists(AddBackslash(loc) + 'Vortex.exe') then
            begin
              Result := RemoveBackslashUnlessRoot(loc);
              exit;
            end;
          if RegQueryStringValue(RootKey, SubKeyBase + '\' + Keys[i], 'UninstallString', uns) then
          begin
            Result := DirOfVortexExe(ExtractQuotedPath(uns));
            if Result <> '' then
              exit;
          end;
        end;
      end;
    end;
  end;
end;

function GetVortexDir(Param: String): String;
var
  cand: String;
begin
  cand := FindVortexFromNxm;
  if cand = '' then
    cand := FindVortexFromUninstall(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall');
  if cand = '' then
    cand := FindVortexFromUninstall(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall');
  if cand = '' then
    cand := FindVortexFromUninstall(HKLM, 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall');
  if (cand = '') and FileExists(ExpandConstant('{localappdata}\Programs\Vortex\Vortex.exe')) then
    cand := ExpandConstant('{localappdata}\Programs\Vortex');
  if cand = '' then
    cand := ExpandConstant('{autopf}\Black Tree Gaming Ltd\Vortex');
  Result := cand;
end;

function VortexExe: String;
begin
  Result := AddBackslash(ExpandConstant('{app}')) + 'Vortex.exe';
end;

{ Close a running Vortex so its app.asar isn't locked. }
procedure CloseVortex;
var
  rc: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/c taskkill /im Vortex.exe /f', '', SW_HIDE,
       ewWaitUntilTerminated, rc);
  Sleep(1500);
end;

{ Run patch.js through the user's Vortex.exe as Node; returns the child exit code. }
function RunPatch(const Args: String): Integer;
var
  cmdLine: String;
  rc: Integer;
begin
  cmdLine := '/c set "ELECTRON_RUN_AS_NODE=1" && "' + VortexExe + '" "' +
             AddBackslash(ExpandConstant('{app}')) + 'vortexfree\patch.js" ' + Args;
  if not Exec(ExpandConstant('{cmd}'), cmdLine, '', SW_HIDE, ewWaitUntilTerminated, rc) then
    rc := -1;
  Result := rc;
end;

{ Gate: the selected folder must be a Vortex 2.9.1 install. }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  ver: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    if not FileExists(VortexExe) then
    begin
      MsgBox('No Vortex.exe found in that folder. Please pick your Vortex install folder.',
             mbError, MB_OK);
      Result := False;
      exit;
    end;
    GetVersionNumbersString(VortexExe, ver);
    if Pos(SUPPORTED, ver) <> 1 then
    begin
      if MsgBox('This patch is built for Vortex ' + SUPPORTED + ', but this install is version '
            + ver + '.' + #13#10 + 'Patching a different version may not work.' + #13#10#13#10
            + 'Continue anyway?', mbConfirmation, MB_YESNO) = IDNO then
        Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  rc: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    CloseVortex;
    rc := RunPatch('apply --dir "' + RemoveBackslashUnlessRoot(ExpandConstant('{app}')) +
                   '" --renderer "' + AddBackslash(ExpandConstant('{app}')) +
                   'vortexfree\renderer.js"');
    if rc <> 0 then
      MsgBox('The patch step reported a problem (code ' + IntToStr(rc) + ').' + #13#10 +
             'Vortex was not changed, or only partly. You can re-run this installer, or '
             + 'uninstall it to restore the original.', mbError, MB_OK);
  end;
end;

{ Uninstall: revert the swap (restore the original app.asar). }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  rc: Integer;
  cmdLine: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec(ExpandConstant('{cmd}'), '/c taskkill /im Vortex.exe /f', '', SW_HIDE,
         ewWaitUntilTerminated, rc);
    Sleep(1500);
    cmdLine := '/c set "ELECTRON_RUN_AS_NODE=1" && "' + AddBackslash(ExpandConstant('{app}')) +
               'Vortex.exe" "' + AddBackslash(ExpandConstant('{app}')) +
               'vortexfree\patch.js" revert --dir "' +
               RemoveBackslashUnlessRoot(ExpandConstant('{app}')) + '"';
    Exec(ExpandConstant('{cmd}'), cmdLine, '', SW_HIDE, ewWaitUntilTerminated, rc);
  end;
end;
