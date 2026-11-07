from pathlib import Path
import os
import sys

VERSION = "3.3.2"
CACHE_VERSION = 3
CACHE_NAME = ".Haven"
IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"
APP_DIR = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
# Bilingual message catalogs shared by the Python backend and the web UI.
LOCALES_DIR = RESOURCE_DIR / "locales"
# macOS apps live in a sealed, often read-only bundle: user data belongs in
# Application Support. Windows keeps the portable beside-the-exe layout.
# HAVEN_DATA_DIR overrides the location (portable run, tests, sandboxes).
if os.environ.get("HAVEN_DATA_DIR"):
    DATA_DIR = Path(os.environ["HAVEN_DATA_DIR"]).expanduser()
elif IS_MACOS:
    DATA_DIR = Path.home() / "Library" / "Application Support" / "Haven"
else:
    DATA_DIR = APP_DIR
STATE_PATH = DATA_DIR / "haven-settings.json"
METADATA_DB_PATH = DATA_DIR / "haven-metadata.sqlite3"
# Default (per-machine) annotation library. Users can point this at a shared
# location such as a NAS folder to keep annotations in sync across platforms.
LIBRARY_DIR = DATA_DIR / "library"
RAW = {".cr2", ".cr3", ".nef", ".arw", ".raf", ".dng", ".orf", ".rw2", ".pef", ".srw"}
HEIC = {".heic", ".heif"}
IMAGES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".tif"} | RAW | HEIC
VIDEOS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".wmv", ".webm", ".flv"}
SKIP = {
    ".git", "__pycache__", "node_modules", ".thumbnails", ".haven", ".photovault",
    # Windows
    "$recycle.bin", "system volume information",
    # macOS (including metadata folders created on network shares)
    ".trashes", ".trash", ".spotlight-v100", ".fseventsd", ".temporaryitems",
    ".documentrevisions-v100", "__macosx", ".ds_store",
}
REPOSITORY = "christo112233/Haven"
RELEASES = f"https://github.com/{REPOSITORY}/releases"
MANIFEST_URL = f"{RELEASES}/latest/download/update.json"


def ensure_data_dir():
    """Create the writable per-user data directory and return it."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR
