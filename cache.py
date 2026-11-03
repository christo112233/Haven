import ctypes
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import uuid

import i18n
from config import CACHE_NAME, CACHE_VERSION

# Absolute paths must never be persisted in the shared scan index: the same
# photo directory can be mounted at a different path on another platform.
VOLATILE_FIELDS = ("path", "live_path", "stack_members", "_root_id", "_rel_path")


def signature(stat):
    """Platform-neutral cache signature (whole-second mtime + size).

    Network filesystems expose timestamps with different precision on Windows
    and macOS; nanosecond sums make each platform invalidate the other's cache.
    """
    return f"{int(stat.st_mtime)}:{stat.st_size}"


def atomic_json(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as stream:
        temp = Path(stream.name)
        json.dump(value, stream, ensure_ascii=False)
    try:
        replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def replace(source, destination):
    for attempt in range(6):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(.025 * (attempt + 1))


def atomic_bytes(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(value)
    try:
        replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def directory(folder, create=True):
    target = Path(folder) / CACHE_NAME
    marker = target / "owner.json"
    if create:
        if not target.exists():
            # Publish a complete cache directory atomically across threads/processes.
            # mkdtemp uses mode 0o700, which disables ACL inheritance on Windows.
            staging = Path(folder) / f".Haven-init-{uuid.uuid4().hex}"
            staging.mkdir()
            try:
                atomic_json(staging / "owner.json", {"app": "Haven"})
                (staging / "thumbs").mkdir()
                (staging / "previews").mkdir()
                try:
                    staging.rename(target)
                except OSError:
                    if not target.exists():
                        raise
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        if target.is_symlink() or (target.exists() and read_json(marker) != {"app": "Haven"}):
            raise PermissionError(i18n.tr("backend.error.cache-not-haven"))
        for name in ("thumbs", "previews"):
            child = target / name
            if child.is_symlink():
                raise PermissionError(i18n.tr("backend.error.cache-symlink"))
            child.mkdir(exist_ok=True)
        if os.name == "nt":
            attributes = ctypes.windll.kernel32.GetFileAttributesW(str(target))
            if attributes != 0xFFFFFFFF:
                ctypes.windll.kernel32.SetFileAttributesW(str(target), attributes & ~2)
    return target


def load(folder):
    data = read_json(directory(folder, False) / "index.json", {})
    return data.get("files", {}) if isinstance(data, dict) and data.get("version") == CACHE_VERSION else {}


def save(folder, files):
    portable = {
        name: {key: value for key, value in item.items() if key not in VOLATILE_FIELDS}
        for name, item in files.items()
    }
    atomic_json(directory(folder) / "index.json", {"version": CACHE_VERSION, "files": portable})


def clean(folder):
    target = directory(folder, False)
    if not target.exists():
        return
    if target.is_symlink() or read_json(target / "owner.json") != {"app": "Haven"}:
        raise PermissionError(i18n.tr("backend.error.cache-clean-refused"))
    shutil.rmtree(target)
