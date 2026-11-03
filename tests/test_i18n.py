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

    def test_catalogs_are_complete_and_parallel(self):
        catalogs = {locale: i18n.catalog(locale) for locale in i18n.SUPPORTED}
        for locale, catalog in catalogs.items():
            self.assertTrue(catalog, f"{locale} catalog is empty")
            for key, value in catalog.items():
                self.assertIsInstance(key, str)
                self.assertTrue(value.strip(), f"{locale}: empty value for {key}")
                self.assertNotEqual(value, key, f"{locale}: untranslated placeholder value for {key}")

        zh, en = base_keys(catalogs["zh-CN"]), base_keys(catalogs["en-US"])
        self.assertEqual(en - zh, set(), "keys present in en-US but missing in zh-CN")
        self.assertEqual(zh - en, set(), "keys present in zh-CN but missing in en-US")

        for key in zh:
            zh_value = catalogs["zh-CN"].get(key, "")
            en_value = catalogs["en-US"].get(key, "")
            self.assertEqual(
                sorted(PLACEHOLDER.findall(zh_value)),
                sorted(PLACEHOLDER.findall(en_value)),
                f"placeholder mismatch for {key}",
            )

    def test_english_plural_forms(self):
        catalogs = i18n.catalog("en-US")
        for key in catalogs:
            if key.endswith(".one"):
                self.assertIn(key.removesuffix(".one"), catalogs, f"{key} has no base entry")

    def test_resolve(self):
        self.assertEqual(i18n.resolve("zh-CN"), "zh-CN")
        self.assertEqual(i18n.resolve("en-US"), "en-US")
        self.assertEqual(i18n.resolve("system"), i18n.resolve(None))
        self.assertEqual(i18n.resolve(""), "en-US" if not i18n.normalize(i18n.system_locale()) == "zh-CN" else "zh-CN")

    def test_system_language_normalization(self):
        self.assertEqual(i18n.normalize("zh-Hans-CN"), "zh-CN")
        self.assertEqual(i18n.normalize("zh_CN.UTF-8"), "zh-CN")
        self.assertEqual(i18n.normalize("zh-Hant-TW"), "zh-TW")
        self.assertEqual(i18n.normalize("en_GB"), "en-US")
        self.assertEqual(i18n.normalize("fr-FR"), "fr-FR")
        self.assertEqual(i18n.normalize(""), "")

    def test_unsupported_system_language_falls_back_to_english(self):
        with patch.dict(os.environ, {"HAVEN_LANGUAGE": "fr-FR"}):
            self.assertEqual(i18n.resolve("system"), "en-US")

    def test_explicit_preference_wins_over_system(self):
        with patch.dict(os.environ, {"HAVEN_LANGUAGE": "en-US"}):
            self.assertEqual(i18n.resolve("zh-CN"), "zh-CN")

    def test_translation_and_interpolation(self):
        i18n.configure("zh-CN")
        self.assertEqual(i18n.tr("menu.file"), "文件")
        i18n.configure("en-US")
        self.assertEqual(i18n.tr("menu.file"), "File")
        self.assertEqual(i18n.tr("menu.copy-failed", error="denied"), "Copy failed: denied")

    def test_plural_selection(self):
        i18n.configure("en-US")
        with patch.object(i18n, "_catalogs", {"en-US": {"web.test.count": "{count} photos", "web.test.count.one": "{count} photo"}}):
            self.assertEqual(i18n.tr("web.test.count", count=1), "1 photo")
            self.assertEqual(i18n.tr("web.test.count", count=2), "2 photos")
        i18n.configure("zh-CN")
        with patch.object(i18n, "_catalogs", {"zh-CN": {"web.test.count": "{count} 张照片"}, "en-US": {}}):
            self.assertEqual(i18n.tr("web.test.count", count=1), "1 张照片")
            self.assertEqual(i18n.tr("web.test.count", count=2), "2 张照片")

    def test_missing_key_is_visible(self):
        i18n.configure("en-US")
        self.assertEqual(i18n.tr("web.not.a.key"), "web.not.a.key")

    def test_payload_contains_active_and_fallback_catalogs(self):
        i18n.configure("zh-CN")
        payload = i18n.payload()
        self.assertEqual(payload["locale"], "zh-CN")
        self.assertEqual(payload["fallback"], "en-US")
        self.assertEqual(payload["messages"]["menu.file"], "文件")
        self.assertEqual(payload["fallbackMessages"]["menu.file"], "File")

        i18n.configure("en-US")
        payload = i18n.payload()
        self.assertEqual(payload["messages"]["menu.file"], "File")
        self.assertEqual(payload["fallbackMessages"], {})


if __name__ == "__main__":
    unittest.main()
