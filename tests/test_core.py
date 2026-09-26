from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch, Mock
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.request import Request, urlopen
import zipfile

from PIL import Image
import imageio_ffmpeg
from api import Api
import cache
import config
import metadata
import scanner
import server
import thumbs
import updater
from updater_src import updater as helper


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(__file__).resolve().parents[1] / ".qa"
        self.workspace.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=self.workspace)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def photo(self, name="image.jpg", size=(1000, 600)):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", size, "#68a789").save(file)
        return file

    def test_scan_incremental_and_cache_version(self):
        file = self.photo()
        self.photo("child/other.png")
        self.photo(".git/hidden.jpg")
        items, _ = scanner.scan(self.root, True)
        self.assertEqual(len(items), 2)
        item = next(i for i in items if i["name"] == file.name)
        item["camera"] = "cached camera"
        cache.save(self.root, {file.name: item})
        self.assertEqual(scanner.scan(self.root)[0][0]["camera"], "cached camera")
        self.photo(size=(1400, 800))
        self.assertNotIn("camera", scanner.scan(self.root)[0][0])
        with patch("cache.CACHE_VERSION", 99):
            self.assertEqual(cache.load(self.root), {})

    def test_concurrent_cache_initialization(self):
        paths = [self.photo(f"image-{index}.jpg") for index in range(32)]
        items, _ = scanner.scan(self.root)
        with ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(thumbs.get, items))
        self.assertTrue(all(data and warning is None for data, warning in results))
        self.assertEqual(len(list((self.root / ".Haven" / "thumbs").glob("*.webp"))), len(paths))
        self.assertEqual(cache.read_json(self.root / ".Haven" / "owner.json"), {"app": "Haven"})

    def test_desktop_window_actions(self):
        with patch("config.STATE_PATH", self.root / "settings.json"):
            api = Api()
            try:
                with self.assertRaises(ValueError):
                    api.window_action("maximize")
                api.window = Mock()
                api.window_action("maximize")
                self.assertTrue(api._maximized)
                api.window.maximize.assert_called_once()
                api.window_action("maximize")
                self.assertFalse(api._maximized)
                api.window.restore.assert_called_once()
                api.window_action("minimize")
                api.window.minimize.assert_called_once()
                with self.assertRaises(ValueError):
                    api.window_action("unsupported")
                api.window_action("close")
                api.window.destroy.assert_called_once()
                api.resize_window(100, 200)
                api.window.resize.assert_called_once_with(800, 560)
            finally:
                api.pool.shutdown()
                api.raw_pool.shutdown()

    def test_thumbnails_orientation_and_invalidation(self):
        path = self.root / "portrait.jpg"
        exif = Image.Exif()
        exif[274] = 6
        exif[34665] = {36867: "2024:05:06 12:00:00", 42036: "Test lens"}
        Image.new("RGB", (900, 600), "red").save(path, exif=exif)
        info = metadata.read(path, ".jpg")
        self.assertEqual((info["width"], info["height"]), (600, 900))
        self.assertEqual(info["lens"], "Test lens")
        item = scanner.scan(self.root)[0][0]
        data, warning = thumbs.get(item)
        self.assertIsNone(warning)
        with Image.open(BytesIO(data)) as thumbnail:
            self.assertEqual(thumbnail.format, "WEBP")
            self.assertEqual(max(thumbnail.size), 512)
            self.assertLess(thumbnail.width, thumbnail.height)
        with patch("thumbs.render", side_effect=AssertionError("must reuse cache")):
            self.assertEqual(thumbs.get(item)[0], data)
        Image.new("RGB", (900, 600), "blue").save(path)
        changed = scanner.scan(self.root)[0][0]
        self.assertNotEqual(thumbs.get(changed)[0], data)

    def test_readonly_in_memory_and_owned_cleanup(self):
        self.photo()
        item = scanner.scan(self.root)[0][0]
        original = cache.directory
        def readonly(folder, create=True):
            if create:
                raise PermissionError("read only")
            return original(folder, False)
        with patch("cache.directory", side_effect=readonly):
            data, warning = thumbs.get(item)
            self.assertTrue(data)
            self.assertIn("内存", warning)
        self.assertFalse((self.root / ".Haven").exists())
        (self.root / ".Haven").mkdir()
        (self.root / ".Haven" / "personal.txt").write_text("do not delete")
        with self.assertRaises(PermissionError):
            cache.clean(self.root)
        self.assertTrue((self.root / ".Haven" / "personal.txt").exists())

    def test_video_and_motion_photo(self):
        path = self.root / "clip.mp4"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10", "-t", "1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True, capture_output=True)
        info = metadata.read(path, ".mp4")
        self.assertEqual((info["width"], info["height"]), (640, 360))
        self.assertGreater(info["duration"], 1)
        item = scanner.scan(self.root)[0][0]
        self.assertTrue(thumbs.get(item)[0])
        motion = self.root / "motion.jpg"
        payload = path.read_bytes()
        xmp = f'<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:camera="http://ns.google.com/photos/1.0/camera/"><camera:Motion camera:MicroVideoOffset="{len(payload)}" /></x:xmpmeta>'
        Image.new("RGB", (800, 600), "green").save(motion, xmp=xmp.encode())
        with motion.open("ab") as stream:
            stream.write(payload)
        self.assertEqual(metadata.read(motion, ".jpg")["motion_offset"], len(payload))

    def test_heic_and_tiff_preview(self):
        for extension, format_name in ((".heic", "HEIF"), (".tiff", "TIFF")):
            with self.subTest(extension=extension):
                path = self.root / ("photo" + extension)
                Image.new("RGB", (900, 600), "#75a4b8").save(path, format=format_name)
                self.assertEqual(metadata.read(path, extension)["width"], 900)
                item = next(i for i in scanner.scan(self.root)[0] if i["ext"] == extension)
                preview, warning = thumbs.get(item, True)
                self.assertIsNone(warning)
                with Image.open(BytesIO(preview)) as image:
                    self.assertEqual(image.format, "JPEG")
                    self.assertEqual(image.width, 900)

    @unittest.skipUnless((Path(__file__).resolve().parents[1] / ".qa" / "sample.CR2").is_file(), "Optional real camera fixture")
    def test_real_raw_process_pool(self):
        source = self.workspace / "sample.CR2"
        shutil.copy2(source, self.root / "camera.CR2")
        with patch("config.STATE_PATH", self.root / "settings.json"):
            api = Api()
            try:
                api.add_folder(str(self.root))
                job = api.open_folder(str(self.root))["job"]
                until = time.monotonic() + 60
                while time.monotonic() < until:
                    result = api.page(job)
                    if result["state"] in {"ready", "error"}:
                        break
                    time.sleep(.1)
                self.assertEqual(result["state"], "ready")
                item = result["items"][0]
                self.assertNotIn("error", item)
                self.assertGreater(item["width"], 0)
                self.assertTrue((self.root / ".Haven" / "thumbs" / "camera.CR2.webp").is_file())
                preview, warning = thumbs.get(item, True)
                self.assertIsNone(warning)
                with Image.open(BytesIO(preview)) as image:
                    self.assertLessEqual(max(image.size), 2560)
            finally:
                api.pool.shutdown()
                api.raw_pool.shutdown()

    def test_local_server_auth_range_and_path_boundary(self):
        path = self.photo()
        with patch("config.STATE_PATH", self.root / "settings.json"):
            api = Api()
            api.add_folder(str(self.root))
            service = server.start(api)
            try:
                base = api.base_url.split("?")[0]
                token = parse_qs(urlparse(api.base_url).query)["token"][0]
                with self.assertRaises(HTTPError) as error:
                    urlopen(base)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
                with urlopen(api.base_url) as response:
                    self.assertIn(token.encode(), response.read())
                url = base + "media?" + urlencode({"token": token, "path": str(path), "mode": "original"})
                with urlopen(Request(url, headers={"Range": "bytes=2-11"})) as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.read(), path.read_bytes()[2:12])
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(url, headers={"Range": "bytes=99999999-"}))
                self.assertEqual(error.exception.code, 416)
                error.exception.close()
                with self.assertRaises(PermissionError):
                    api.authorize(config.APP_DIR / "config.py")
                job = api.open_folder(str(self.root))["job"]
                until = time.monotonic() + 15
                while time.monotonic() < until:
                    result = api.page(job)
                    if result["state"] in {"ready", "error"}:
                        break
                    time.sleep(.05)
                self.assertEqual(result["state"], "ready")
                self.assertEqual(result["items"][0]["width"], 1000)
                self.assertEqual(api.page(job, kind="video")["filtered"], 0)
            finally:
                service.shutdown()
                service.server_close()
                api.pool.shutdown()
                api.raw_pool.shutdown()

    def test_update_validation_and_zip_traversal(self):
        good = {"version": "0.2.0", "url": config.RELEASES + "/download/v0.2.0/Haven-win64.zip", "size": 100, "sha256": "a" * 64}
        self.assertEqual(updater.validate_manifest(good, "0.1.0"), good)
        for changes in ({"version": "0.0.1"}, {"url": "http://github.com/file"}, {"sha256": "bad"}, {"url": "https://github.com/other/repo/releases/download/v1/file"}):
            with self.assertRaises(ValueError):
                updater.validate_manifest(good | changes, "0.1.0")
        package = self.root / "bad.zip"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("../escape.txt", "bad")
        with self.assertRaises(ValueError):
            helper.extract(package, self.root / "stage")
        self.assertFalse((self.root.parent / "escape.txt").exists())

    def test_updater_restores_partial_replacement(self):
        target, stage, backup = (self.root / name for name in ("target", "stage", "backup"))
        target.mkdir(); stage.mkdir()
        (target / "Haven.exe").write_text("old")
        (stage / "Haven.exe").write_text("new")
        (target / "haven-settings.json").write_text("user settings")
        original = shutil.move
        def fail_install(source, destination, *args, **kwargs):
            if Path(source) == stage / "Haven.exe":
                raise PermissionError("simulated locked file")
            return original(source, destination, *args, **kwargs)
        with patch("updater_src.updater.shutil.move", side_effect=fail_install):
            with self.assertRaises(PermissionError):
                helper.replace(target, stage, backup)
        self.assertEqual((target / "Haven.exe").read_text(), "old")
        self.assertEqual((target / "haven-settings.json").read_text(), "user settings")

    def test_complete_update_plan_preserves_settings(self):
        target = self.root / "target"
        target.mkdir()
        (target / "Haven.exe").write_text("old executable")
        (target / "version.txt").write_text("0.1.0")
        (target / "haven-settings.json").write_text("my photo folders")
        package = self.root / "package.zip"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("Haven.exe", "new executable")
            archive.writestr("version.txt", "0.2.0")
            archive.writestr("_internal/runtime.txt", "new runtime")
        digest = hashlib.sha256(package.read_bytes()).hexdigest()
        plan = {"target": str(target), "package": str(package), "pid": 12345, "current": "0.1.0", "manifest": {"version": "0.2.0", "size": package.stat().st_size, "sha256": digest}}
        plan_path = self.root / "plan.json"
        cache.atomic_json(plan_path, plan)
        with patch("updater_src.updater.wait_for_exit"), patch("updater_src.updater.subprocess.Popen") as launch:
            helper.apply(plan_path)
            launch.assert_called_once_with([str(target / "Haven.exe")], cwd=target)
        self.assertEqual((target / "version.txt").read_text(), "0.2.0")
        self.assertEqual((target / "haven-settings.json").read_text(), "my photo folders")
        self.assertEqual((self.root / "backup" / "Haven.exe").read_text(), "old executable")

    def test_download_checksum_failure_and_offline_check(self):
        data = b"invalid update payload"
        manifest = {"version": "0.2.0", "url": config.RELEASES + "/download/v0.2.0/Haven-win64.zip", "size": len(data), "sha256": "a" * 64}
        destination = self.root / "download.zip"
        with patch("updater.request", return_value=BytesIO(data)):
            with self.assertRaises(ValueError):
                updater.download(manifest, destination, lambda _: None)
        self.assertFalse(destination.exists())
        with patch("updater.request", side_effect=OSError("offline")):
            result = updater.check("0.1.0")
            self.assertFalse(result["available"])
            self.assertIn("offline", result["error"])


if __name__ == "__main__":
    unittest.main()
