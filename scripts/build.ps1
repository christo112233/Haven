$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$python = Join-Path (Get-Location) 'venv\Scripts\python.exe'
if (!(Test-Path $python)) { $python = 'python' }
& $python -m PyInstaller --noconfirm build.spec
if ($LASTEXITCODE -ne 0) { throw 'Haven build failed' }
& $python -m PyInstaller --noconfirm --onefile --windowed --name updater --distpath dist\helper updater_src\updater.py
if ($LASTEXITCODE -ne 0) { throw 'Updater build failed' }
Copy-Item dist\helper\updater.exe dist\Haven\updater.exe
Copy-Item version.txt dist\Haven\version.txt
Copy-Item THIRD_PARTY_NOTICES.md dist\Haven\THIRD_PARTY_NOTICES.md
& $python scripts\release_manifest.py
if ($LASTEXITCODE -ne 0) { throw 'Release manifest generation failed' }
