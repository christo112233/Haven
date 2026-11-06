from io import BytesIO
from pathlib import Path
import os
import threading
from PIL import Image, ImageOps
import cache
import i18n
from config import RAW, VIDEOS
import heic_handler
import raw_handler
import video_handler

_locks = [threading.Lock() for _ in range(64)]

MODE_SIZES = {"thumb": 512, "display": 1280, "preview": 2560}
MODE_FOLDERS = {"thumb": "thumbs", "display": "displays", "preview": "previews"}
MODE_SUFFIXES = {"thumb": ".webp", "display": ".jpg", "preview": ".jpg"}


def render(item, mode="thumb"):
    path = Path(item["path"])
    if item["ext"] in RAW:
        image = raw_handler.decode(path, mode != "thumb")
    elif item["ext"] in VIDEOS:
        image = video_handler.frame(path)
    else:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).copy()
    with image:
        size = MODE_SIZES[mode]
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        stream = BytesIO()
        if mode == "thumb":
            image.convert("RGBA" if "A" in image.getbands() else "RGB").save(stream, "WEBP", quality=85)
        else:
            image.convert("RGB").save(stream, "JPEG", quality=90 if mode == "display" else 92)
        return stream.getvalue()


def get(item, mode="thumb"):
    path = Path(item["path"])
    target = cache.directory(path.parent, False) / MODE_FOLDERS[mode] / (path.name + MODE_SUFFIXES[mode])
    with _locks[hash(str(path)) % len(_locks)]:
        signature_path = target.with_suffix(target.suffix + ".json")
        expected = {"signature": item["signature"], "version": cache.CACHE_VERSION}
        if target.is_file() and cache.read_json(signature_path) == expected:
            return target.read_bytes(), None
        data = render(item, mode)
        warning = None
        try:
            cache.directory(path.parent)
            cache.atomic_bytes(target, data)
            cache.atomic_json(signature_path, expected)
        except OSError as exc:
            warning = i18n.tr("backend.warning.preview-cache-readonly", path=path.parent, error=exc)
        return data, warning
