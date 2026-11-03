# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

root = Path(globals().get("SPECPATH", "."))
version = (root / "version.txt").read_text(encoding="utf-8").strip()

datas = [
    (str(root / "web"), "web"),
    (str(root / "locales"), "locales"),
    (str(root / "version.txt"), "."),
    (str(root / "logo.icns"), "."),
    (str(root / "THIRD_PARTY_NOTICES.md"), "."),
]
binaries = []
hiddenimports = ["macos_menu", "updater_macos"]
for package in ("webview", "pillow_heif", "rawpy", "imageio_ffmpeg"):
    data, binary, hidden = collect_all(package)
    datas += data
    binaries += binary
    hiddenimports += hidden

a = Analysis(
    [str(root / "main.py")],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Haven", debug=False, strip=False, upx=False, console=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="Haven")
app = BUNDLE(
    coll,
    name="Haven.app",
    icon=str(root / "logo.icns"),
    bundle_identifier="io.github.christo112233.haven",
    version=version,
    info_plist={
        "CFBundleDisplayName": "Haven",
        "CFBundleName": "Haven",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version.replace(".", ""),
        "LSMinimumSystemVersion": "11.0",
        "LSApplicationCategoryType": "public.app-category.photography",
        "NSHighResolutionCapable": True,
        "NSPrincipalClass": "NSApplication",
        "NSHumanReadableCopyright": "MIT License",
    },
)
