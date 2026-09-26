import json
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import webview
import main
import config

original = webview.create_window
result = {}


def create_window(*args, **kwargs):
    kwargs["hidden"] = True
    window = original(*args, **kwargs)
    def verify():
        try:
            window.evaluate_js("window.pywebview.api.bootstrap().then(value => window.__nativeSmoke = value)")
            until = time.monotonic() + 20
            while time.monotonic() < until:
                value = window.evaluate_js("window.__nativeSmoke || null")
                glass = window.evaluate_js("window.havenGlass ? window.havenGlass.diagnostics : null")
                if glass and glass.get("ready") and not glass.get("frames"):
                    window.evaluate_js("window.havenGlass.renderOnce()")
                    glass = window.evaluate_js("window.havenGlass.diagnostics")
                if value and glass and ((glass.get("ready") and glass.get("frames", 0) > 0) or glass.get("error")):
                    result.update(value)
                    result["glass"] = glass
                    break
                time.sleep(.1)
            result["heading"] = window.evaluate_js("document.querySelector('#folder-title').textContent")
            result["api_methods"] = window.evaluate_js("Object.keys(window.pywebview.api)")
            assert result.get("desktop") is True
            assert "bootstrap" in result["api_methods"]
            assert "window" not in result["api_methods"]
            assert result["glass"]["ready"] is True, result["glass"]
            result["glass_pixel"] = window.evaluate_js("(() => { const canvas = document.querySelector('#liquid-canvas'); const gl = canvas.getContext('webgl2'); const rect = document.querySelector('#sidebar').getBoundingClientRect(); const scale = canvas.width / innerWidth; const pixel = new Uint8Array(4); gl.readPixels(Math.floor((rect.x + rect.width / 2) * scale), Math.floor((innerHeight - rect.y - 30) * scale), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return [...pixel]; })()")
            assert result["glass_pixel"][3] > 0, "Native glass canvas is blank"
            result["passed"] = True
        except Exception as exc:
            result.update(passed=False, error=str(exc))
        finally:
            window.destroy()
    window.events.loaded += verify
    return window


if __name__ == "__main__":
    qa = Path(__file__).resolve().parents[1] / ".qa"
    qa.mkdir(exist_ok=True)
    config.STATE_PATH = qa / "native-smoke-settings.json"
    webview.create_window = create_window
    main.main()
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result.get("passed") else 1)
