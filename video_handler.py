from io import BytesIO
import re
import subprocess
import imageio_ffmpeg
from PIL import Image

FLAGS = {"creationflags": subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}


def metadata(path):
    result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, timeout=20, **FLAGS)
    output = result.stderr.decode("utf-8", errors="replace")
    duration = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", output)
    size = re.search(r"Video:.*?\b(\d{2,6})x(\d{2,6})\b", output)
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3]) if duration else 0
    return {"duration": seconds, "width": int(size[1]) if size else 0, "height": int(size[2]) if size else 0}


def frame(path):
    binary = imageio_ffmpeg.get_ffmpeg_exe()
    for position in ("1", "0"):
        result = subprocess.run([binary, "-v", "error", "-ss", position, "-i", str(path), "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], capture_output=True, timeout=40, **FLAGS)
        if result.returncode == 0 and result.stdout:
            with Image.open(BytesIO(result.stdout)) as image:
                return image.copy()
    raise ValueError("视频抽帧失败")
