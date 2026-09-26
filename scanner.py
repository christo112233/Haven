import os
from pathlib import Path

import cache
from config import IMAGES, RAW, HEIC, VIDEOS, SKIP


def visible(entry):
    if entry.name.lower() in SKIP or entry.is_symlink():
        return False
    try:
        return not (getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0) & 6)
    except OSError:
        return False


def media_count(folder):
    """Count the photos and videos stored directly in a folder."""
    count = 0
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if visible(entry) and Path(entry.name).suffix.lower() in IMAGES | VIDEOS:
                    count += 1
    except OSError:
        pass
    return count


def children(folder):
    """Describe a folder for the sidebar tree: its own media count and its subfolders."""
    results = []
    with os.scandir(folder) as entries:
        for entry in entries:
            if entry.is_dir(follow_symlinks=False) and visible(entry):
                results.append({"name": entry.name, "path": entry.path, "count": media_count(entry.path)})
    return {
        "path": str(folder),
        "count": media_count(folder),
        "children": sorted(results, key=lambda item: item["name"].casefold()),
    }


def scan(folder, recursive=False):
    items, warnings = [], []
    stack = [Path(folder)]
    while stack:
        current = stack.pop()
        old = cache.load(current)
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if not visible(entry):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if recursive:
                            stack.append(Path(entry.path))
                        continue
                    ext = Path(entry.name).suffix.lower()
                    if ext not in IMAGES | VIDEOS:
                        continue
                    stat = entry.stat()
                    signature = f"{stat.st_mtime_ns}:{stat.st_size}"
                    prior = old.get(entry.name, {})
                    item = dict(prior) if prior.get("signature") == signature else {}
                    item.update(path=entry.path, name=entry.name, ext=ext, size=stat.st_size,
                                mtime=stat.st_mtime, signature=signature,
                                kind="video" if ext in VIDEOS else "raw" if ext in RAW else "heic" if ext in HEIC else "image")
                    item.setdefault("date", stat.st_mtime)
                    item.setdefault("width", 0)
                    item.setdefault("height", 0)
                    companion = current / (Path(entry.name).stem + ".mov")
                    if ext in IMAGES:
                        # iPhone sidecar pairs are matched case-insensitively below.
                        item["live_path"] = str(companion) if companion.is_file() else None
                    items.append(item)
        except OSError as exc:
            warnings.append(f"{current}: {exc}")
    by_stem = {(str(Path(i["path"]).parent).casefold(), Path(i["name"]).stem.casefold()): i["path"] for i in items if i["ext"] in {".mov", ".mp4"}}
    for item in items:
        if item["kind"] != "video":
            item["live_path"] = by_stem.get((str(Path(item["path"]).parent).casefold(), Path(item["name"]).stem.casefold()))
    return items, warnings
