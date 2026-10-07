from io import BytesIO
from PIL import Image
import rawpy


def decode(path, preview=False):
    with rawpy.imread(str(path)) as raw:
        if not preview:
            try:
                thumb = raw.extract_thumb()
                if thumb.format == rawpy.ThumbFormat.JPEG:
                    with Image.open(BytesIO(thumb.data)) as image:
                        return image.copy()
                return Image.fromarray(thumb.data)
            except (rawpy.LibRawError, OSError, ValueError):
                pass
        return Image.fromarray(raw.postprocess(half_size=True, use_camera_wb=True))


def dimensions(path):
    with rawpy.imread(str(path)) as raw:
        return raw.sizes.width, raw.sizes.height


def _format_shutter(seconds):
    seconds = float(seconds)
    if seconds >= 1:
        return f"{seconds:g}"
    reciprocal = 1.0 / seconds
    rounded = round(reciprocal)
    if abs(rounded - reciprocal) <= max(0.01, reciprocal * 0.02):
        return f"1/{rounded}"
    return f"{seconds:g}"


def metadata(path):
    """Width/height plus the EXIF fields rawpy exposes via raw.other / raw.lens."""
    with rawpy.imread(str(path)) as raw:
        data = {"width": raw.sizes.width, "height": raw.sizes.height}
        try:
            other = raw.other
        except Exception:
            other = None
        if other:
            try:
                if other.timestamp:
                    data["date"] = other.timestamp.timestamp()
            except (OSError, ValueError, OverflowError):
                pass
            if other.shutter_speed:
                data["shutter"] = _format_shutter(other.shutter_speed)
            if other.aperture:
                data["aperture"] = f"{other.aperture:g}"
            if other.iso_speed:
                data["iso"] = str(int(round(other.iso_speed)))
        try:
            lens = raw.lens
            parts = [part for part in (lens.make, lens.model) if part]
            if parts:
                data["lens"] = " ".join(parts)
        except Exception:
            pass
        return data
