from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import secrets
import threading
from urllib.parse import urlparse, parse_qs

import config
import thumbs
import metadata

METHODS = {"bootstrap", "settings", "window_action", "resize_window", "add_folder", "remove_folder", "folders", "open_folder", "page", "clean_cache", "file_action", "check_update", "install_update", "update_progress", "release_history"}


def start(api, port=0):
    token = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def headers_for(self, mime, length, status=200, extra=None):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(length))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            if extra:
                for key, value in extra.items():
                    self.send_header(key, value)
            self.end_headers()

        def send_json(self, value, status=200):
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.headers_for("application/json; charset=utf-8", len(body), status)
            self.wfile.write(body)

        def authenticated(self):
            host = self.headers.get("Host", "")
            return host == f"127.0.0.1:{self.server.server_port}"

        def do_POST(self):
            try:
                if not self.authenticated() or self.headers.get("X-Haven-Token") != token:
                    self.send_json({"error": "未授权"}, 403)
                    return
                method = self.path.removeprefix("/api/")
                if not self.path.startswith("/api/") or method not in METHODS:
                    self.send_json({"error": "API 不存在"}, 404)
                    return
                size = int(self.headers.get("Content-Length", 0))
                if size > 65536:
                    raise ValueError("请求过大")
                arguments = json.loads(self.rfile.read(size) or b"[]")
                self.send_json({"result": getattr(api, method)(*arguments)})
            except Exception as exc:
                self.send_json({"error": str(exc)}, 400)

        def do_GET(self):
            try:
                parsed = urlparse(self.path)
                query = parse_qs(parsed.query)
                if not self.authenticated() or query.get("token", [""])[0] != token:
                    self.send_json({"error": "未授权"}, 403)
                    return
                if parsed.path == "/media":
                    path = query.get("path", [""])[0]
                    item = api.media_item(path)
                    mode = query.get("mode", ["thumb"])[0]
                    if mode == "motion":
                        offset = metadata.read(item["path"], item["ext"]).get("motion_offset", 0)
                        if not offset:
                            raise ValueError("文件不包含支持的 Motion Photo 视频")
                        original = Path(item["path"])
                        self.stream_file(original, original.stat().st_size - offset, "video/mp4")
                        return
                    if mode == "original":
                        self.stream_file(Path(item["path"]))
                        return
                    if mode not in {"thumb", "preview"}:
                        raise ValueError("未知媒体模式")
                    body, warning = thumbs.get(item, mode == "preview")
                    self.headers_for("image/jpeg" if mode == "preview" else "image/webp", len(body))
                    self.wfile.write(body)
                    return
                name = "index.html" if parsed.path == "/" else parsed.path.lstrip("/")
                root = (config.RESOURCE_DIR / "web").resolve()
                file = (root / name).resolve()
                file.relative_to(root)
                body = file.read_bytes()
                if name == "index.html":
                    body = body.replace(b"__HAVEN_TOKEN__", token.encode())
                self.headers_for(mimetypes.guess_type(str(file))[0] or "application/octet-stream", len(body))
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                self.send_json({"error": str(exc)}, 404)

        def stream_file(self, file, base=0, mime=None):
            size = file.stat().st_size - base
            start, end, status = 0, size - 1, 200
            extra = {"Accept-Ranges": "bytes"}
            range_header = self.headers.get("Range")
            if range_header:
                try:
                    unit, part = range_header.split("=", 1)
                    first, last = part.split("-", 1)
                    if unit != "bytes" or "," in part:
                        raise ValueError()
                    if first:
                        start = int(first)
                        end = min(int(last), size - 1) if last else size - 1
                    else:
                        start = max(0, size - int(last))
                    if start < 0 or start >= size or end < start:
                        raise ValueError()
                except ValueError:
                    self.headers_for("text/plain", 0, 416, {"Content-Range": f"bytes */{size}"})
                    return
                status = 206
                extra["Content-Range"] = f"bytes {start}-{end}/{size}"
            self.headers_for(mime or mimetypes.guess_type(str(file))[0] or "application/octet-stream", end - start + 1, status, extra)
            with file.open("rb") as stream:
                stream.seek(base + start)
                remaining = end - start + 1
                while remaining > 0:
                    block = stream.read(min(256 * 1024, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    api.base_url = f"http://127.0.0.1:{server.server_port}/?token={token}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
