import argparse
from pathlib import Path
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import config


def main():
    parser = argparse.ArgumentParser(description="Isolated Haven UI preview")
    parser.add_argument("--port", type=int, default=8877)
    parser.add_argument("--folder", default=str(ROOT / ".qa" / "gallery"))
    args = parser.parse_args()
    qa = ROOT / ".qa"
    qa.mkdir(exist_ok=True)
    config.STATE_PATH = qa / "preview-ui-settings.json"
    from api import Api
    from server import start
    api = Api()
    api.settings({"theme": "light", "thumb_size": 240, "auto_update": False})
    if Path(args.folder).is_dir():
        api.add_folder(args.folder)
    service = start(api, args.port)
    print(api.base_url, flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        service.shutdown()
        service.server_close()
        api.pool.shutdown(cancel_futures=True)
        api.raw_pool.shutdown(cancel_futures=True)


if __name__ == "__main__":
    main()
