"""Tests for platform-aware update selection and the macOS bundle swap."""
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import config
import updater
import updater_macos

GOOD_SHA = "a" * 64


def platform_manifest():
    return {
        "version": "9.9.9",
        "notes": "test",
        "mandatory": False,
        "platforms": {
            "windows-x64": {
                "url": "https://github.com/christo112233/Haven/releases/download/v9.9.9/Haven-win64.zip",
                "sha256": GOOD_SHA,
                "size": 100,
            },
            "macos-arm64": {
                "url": "https://github.com/christo112233/Haven/releases/download/v9.9.9/Haven-mac-arm64.zip",
                "sha256": "b" * 64,
                "size": 200,
            },
        },
    }


class PlatformSelectionTests(unittest.TestCase):
    def test_platform_key_windows(self):
        with patch.object(updater.config, "IS_MACOS", False), patch.object(updater.config, "IS_WINDOWS", True):
            self.assertEqual(updater.platform_key(), "windows-x64")
        with patch.object(updater.config, "IS_MACOS", True), patch.object(updater.config, "IS_WINDOWS", False):
            self.assertEqual(updater.platform_key(), "macos-arm64")

    def test_selects_artifact_for_each_platform(self):
        data = platform_manifest()
        macos = updater.select_update(data, "1.0.0", "macos-arm64")
        self.assertTrue(macos["url"].endswith("Haven-mac-arm64.zip"))
        self.assertEqual(macos["size"], 200)
        self.assertEqual(macos["version"], "9.9.9")
        windows = updater.select_update(data, "1.0.0", "windows-x64")
        self.assertTrue(windows["url"].endswith("Haven-win64.zip"))

    def test_legacy_manifest_is_windows_only(self):
        legacy = {
            "version": "9.9.9",
            "url": "https://github.com/christo112233/Haven/releases/download/v9.9.9/Haven-win64.zip",
            "sha256": GOOD_SHA,
            "size": 100,
        }
        self.assertIsNone(updater.select_update(legacy, "1.0.0", "macos-arm64"))
        self.assertIsNotNone(updater.select_update(legacy, "1.0.0", "windows-x64"))

    def test_rejects_bad_entries(self):
        data = platform_manifest()
        data["platforms"]["macos-arm64"]["url"] = "http://github.com/x/Haven.zip"
        with self.assertRaises(ValueError):
            updater.select_update(data, "1.0.0", "macos-arm64")
        data = platform_manifest()
        data["platforms"]["macos-arm64"]["sha256"] = "nope"
        with self.assertRaises(ValueError):
            updater.select_update(data, "1.0.0", "macos-arm64")
        data = platform_manifest()
        data["version"] = "1.0.0"
        with self.assertRaises(ValueError):
            updater.select_update(data, "1.0.0", "macos-arm64")


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def fake_bundle(self, version="9.9.9", identifier=updater_macos.BUNDLE_IDENTIFIER):
        bundle = self.root / "Haven.app"
        (bundle / "Contents" / "MacOS").mkdir(parents=True, exist_ok=True)
        (bundle / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": identifier,
            "CFBundleShortVersionString": version,
            "CFBundleExecutable": "Haven",
        }))
        executable = bundle / "Contents" / "MacOS" / "Haven"
        executable.write_text("#!/bin/sh\n")
        executable.chmod(0o755)
        return bundle

    def test_bundle_from_executable(self):
        bundle = self.fake_bundle()
        found = updater_macos.bundle_from_executable(bundle / "Contents" / "MacOS" / "Haven")
        self.assertEqual(found, bundle.resolve())
        with self.assertRaises(ValueError):
            updater_macos.bundle_from_executable(self.root / "plain" / "binary")

    def test_translocation_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            updater_macos.check_environment(
                Path("/private/var/folders/x/AppTranslocation/ABC/d/Haven.app"), {"size": 10}
            )
        self.assertIn("临时位置", str(caught.exception))

    def test_unwritable_parent_is_rejected(self):
        bundle = self.fake_bundle()
        with patch("updater_macos.os.access", return_value=False):
            with self.assertRaises(ValueError) as caught:
                updater_macos.check_environment(bundle, {"size": 10})
        self.assertIn("写入权限", str(caught.exception))

    def test_insufficient_disk_space_is_rejected(self):
        bundle = self.fake_bundle()
        with patch("updater_macos.shutil.disk_usage", return_value=type("D", (), {"free": 1024})()):
            with self.assertRaises(ValueError) as caught:
                updater_macos.check_environment(bundle, {"size": 10})
        self.assertIn("磁盘空间不足", str(caught.exception))

    def test_verify_bundle_checks_identifier_and_version(self):
        bundle = self.fake_bundle(version="9.9.9")
        with self.assertRaises(ValueError) as caught:
            updater_macos.verify_bundle(bundle, {"version": "1.0.0"})
        self.assertIn("版本", str(caught.exception))
        other = self.fake_bundle(version="9.9.9", identifier="com.example.other")
        with self.assertRaises(ValueError) as caught:
            updater_macos.verify_bundle(other, {"version": "9.9.9"})
        self.assertIn("Bundle ID", str(caught.exception))

    @unittest.skipUnless(sys.platform == "darwin", "macOS codesign")
    def test_verify_bundle_accepts_adhoc_signed_app(self):
        bundle = self.fake_bundle(version="9.9.9")
        info = plistlib.loads((bundle / "Contents" / "Info.plist").read_bytes())
        for name, value in (("CFBundleName", "Haven"), ("CFBundlePackageType", "APPL")):
            info[name] = value
        (bundle / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info))
        subprocess.run(["codesign", "--force", "--deep", "-s", "-", str(bundle)], check=True, capture_output=True)
        updater_macos.verify_bundle(bundle, {"version": "9.9.9"})


@unittest.skipUnless(sys.platform == "darwin", "macOS helper script")
class HelperScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.applications = self.base / "Applications"
        self.bundle = self.applications / "Haven.app"
        (self.bundle / "Contents").mkdir(parents=True)
        (self.bundle / "old.txt").write_text("old")
        self.work = self.base / "updates" / "work"
        self.stage = self.work / "stage" / "Haven.app"
        (self.stage / "Contents").mkdir(parents=True)
        (self.stage / "new.txt").write_text("new")
        self.backup = self.applications / "Haven.app.backup-0.1.0"

    def tearDown(self):
        self.temp.cleanup()

    def run_helper(self, staged=None):
        manifest = {"version": "9.9.9", "size": 1, "sha256": GOOD_SHA}
        with patch("updater_macos.os.getpid", return_value=999999):
            script = updater_macos._helper_script(
                self.work, self.bundle, staged or self.stage, self.backup, manifest,
                open_command="/usr/bin/true",
            )
        return subprocess.run(["/bin/sh", str(script)], capture_output=True, text=True, timeout=30)

    def test_successful_swap_and_cleanup(self):
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bundle / "new.txt").read_text(), "new")
        self.assertFalse((self.bundle / "old.txt").exists())
        self.assertEqual((self.backup / "old.txt").read_text(), "old")
        marker = (self.work / "installed.txt").read_text()
        self.assertIn("version=9.9.9", marker)
        with patch("config.STATE_PATH", self.base / "data" / "settings.json"):
            (self.base / "data" / "updates").mkdir(parents=True)
            import shutil as _shutil
            _shutil.move(str(self.work), str(self.base / "data" / "updates" / "work"))
            updater_macos.cleanup("9.9.9", bundle=self.bundle)
            self.assertFalse(self.backup.exists())
            self.assertFalse((self.base / "data" / "updates" / "work").exists())

    def test_missing_stage_leaves_old_bundle(self):
        result = self.run_helper(staged=self.work / "stage" / "missing.app")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.bundle / "old.txt").is_file())
        self.assertFalse(self.backup.exists())


@unittest.skipUnless(sys.platform == "darwin", "macOS full install pipeline")
class InstallPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.applications = self.base / "Applications"
        self.old_bundle = self.applications / "Haven.app"
        self.new_bundle = self.base / "build" / "Haven.app"
        self._make_signed_app(self.old_bundle, "0.1.0", "old")
        self._make_signed_app(self.new_bundle, "9.9.9", "new")
        self.package = self.base / "Haven-mac-arm64.zip"
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(self.new_bundle), str(self.package)], check=True)
        self.settings = self.base / "data" / "settings.json"

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _make_signed_app(bundle, version, marker):
        (bundle / "Contents" / "MacOS").mkdir(parents=True, exist_ok=True)
        executable = bundle / "Contents" / "MacOS" / "Haven"
        executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        executable.chmod(0o755)
        (bundle / "Contents" / "Resources").mkdir(exist_ok=True)
        (bundle / "Contents" / "Resources" / "marker.txt").write_text(marker, encoding="utf-8")
        (bundle / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": updater_macos.BUNDLE_IDENTIFIER,
            "CFBundleShortVersionString": version,
            "CFBundleExecutable": "Haven",
            "CFBundleName": "Haven",
            "CFBundlePackageType": "APPL",
        }))
        subprocess.run(["codesign", "--force", "--deep", "-s", "-", str(bundle)], check=True, capture_output=True)

    def test_download_verify_swap_and_cleanup(self):
        manifest = {"version": "9.9.9", "size": self.package.stat().st_size, "sha256": GOOD_SHA}
        package = self.package

        def fake_download(_manifest, destination, progress):
            import shutil as _shutil
            _shutil.copy2(package, destination)
            progress(100)

        with patch("config.STATE_PATH", self.settings), \
             patch("updater_macos.app_bundle", return_value=self.old_bundle), \
             patch("updater_macos.DEFAULT_OPEN_COMMAND", "/usr/bin/true"), \
             patch("updater_macos.os.getpid", return_value=999999), \
             patch("updater_macos.updater.download", side_effect=fake_download):
            updater_macos.install(manifest, lambda value: None)
            deadline = time.monotonic() + 20
            installed = None
            while time.monotonic() < deadline:
                try:
                    info = plistlib.loads((self.old_bundle / "Contents" / "Info.plist").read_bytes())
                except OSError:
                    info = {}
                if info.get("CFBundleShortVersionString") == "9.9.9":
                    installed = info
                    break
                time.sleep(0.2)
            self.assertIsNotNone(installed, "helper did not replace the bundle")
            self.assertEqual((self.old_bundle / "Contents" / "Resources" / "marker.txt").read_text(), "new")
            backup = self.applications / f"Haven.app.backup-{config.VERSION}"
            self.assertTrue(backup.is_dir())
            self.assertEqual((backup / "Contents" / "Resources" / "marker.txt").read_text(), "old")
            updater_macos.cleanup("9.9.9", bundle=self.old_bundle)
            self.assertFalse(backup.exists(), "old bundle must be removed after a successful update")
            self.assertFalse((self.base / "data" / "updates").exists())


if __name__ == "__main__":
    unittest.main()
