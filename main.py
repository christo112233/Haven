import argparse
import multiprocessing
import os
from pathlib import Path
import threading
import time

from api import Api
import config
import i18n
import platform_support
from server import start, METHODS
from updater import cleanup_completed_updates


def main():
    parser = argparse.ArgumentParser(description="Haven local photo manager")
    parser.add_argument("--browser", action="store_true", help="Start browser development server")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--folder", help="Open a local photo folder")
    args = parser.parse_args()
    # User data lives in the writable per-user data directory; on macOS the app
    # bundle itself is sealed and must never be written at runtime.
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if config.IS_WINDOWS:
        # WebView2 writes its runtime profile beside the application, never to AppData.
        profile = config.DATA_DIR / ".haven-runtime"
        profile.mkdir(exist_ok=True)
        os.environ["WEBVIEW2_USER_DATA_FOLDER"] = str(profile)
    else:
        # Cocoa uses WKWebView's own data store; this directory is only a
        # placeholder for browser-mode data and future explicit stores.
        profile = config.DATA_DIR / "webview"
        profile.mkdir(exist_ok=True)
    api = Api()
    if config.IS_MACOS:
        try:
            import updater_macos
            updater_macos.cleanup(config.VERSION)
        except Exception:
            pass
    if args.folder:
        api.add_folder(args.folder)
    server = start(api, args.port)
    def cleanup_updates():
        for _ in range(10):
            time.sleep(1)
            cleanup_completed_updates(config.DATA_DIR)
    threading.Thread(target=cleanup_updates, daemon=True).start()
    if args.browser:
        print(api.base_url, flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            server.shutdown()
        return
    import webview
    if config.IS_MACOS:
        # pywebview's JS drag fallback moves the window via a chatty bridge and
        # has known multi-monitor issues; macOS uses the custom native drag in
        # app.js (api.drag_window) instead.
        webview.settings['DRAG_REGION_SELECTOR'] = '.haven-native-drag-disabled'
    # Windows keeps its frameless window with custom controls; macOS uses the
    # native title bar so the standard traffic lights stay available.
    window = webview.create_window("Haven", api.base_url, width=1440, height=920, min_size=(800, 560), background_color="#0d293d", frameless=config.IS_WINDOWS, easy_drag=False)
    # Expose only the frontend contract; native windows and executors stay private.
    window.expose(*(getattr(api, name) for name in sorted(METHODS)))
    api.window = window
    window.events.maximized += lambda: setattr(api, "_maximized", True)
    window.events.restored += lambda: setattr(api, "_maximized", False)
    def loaded():
        platform_support.configure_macos_window(window)
        if config.IS_MACOS:
            import macos_menu
            macos_menu.install(window, api)
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
            api.emit("error", {"message": i18n.tr("main.drop-failed", error=last_error or i18n.tr("main.sidebar-not-ready"))})
        def auto_check():
            time.sleep(5)
            if api.state.get("auto_update", True):
                result = api.check_update(False)
                if result.get("available"):
                    api.emit("update", result)
        threading.Thread(target=auto_check, daemon=True).start()
    window.events.loaded += loaded
    if config.IS_WINDOWS:
        # The frameless window has no OS title bar, so the taskbar/title icon
        # comes from this file.
        icon = config.RESOURCE_DIR / "logo.ico"
        webview.start(gui="edgechromium", storage_path=str(profile), private_mode=False, icon=str(icon) if icon.is_file() else None)
    else:
        # macOS takes its icon from the app bundle; a Windows .ico would not
        # produce a usable Dock image.
        webview.start(gui="cocoa", storage_path=str(profile), private_mode=False)
    server.shutdown()
    api.store.close()
    api.pool.shutdown(wait=False, cancel_futures=True)
    api.raw_pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
