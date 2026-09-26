import argparse
import multiprocessing
import os
from pathlib import Path
import threading
import time

from api import Api
from config import APP_DIR, RESOURCE_DIR
from server import start, METHODS


def main():
    parser = argparse.ArgumentParser(description="Haven local photo manager")
    parser.add_argument("--browser", action="store_true", help="Start browser development server")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--folder", help="Open a local photo folder")
    args = parser.parse_args()
    # WebView2 writes its runtime profile beside the application, never to AppData.
    profile = APP_DIR / ".haven-runtime"
    profile.mkdir(exist_ok=True)
    os.environ["WEBVIEW2_USER_DATA_FOLDER"] = str(profile)
    api = Api()
    if args.folder:
        api.add_folder(args.folder)
    server = start(api, args.port)
    if args.browser:
        print(api.base_url, flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            server.shutdown()
        return
    import webview
    window = webview.create_window("Haven", api.base_url, width=1440, height=920, min_size=(800, 560), background_color="#0d293d", frameless=True, easy_drag=False)
    # Expose only the frontend contract; native windows and executors stay private.
    window.expose(*(getattr(api, name) for name in sorted(METHODS)))
    api.window = window
    window.events.maximized += lambda: setattr(api, "_maximized", True)
    window.events.restored += lambda: setattr(api, "_maximized", False)
    def loaded():
        from webview.dom import DOMEventHandler
        def drop(event):
            for file in event.get("dataTransfer", {}).get("files", []):
                path = file.get("pywebviewFullPath")
                if path and Path(path).is_dir():
                    try:
                        result = api.add_folder(path)
                        api.emit("folder-added", result)
                    except Exception as exc:
                        api.emit("error", {"message": str(exc)})
        last_error = None
        for _ in range(50):
            try:
                sidebar = window.dom.get_element("#sidebar")
                if sidebar is not None:
                    sidebar.on("drop", DOMEventHandler(drop, prevent_default=True))
                    break
            except Exception as exc:
                last_error = exc
            time.sleep(.1)
        else:
            print(f"Native folder drop setup failed: {last_error or 'sidebar unavailable'}", flush=True)
            api.emit("error", {"message": f"无法启用文件夹拖放: {last_error or '侧边栏未加载'}"})
        def auto_check():
            time.sleep(5)
            if api.state.get("auto_update", True):
                result = api.check_update(False)
                if result.get("available"):
                    api.emit("update", result)
        threading.Thread(target=auto_check, daemon=True).start()
    window.events.loaded += loaded
    # The frameless window has no OS title bar, so the taskbar/title icon comes from this file.
    icon = RESOURCE_DIR / "logo.ico"
    webview.start(gui="edgechromium", storage_path=str(profile), private_mode=False, icon=str(icon) if icon.is_file() else None)
    server.shutdown()
    api.pool.shutdown(wait=False, cancel_futures=True)
    api.raw_pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
