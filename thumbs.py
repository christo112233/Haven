from io import BytesIO
from pathlib import Path
import os
import threading
from PIL import Image, ImageOps
import cache
from config import RAW, VIDEOS
import heic_handler
import raw_handler
import video_handler

_locks = [threading.Lock() for _ in range(64)]


def render(item, preview=False):
    path = Path(item["path"])
    if item["ext"] in RAW:
        image = raw_handler.decode(path, preview)
    elif item["ext"] in VIDEOS:
        image = video_handler.frame(path)
    else:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).copy()
    with image:
        image.thumbnail((2560, 2560) if preview else (512, 512), Image.Resampling.LANCZOS)
        stream = BytesIO()
        if preview:
            image.convert("RGB").save(stream, "JPEG", quality=92)
        else:
            image.convert("RGBA" if "A" in image.getbands() else "RGB").save(stream, "WEBP", quality=85)
        return stream.getvalue()


def get(item, preview=False):
    path = Path(item["path"])
    target = cache.directory(path.parent, False) / ("previews" if preview else "thumbs") / (path.name + (".jpg" if preview else ".webp"))
    with _locks[hash(str(path)) % len(_locks)]:
        signature_path = target.with_suffix(target.suffix + ".json")
        expected = {"signature": item["signature"], "version": cache.CACHE_VERSION}
        if target.is_file() and cache.read_json(signature_path) == expected:
            return target.read_bytes(), None
        data = render(item, preview)
        warning = None
        try:
            cache.directory(path.parent)
            cache.atomic_bytes(target, data)
            cache.atomic_json(signature_path, expected)
        except OSError as exc:
            warning = f"缓存不可写，仅使用内存预览：{path.parent} ({exc})"
        return data, warning
