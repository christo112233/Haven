"""SQLite-backed photo metadata that never touches the original media files."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path


COLORS = {"red", "yellow", "green", "blue", "purple"}
_TAG_SPACE = re.compile(r"\s+")


def normalize_path(path: str | os.PathLike) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def file_key(path: str | os.PathLike, stat: os.stat_result | None = None) -> str:
    """Return a cheap filesystem identity, with a path fallback on limited filesystems."""
    actual = os.fspath(path)
    stat = stat or os.stat(actual)
    device = getattr(stat, "st_dev", 0)
    inode = getattr(stat, "st_ino", 0)
    if device and inode:
        return f"inode:{device}:{inode}"
    return f"path:{normalize_path(actual)}:{stat.st_size}:{stat.st_mtime_ns}"


def clean_tag(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("标签必须是文本")
    value = _TAG_SPACE.sub(" ", value.strip())
    if not value:
        raise ValueError("标签不能为空")
    if len(value) > 64:
        raise ValueError("标签不能超过 64 个字符")
    return value


class MetadataStore:
    def __init__(self, path: str | os.PathLike):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._local = threading.local()
        self._connections = set()
        self._initialize()

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

    def _initialize(self):
        with self._lock:
            connection = self._connection()
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS photos (
                    id INTEGER PRIMARY KEY,
                    file_key TEXT NOT NULL UNIQUE,
                    path TEXT NOT NULL UNIQUE,
                    size INTEGER NOT NULL DEFAULT 0,
                    mtime_ns INTEGER NOT NULL DEFAULT 0,
                    rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
                    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
                    flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
                    rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected IN (0, 1)),
                    color_label TEXT CHECK (color_label IS NULL OR color_label IN ('red','yellow','green','blue','purple')),
                    missing_since REAL
                );
                CREATE INDEX IF NOT EXISTS idx_photos_path ON photos(path);
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
                """
            )
            connection.commit()

    def close(self):
        with self._lock:
            for connection in list(self._connections):
                connection.close()
            self._connections.clear()
            self._local.connection = None

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

    def reconcile(self, items):
        """Upsert scanned files and preserve records when an inode changed path."""
        connection = self._connection()
        now = time.time()
        with self._lock, connection:
            for item in items:
                path = normalize_path(item["path"])
                stat = os.stat(item["path"])
                key = file_key(item["path"], stat)
                old = connection.execute("SELECT id FROM photos WHERE file_key=?", (key,)).fetchone()
                if old:
                    connection.execute("UPDATE photos SET path=?,size=?,mtime_ns=?,missing_since=NULL WHERE id=?", (path, stat.st_size, stat.st_mtime_ns, old["id"]))
                else:
                    connection.execute("INSERT OR IGNORE INTO photos(file_key,path,size,mtime_ns,missing_since) VALUES(?,?,?,?,NULL)", (key, path, stat.st_size, stat.st_mtime_ns))
                item["file_key"] = key
        return self.metadata_for_paths([item["path"] for item in items])

    def metadata_for_paths(self, paths):
        paths = [normalize_path(path) for path in paths]
        if not paths:
            return {}
        connection = self._connection()
        marks = ",".join("?" for _ in paths)
        rows = connection.execute(f"SELECT * FROM photos WHERE path IN ({marks})", paths).fetchall()
        by_id = {row["id"]: row for row in rows}
        tags = {}
        if rows:
            tag_rows = connection.execute(f"SELECT photo_id,name FROM photo_tags JOIN tags ON tags.id=tag_id WHERE photo_id IN ({','.join('?' for _ in rows)})", list(by_id)).fetchall()
            for row in tag_rows:
                tags.setdefault(row["photo_id"], []).append(row["name"])
        return {row["path"]: self._metadata(row, sorted(tags.get(row["id"], []), key=str.casefold)) for row in rows}

    def enrich(self, items):
        values = self.metadata_for_paths([item["path"] for item in items])
        for item in items:
            item.update(values.get(normalize_path(item["path"]), self._metadata(None, [])))
        return items

    def update(self, paths, patch):
        paths = [normalize_path(path) for path in paths]
        if not paths:
            return {"count": 0, "metadata": {}}
        unknown = set(patch) - {"tags_add", "tags_remove", "rating", "favorite", "flagged", "rejected", "color_label"}
        if unknown:
            raise ValueError(f"不支持的元数据字段: {', '.join(sorted(unknown))}")
        rating = patch.get("rating", "__missing__")
        if rating != "__missing__" and rating is not None and (not isinstance(rating, int) or not 1 <= rating <= 5):
            raise ValueError("评分必须是 1 到 5 星，或清除评分")
        color = patch.get("color_label", "__missing__")
        if color != "__missing__" and color is not None and color not in COLORS:
            raise ValueError("颜色标签无效")
        for key in ("favorite", "flagged", "rejected"):
            if key in patch and not isinstance(patch[key], bool):
                raise ValueError(f"{key} 必须是布尔值")
        adds = [clean_tag(value) for value in patch.get("tags_add", [])]
        removes = [clean_tag(value) for value in patch.get("tags_remove", [])]
        connection = self._connection()
        with self._lock, connection:
            rows = connection.execute(f"SELECT id,path FROM photos WHERE path IN ({','.join('?' for _ in paths)})", paths).fetchall()
            ids = [row["id"] for row in rows]
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

    def list_tags(self):
        connection = self._connection()
        return [dict(row) for row in connection.execute("SELECT tags.name, COUNT(photo_tags.photo_id) AS count FROM tags LEFT JOIN photo_tags ON photo_tags.tag_id=tags.id GROUP BY tags.id ORDER BY tags.name COLLATE NOCASE").fetchall()]

    def rejected_paths(self):
        connection = self._connection()
        return [row["path"] for row in connection.execute("SELECT path FROM photos WHERE rejected=1").fetchall()]

    def move_path(self, old, new):
        connection = self._connection()
        with self._lock, connection:
            connection.execute("UPDATE photos SET path=? WHERE path=?", (normalize_path(new), normalize_path(old)))

    def rename_prefix(self, old, new):
        old, new = normalize_path(old), normalize_path(new)
        connection = self._connection()
        with self._lock, connection:
            rows = connection.execute("SELECT id,path FROM photos WHERE path=? OR path LIKE ?", (old, old + os.sep + "%")).fetchall()
            for row in rows:
                relative = os.path.relpath(row["path"], old)
                destination = new if relative == "." else os.path.join(new, relative)
                connection.execute("UPDATE photos SET path=? WHERE id=?", (normalize_path(destination), row["id"]))

    def remove_path(self, path):
        connection = self._connection()
        with self._lock, connection:
            connection.execute("DELETE FROM photos WHERE path=?", (normalize_path(path),))

    def smart_albums(self):
        return [dict(row) | {"definition": json.loads(row["definition"])} for row in self._connection().execute("SELECT * FROM smart_albums ORDER BY name COLLATE NOCASE").fetchall()]

    def save_smart_album(self, name, definition, album_id=None):
        name = clean_tag(name)
        if not isinstance(definition, dict) or definition.get("logic", "and").lower() not in {"and", "or"} or not isinstance(definition.get("conditions", []), list):
            raise ValueError("智能相册条件无效")
        allowed = {"tags", "rating", "color_label", "favorite", "flagged", "rejected"}
        operators = {"tags": {"contains", "not_contains", "="}, "rating": {"=", ">=", "<=", "is_empty"}, "color_label": {"="}, "favorite": {"="}, "flagged": {"="}, "rejected": {"="}}
        for condition in definition["conditions"]:
            if not isinstance(condition, dict) or condition.get("field") not in allowed or condition.get("operator") not in operators[condition["field"]]:
                raise ValueError("智能相册条件无效")
            field, value = condition["field"], condition.get("value")
            if field == "rating" and condition["operator"] != "is_empty" and (value != "unrated" and (not isinstance(value, int) or not 1 <= value <= 5)):
                raise ValueError("智能相册评分条件无效")
            if field == "color_label" and value not in COLORS:
                raise ValueError("智能相册颜色条件无效")
            if field == "tags":
                clean_tag(value)
        encoded = json.dumps(definition, ensure_ascii=False, separators=(",", ":"))
        now = time.time()
        connection = self._connection()
        with self._lock, connection:
            if album_id is None:
                cursor = connection.execute("INSERT INTO smart_albums(name,definition,created_at,updated_at) VALUES(?,?,?,?)", (name, encoded, now, now))
                album_id = cursor.lastrowid
            else:
                connection.execute("UPDATE smart_albums SET name=?,definition=?,updated_at=? WHERE id=?", (name, encoded, now, int(album_id)))
        return next(album for album in self.smart_albums() if album["id"] == album_id)

    def delete_smart_album(self, album_id):
        with self._lock, self._connection():
            self._connection().execute("DELETE FROM smart_albums WHERE id=?", (int(album_id),))

    def get_smart_album(self, album_id):
        row = self._connection().execute("SELECT * FROM smart_albums WHERE id=?", (int(album_id),)).fetchone()
        if not row:
            raise ValueError("智能相册不存在")
        return dict(row) | {"definition": json.loads(row["definition"])}

