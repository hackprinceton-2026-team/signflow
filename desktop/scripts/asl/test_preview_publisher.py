"""python3 -m unittest desktop/scripts/asl/test_preview_publisher.py   (stdlib only; no camera or OpenCV needed)"""
import json
import os
import sys
import threading
import time
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from signflow_recognizer import PreviewPublisher  # noqa: E402


class FakeImage:
    def __init__(self, w, h):
        self.shape = (h, w, 3)


class FakeBuf:
    def tobytes(self):
        return b"\xff\xd8\xff-jpeg"


class FakeCV2:
    INTER_AREA = 3
    IMWRITE_JPEG_QUALITY = 1

    def __init__(self, encode_delay=0.0):
        self.encode_delay = encode_delay
        self.sizes = []
        self.qualities = []

    def resize(self, img, size, interpolation):
        self.sizes.append(size)
        return FakeImage(*size)

    def imencode(self, ext, img, params):
        time.sleep(self.encode_delay)
        self.qualities.append(params[1])
        return True, FakeBuf()


class FakeWS:
    def __init__(self):
        self.clients = {object()}
        self.sent = []

    def send(self, text):
        self.sent.append(json.loads(text))


def engine():
    return SimpleNamespace(results=None, state="waiting", spacebar=False, last=None, keyword=False, sentence=["HELP"])


def wait_for(cond, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.005)
    return False


class PreviewPublisherTest(unittest.TestCase):
    def make(self, cv2=None, fps=1000, width=640, quality=80, draw=None):
        self.ws = FakeWS()
        self.cv2 = cv2 or FakeCV2()
        live = SimpleNamespace(draw=draw or (lambda snap, bgr: bgr), log=lambda *_: None)
        pub = PreviewPublisher(self.cv2, live, self.ws, width, quality, fps)
        self.addCleanup(pub.close)
        return pub

    def test_sends_640px_quality_80_keeping_the_camera_aspect_ratio(self):
        pub = self.make()
        pub.offer(engine(), FakeImage(1920, 1080), time.time())
        self.assertTrue(wait_for(lambda: self.ws.sent))
        msg = self.ws.sent[0]
        self.assertEqual((msg["type"], msg["width"], msg["height"]), ("preview", 640, 360))
        self.assertEqual(self.cv2.qualities, [80])
        pub.offer(engine(), FakeImage(1552, 1552), time.time() + 1)  # a square camera stays square
        self.assertTrue(wait_for(lambda: len(self.ws.sent) == 2))
        self.assertEqual((self.ws.sent[1]["width"], self.ws.sent[1]["height"]), (640, 640))
        self.assertTrue(msg["jpeg"].startswith("/9j/"))  # base64 of a JPEG start-of-image

    def test_never_upscales_a_smaller_camera(self):
        pub = self.make()
        pub.offer(engine(), FakeImage(320, 240), time.time())
        self.assertTrue(wait_for(lambda: self.ws.sent))
        self.assertEqual((self.ws.sent[0]["width"], self.ws.sent[0]["height"]), (320, 240))

    def test_offer_never_blocks_and_only_the_newest_frame_is_kept(self):
        pub = self.make(cv2=FakeCV2(encode_delay=0.2))
        t0 = time.perf_counter()
        base = time.time()
        pub.offer(engine(), FakeImage(1920, 1080), base)
        time.sleep(0.02)  # the publisher thread is now encoding frame 0 (takes 0.2 s)
        for i in range(1, 5):  # the loop keeps going meanwhile
            pub.offer(engine(), FakeImage(1920, 1080), base + i)
        self.assertLess(time.perf_counter() - t0, 0.1)  # 5 offers incl. the 20 ms pause: no waiting on encoding
        self.assertTrue(wait_for(lambda: len(self.ws.sent) == 2, timeout=3))
        time.sleep(0.3)
        self.assertEqual(len(self.ws.sent), 2)  # the first, then the newest; the 3 in between were dropped
        self.assertEqual(self.ws.sent[1]["ts"], round(base + 4, 3))
        self.assertGreaterEqual(pub.dropped, 3)

    def test_rate_is_capped(self):
        pub = self.make(fps=10)
        now = time.time()
        for i in range(30):  # 30 loop frames within 0.29 s
            pub.offer(engine(), FakeImage(1920, 1080), now + i * 0.01)
        wait_for(lambda: len(self.ws.sent) >= 3)
        time.sleep(0.05)
        self.assertLessEqual(len(self.ws.sent), 3)

    def test_slow_encoding_steps_the_width_down(self):
        pub = self.make(fps=1000, width=640)
        pub.interval = 0.01  # budget 6 ms
        for _ in range(15):
            pub._adapt(0.05)
        self.assertEqual(pub.width, 480)

    def test_a_failing_frame_never_breaks_the_publisher(self):
        calls = []

        def draw(snap, bgr):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("bad frame")
            return bgr

        pub = self.make(draw=draw)
        pub.offer(engine(), FakeImage(1920, 1080), time.time())
        self.assertTrue(wait_for(lambda: calls))
        pub.offer(engine(), FakeImage(1920, 1080), time.time() + 1)
        self.assertTrue(wait_for(lambda: self.ws.sent))

    def test_no_clients_nothing_sent(self):
        pub = self.make()
        self.ws.clients = set()
        pub.offer(engine(), FakeImage(1920, 1080), time.time())
        time.sleep(0.1)
        self.assertEqual(self.ws.sent, [])
        self.assertIsInstance(threading.active_count(), int)


if __name__ == "__main__":
    unittest.main()
