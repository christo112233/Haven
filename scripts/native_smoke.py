import json
from pathlib import Path
import sys
import threading
import time

IS_WINDOWS = sys.platform == "win32"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import webview
try:
    from webview.dom import _dnd_state
except ImportError:  # pywebview builds outside Windows may not expose the drag state
    _dnd_state = None
import main
import config

original = webview.create_window
result = {}

# The frosted glass is plain CSS now: the sidebar must compute a backdrop blur.
BACKDROP_FILTER_JS = """(() => {
  const sidebar = document.querySelector('#sidebar');
  if (!sidebar) return '';
  const style = getComputedStyle(sidebar);
  return style.backdropFilter || style.webkitBackdropFilter || '';
})()"""


def create_window(*args, **kwargs):
    kwargs["hidden"] = True
    window = original(*args, **kwargs)
    def verify():
        try:
            window.evaluate_js("window.pywebview.api.bootstrap().then(value => window.__nativeSmoke = value)")
            until = time.monotonic() + 20
            while time.monotonic() < until:
                value = window.evaluate_js("window.__nativeSmoke || null")
                if value:
                    result.update(value)
                    break
                time.sleep(.1)
            assert result.get("desktop") is True, "Native bootstrap did not report desktop mode"
            until = time.monotonic() + 10
            while time.monotonic() < until:
                if window.evaluate_js("document.documentElement.dataset.theme || ''"):
                    break
                time.sleep(.1)
            result["heading"] = window.evaluate_js("document.querySelector('#folder-title').textContent")
            result["api_methods"] = window.evaluate_js("Object.keys(window.pywebview.api)")
            assert "bootstrap" in result["api_methods"]
            assert "window" not in result["api_methods"]
            result["backdrop_filter"] = window.evaluate_js(BACKDROP_FILTER_JS) or ""
            assert "blur(" in result["backdrop_filter"], "Native sidebar must keep its CSS frosted glass: %r" % result["backdrop_filter"]
            if IS_WINDOWS and _dnd_state is not None:
                until = time.monotonic() + 5
                while _dnd_state['num_listeners'] == 0 and time.monotonic() < until:
                    time.sleep(.05)
                result["drop_listeners"] = _dnd_state['num_listeners']
                assert result["drop_listeners"] > 0, "Native folder drop listener is missing"
            result["passed"] = True
        except Exception as exc:
            result.update(passed=False, error=str(exc))
        finally:
            window.destroy()
    window.events.loaded += lambda: threading.Thread(target=verify, daemon=True).start()
    return window


if __name__ == "__main__":
    qa = Path(__file__).resolve().parents[1] / ".qa"
    qa.mkdir(exist_ok=True)
    config.STATE_PATH = qa / "native-smoke-settings.json"
    webview.create_window = create_window
    main.main()
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result.get("passed") else 1)
