"""Web UI i18n coverage checks: markup keys, catalog parity, JS syntax.

These tests only need the locale JSON fragments and the frontend sources, so
they run without a browser or a display.
"""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import i18n

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
LOCALES = ROOT / "locales"

PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
HTML_I18N_ATTRIBUTE = re.compile(r'data-i18n(?:-[a-z-]+)?="([^"]+)"')
JS_KEY = re.compile(r"""['"](web\.[A-Za-z0-9.\-]+)['"]""")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
# Han characters plus CJK punctuation; user-visible Chinese must not return to the markup.
CJK = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]")


def web_catalog(locale):
    path = LOCALES / locale / "web.json"
    return json.loads(path.read_text(encoding="utf-8"))


def base_keys(catalog):
    """Keys without the optional English ``.one`` suffix."""
    return {key.removesuffix(".one") for key in catalog}


class WebI18nTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalogs = {locale: web_catalog(locale) for locale in i18n.SUPPORTED}
        cls.html = (WEB / "index.html").read_text(encoding="utf-8")
        cls.app_js = (WEB / "app.js").read_text(encoding="utf-8")
        cls.html_keys = set(HTML_I18N_ATTRIBUTE.findall(cls.html))
        cls.js_keys = set(JS_KEY.findall(cls.app_js))

    def test_markup_keys_exist_in_every_catalog(self):
        self.assertTrue(self.html_keys, "index.html has no data-i18n attributes")
        for locale, catalog in self.catalogs.items():
            keys = base_keys(catalog)
            for key in sorted(self.html_keys):
                self.assertIn(key, keys, f"index.html key missing from {locale}: {key}")

    def test_markup_keys_are_static(self):
        """applyI18n() has no parameters, so markup keys must be parameter free."""
        for key in sorted(self.html_keys):
            for locale, catalog in self.catalogs.items():
                value = catalog.get(key, "")
                self.assertEqual(
                    PLACEHOLDER.findall(value), [],
                    f"static markup key {key} has placeholders in {locale}",
                )

    def test_app_keys_exist_in_every_catalog(self):
        for locale, catalog in self.catalogs.items():
            keys = base_keys(catalog)
            for key in sorted(self.js_keys):
                # platformKey('web.trash.move-title') expands to .mac / .win entries
                platform = {f"{key}.mac", f"{key}.win"}
                self.assertTrue(
                    key in keys or platform <= keys,
                    f"app.js key missing from {locale}: {key}",
                )

    def test_catalogs_are_parallel_and_complete(self):
        reference = base_keys(self.catalogs[i18n.FALLBACK])
        for locale, catalog in self.catalogs.items():
            self.assertTrue(catalog, f"{locale} web catalog is empty")
            keys = base_keys(catalog)
            self.assertEqual(keys - reference, set(), f"extra keys in {locale}")
            self.assertEqual(reference - keys, set(), f"keys missing from {locale}")
            for key, value in catalog.items():
                self.assertTrue(value.strip(), f"{locale}: empty value for {key}")
                self.assertNotEqual(value, key, f"{locale}: untranslated value for {key}")
                if key.endswith(".one"):
                    self.assertEqual(locale, "en-US", f"{locale} should not define {key}")
                    self.assertIn(key.removesuffix(".one"), catalog, f"{key} has no base entry")
                self.assertEqual(
                    sorted(PLACEHOLDER.findall(value)),
                    sorted(PLACEHOLDER.findall(self.catalogs[i18n.FALLBACK].get(key, ""))),
                    f"placeholder mismatch for {key} in {locale}",
                )

    def test_markup_has_no_user_visible_chinese(self):
        visible = HTML_COMMENT.sub("", self.html)
        matches = sorted({match.group(0) for match in CJK.finditer(visible)})
        self.assertEqual(matches, [], f"index.html still contains Chinese characters: {matches}")

    def test_javascript_syntax(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not available in PATH")
        for name in ("app.js", "i18n.js"):
            result = subprocess.run(
                [node, "--check", str(WEB / name)],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, f"{name} syntax error:\n{result.stderr}")


if __name__ == "__main__":
    unittest.main()
