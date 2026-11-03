import os
import re
import unittest
from unittest.mock import patch

import i18n

PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def base_keys(catalog):
    """Keys without the optional English ``.one`` suffix."""
    return {key.removesuffix(".one") for key in catalog}


class I18nTests(unittest.TestCase):
    def tearDown(self):
        i18n.configure(i18n.SYSTEM)
        i18n.reload()

    def test_supported_locales_are_complete_and_parallel(self):
        catalogs = {locale: i18n.catalog(locale) for locale in i18n.SUPPORTED}
        for locale, catalog in catalogs.items():
            self.assertTrue(catalog, f"{locale} catalog is empty")
            for key, value in catalog.items():
                self.assertIsInstance(key, str)
                self.assertTrue(value.strip(), f"{locale}: empty value for {key}")
                self.assertNotEqual(value, key, f"{locale}: untranslated placeholder value for {key}")

        reference = base_keys(catalogs[i18n.FALLBACK])
        for locale, catalog in catalogs.items():
            self.assertEqual(
                base_keys(catalog) - reference, set(),
                f"keys present in {locale} but missing in {i18n.FALLBACK}",
            )
            self.assertEqual(
                reference - base_keys(catalog), set(),
                f"keys present in {i18n.FALLBACK} but missing in {locale}",
            )

        for locale, catalog in catalogs.items():
            for key in base_keys(catalog):
                expected = catalogs[i18n.FALLBACK].get(key, "")
                self.assertEqual(
                    sorted(PLACEHOLDER.findall(catalog.get(key, ""))),
                    sorted(PLACEHOLDER.findall(expected)),
                    f"placeholder mismatch for {key} in {locale}",
                )

    def test_only_english_uses_plural_forms(self):
        for locale in i18n.SUPPORTED:
            catalog = i18n.catalog(locale)
            for key in catalog:
                if key.endswith(".one"):
                    self.assertEqual(locale, "en-US", f"{locale} should not define singular form {key}")
                    self.assertIn(key.removesuffix(".one"), catalog, f"{key} has no base entry")

    def test_resolve(self):
        for locale in i18n.SUPPORTED:
            self.assertEqual(i18n.resolve(locale), locale)
        self.assertEqual(i18n.resolve("system"), i18n.resolve(None))
        self.assertEqual(i18n.resolve(""), i18n.resolve("system"))

    def test_system_language_normalization(self):
        self.assertEqual(i18n.normalize("zh-Hans-CN"), "zh-CN")
        self.assertEqual(i18n.normalize("zh_CN.UTF-8"), "zh-CN")
        self.assertEqual(i18n.normalize("zh-Hant-TW"), "zh-TW")
        self.assertEqual(i18n.normalize("en_GB"), "en-US")
        self.assertEqual(i18n.normalize("ja"), "ja-JP")
        self.assertEqual(i18n.normalize("ja_JP.UTF-8"), "ja-JP")
        self.assertEqual(i18n.normalize("fr-FR"), "fr-FR")
        self.assertEqual(i18n.normalize(""), "")

    def test_unsupported_system_language_falls_back_to_english(self):
        with patch.dict(os.environ, {"HAVEN_LANGUAGE": "fr-FR"}):
            self.assertEqual(i18n.resolve("system"), "en-US")

    def test_japanese_system_language_resolves(self):
        with patch.dict(os.environ, {"HAVEN_LANGUAGE": "ja-JP"}):
            self.assertEqual(i18n.resolve("system"), "ja-JP")

    def test_explicit_preference_wins_over_system(self):
        with patch.dict(os.environ, {"HAVEN_LANGUAGE": "en-US"}):
            self.assertEqual(i18n.resolve("zh-CN"), "zh-CN")
            self.assertEqual(i18n.resolve("ja-JP"), "ja-JP")

    def test_translation_and_interpolation(self):
        i18n.configure("zh-CN")
        self.assertEqual(i18n.tr("menu.file"), "文件")
        i18n.configure("en-US")
        self.assertEqual(i18n.tr("menu.file"), "File")
        self.assertEqual(i18n.tr("menu.copy-failed", error="denied"), "Copy failed: denied")
        i18n.configure("ja-JP")
        self.assertEqual(i18n.tr("menu.file"), "ファイル")
        self.assertEqual(i18n.tr("menu.copy-failed", error="denied"), "コピーに失敗しました：denied")

    def test_plural_selection(self):
        i18n.configure("en-US")
        with patch.object(i18n, "_catalogs", {"en-US": {"web.test.count": "{count} photos", "web.test.count.one": "{count} photo"}}):
            self.assertEqual(i18n.tr("web.test.count", count=1), "1 photo")
            self.assertEqual(i18n.tr("web.test.count", count=2), "2 photos")
        i18n.configure("zh-CN")
        with patch.object(i18n, "_catalogs", {"zh-CN": {"web.test.count": "{count} 张照片"}, "en-US": {}}):
            self.assertEqual(i18n.tr("web.test.count", count=1), "1 张照片")
            self.assertEqual(i18n.tr("web.test.count", count=2), "2 张照片")
        i18n.configure("ja-JP")
        with patch.object(i18n, "_catalogs", {"ja-JP": {"web.test.count": "{count} 枚の写真"}, "en-US": {}}):
            self.assertEqual(i18n.tr("web.test.count", count=1), "1 枚の写真")
            self.assertEqual(i18n.tr("web.test.count", count=2), "2 枚の写真")

    def test_missing_key_is_visible(self):
        i18n.configure("en-US")
        self.assertEqual(i18n.tr("web.not.a.key"), "web.not.a.key")

    def test_payload_contains_active_and_fallback_catalogs(self):
        i18n.configure("ja-JP")
        payload = i18n.payload()
        self.assertEqual(payload["locale"], "ja-JP")
        self.assertEqual(payload["fallback"], "en-US")
        self.assertEqual(payload["messages"]["menu.file"], "ファイル")
        self.assertEqual(payload["fallbackMessages"]["menu.file"], "File")

        i18n.configure("en-US")
        payload = i18n.payload()
        self.assertEqual(payload["messages"]["menu.file"], "File")
        self.assertEqual(payload["fallbackMessages"], {})


if __name__ == "__main__":
    unittest.main()
