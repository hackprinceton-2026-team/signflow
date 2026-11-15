"""Print every message live.py sends over the WebSocket (for frontend testing).

    python src/ws_client_demo.py [--url ws://localhost:8765] [--retry 30]

Start it before or after live.py; it keeps retrying until the server is up (--retry seconds).
No camera needed for a test: in another terminal run
    python src/live.py --headless --video data/webcam/HELP-20261114-200819.mp4 --video data/webcam/NO-20261114-204612.mp4
"""
import argparse
import json
import time

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://localhost:8765")
    ap.add_argument("--retry", type=float, default=30, help="seconds to keep trying to connect")
    args = ap.parse_args()

    deadline = time.time() + args.retry
    while True:
        try:
            ws = connect(args.url)
            break
        except OSError:
            if time.time() > deadline:
                raise SystemExit(f"could not connect to {args.url} - is live.py running?")
            time.sleep(0.5)
    print(f"connected to {args.url}", flush=True)
    try:
        for text in ws:
            msg = json.loads(text)
            if msg["type"] == "sign":
                print(f"SIGN  {msg['sign']:<10} confidence {msg['confidence']:.2f}   raw: {text}", flush=True)
            elif msg["type"] == "end_of_sentence":
                print(f"END OF SENTENCE  {' '.join(msg['signs'])}   raw: {text}", flush=True)
            else:
                print("OTHER", text, flush=True)
    except ConnectionClosed:
        pass
    print("server closed the connection", flush=True)


if __name__ == "__main__":
    main()
