#!/usr/bin/env bash
# Build an ad-hoc signed macOS arm64 Haven.app and a ditto zip suitable for
# GitHub Releases (symlinks preserved). No Apple Developer account is required;
# users approve the first launch via 系统设置 → 隐私与安全性 → 仍要打开.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${PYTHON:-}" ]; then
  if [ -x .venv/bin/python ]; then PYTHON=.venv/bin/python; else PYTHON=python3; fi
fi
# Keep PyInstaller's cache inside the repo so builds work in sandboxes and
# don't touch ~/Library/Application Support.
export PYINSTALLER_CONFIG_DIR="${PYINSTALLER_CONFIG_DIR:-$PWD/.qa/pyinstaller}"
APP="dist/Haven.app"
ZIP="dist/Haven-mac-arm64.zip"

"$PYTHON" -m PyInstaller --noconfirm build-mac.spec

ARCHS="$(lipo -archs "$APP/Contents/MacOS/Haven")"
if [ "$ARCHS" != "arm64" ]; then
  echo "Expected arm64 build, got: $ARCHS" >&2
  exit 1
fi
codesign --verify --deep --strict "$APP"
echo "Signature:"
codesign -dv "$APP" 2>&1 | sed -n '1,6p'

rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "Built $APP ($ARCHS)"
echo "Release zip: $ZIP"

DMG="dist/Haven-mac-arm64.dmg"
if "$PYTHON" -c "import dmgbuild" >/dev/null 2>&1; then
  rm -f "$DMG"
  "$PYTHON" scripts/build_dmg.py --app "$APP" --output "$DMG" --version "$(cat version.txt)"
  /usr/bin/hdiutil verify "$DMG" >/dev/null
  echo "Installer dmg: $DMG"
else
  echo "dmgbuild 未安装，跳过 DMG；安装：$PYTHON -m pip install -r requirements-build.txt" >&2
fi
