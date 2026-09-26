from datetime import datetime
import xml.etree.ElementTree as ET
from PIL import Image, ExifTags
import heic_handler  # Registers the Pillow decoder before any files are opened.
from config import RAW, VIDEOS
import raw_handler
import video_handler


def read(path, ext):
    if ext in VIDEOS:
        return video_handler.metadata(path)
    if ext in RAW:
        width, height = raw_handler.dimensions(path)
        return {"width": width, "height": height}
    with Image.open(path) as image:
        exif = image.getexif()
        values = {ExifTags.TAGS.get(key, key): value for key, value in exif.items()}
        try:
            values.update({ExifTags.TAGS.get(key, key): value for key, value in exif.get_ifd(34665).items()})
        except (KeyError, TypeError, ValueError):
            pass
        width, height = image.size
        if values.get("Orientation") in (5, 6, 7, 8):
            width, height = height, width
        data = {"width": width, "height": height}
        xmp = image.info.get("xmp")
        if xmp:
            try:
                root = ET.fromstring(xmp)
                offset = 0
                for node in root.iter():
                    attributes = {key.rsplit("}", 1)[-1]: value for key, value in node.attrib.items()}
                    if "MicroVideoOffset" in attributes:
                        offset = int(attributes["MicroVideoOffset"])
                    if attributes.get("Mime") == "video/mp4" and attributes.get("Length"):
                        offset = int(attributes["Length"])
                if offset > 0:
                    from pathlib import Path
                    source = Path(path)
                    start = source.stat().st_size - offset
                    if start > 0:
                        with source.open("rb") as stream:
                            stream.seek(start + 4)
                            if stream.read(4) == b"ftyp":
                                data["motion_offset"] = offset
            except (ET.ParseError, ValueError, OSError):
                pass
        for source, target in (("Model", "camera"), ("LensModel", "lens"), ("ISOSpeedRatings", "iso"), ("FNumber", "aperture"), ("ExposureTime", "shutter")):
            if source in values:
                data[target] = str(values[source])
        try:
            data["date"] = datetime.strptime(str(values["DateTimeOriginal"]), "%Y:%m:%d %H:%M:%S").timestamp()
        except (KeyError, ValueError, OverflowError):
            pass
        return data
