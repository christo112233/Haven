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
        # rawpy exposes sizes, but does not expose raw.metadata.
        return raw.sizes.width, raw.sizes.height
