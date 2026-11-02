"""Portable photo-library identity.

User annotations live in one SQLite database per library. The library directory
is user-selectable: by default it sits in the per-user data directory, but it
can point at a shared location (for example a NAS folder) so Windows and macOS
read and write the same annotations.

A photo is identified portably by ``root_id + relative POSIX path``. The
``root_id`` is persisted inside ``<photo root>/.Haven/library.json`` so both
platforms agree on it regardless of how the share is mounted (``Z:\\Photos`` on
Windows versus ``/Volumes/Photos`` on macOS). Relative paths and Unicode NFC
normalization make the identity stable across filesystems.

Files written to a photo root are small and land in the existing hidden
``.Haven`` cache directory. Read-only roots still work locally, but their
annotations cannot be matched across machines.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
import unicodedata
import uuid
from pathlib import Path, PurePosixPath

import cache
import config

MARKER_NAME = "library.json"
DATABASE_NAME = "library.sqlite3"
BACKUP_DIRECTORY = "backups"


def normalize_relative(value):
    """Normalize a path to NFC POSIX form for use as a portable identity."""
    text = unicodedata.normalize("NFC", str(value).replace("\\", "/"))
    parts = [part for part in PurePosixPath(text).parts if part not in ("", ".", "/")]
    return "/".join(parts)


def relative_path(root, path):
    """Return the portable path of ``path`` inside ``root``, or None."""
    try:
        # Resolve both sides so mounts with symlinked prefixes (macOS /var vs
        # /private/var, Linux bind mounts) map onto the same portable path.
        relative = Path(path).resolve().relative_to(Path(root).resolve())
    except (ValueError, OSError):
        return None
    return normalize_relative(relative.as_posix())


def absolute_path(root, relative):
    parts = [part for part in str(relative).split("/") if part]
    return Path(root).joinpath(*parts)


def root_for(path, roots):
    """Pick the configured root that contains ``path`` (longest match wins)."""
    try:
        target = Path(path).resolve()
    except OSError:
        return None
    best = None
    for root in roots:
        try:
            candidate = Path(root).resolve()
            target.relative_to(candidate)
        except (ValueError, OSError):
            continue
        if best is None or len(str(candidate)) > len(str(best)):
            best = candidate
    return best


def _read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cache.atomic_json(path, value)


def root_marker(root):
    """Read the per-root identity marker without creating anything."""
    return _read_json(Path(root) / config.CACHE_NAME / MARKER_NAME)


def _repair_cache_directory(root):
    """Adopt a .Haven directory that only contains our root marker.

    Earlier builds could create ``.Haven/library.json`` before the cache owner
    marker existed; the cache then rejected the directory as foreign. Only an
    effectively empty directory (or one holding just library.json) is adopted,
    so a .Haven created by another application is never touched.
    """
    target = Path(root) / config.CACHE_NAME
    try:
        if target.is_symlink() or not target.is_dir() or (target / "owner.json").exists():
            return
        entries = {entry.name for entry in target.iterdir()}
        if entries - {MARKER_NAME}:
            return
        cache.atomic_json(target / "owner.json", {"app": "Haven"})
        for name in ("thumbs", "previews"):
            (target / name).mkdir(exist_ok=True)
    except OSError:
        return


def ensure_root_marker(root, library_id, name=None):
    """Create or read ``<root>/.Haven/library.json``.

    Returns the marker dict, or None when the root is not writable (read-only
    media, unavailable share). A missing marker means the root cannot share its
    annotations with another machine.
    """
    root = Path(root)
    _repair_cache_directory(root)
    # Make sure .Haven is a valid Haven cache directory (owner marker, thumbs and
    # previews) before adding the root marker; otherwise later cache writes are
    # rejected as a foreign .Haven directory.
    try:
        cache_dir = cache.directory(root)
    except OSError:
        return None
    marker_path = cache_dir / MARKER_NAME
    existing = _read_json(marker_path)
    if existing and existing.get("root_id"):
        updated = dict(existing)
        updated.setdefault("app", "Haven")
        updated.setdefault("name", name or root.name)
        if updated.get("library_id") != library_id:
            # A single-library app treats its configured library as
            # authoritative; the stable root_id is preserved.
            updated["library_id"] = library_id
        if updated != existing:
            try:
                _write_json(marker_path, updated)
            except OSError:
                pass
        return updated
    marker = {
        "app": "Haven",
        "library_id": library_id,
        "root_id": uuid.uuid4().hex,
        "name": name or root.name,
    }
    try:
        marker_path.parent.mkdir(parents=True, exist_ok=True)
        _write_json(marker_path, marker)
    except OSError:
        return None
    return marker


def ensure_library(directory):
    """Create or open a library directory and return its metadata."""
    directory = Path(directory)
    library_file = directory / MARKER_NAME
    existing = _read_json(library_file)
    if existing and existing.get("library_id"):
        return {
            "directory": directory,
            "library_id": existing["library_id"],
            "created": False,
        }
    directory.mkdir(parents=True, exist_ok=True)
    library = {"app": "Haven", "library_id": uuid.uuid4().hex, "created_at": time.time()}
    _write_json(library_file, library)
    return {"directory": directory, "library_id": library["library_id"], "created": True}


def database_path(directory):
    return Path(directory) / DATABASE_NAME


def backups_path(directory):
    return Path(directory) / BACKUP_DIRECTORY


def is_shared_location(directory, data_dir=None):
    """True when the library directory lives outside Haven's local data dir."""
    try:
        Path(directory).resolve().relative_to(Path(data_dir or config.DATA_DIR).resolve())
        return False
    except ValueError:
        return True


def adopt_database(source, destination):
    """Copy a legacy local database into an empty library via SQLite backup."""
    source, destination = Path(source), Path(destination)
    if not source.is_file() or destination.exists():
        return False
    if source.resolve() == destination.resolve():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    origin = sqlite3.connect(source)
    target = sqlite3.connect(destination)
    try:
        origin.backup(target)
    finally:
        target.close()
        origin.close()
    return True


def maybe_backup(db_path, directory, interval=86400, keep=14):
    """Snapshot the annotation database at most once per ``interval`` seconds."""
    db_path = Path(db_path)
    if not db_path.is_file():
        return None
    backups = backups_path(directory)
    try:
        backups.mkdir(parents=True, exist_ok=True)
        snapshots = sorted(backups.glob("library-*.sqlite3"))
        latest = max((snapshot.stat().st_mtime for snapshot in snapshots), default=0)
    except OSError:
        return None
    if time.time() - latest < interval:
        return None
    target = backups / f"library-{time.strftime('%Y%m%d-%H%M%S')}.sqlite3"
    if target.exists():
        return None
    temporary = target.with_suffix(".tmp")
    try:
        shutil.copy2(db_path, temporary)
        os.replace(temporary, target)
        for snapshot in snapshots[:-keep] if len(snapshots) >= keep else []:
            snapshot.unlink(missing_ok=True)
    except OSError:
        temporary.unlink(missing_ok=True)
        return None
    return target
