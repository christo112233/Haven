$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$python = Join-Path (Get-Location) 'venv\Scripts\python.exe'
if (!(Test-Path $python)) { $python = 'python' }
# PyInstaller reuses its cached EXE when only the icon file changed, which would ship the previous
# logo. Drop the cached executables whenever logo.ico is newer so the icon is embedded again.
$cached = @('build\build\Haven.exe', 'build\updater\updater.exe')
if (Test-Path 'logo.ico') {
    $icon = Get-Item 'logo.ico'
    foreach ($file in $cached) {
        if ((Test-Path $file) -and ($icon.LastWriteTime -gt (Get-Item $file).LastWriteTime)) {
            Remove-Item $file -Force
        }
    }
}
& $python -m PyInstaller --noconfirm build.spec
if ($LASTEXITCODE -ne 0) { throw 'Haven build failed' }
& $python -m PyInstaller --noconfirm --onefile --windowed --icon logo.ico --name updater --distpath dist\helper updater_src\updater.py
if ($LASTEXITCODE -ne 0) { throw 'Updater build failed' }
Copy-Item dist\helper\updater.exe dist\Haven\updater.exe
Copy-Item version.txt dist\Haven\version.txt
Copy-Item THIRD_PARTY_NOTICES.md dist\Haven\THIRD_PARTY_NOTICES.md
& $python scripts\release_manifest.py
if ($LASTEXITCODE -ne 0) { throw 'Release manifest generation failed' }
