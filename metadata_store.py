"""SQLite-backed photo metadata that never touches the original media files.

Annotations are keyed by a portable identity — ``root_id + relative path`` — so
the same shared library database can be read and written from Windows and macOS
even though each platform mounts the photo directories at a different absolute
path. The absolute ``path`` column is only a per-machine convenience updated
during scans; it is never used as an identity.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import i18n
import library

COLORS = {"red", "yellow", "green", "blue", "purple"}
_TAG_SPACE = re.compile(r"\s+")
SCHEMA_VERSION = 2


def normalize_path(path: str | os.PathLike) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def clean_tag(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError(i18n.tr("backend.error.tag-text"))
    value = _TAG_SPACE.sub(" ", value.strip())
    if not value:
        raise ValueError(i18n.tr("backend.error.tag-empty"))
    if len(value) > 64:
        raise ValueError(i18n.tr("backend.error.tag-too-long"))
    return value


class _FileLock:
    """Best-effort cross-process lock for libraries on network shares."""

    def __init__(self, path, timeout=10.0, stale=30.0):
        self.path = Path(path)
        self.timeout = timeout
        self.stale = stale
        self.owned = False

    def __enter__(self):
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                try:
                    age = time.time() - self.path.stat().st_mtime
                except OSError:
                    age = 0
                if age > self.stale:
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(i18n.tr("backend.error.database-busy"))
                time.sleep(0.05)
                continue
            try:
                os.write(descriptor, json.dumps({"pid": os.getpid(), "time": time.time()}).encode("utf-8"))
            finally:
                os.close(descriptor)
            self.owned = True
            return self

    def __exit__(self, *_):
        if self.owned:
            try:
                self.path.unlink()
            except OSError:
                pass


class MetadataStore:
    def __init__(self, path, roots=None, root_ids=None, shared=False):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._local = threading.local()
        self._connections = set()
        self._shared = bool(shared)
        self._file_lock = Path(str(self.path) + ".lock") if self._shared else None
        self._roots = []
        self._root_ids = {}
        self._root_paths = {}
        self.set_roots(roots or [], root_ids or {})
        self._legacy = False
        self.migration_report = None
        self._initialize()
        self._migrate()

    # -- connections -----------------------------------------------------

    def _connection(self):
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=10000")
            self._local.connection = connection
            self._connections.add(connection)
        return connection

    def close(self):
        with self._lock:
            for connection in list(self._connections):
                connection.close()
            self._connections.clear()
            self._local.connection = None

    @contextmanager
    def _writing(self):
        with self._lock:
            if self._file_lock:
                with _FileLock(self._file_lock):
                    yield
            else:
                yield

    # -- schema and migration -------------------------------------------

    @staticmethod
    def _columns(connection, table):
        return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}

    def _initialize(self):
        with self._lock:
            connection = self._connection()
            if self._shared:
                connection.execute("PRAGMA journal_mode=DELETE")
            else:
                connection.execute("PRAGMA journal_mode=WAL")
            tables = {row["name"] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self._legacy = "photos" in tables and "root_id" not in self._columns(connection, "photos")
            if not self._legacy:
                self._create_schema(connection)
                connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            connection.commit()

    @staticmethod
    def _create_schema(connection):
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS photos (
                id INTEGER PRIMARY KEY,
                root_id TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                path TEXT,
                size INTEGER NOT NULL DEFAULT 0,
                mtime_ns INTEGER NOT NULL DEFAULT 0,
                rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
                favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
                flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
                rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected IN (0, 1)),
                color_label TEXT CHECK (color_label IS NULL OR color_label IN ('red','yellow','green','blue','purple')),
                missing_since REAL,
                UNIQUE(root_id, rel_path)
            );
            CREATE INDEX IF NOT EXISTS idx_photos_identity ON photos(root_id, rel_path);
            CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating);
            CREATE INDEX IF NOT EXISTS idx_photos_color ON photos(color_label);
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE
            );
            CREATE TABLE IF NOT EXISTS photo_tags (
                photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY(photo_id, tag_id)
            );
            CREATE INDEX IF NOT EXISTS idx_photo_tags_tag ON photo_tags(tag_id);
            CREATE TABLE IF NOT EXISTS smart_albums (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                definition TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS legacy_unmatched (
                id INTEGER PRIMARY KEY,
                path TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            """
        )

    def _migrate(self):
        """Rewrite a pre-library database (absolute path + inode keys) in place."""
        if not self._legacy:
            return
        connection = self._connection()
        rows = [dict(row) for row in connection.execute("SELECT * FROM photos")]
        with self._writing():
            connection.execute("PRAGMA foreign_keys=OFF")
            with connection:
                connection.execute("ALTER TABLE photos RENAME TO photos_legacy")
                self._create_schema(connection)
                matched = unmatched = 0
                for row in rows:
                    identity = self._identity_from_path(row.get("path") or "")
                    if identity is None:
                        connection.execute(
                            "INSERT INTO legacy_unmatched(path,payload) VALUES(?,?)",
                            (row.get("path") or "", json.dumps(row, ensure_ascii=False, default=str)),
                        )
                        unmatched += 1
                        continue
                    root_id, rel_path = identity
                    connection.execute(
                        """INSERT INTO photos(id,root_id,rel_path,path,size,mtime_ns,rating,favorite,flagged,rejected,color_label,missing_since)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            row["id"], root_id, rel_path, normalize_path(row.get("path") or ""),
                            row.get("size", 0), row.get("mtime_ns", 0), row.get("rating"),
                            row.get("favorite", 0), row.get("flagged", 0), row.get("rejected", 0),
                            row.get("color_label"), row.get("missing_since"),
                        ),
                    )
                    matched += 1
                connection.execute("DROP TABLE photos_legacy")
                connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.commit()
        self._legacy = False
        self.migration_report = {"matched": matched, "unmatched": unmatched}

    # -- root mapping ----------------------------------------------------

    def set_roots(self, roots, root_ids):
        self._roots = []
        for root in roots:
            try:
                self._roots.append(str(Path(root).resolve()))
            except OSError:
                self._roots.append(os.path.abspath(os.fspath(root)))
        self._root_ids = {}
        for key, value in (root_ids or {}).items():
            try:
                self._root_ids[str(Path(key).resolve())] = str(value)
            except OSError:
                self._root_ids[os.path.abspath(os.fspath(key))] = str(value)
        self._root_paths = {value: key for key, value in self._root_ids.items()}

    def _identity_from_path(self, path):
        root = library.root_for(path, self._roots)
        if root is None:
            return None
        rel_path = library.relative_path(root, path)
        if rel_path is None:
            return None
        root_id = self._root_ids.get(str(root))
        if not root_id:
            # Deterministic fallback for a root that could not be registered
            # (for example read-only media). Local only, not portable.
            root_id = "local-" + hashlib.sha1(str(root).encode("utf-8")).hexdigest()[:16]
        return root_id, rel_path

    def identity(self, path):
        """Return the portable ``(root_id, relative_path)`` for a path."""
        return self._identity_from_path(path)

    # -- row helpers -----------------------------------------------------

    def _rows_for_identities(self, connection, identities):
        rows = {}
        unique = list(dict.fromkeys(identities))
        for start in range(0, len(unique), 200):
            chunk = unique[start:start + 200]
            placeholders = ",".join("(?,?)" for _ in chunk)
            parameters = [value for identity in chunk for value in identity]
            for row in connection.execute(
                f"SELECT * FROM photos WHERE (root_id, rel_path) IN ({placeholders})", parameters
            ):
                rows[(row["root_id"], row["rel_path"])] = row
        return rows

    def _metadata_map(self, identities):
        if not identities:
            return {}
        connection = self._connection()
        with self._lock:
            rows = self._rows_for_identities(connection, identities)
            tags = {}
            by_id = {row["id"]: row for row in rows.values()}
            if by_id:
                marks = ",".join("?" for _ in by_id)
                for row in connection.execute(
                    f"SELECT photo_id,name FROM photo_tags JOIN tags ON tags.id=tag_id WHERE photo_id IN ({marks})",
                    list(by_id),
                ):
                    tags.setdefault(row["photo_id"], []).append(row["name"])
        return {
            identity: self._metadata(row, sorted(tags.get(row["id"], []), key=str.casefold))
            for identity, row in rows.items()
        }

    @staticmethod
    def _metadata(row, tags):
        if not row:
            return {"tags": [], "rating": None, "favorite": False, "flagged": False, "rejected": False, "color_label": None}
        return {
            "tags": tags,
            "rating": row["rating"],
            "favorite": bool(row["favorite"]),
            "flagged": bool(row["flagged"]),
            "rejected": bool(row["rejected"]),
            "color_label": row["color_label"],
        }

    # -- scanning --------------------------------------------------------

    def reconcile(self, items):
        """Upsert scanned files by portable identity, preserving annotations."""
        connection = self._connection()
        with self._writing(), connection:
            for item in items:
                identity = self._identity_from_path(item.get("path") or "")
                if identity is None:
                    item["file_key"] = None
                    continue
                root_id, rel_path = identity
                try:
                    stat = os.stat(item["path"])
                except OSError:
                    continue
                item["_root_id"] = root_id
                item["_rel_path"] = rel_path
                item["file_key"] = f"{root_id}:{rel_path}"
                old = connection.execute("SELECT id FROM photos WHERE root_id=? AND rel_path=?", (root_id, rel_path)).fetchone()
                if old:
                    connection.execute(
                        "UPDATE photos SET path=?,size=?,mtime_ns=?,missing_since=NULL WHERE id=?",
                        (normalize_path(item["path"]), stat.st_size, stat.st_mtime_ns, old["id"]),
                    )
                else:
                    connection.execute(
                        "INSERT OR IGNORE INTO photos(root_id,rel_path,path,size,mtime_ns,missing_since) VALUES(?,?,?,?,?,NULL)",
                        (root_id, rel_path, normalize_path(item["path"]), stat.st_size, stat.st_mtime_ns),
                    )
        return self.metadata_for_paths([item.get("path") for item in items if item.get("file_key")])

    def metadata_for_paths(self, paths):
        """Return metadata keyed by the requested (per-machine) paths."""
        identity_by_path = {}
        identities = []
        for path in paths:
            identity = self._identity_from_path(path)
            if identity is None:
                continue
            identity_by_path[normalize_path(path)] = identity
            identities.append(identity)
        values = self._metadata_map(identities)
        result = {}
        for path, identity in identity_by_path.items():
            result[path] = values.get(identity, self._metadata(None, []))
        return result

    def enrich(self, items):
        values = self.metadata_for_paths([item["path"] for item in items])
        for item in items:
            item.update(values.get(normalize_path(item["path"]), self._metadata(None, [])))
        return items

    # -- annotation updates ---------------------------------------------

    def _identities_for_paths(self, paths):
        identities = []
        seen = set()
        for path in paths:
            identity = self._identity_from_path(path)
            if identity is None or identity in seen:
                continue
            seen.add(identity)
            identities.append(identity)
        return identities

    def update(self, paths, patch):
        identities = self._identities_for_paths(paths)
        if not identities:
            return {"count": 0, "metadata": {}}
        unknown = set(patch) - {"tags_add", "tags_remove", "rating", "favorite", "flagged", "rejected", "color_label"}
        if unknown:
            raise ValueError(i18n.tr("backend.error.metadata-fields", fields=", ".join(sorted(unknown))))
        rating = patch.get("rating", "__missing__")
        if rating != "__missing__" and rating is not None and (not isinstance(rating, int) or not 1 <= rating <= 5):
            raise ValueError(i18n.tr("backend.error.rating-range"))
        color = patch.get("color_label", "__missing__")
        if color != "__missing__" and color is not None and color not in COLORS:
            raise ValueError(i18n.tr("backend.error.color-label"))
        for key in ("favorite", "flagged", "rejected"):
            if key in patch and not isinstance(patch[key], bool):
                raise ValueError(i18n.tr("backend.error.boolean-field", field=key))
        adds = [clean_tag(value) for value in patch.get("tags_add", [])]
        removes = [clean_tag(value) for value in patch.get("tags_remove", [])]
        connection = self._connection()
        with self._writing(), connection:
            rows = self._rows_for_identities(connection, identities)
            ids = [row["id"] for row in rows.values()]
            if not ids:
                return {"count": 0, "metadata": {}}
            set_values, values = [], []
            for key in ("rating", "favorite", "flagged", "rejected", "color_label"):
                if key in patch:
                    set_values.append(f"{key}=?")
                    values.append(None if patch[key] is None else int(patch[key]) if key in {"favorite", "flagged", "rejected"} else patch[key])
            if patch.get("flagged") is True:
                set_values.append("rejected=0")
            if patch.get("rejected") is True:
                set_values.append("flagged=0")
            if set_values:
                connection.execute(f"UPDATE photos SET {','.join(set_values)} WHERE id IN ({','.join('?' for _ in ids)})", (*values, *ids))
            for tag in adds:
                connection.execute("INSERT OR IGNORE INTO tags(name) VALUES(?)", (tag,))
                tag_id = connection.execute("SELECT id FROM tags WHERE name=? COLLATE NOCASE", (tag,)).fetchone()["id"]
                connection.executemany("INSERT OR IGNORE INTO photo_tags(photo_id,tag_id) VALUES(?,?)", [(photo_id, tag_id) for photo_id in ids])
            if removes:
                marks = ",".join("?" for _ in removes)
                tag_ids = [row["id"] for row in connection.execute(f"SELECT id FROM tags WHERE name IN ({marks}) COLLATE NOCASE", removes).fetchall()]
                if tag_ids:
                    connection.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({','.join('?' for _ in ids)}) AND tag_id IN ({','.join('?' for _ in tag_ids)})", (*ids, *tag_ids))
        return {"count": len(ids), "metadata": self.metadata_for_paths(paths)}

    # -- moves, renames and deletions ------------------------------------

    def move_identity(self, old_identity, new_identity):
        """Move an annotation row to a new portable identity."""
        connection = self._connection()
        with self._writing(), connection:
            if new_identity is None:
                connection.execute("DELETE FROM photos WHERE root_id=? AND rel_path=?", old_identity)
            elif new_identity == old_identity:
                return
            else:
                connection.execute(
                    "UPDATE photos SET root_id=?,rel_path=?,path=NULL WHERE root_id=? AND rel_path=?",
                    (*new_identity, *old_identity),
                )

    def move_path(self, old, new):
        old_identity = self._identity_from_path(old)
        if old_identity is None:
            return
        new_identity = self._identity_from_path(new)
        self.move_identity(old_identity, new_identity)

    def rename_prefix(self, root_id, old_relative, new_relative):
        """Rewrite every row under a renamed directory inside one root."""
        old_relative = library.normalize_relative(old_relative)
        new_relative = library.normalize_relative(new_relative)
        connection = self._connection()
        pattern = (old_relative + "/%") if old_relative else "%"
        with self._writing(), connection:
            rows = connection.execute(
                "SELECT id,rel_path FROM photos WHERE root_id=? AND (rel_path=? OR rel_path LIKE ?)",
                (root_id, old_relative, pattern),
            ).fetchall()
            for row in rows:
                tail = row["rel_path"][len(old_relative):].lstrip("/") if old_relative else row["rel_path"]
                new_path = "/".join(part for part in (new_relative, tail) if part)
                connection.execute("UPDATE photos SET rel_path=?,path=NULL WHERE id=?", (new_path, row["id"]))

    def remove_identity(self, identity):
        connection = self._connection()
        with self._writing(), connection:
            connection.execute("DELETE FROM photos WHERE root_id=? AND rel_path=?", identity)

    def remove_path(self, path):
        identity = self._identity_from_path(path)
        if identity is not None:
            self.remove_identity(identity)

    def rejected_identities(self):
        connection = self._connection()
        with self._lock:
            return [
                (row["root_id"], row["rel_path"])
                for row in connection.execute("SELECT root_id,rel_path FROM photos WHERE rejected=1").fetchall()
            ]

    def rejected_paths(self):
        """Resolve rejected rows to paths on this machine, skipping absent roots."""
        paths = []
        for root_id, rel_path in self.rejected_identities():
            root = self._root_paths.get(root_id)
            if not root:
                continue
            paths.append(str(library.absolute_path(root, rel_path)))
        return paths

    # -- tags and smart albums ------------------------------------------

    def list_tags(self):
        connection = self._connection()
        return [dict(row) for row in connection.execute("SELECT tags.name, COUNT(photo_tags.photo_id) AS count FROM tags LEFT JOIN photo_tags ON photo_tags.tag_id=tags.id GROUP BY tags.id ORDER BY tags.name COLLATE NOCASE").fetchall()]

    def smart_albums(self):
        connection = self._connection()
        with self._lock:
            return [dict(row) | {"definition": json.loads(row["definition"])} for row in connection.execute("SELECT * FROM smart_albums ORDER BY name COLLATE NOCASE").fetchall()]

    def get_smart_album(self, album_id):
        row = self._connection().execute("SELECT * FROM smart_albums WHERE id=?", (int(album_id),)).fetchone()
        if not row:
            raise ValueError(i18n.tr("backend.error.smart-album-missing"))
        return dict(row) | {"definition": json.loads(row["definition"])}

    def save_smart_album(self, name, definition, album_id=None):
        name = clean_tag(name)
        if not isinstance(definition, dict) or definition.get("logic", "and").lower() not in {"and", "or"} or not isinstance(definition.get("conditions", []), list):
            raise ValueError(i18n.tr("backend.error.smart-album-definition"))
        allowed = {"tags", "rating", "color_label", "favorite", "flagged", "rejected"}
        operators = {"tags": {"contains", "not_contains", "="}, "rating": {"=", ">=", "<=", "is_empty"}, "color_label": {"="}, "favorite": {"="}, "flagged": {"="}, "rejected": {"="}}
        for condition in definition["conditions"]:
            if not isinstance(condition, dict) or condition.get("field") not in allowed or condition.get("operator") not in operators[condition["field"]]:
                raise ValueError(i18n.tr("backend.error.smart-album-definition"))
            field, value = condition["field"], condition.get("value")
            if field == "rating" and condition["operator"] != "is_empty" and (value != "unrated" and (not isinstance(value, int) or not 1 <= value <= 5)):
                raise ValueError(i18n.tr("backend.error.smart-album-rating"))
            if field == "color_label" and value not in COLORS:
                raise ValueError(i18n.tr("backend.error.smart-album-color"))
            if field == "tags":
                clean_tag(value)
        encoded = json.dumps(definition, ensure_ascii=False, separators=(",", ":"))
        now = time.time()
        connection = self._connection()
        with self._writing(), connection:
            if album_id is None:
                cursor = connection.execute("INSERT INTO smart_albums(name,definition,created_at,updated_at) VALUES(?,?,?,?)", (name, encoded, now, now))
                album_id = cursor.lastrowid
            else:
                connection.execute("UPDATE smart_albums SET name=?,definition=?,updated_at=? WHERE id=?", (name, encoded, now, int(album_id)))
        return next(album for album in self.smart_albums() if album["id"] == album_id)

    def delete_smart_album(self, album_id):
        connection = self._connection()
        with self._writing(), connection:
            connection.execute("DELETE FROM smart_albums WHERE id=?", (int(album_id),))
