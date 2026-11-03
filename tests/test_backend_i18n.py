"""Backend message localisation tests (api / metadata_store / platform_support / updater).

These tests pin ``i18n`` to an explicit locale so they never depend on the host
machine's system language.
"""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import api
import cache
import i18n
import metadata_store
import platform_support
import thumbs
import updater
import updater_macos
from updater_src import updater as helper

BACKEND_PREFIX = "backend."


class BackendI18nTestCase(unittest.TestCase):
    """Base class that restores the system language after every test."""

    def setUp(self):
        self.addCleanup(i18n.configure, i18n.SYSTEM)

    def configure(self, locale):
        i18n.configure(locale)
        self.assertEqual(i18n.current(), locale)


class CatalogTests(BackendI18nTestCase):
    def test_backend_catalogs_are_complete(self):
        en = i18n.catalog("en-US")
        # ``.one`` is an English-only singular variant of a base key.
        backend_en = {key.removesuffix(".one") for key in en if key.startswith(BACKEND_PREFIX)}
        self.assertTrue(backend_en)
        for locale in i18n.SUPPORTED:
            catalog = i18n.catalog(locale)
            backend = {key.removesuffix(".one") for key in catalog if key.startswith(BACKEND_PREFIX)}
            self.assertEqual(backend, backend_en, f"backend keys differ for {locale}")

    def test_windows_updater_helper_messages_are_parallel(self):
        reference = set(helper.MESSAGES["en-US"])
        self.assertTrue(reference)
        for locale, messages in helper.MESSAGES.items():
            self.assertEqual(set(messages), reference, f"updater helper messages differ for {locale}")
        helper.set_language("ja-JP")
        try:
            self.assertIn("Haven", helper.tr("title"))
            self.assertIn("{error}", helper.tr("failed"))
        finally:
            helper.set_language("en-US")

    def test_switching_language_changes_backend_output(self):
        self.configure("zh-CN")
        zh = i18n.tr("backend.error.folder-missing")
        zh_warning = i18n.tr("backend.warning.settings-save", error="denied")
        self.configure("en-US")
        en = i18n.tr("backend.error.folder-missing")
        en_warning = i18n.tr("backend.warning.settings-save", error="denied")
        self.assertNotEqual(zh, en)
        self.assertEqual(zh, "文件夹不存在")
        self.assertEqual(en, "The folder does not exist")
        self.assertNotEqual(zh_warning, en_warning)
        self.assertIn("denied", en_warning)


class ExceptionLanguageTests(BackendI18nTestCase):
    def test_metadata_store_validation_messages_follow_language(self):
        self.configure("zh-CN")
        with self.assertRaises(ValueError) as caught:
            metadata_store.clean_tag("")
        self.assertEqual(str(caught.exception), i18n.tr("backend.error.tag-empty"))
        self.configure("en-US")
        with self.assertRaises(ValueError) as caught:
            metadata_store.clean_tag("")
        self.assertEqual(str(caught.exception), "Tags cannot be empty")

    def test_platform_name_validation_messages_follow_language(self):
        self.configure("zh-CN")
        with self.assertRaises(ValueError) as caught:
            platform_support.validate_entry_name("bad/name")
        self.assertIn("单个文件名", str(caught.exception))
        self.configure("en-US")
        with self.assertRaises(ValueError) as caught:
            platform_support.validate_entry_name("bad/name")
        self.assertEqual(
            str(caught.exception),
            "The name must be a single file name in the current folder",
        )

    def test_updater_errors_and_check_message_follow_language(self):
        manifest = {
            "version": "0.1.0",
            "url": "https://github.com/christo112233/Haven/releases/download/v0.1.0/Haven.zip",
            "sha256": "a" * 64,
            "size": 100,
        }
        self.configure("zh-CN")
        with self.assertRaises(ValueError) as caught:
            updater.validate_manifest(manifest, "1.0.0")
        self.assertIn("高于当前版本", str(caught.exception))
        with patch("updater.request", side_effect=OSError("offline")):
            result = updater.check("1.0.0")
        self.assertIn("暂时无法检查更新", result["error"])
        self.assertIn("offline", result["error"])

        self.configure("en-US")
        with self.assertRaises(ValueError) as caught:
            updater.validate_manifest(manifest, "1.0.0")
        self.assertIn("newer than the current version", str(caught.exception))
        with patch("updater.request", side_effect=OSError("offline")):
            result = updater.check("1.0.0")
        self.assertIn("Could not check for updates right now", result["error"])
        self.assertIn("offline", result["error"])

    def test_macos_update_environment_messages_follow_language(self):
        self.configure("zh-CN")
        with self.assertRaises(ValueError) as caught:
            updater_macos.check_environment(
                Path("/private/var/folders/x/AppTranslocation/ABC/d/Haven.app"), {"size": 10}
            )
        self.assertIn("临时位置", str(caught.exception))
        self.configure("en-US")
        with self.assertRaises(ValueError) as caught:
            updater_macos.check_environment(
                Path("/private/var/folders/x/AppTranslocation/ABC/d/Haven.app"), {"size": 10}
            )
        self.assertIn("read-only temporary location", str(caught.exception))

    def test_api_validation_message_follows_language(self):
        self.configure("zh-CN")
        with self.assertRaises(ValueError) as caught:
            api.Api._validate_export_target("")
        self.assertEqual(str(caught.exception), "请选择导出文件夹")
        self.configure("en-US")
        with self.assertRaises(ValueError) as caught:
            api.Api._validate_export_target("")
        self.assertEqual(str(caught.exception), "Please choose an export folder")


class PlaceholderTests(BackendI18nTestCase):
    def test_placeholders_are_interpolated_in_both_languages(self):
        for locale, expected in (
            ("zh-CN", "未找到程序：/tmp/editor.app"),
            ("en-US", "Program not found: /tmp/editor.app"),
        ):
            self.configure(locale)
            text = i18n.tr("backend.error.program-not-found", path="/tmp/editor.app")
            self.assertEqual(text, expected)
            self.assertNotIn("{path}", text)
        self.configure("zh-CN")
        warning = i18n.tr("backend.warning.cache-readonly", path="/photos")
        self.assertIn("/photos", warning)
        self.assertNotIn("{path}", warning)

    def test_metadata_store_error_includes_placeholder(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            photo = root / "one.jpg"
            photo.write_bytes(b"x")
            store = metadata_store.MetadataStore(root / "metadata.sqlite3", roots=[str(root)], root_ids={str(root): "root"})
            try:
                self.configure("zh-CN")
                with self.assertRaises(ValueError) as caught:
                    store.update([str(photo)], {"bogus": 1})
                self.assertIn("bogus", str(caught.exception))
                self.assertIn("不支持的元数据字段", str(caught.exception))
                self.assertNotIn("{fields}", str(caught.exception))

                self.configure("en-US")
                with self.assertRaises(ValueError) as caught:
                    store.update([str(photo)], {"favorite": "yes"})
                self.assertIn("favorite", str(caught.exception))
                self.assertIn("must be true or false", str(caught.exception))
                self.assertNotIn("{field}", str(caught.exception))
            finally:
                store.close()


class CacheAndThumbnailMessageTests(BackendI18nTestCase):
    def test_cache_ownership_error_follows_language(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / cache.CACHE_NAME).mkdir()
            self.configure("zh-CN")
            with self.assertRaises(PermissionError) as caught:
                cache.directory(folder)
            self.assertIn("不是 Haven 缓存", str(caught.exception))
            self.configure("en-US")
            with self.assertRaises(PermissionError) as caught:
                cache.directory(folder)
            self.assertIn("not a Haven cache", str(caught.exception))

    def test_thumbnail_warning_follows_language(self):
        original = cache.directory

        def readonly(folder, create=True):
            if create:
                raise PermissionError("read only")
            return original(folder, False)

        with tempfile.TemporaryDirectory() as temp:
            photo = Path(temp) / "one.jpg"
            Image.new("RGB", (16, 16), "red").save(photo)
            item = {"path": str(photo), "ext": ".jpg", "signature": "1:2"}
            for locale, prefix in (("zh-CN", "缓存不可写"), ("en-US", "Cache is not writable")):
                self.configure(locale)
                with patch("cache.directory", side_effect=readonly):
                    data, warning = thumbs.get(item)
                self.assertTrue(data)
                self.assertTrue(warning.startswith(prefix), warning)
                self.assertIn("read only", warning)
                self.assertIn(str(photo.parent), warning)
                self.assertNotIn("{path}", warning)
                self.assertNotIn("{error}", warning)


class InstallPlanLanguageTests(BackendI18nTestCase):
    def _install(self, locale):
        self.configure(locale)
        with tempfile.TemporaryDirectory() as temp:
            app_dir = Path(temp) / "app"
            app_dir.mkdir()
            (app_dir / "updater.exe").write_bytes(b"helper")
            fake_subprocess = SimpleNamespace(Popen=lambda *args, **kwargs: None, CREATE_NO_WINDOW=0)
            with patch.object(updater.config, "APP_DIR", app_dir), \
                 patch.object(updater, "download", lambda manifest, destination, progress: None), \
                 patch.object(updater, "subprocess", fake_subprocess):
                updater.install({"version": "9.9.9"}, lambda value: None)
            plans = list((app_dir / ".updates").glob("haven-*/plan.json"))
            self.assertEqual(len(plans), 1)
            return json.loads(plans[0].read_text(encoding="utf-8"))

    def test_install_plan_records_active_language(self):
        plan = self._install("zh-CN")
        self.assertEqual(plan["language"], "zh-CN")
        plan = self._install("en-US")
        self.assertEqual(plan["language"], "en-US")

    def test_install_plan_still_carries_update_fields(self):
        plan = self._install("en-US")
        self.assertEqual(plan["manifest"], {"version": "9.9.9"})
        self.assertEqual(plan["current"], updater.config.VERSION)
        self.assertIn("target", plan)
        self.assertIn("package", plan)
        self.assertIn("pid", plan)


if __name__ == "__main__":
    unittest.main()
