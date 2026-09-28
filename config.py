from pathlib import Path
import sys

VERSION = "2.1.2"
CACHE_VERSION = 1
CACHE_NAME = ".Haven"
APP_DIR = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
STATE_PATH = APP_DIR / "haven-settings.json"
METADATA_DB_PATH = APP_DIR / "haven-metadata.sqlite3"
RAW = {".cr2", ".cr3", ".nef", ".arw", ".raf", ".dng", ".orf", ".rw2", ".pef", ".srw"}
HEIC = {".heic", ".heif"}
IMAGES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".tif"} | RAW | HEIC
VIDEOS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".wmv", ".webm", ".flv"}
SKIP = {".git", "__pycache__", "node_modules", ".thumbnails", ".haven", ".photovault", "$recycle.bin", "system volume information"}
REPOSITORY = "christo112233/Haven"
RELEASES = f"https://github.com/{REPOSITORY}/releases"
MANIFEST_URL = f"{RELEASES}/latest/download/update.json"
