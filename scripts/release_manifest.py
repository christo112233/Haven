"""Generate the release manifest (update.json) for every built platform.

The combined manifest keeps the legacy Windows fields at the top level so
already-installed Windows builds keep updating, and adds a ``platforms`` map for
the macOS build (and future platforms). Run it after the platform artifacts are
present in ``dist/``: Windows builds zip by invoking it directly, while CI
downloads both artifacts and runs it again to produce the final manifest.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import VERSION, REPOSITORY

WINDOWS_ZIP = "Haven-win64.zip"
MACOS_ZIP = "Haven-mac-arm64.zip"
# Keep in sync with updater_src/updater.py; duplicated so this script has no
# third-party dependency on the CI release runner.
OWNED = {"Haven.exe", "updater.exe", "_internal", "web", "version.txt", "LICENSE", "THIRD_PARTY_NOTICES.md"}

root = Path(__file__).resolve().parents[1]
if (root / "version.txt").read_text().strip() != VERSION:
    raise SystemExit("version.txt must match config.VERSION")
tag = f"v{VERSION}"
if len(sys.argv) > 1 and sys.argv[1] != tag:
    raise SystemExit(f"Tag must match config.VERSION: {tag}")


def rebuild_windows_zip():
    """Older builds created the ZIP from dist/Haven; keep that behaviour."""
    folder = root / "dist" / "Haven"
    package = root / "dist" / WINDOWS_ZIP
    if not folder.is_dir():
        return
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in folder.rglob("*"):
            relative = file.relative_to(folder)
            if relative.parts[0] not in OWNED:
                continue
            if file.is_symlink():
                raise SystemExit(f"Release files cannot be symlinks: {relative}")
            if file.is_file():
                archive.write(file, file.relative_to(folder))


def platform_entry(filename):
    package = root / "dist" / filename
    if not package.is_file():
        return None
    with package.open("rb") as stream:
        sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    return {
        "url": f"https://github.com/{REPOSITORY}/releases/download/{tag}/{filename}",
        "sha256": sha256,
        "size": package.stat().st_size,
    }


rebuild_windows_zip()
windows = platform_entry(WINDOWS_ZIP)
if windows is None:
    raise SystemExit(f"缺少 Windows 发布包：{root / 'dist' / WINDOWS_ZIP}")
macos = platform_entry(MACOS_ZIP)
platforms = {"windows-x64": windows}
if macos is not None:
    platforms["macos-arm64"] = macos
# Release notes are shown inside the update dialog. ``notes`` stays a plain
# string for already-installed clients (which concatenate nothing) and carries
# every language, while ``notesI18n`` lets current clients pick one.
note_zh = "Haven 本地照片与视频管理工具。Windows 支持应用内更新；macOS 请解压后替换 Haven.app。更新详情请参阅 GitHub Releases。"
note_en = "Haven is a local photo and video manager. Windows supports in-app updates; on macOS, unzip and replace Haven.app. See GitHub Releases for details."
note_ja = "Haven はローカル写真・動画管理ツールです。Windows はアプリ内アップデートに対応し、macOS は展開して Haven.app を置き換えてください。詳細は GitHub Releases をご覧ください。"
manifest = {
    "version": VERSION,
    "url": windows["url"],
    "sha256": windows["sha256"],
    "size": windows["size"],
    "mandatory": False,
    "notes": f"{note_zh}\n\n{note_en}\n\n{note_ja}",
    "notesI18n": {"zh-CN": note_zh, "en-US": note_en, "ja-JP": note_ja},
    "platforms": platforms,
}
(root / "dist" / "update.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(root / "dist" / "update.json")
for name, entry in platforms.items():
    print(f"{name}: {entry['size']} bytes")
