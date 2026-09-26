import hashlib
import json
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import VERSION, REPOSITORY
from updater_src.updater import OWNED

root = Path(__file__).resolve().parents[1]
if (root / "version.txt").read_text().strip() != VERSION:
    raise SystemExit("version.txt must match config.VERSION")
tag = f"v{VERSION}"
if len(sys.argv) > 1 and sys.argv[1] != tag:
    raise SystemExit(f"Tag must match config.VERSION: {tag}")
folder = root / "dist" / "Haven"
package = root / "dist" / "Haven-win64.zip"
with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in folder.rglob("*"):
        relative = file.relative_to(folder)
        if relative.parts[0] not in OWNED:
            continue
        if file.is_symlink():
            raise SystemExit(f"Release files cannot be symlinks: {relative}")
        if file.is_file():
            archive.write(file, file.relative_to(folder))
with package.open("rb") as stream:
    sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
manifest = {"version": VERSION, "url": f"https://github.com/{REPOSITORY}/releases/download/{tag}/Haven-win64.zip", "sha256": sha256, "size": package.stat().st_size, "mandatory": False, "notes": "Haven 本地照片与视频管理工具。更新详情请参阅 GitHub Releases。"}
(root / "dist" / "update.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(package)
