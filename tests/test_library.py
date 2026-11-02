"""Tests for the portable shared-library data layer (Phase 1).

These tests use only the standard library plus Haven's own stdlib-only modules,
so they can run on any platform even before the media dependencies are built.
"""
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cache
import config
import library
import metadata_store


class LibraryIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "photos"
        self.root.mkdir()
        self.library_dir = Path(self.temp.name) / "library"
        self.info = library.ensure_library(self.library_dir)
        self.addCleanup(self.temp.cleanup)

    def photo(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"photo")
        return path

    def store(self, roots=None, **kwargs):
        store = metadata_store.MetadataStore(
            library.database_path(self.library_dir),
            roots=roots or [str(self.root)],
            root_ids={str(self.root): "root-1"},
            **kwargs,
        )
        self.addCleanup(store.close)
        return store

    def test_root_marker_round_trip_and_stable_id(self):
        marker = library.ensure_root_marker(self.root, self.info["library_id"])
        self.assertEqual(marker["app"], "Haven")
        self.assertEqual(marker["library_id"], self.info["library_id"])
        self.assertTrue(marker["root_id"])
        again = library.ensure_root_marker(self.root, self.info["library_id"])
        self.assertEqual(marker["root_id"], again["root_id"])
        self.assertEqual(library.root_marker(self.root)["root_id"], marker["root_id"])

    def test_normalize_relative_handles_nfc_and_separators(self):
        composed = library.normalize_relative("2024/trip/caf\u00e9.jpg")
        decomposed = library.normalize_relative("2024\\trip\\cafe\u0301.jpg")
        self.assertEqual(composed, decomposed)
        self.assertEqual(library.normalize_relative("./a//b/../c"), "a/b/../c")

    def test_relative_and_absolute_paths(self):
        file = self.photo("2024/trip/a.jpg")
        relative = library.relative_path(self.root, file)
        self.assertEqual(relative, "2024/trip/a.jpg")
        self.assertEqual(library.absolute_path(self.root, relative), file)
        self.assertIsNone(library.relative_path(self.root, Path(self.temp.name) / "outside.jpg"))

    def test_identity_is_shared_between_mounted_paths(self):
        file = self.photo("trip/a.jpg")
        library.ensure_root_marker(self.root, self.info["library_id"])
        store = self.store()
        store.reconcile([{"path": str(file)}])
        store.update([str(file)], {"rating": 5, "tags_add": ["旅行"]})

        # Simulate the same root mounted under a different path (macOS /Volumes
        # versus Windows Z:\) via a symlink on POSIX.
        link = Path(self.temp.name) / "mounted"
        try:
            os.symlink(self.root, link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable on this platform")
        marker = library.root_marker(link)
        self.assertEqual(marker["root_id"], library.root_marker(self.root)["root_id"])

        second = metadata_store.MetadataStore(
            library.database_path(self.library_dir),
            roots=[str(link)],
            root_ids={str(link): "root-1"},
        )
        self.addCleanup(second.close)
        values = second.metadata_for_paths([str(link / "trip/a.jpg")])
        metadata = next(iter(values.values()))
        self.assertEqual(metadata["rating"], 5)
        self.assertEqual(metadata["tags"], ["旅行"])
        # The absolute path stored by the second mount must not break the first.
        first_values = store.metadata_for_paths([str(file)])
        self.assertEqual(next(iter(first_values.values()))["rating"], 5)

    def test_rejected_paths_resolve_to_current_mount(self):
        file = self.photo("bad.jpg")
        store = self.store()
        store.reconcile([{"path": str(file)}])
        store.update([str(file)], {"rejected": True})
        self.assertEqual([Path(value).resolve() for value in store.rejected_paths()], [file.resolve()])
        moved_root = Path(self.temp.name) / "photos-renamed"
        self.root.rename(moved_root)
        store.set_roots([str(moved_root)], {str(moved_root): "root-1"})
        self.assertEqual([Path(value).resolve() for value in store.rejected_paths()], [(moved_root / "bad.jpg").resolve()])

    def test_legacy_database_migrates_to_portable_identity(self):
        legacy = Path(self.temp.name) / "legacy.sqlite3"
        connection = sqlite3.connect(legacy)
        connection.executescript(
            """
            CREATE TABLE photos (
                id INTEGER PRIMARY KEY,
                file_key TEXT NOT NULL UNIQUE,
                path TEXT NOT NULL UNIQUE,
                size INTEGER NOT NULL DEFAULT 0,
                mtime_ns INTEGER NOT NULL DEFAULT 0,
                rating INTEGER,
                favorite INTEGER NOT NULL DEFAULT 0,
                flagged INTEGER NOT NULL DEFAULT 0,
                rejected INTEGER NOT NULL DEFAULT 0,
                color_label TEXT,
                missing_since REAL
            );
            CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
            CREATE TABLE photo_tags (photo_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY(photo_id, tag_id));
            CREATE TABLE smart_albums (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, definition TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
            """
        )
        file = self.photo("trip/a.jpg")
        inside = connection.execute("INSERT INTO photos(file_key,path,size,mtime_ns,rating,favorite) VALUES(?,?,?,?,?,?)", ("inode:1:2", str(file), 5, 1, 4, 1))
        outside = connection.execute("INSERT INTO photos(file_key,path,size,mtime_ns,rating) VALUES(?,?,?,?,?)", ("inode:1:3", str(Path(self.temp.name) / "old" / "gone.jpg"), 5, 2, 3))
        connection.execute("INSERT INTO tags(name) VALUES('keep')")
        tag_id = connection.execute("SELECT id FROM tags").fetchone()[0]
        connection.execute("INSERT INTO photo_tags(photo_id,tag_id) VALUES(?,?)", (inside.lastrowid, tag_id))
        connection.commit()
        connection.close()

        store = metadata_store.MetadataStore(legacy, roots=[str(self.root)], root_ids={str(self.root): "root-1"})
        self.addCleanup(store.close)
        self.assertEqual(store.migration_report, {"matched": 1, "unmatched": 1})
        values = store.metadata_for_paths([str(file)])
        metadata = next(iter(values.values()))
        self.assertEqual(metadata["rating"], 4)
        self.assertTrue(metadata["favorite"])
        self.assertEqual(metadata["tags"], ["keep"])
        with sqlite3.connect(legacy) as check:
            unmatched = check.execute("SELECT path FROM legacy_unmatched").fetchall()
        self.assertEqual(unmatched, [(str(Path(self.temp.name) / "old" / "gone.jpg"),)])
        self.assertGreater(outside.lastrowid, 0)

    def test_shared_library_uses_network_safe_journal_and_lock(self):
        store = self.store(shared=True)
        file = self.photo("shared.jpg")
        store.reconcile([{"path": str(file)}])
        with sqlite3.connect(library.database_path(self.library_dir)) as connection:
            mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        self.assertEqual(mode.lower(), "delete")
        self.assertFalse(Path(str(store.path) + ".lock").exists())

    def test_legacy_is_detected_only_once(self):
        file = self.photo("a.jpg")
        store = self.store()
        store.reconcile([{"path": str(file)}])
        self.assertFalse(store._legacy)
        store.close()
        reopened = self.store()
        self.assertFalse(reopened._legacy)
        self.assertIsNone(reopened.migration_report)


    def test_root_marker_repairs_marker_only_cache_directory(self):
        # Older builds wrote .Haven/library.json without owner.json; adopting the
        # root must heal the cache instead of treating it as a foreign directory.
        stale = self.root / config.CACHE_NAME
        stale.mkdir()
        (stale / "library.json").write_text("{}", encoding="utf-8")
        marker = library.ensure_root_marker(self.root, self.info["library_id"])
        self.assertIsNotNone(marker)
        self.assertTrue((stale / "owner.json").is_file())
        self.assertTrue((stale / "thumbs").is_dir())
        self.assertTrue((stale / "previews").is_dir())


class CachePortabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def test_signature_is_whole_second_and_size(self):
        class Stat:
            st_mtime = 1700000000.987
            st_size = 1234
        self.assertEqual(cache.signature(Stat()), "1700000000:1234")

    def test_index_does_not_persist_absolute_paths(self):
        file = self.root / "a.jpg"
        file.write_bytes(b"x")
        item = {"path": str(file), "live_path": str(self.root / "a.mov"), "name": "a.jpg", "signature": "1:1"}
        cache.save(self.root, {"a.jpg": item})
        loaded = cache.load(self.root)
        self.assertNotIn("path", loaded["a.jpg"])
        self.assertNotIn("live_path", loaded["a.jpg"])
        self.assertEqual(loaded["a.jpg"]["name"], "a.jpg")
        self.assertEqual(cache.load(self.root)["a.jpg"]["signature"], "1:1")

    def test_apple_double_files_are_ignored(self):
        import scanner
        self.assertFalse(scanner.visible(_Entry("._a.jpg")))
        self.assertFalse(scanner.visible(_Entry(".DS_Store")))
        self.assertTrue(scanner.visible(_Entry("a.jpg")))


class _Entry:
    def __init__(self, name):
        self.name = name

    def is_symlink(self):
        return False

    def stat(self, follow_symlinks=False):
        class Result:
            st_file_attributes = 0
        return Result()


class ApiLibraryIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "photos"
        self.root.mkdir()
        (self.root / "a.jpg").write_bytes(b"x")
        self.addCleanup(self.temp.cleanup)

    def test_api_creates_root_marker_and_persists_annotations_across_restart(self):
        try:
            from api import Api
        except Exception as exc:  # media dependencies are optional for this test
            self.skipTest(f"Api unavailable: {exc}")
        settings = Path(self.temp.name) / "settings.json"
        with patch("config.STATE_PATH", settings):
            api = Api()
            try:
                api.add_folder(str(self.root))
                marker = library.root_marker(self.root)
                self.assertIsNotNone(marker)
                self.assertEqual(api.root_ids[str(self.root.resolve())], marker["root_id"])
                api.store.reconcile([{"path": str(self.root / "a.jpg")}])
                api.store.update([str(self.root / "a.jpg")], {"rating": 5})
            finally:
                api.store.close()
                api.pool.shutdown(wait=False, cancel_futures=True)
                api.raw_pool.shutdown(wait=False, cancel_futures=True)
            restarted = Api()
            try:
                values = restarted.store.metadata_for_paths([str(self.root / "a.jpg")])
                self.assertEqual(next(iter(values.values()))["rating"], 5)
                self.assertTrue((Path(self.temp.name) / "library" / "library.json").is_file())
            finally:
                restarted.store.close()
                restarted.pool.shutdown(wait=False, cancel_futures=True)
                restarted.raw_pool.shutdown(wait=False, cancel_futures=True)


    def test_set_library_dir_moves_annotations_to_shared_location(self):
        try:
            from api import Api
        except Exception as exc:
            self.skipTest(f"Api unavailable: {exc}")
        data_dir = Path(self.temp.name) / "appdata"
        data_dir.mkdir()
        settings = data_dir / "settings.json"
        shared = Path(self.temp.name) / "nas-library"
        photo = self.root / "a.jpg"
        with patch("config.STATE_PATH", settings):
            api = Api()
            try:
                api.add_folder(str(self.root))
                api.store.reconcile([{"path": str(photo)}])
                api.store.update([str(photo)], {"rating": 3, "tags_add": ["共用"]})
                info = api.set_library_dir(str(shared))
                self.assertTrue(info["shared"])
                self.assertTrue((shared / "library.json").is_file())
                self.assertTrue((shared / "library.sqlite3").is_file())
            finally:
                api.store.close()
                api.pool.shutdown(wait=False, cancel_futures=True)
                api.raw_pool.shutdown(wait=False, cancel_futures=True)
            restarted = Api()
            try:
                self.assertEqual(restarted.library_dir.resolve(), shared.resolve())
                values = restarted.store.metadata_for_paths([str(photo)])
                metadata = next(iter(values.values()))
                self.assertEqual(metadata["rating"], 3)
                self.assertEqual(metadata["tags"], ["共用"])
            finally:
                restarted.store.close()
                restarted.pool.shutdown(wait=False, cancel_futures=True)
                restarted.raw_pool.shutdown(wait=False, cancel_futures=True)

    def test_api_adopts_and_migrates_legacy_local_database(self):
        try:
            from api import Api
        except Exception as exc:
            self.skipTest(f"Api unavailable: {exc}")
        data_dir = Path(self.temp.name)
        photo = self.root / "a.jpg"
        settings = data_dir / "settings.json"
        settings.write_text(json.dumps({"roots": [str(self.root)]}), encoding="utf-8")
        legacy = data_dir / "haven-metadata.sqlite3"
        connection = sqlite3.connect(legacy)
        connection.executescript(
            """
            CREATE TABLE photos (id INTEGER PRIMARY KEY, file_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL DEFAULT 0, mtime_ns INTEGER NOT NULL DEFAULT 0, rating INTEGER, favorite INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, color_label TEXT, missing_since REAL);
            CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
            CREATE TABLE photo_tags (photo_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY(photo_id, tag_id));
            CREATE TABLE smart_albums (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, definition TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
            """
        )
        connection.execute("INSERT INTO photos(file_key,path,size,mtime_ns,rating) VALUES(?,?,?,?,?)", ("inode:9:9", str(photo), 1, 1, 2))
        connection.commit()
        connection.close()
        with patch("config.STATE_PATH", settings):
            api = Api()
            try:
                self.assertTrue((data_dir / "library" / "library.sqlite3").is_file())
                values = api.store.metadata_for_paths([str(photo)])
                self.assertEqual(next(iter(values.values()))["rating"], 2)
            finally:
                api.store.close()
                api.pool.shutdown(wait=False, cancel_futures=True)
                api.raw_pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    unittest.main()
