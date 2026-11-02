"""Platform integration tests that run on the host platform."""
import os
import unittest
from pathlib import Path
from unittest.mock import patch
import tempfile

import platform_support


class EntryNameTests(unittest.TestCase):
    def test_accepts_normal_names(self):
        for name in ("photo.jpg", "旅行 2024", "a.b.c", "DSC_0001.CR3"):
            self.assertEqual(platform_support.validate_entry_name(name), name)

    def test_rejects_cross_platform_unsafe_names(self):
        for name in ("", "  ", ".", "..", "a/b", "a\\b", "a:b", "a?b", "a*b", 'a"b', "a<b", "a>b", "a|b",
                     "trailing.", "trailing ", "CON", "nul.jpg", "COM1", "lpt9.txt", "a\x00b", "a\nb"):
            with self.assertRaises(ValueError, msg=name):
                platform_support.validate_entry_name(name)

    def test_rejects_overlong_utf8_name(self):
        with self.assertRaises(ValueError):
            platform_support.validate_entry_name("长" * 100)


class PathIdentityTests(unittest.TestCase):
    def test_same_path_is_case_insensitive_on_default_mac_and_windows_volumes(self):
        if platform_support.IS_WINDOWS or platform_support.IS_MACOS:
            self.assertTrue(platform_support.same_path("/tmp/Photos/a.jpg", "/tmp/photos/A.JPG"))
        self.assertTrue(platform_support.same_path("/tmp/a.jpg", "/tmp/a.jpg"))
        self.assertFalse(platform_support.same_path("/tmp/a.jpg", "/tmp/b.jpg"))

    def test_contains_path(self):
        with tempfile.TemporaryDirectory() as folder:
            child = Path(folder) / "sub" / "a.jpg"
            self.assertTrue(platform_support.contains_path(folder, child))
            self.assertTrue(platform_support.contains_path(folder, folder))
            self.assertFalse(platform_support.contains_path(folder, Path(folder).parent))


class ShellIntegrationTests(unittest.TestCase):
    def test_subprocess_flags(self):
        flags = platform_support.subprocess_flags()
        self.assertIsInstance(flags, dict)
        if not platform_support.IS_WINDOWS:
            self.assertEqual(flags, {})

    def test_reveal_and_open_commands(self):
        if not platform_support.IS_MACOS:
            self.skipTest("macOS command shape")
        with patch("platform_support.subprocess.Popen") as popen:
            platform_support.reveal_path("/tmp/a.jpg")
            popen.assert_called_with(["open", "-R", "/tmp/a.jpg"])
        with patch("platform_support.subprocess.Popen") as popen:
            platform_support.open_path("/tmp/a.jpg")
            popen.assert_called_with(["open", "/tmp/a.jpg"])
        with patch("platform_support.subprocess.Popen") as popen:
            platform_support.open_defaults(["/tmp/a.jpg", "/tmp/b.jpg"])
            popen.assert_called_with(["open", "/tmp/a.jpg", "/tmp/b.jpg"])
        with patch("platform_support.subprocess.Popen") as popen:
            platform_support.open_with_editor("/Applications/Adobe Photoshop.app", ["/tmp/a.jpg"])
            popen.assert_called_with(["open", "-a", "/Applications/Adobe Photoshop.app", "/tmp/a.jpg"])

    def test_macos_copy_path_uses_pbcopy(self):
        if not platform_support.IS_MACOS:
            self.skipTest("macOS clipboard")
        with patch("platform_support.subprocess.run") as run:
            platform_support.copy_text("/tmp/a.jpg")
            args = run.call_args[0][0]
            self.assertEqual(args, ["/usr/bin/pbcopy"])
            self.assertEqual(run.call_args[1]["input"], b"/tmp/a.jpg")

    def test_windows_shell_commands(self):
        with patch.object(platform_support, "IS_WINDOWS", True), patch.object(platform_support, "IS_MACOS", False), \
             patch.object(platform_support.subprocess, "Popen") as popen, patch.object(platform_support.os, "startfile", create=True) as startfile:
            platform_support.open_path("D:\\Photos\\a.jpg")
            startfile.assert_called_once_with("D:\\Photos\\a.jpg")
            platform_support.reveal_path("D:\\Photos\\a.jpg")
            popen.assert_called_once_with(["explorer.exe", "/select,", "D:\\Photos\\a.jpg"])
        with patch.object(platform_support, "IS_WINDOWS", False), patch.object(platform_support, "IS_MACOS", False), \
             patch.object(platform_support.subprocess, "Popen") as popen:
            platform_support.open_path("/tmp/a.jpg")
            popen.assert_called_once_with(["xdg-open", "/tmp/a.jpg"])

    def test_detect_editors_structure(self):
        editors = platform_support.detect_editors()
        self.assertEqual(editors[0]["id"], "default")
        self.assertEqual({editor["id"] for editor in editors}, {"default", "photoshop", "lightroom"})
        for editor in editors:
            self.assertIn("name", editor)
            self.assertIn("available", editor)
            self.assertIsInstance(editor["available"], bool)


if __name__ == "__main__":
    unittest.main()
