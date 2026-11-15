"""python3 -m unittest desktop/scripts/asl/test_camera_select.py   (stdlib only; no camera needed)"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from camera_select import BUILTIN_TYPE, CONTINUITY_TYPE, Camera, choose_camera, locate_index, unique_format  # noqa: E402

MAC = Camera(1, "MacBook Air Camera", "MacBook Air Camera", BUILTIN_TYPE, 0x626C746E)
IPHONE = Camera(0, "iPhone (Sam)  Camera", "iPhone17,3", "AVCaptureDeviceTypeExternal", 0x6F6E6572)
USB = Camera(2, "Logitech BRIO", "BRIO", "AVCaptureDeviceTypeExternal", 0x75736220)


class ChooseCamera(unittest.TestCase):
    def test_builtin_preferred_even_when_the_iphone_is_index_0(self):
        c = choose_camera([IPHONE, MAC])
        self.assertEqual((c.index, c.camera.name, c.how), (1, "MacBook Air Camera", "automatic"))

    def test_builtin_recognized_by_type_transport_or_name(self):
        self.assertTrue(Camera(0, "Some Camera", "", BUILTIN_TYPE).builtin)
        self.assertTrue(Camera(0, "Some Camera", "", "", 0x626C746E).builtin)
        self.assertTrue(Camera(0, "FaceTime HD Camera").builtin)
        self.assertTrue(Camera(0, "Built-in Camera").builtin)
        self.assertFalse(IPHONE.builtin)
        self.assertTrue(IPHONE.continuity)
        self.assertTrue(Camera(0, "Desk View", "", CONTINUITY_TYPE).continuity)

    def test_explicit_index_always_wins(self):
        c = choose_camera([IPHONE, MAC], explicit_index=0)
        self.assertEqual((c.index, c.camera, c.how), (0, None, "explicit-index"))  # no name guessed for an index

    def test_explicit_index_that_does_not_exist_is_an_error(self):
        with self.assertRaises(ValueError):
            choose_camera([IPHONE, MAC], explicit_index=5)

    def test_explicit_name(self):
        self.assertEqual(choose_camera([MAC, IPHONE], name_query="iphone").index, 0)
        with self.assertRaises(ValueError):
            choose_camera([MAC, IPHONE], name_query="brio")

    def test_fallback_without_builtin_prefers_external_then_iphone(self):
        c = choose_camera([IPHONE, USB])
        self.assertEqual((c.index, c.camera.name), (2, "Logitech BRIO"))
        c = choose_camera([IPHONE])
        self.assertEqual((c.index, c.note), (0, "no built-in camera; falling back to the iPhone"))

    def test_unidentifiable_cameras_are_not_guessed(self):
        c = choose_camera(None)
        self.assertEqual((c.index, c.how), (0, "unidentified"))
        self.assertIn("--camera N", c.note)
        self.assertEqual(choose_camera(None, explicit_index=1).index, 1)  # an explicit choice still works
        with self.assertRaises(ValueError):
            choose_camera(None, name_query="MacBook")

    def test_no_camera_at_all(self):
        with self.assertRaises(ValueError):
            choose_camera([])


MAC_F = Camera(0, "MacBook Air Camera", "", BUILTIN_TYPE, formats=frozenset({(1920, 1080), (1552, 1552), (1280, 720)}))
IPHONE_F = Camera(1, "iPhone Camera", "iPhone17,3", "AVCaptureDeviceTypeExternal", formats=frozenset({(1920, 1080), (1920, 1440)}))


class LocateIndex(unittest.TestCase):
    """OpenCV's index is verified physically, never assumed from AVFoundation's order."""

    @staticmethod
    def probe_for(opencv_order):
        """A fake camera probe: OpenCV index -> camera; delivers the size if that camera supports it."""
        opened = []

        def probe(index, size):
            opened.append(index)
            cam = opencv_order[index] if index < len(opencv_order) else None
            return size if cam and size in cam.formats else (1920, 1080) if cam else None
        return probe, opened

    def test_finds_the_builtin_even_when_opencv_order_differs(self):
        # What the test Mac actually does: AVFoundation lists the MacBook first, OpenCV index 0 is the iPhone.
        probe, opened = self.probe_for([IPHONE_F, MAC_F])
        self.assertEqual(unique_format(MAC_F, [MAC_F, IPHONE_F]), (1552, 1552))
        self.assertEqual(locate_index(MAC_F, [MAC_F, IPHONE_F], probe), 1)
        self.assertEqual(opened, [0, 1])  # one camera at a time

    def test_same_order_is_confirmed_with_one_probe(self):
        probe, opened = self.probe_for([MAC_F, IPHONE_F])
        self.assertEqual(locate_index(MAC_F, [MAC_F, IPHONE_F], probe), 0)
        self.assertEqual(opened, [0])

    def test_iphone_located_by_its_own_unique_format(self):
        probe, _ = self.probe_for([IPHONE_F, MAC_F])
        self.assertEqual(locate_index(IPHONE_F, [MAC_F, IPHONE_F], probe), 0)

    def test_unverifiable_returns_none_instead_of_guessing(self):
        twin = Camera(1, "Other", formats=MAC_F.formats)
        probe, opened = self.probe_for([twin, MAC_F])
        self.assertIsNone(locate_index(MAC_F, [MAC_F, twin], probe))
        self.assertEqual(opened, [])

    def test_a_single_camera_needs_no_probe(self):
        probe, opened = self.probe_for([MAC_F])
        self.assertEqual(locate_index(MAC_F, [MAC_F], probe), 0)
        self.assertEqual(opened, [])


if __name__ == "__main__":
    unittest.main()
