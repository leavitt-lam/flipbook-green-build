import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fitz

import enhanced_server as enhanced


class EnhancedServerTests(unittest.TestCase):
    def test_model_number_is_not_removed_as_page_number(self):
        self.assertEqual(enhanced.clean_name("BUDG BEAM 300"), "BUDG BEAM 300")
        self.assertEqual(enhanced.clean_name("BUDG BEAM 300 90/91"), "BUDG BEAM 300")

    def test_spread_page_number_parser(self):
        self.assertEqual(enhanced.page_number_from_text("SUPER SCOPE 100/101 HYBRID PRO"), 100)
        self.assertEqual(enhanced.page_number_from_text("SEA ANGEL 110 | 111"), 110)

    def test_vector_card_cluster_and_printed_page_map(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "fixture.pdf"
            doc = fitz.open()
            for physical in range(1, 7):
                page = doc.new_page(width=800, height=600)
                page.insert_text((30, 580), str(100 + physical), fontsize=8)
                if physical == 3:
                    for row in range(2):
                        for col in range(4):
                            x = 70 + col * 120
                            y = 140 + row * 100
                            page.draw_rect(fitz.Rect(x, y, x + 80, y + 45), color=(0.4, 0.4, 0.4), width=0.5)
                            page.insert_text((x, y + 58), f"PRODUCT {row * 4 + col}", fontsize=7)
            doc.save(path)
            doc.close()

            with fitz.open(path) as reopened:
                rects = enhanced.repeated_card_rects(reopened[2])
                self.assertEqual(len(rects), 8)
                mapping = enhanced.fit_printed_page_map(reopened)
                self.assertIsNotNone(mapping)
                self.assertEqual(enhanced.map_printed_page(mapping, 104, len(reopened)), 4)

            with mock.patch.object(enhanced, "find_tesseract", return_value=None):
                report = enhanced.analyze_catalog(path, 3, Path(temp))
            first = report["zones"][0]
            self.assertAlmostEqual(first["x"], 67 / 800, places=5)
            self.assertAlmostEqual(first["y"], 137 / 600, places=5)
            self.assertAlmostEqual(first["x"] + first["w"], 153 / 800, places=5)

    def test_document_font_digit_recognition_without_tesseract(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "font-ocr.pdf"
            doc = fitz.open()
            label_rect = fitz.Rect(70, 140, 150, 185)
            for physical in range(1, 13):
                page = doc.new_page(width=800, height=600)
                page.insert_text((30, 580), str(100 + physical), fontsize=8)
                if physical == 3:
                    page.draw_rect(label_rect, color=(0.4, 0.4, 0.4), width=0.5)
                    page.insert_text((122, 198), "104/105", fontsize=8, color=(0.45, 0.45, 0.45))
            doc.save(path)
            doc.close()

            with fitz.open(path) as reopened:
                mapping = enhanced.fit_printed_page_map(reopened)
                templates = enhanced.learn_digit_templates(reopened)
                printed, confidence = enhanced.recognize_label_from_templates(
                    reopened[2], label_rect, mapping, len(reopened), templates
                )
            self.assertEqual(printed, 104)
            self.assertGreaterEqual(confidence, 0.72)


if __name__ == "__main__":
    unittest.main()
