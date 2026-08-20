#!/usr/bin/env python3
"""FLIPBOOK_FORGE v3.6 enhanced local server.

The browser editor remains the UI.  This localhost-only companion adds the
operations that a sandboxed browser cannot do reliably:

* image-aware PDF compression while preserving text/vector objects;
* independent MuPDF rendering for pages that PDF.js is likely to misrender;
* exact catalogue-card geometry from the PDF drawing layer;
* self-trained recognition of outlined page-number labels, with optional Tesseract fallback.

It intentionally uses only the Python standard library plus PyMuPDF.  If
Ghostscript is available it is preferred for compression; otherwise PyMuPDF's
image rewriter is used.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import webbrowser
import zipfile
from collections import Counter
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    # PyMuPDF 1.24+ exposes ``pymupdf`` as the canonical package name.
    # Importing it directly is also important for the portable build: the
    # replaceable tool layer is loaded at runtime, so PyInstaller cannot see
    # its legacy ``import fitz`` statement during static analysis.
    import pymupdf as fitz
except Exception as pymupdf_exc:  # pragma: no cover - compatibility fallback
    try:
        import fitz  # type: ignore[no-redef]
    except Exception as fitz_exc:  # pragma: no cover - displayed by launcher
        fitz = None
        FITZ_IMPORT_ERROR = f"pymupdf: {pymupdf_exc}; fitz: {fitz_exc}"
    else:
        FITZ_IMPORT_ERROR = ""
else:
    FITZ_IMPORT_ERROR = ""

try:
    import pypdfium2 as pdfium
except Exception as exc:
    pdfium = None
    PDFIUM_IMPORT_ERROR = str(exc)
else:
    PDFIUM_IMPORT_ERROR = ""

try:
    import numpy as np
    from PIL import Image
except Exception as exc:
    np = None
    Image = None
    TEMPLATE_OCR_IMPORT_ERROR = str(exc)
else:
    TEMPLATE_OCR_IMPORT_ERROR = ""


APP_ROOT = Path(os.environ.get("FLIPBOOK_TOOL_ROOT") or getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
INSTALL_ROOT = Path(os.environ.get("FLIPBOOK_BUNDLE_ROOT") or (Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else APP_ROOT))
MAX_UPLOAD = 600 * 1024 * 1024
PROFILE_OPTIONS = {
    "quality": {"dpi": 180, "jpeg": 88, "webp_width": 3000, "webp_quality": 90},
    "balanced": {"dpi": 150, "jpeg": 84, "webp_width": 2600, "webp_quality": 87},
    "small": {"dpi": 110, "jpeg": 74, "webp_width": 2000, "webp_quality": 80},
    "original": {"dpi": 0, "jpeg": 0, "webp_width": 2600, "webp_quality": 87},
}


def find_executable(env_name: str, names: list[str], bundled_globs: list[str] | None = None) -> str | None:
    configured = os.environ.get(env_name, "").strip()
    if configured and Path(configured).is_file():
        return configured
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    for pattern in bundled_globs or []:
        for root in dict.fromkeys([INSTALL_ROOT, APP_ROOT]):
            for candidate in sorted(root.glob(pattern), reverse=True):
                if candidate.is_file():
                    return str(candidate)
    return None


def find_ghostscript() -> str | None:
    return find_executable(
        "FLIPBOOK_GS",
        ["gswin64c.exe", "gswin32c.exe", "gs"],
        ["tools/ghostscript/**/gswin64c.exe", "tools/ghostscript/**/gswin32c.exe"],
    )


def find_tesseract() -> str | None:
    return find_executable(
        "FLIPBOOK_TESSERACT",
        ["tesseract.exe", "tesseract"],
        ["tools/tesseract/tesseract.exe"],
    )


def median(values: list[float], fallback: float = 0.0) -> float:
    return statistics.median(values) if values else fallback


def clean_name(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    # A trailing standalone number may be part of the model name (BUDG BEAM 300).
    # Only the unambiguous spread-page form is stripped here.
    text = re.sub(r"(?:\s+|^)(?:\d{1,4}\s*[/|]\s*\d{1,4})\s*$", "", text).strip()
    return text[:80]


def page_number_from_text(text: str) -> int | None:
    matches = re.findall(r"(?<!\d)(\d{1,4})\s*[/|]\s*(\d{1,4})(?!\d)", text or "")
    for first, second in reversed(matches):
        a, b = int(first), int(second)
        if 1 <= a <= 9999 and 0 <= b - a <= 2:
            return a
    singles = re.findall(r"(?<![A-Z0-9])(\d{1,3})(?![A-Z0-9])", (text or "").upper())
    return int(singles[-1]) if singles else None


def spread_page_number_from_text(text: str) -> int | None:
    """Read only an unambiguous n/n+1 pair.

    Catalogue names may legitimately end in a model number (for example
    ``BUDG BEAM 300``), so extracted PDF text must never use a standalone
    trailing number as the printed page.
    """
    matches = re.findall(r"(?<!\d)(\d{1,4})\s*[/|]\s*(\d{1,4})(?!\d)", text or "")
    for first, second in reversed(matches):
        a, b = int(first), int(second)
        if 1 <= a <= 9999 and 0 <= b - a <= 2:
            return a
    return None


def fit_printed_page_map(doc) -> dict | None:
    samples: list[tuple[int, int]] = []
    for physical, page in enumerate(doc, start=1):
        height = page.rect.height
        candidates = []
        for word in page.get_text("words"):
            text = str(word[4]).strip()
            if not re.fullmatch(r"\d{1,4}", text):
                continue
            x0, y0, x1, y1 = word[:4]
            if y0 <= height * 0.09 or y1 >= height * 0.91:
                candidates.append((x0, int(text)))
        if candidates:
            candidates.sort()
            samples.append((physical, candidates[0][1]))
    if len(samples) < 3:
        return None

    slopes = []
    for i, (p1, n1) in enumerate(samples):
        for p2, n2 in samples[i + 1 :]:
            if p2 != p1:
                slopes.append((n2 - n1) / (p2 - p1))
    k0 = median(slopes)
    candidates_k = [k0, round(k0), 1.0, 2.0]
    best = None
    for k in candidates_k:
        if not 0.1 < k <= 4:
            continue
        offsets = [printed - k * physical for physical, printed in samples]
        c = median(offsets)
        limit = max(1.0, abs(k) * 0.24)
        inliers = [(physical, printed) for physical, printed in samples if abs(printed - (k * physical + c)) <= limit]
        score = (len(inliers), -median([abs(printed - (k * physical + c)) for physical, printed in inliers], 999))
        if best is None or score > best[0]:
            best = (score, k, c, inliers)
    if not best or len(best[3]) < 3 or len(best[3]) / len(samples) < 0.65:
        return None
    _, k, c, inliers = best
    # Refit the offset using only inliers.
    c = median([printed - k * physical for physical, printed in inliers])
    return {"k": k, "c": c, "sampleCount": len(samples), "inlierCount": len(inliers)}


def map_printed_page(mapping: dict | None, printed: int | None, total_pages: int) -> int:
    if not mapping or not printed:
        return 0
    physical = round((printed - mapping["c"]) / mapping["k"])
    return physical if 1 <= physical <= total_pages else 0


def repeated_card_rects(page) -> list:
    groups: dict[tuple[int, int], list] = {}
    width, height = page.rect.width, page.rect.height
    for drawing in page.get_drawings():
        if drawing.get("type") not in {"s", "fs"}:
            continue
        rect = drawing.get("rect")
        if not rect or rect.width <= 0 or rect.height <= 0:
            continue
        wr, hr = rect.width / width, rect.height / height
        aspect = rect.width / rect.height
        if not (0.035 <= wr <= 0.16 and 0.025 <= hr <= 0.13 and 1.1 <= aspect <= 3.6):
            continue
        key = (round(wr * 1000), round(hr * 1000))
        groups.setdefault(key, []).append(rect)
    if not groups:
        return []
    rects = max(groups.values(), key=len)
    if len(rects) < 6:
        return []
    # Stable visual order; row rounding prevents tiny PDF float noise from reordering columns.
    rects.sort(key=lambda r: (round(r.y0, 1), r.x0))
    return rects


def find_catalog_page(doc, preferred: int = 0) -> tuple[int, list]:
    if 1 <= preferred <= len(doc):
        rects = repeated_card_rects(doc[preferred - 1])
        if rects:
            return preferred, rects
    best_page, best_rects = 0, []
    for index, page in enumerate(doc):
        rects = repeated_card_rects(page)
        if len(rects) > len(best_rects):
            best_page, best_rects = index + 1, rects
    return best_page, best_rects


def words_in_rect(page, rect) -> list:
    found = []
    for word in page.get_text("words"):
        x0, y0, x1, y1, text = word[:5]
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if rect.x0 <= cx <= rect.x1 and rect.y0 <= cy <= rect.y1:
            found.append((x0, y0, x1, y1, str(text)))
    found.sort(key=lambda w: (round(w[1] / 3), w[0]))
    return found


def ocr_label(page, rect, tesseract: str | None, temp_dir: Path) -> str:
    if not tesseract:
        return ""
    clip = fitz.Rect(
        max(0, rect.x0 - 4),
        max(0, rect.y1 - 2),
        min(page.rect.width, rect.x1 + 14),
        min(page.rect.height, rect.y1 + max(32, page.rect.height * 0.04)),
    )
    pix = page.get_pixmap(matrix=fitz.Matrix(600 / 72, 600 / 72), clip=clip, alpha=False)
    image_path = temp_dir / f"label-{abs(hash((rect.x0, rect.y0))) & 0xFFFFFFFF:08x}.png"
    pix.save(image_path)
    try:
        result = subprocess.run(
            [tesseract, str(image_path), "stdout", "--psm", "6", "-l", "eng"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
            check=False,
        )
        return re.sub(r"\s+", " ", result.stdout or "").strip()
    except Exception:
        return ""


def _glyph_mask(page, clip, threshold: int, dpi: int = 600):
    if np is None:
        return None
    pix = page.get_pixmap(
        matrix=fitz.Matrix(dpi / 72, dpi / 72),
        clip=fitz.Rect(clip),
        alpha=False,
        colorspace=fitz.csGRAY,
    )
    data = np.frombuffer(pix.samples, dtype=np.uint8)
    return data.reshape(pix.height, pix.width) < threshold


def _segment_glyphs(mask) -> list:
    if mask is None or not getattr(mask, "size", 0):
        return []
    active = mask.sum(axis=0) >= 2
    segments = []
    start = None
    for index, value in enumerate(active):
        if value and start is None:
            start = index
        if start is not None and (not value or index == len(active) - 1):
            end = index if not value else index + 1
            glyph = mask[:, start:end]
            rows = np.flatnonzero(glyph.sum(axis=1) >= 1)
            if rows.size:
                segments.append(glyph[rows[0] : rows[-1] + 1, :])
            start = None
    return segments


def _normalize_glyph(mask, width: int = 28, height: int = 40):
    if Image is None or mask is None or not mask.size:
        return None
    source = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    src_w, src_h = source.size
    scale = min((width - 2) / max(1, src_w), (height - 2) / max(1, src_h))
    out_w, out_h = max(1, round(src_w * scale)), max(1, round(src_h * scale))
    source = source.resize((out_w, out_h), Image.Resampling.NEAREST)
    result = np.zeros((height, width), dtype=bool)
    left, top = (width - out_w) // 2, (height - out_h) // 2
    result[top : top + out_h, left : left + out_w] = np.asarray(source) > 0
    return result


def learn_digit_templates(doc) -> dict[str, list]:
    """Learn 0-9 from the document's own live footer/header page numbers.

    The catalogue labels and page folios normally use the same typeface.  This
    makes the recognizer font-adaptive and removes the Windows Tesseract
    dependency for the common outlined-label case.
    """
    templates = {str(number): [] for number in range(10)}
    if np is None or Image is None:
        return templates
    for page in doc:
        height = page.rect.height
        for word in page.get_text("words"):
            text = str(word[4]).strip()
            if not re.fullmatch(r"\d{1,3}", text):
                continue
            x0, y0, x1, y1 = word[:4]
            if not (y0 <= height * 0.09 or y1 >= height * 0.91):
                continue
            mask = _glyph_mask(page, (x0 - 1, y0 - 1, x1 + 1, y1 + 1), threshold=200)
            glyphs = _segment_glyphs(mask)
            if len(glyphs) != len(text):
                continue
            for character, glyph in zip(text, glyphs):
                normalized = _normalize_glyph(glyph)
                if normalized is not None:
                    templates[character].append(normalized)
    return templates


def _glyph_distance(observed, template) -> float:
    union = np.logical_or(observed, template).sum()
    return float(np.logical_xor(observed, template).sum() / max(1, union))


def recognize_label_from_templates(page, rect, mapping: dict | None, total_pages: int, templates) -> tuple[int | None, float]:
    """Recognize an outlined ``n/n+1`` label using document-trained digits."""
    if np is None or not mapping or not templates or not any(templates.values()):
        return None, 0.0
    # The label is right-aligned just below the vector card.  Cropping only the
    # final 42pt keeps the page pair while harmlessly allowing a short name
    # suffix on the left; scoring uses the rightmost expected glyphs.
    mask = _glyph_mask(
        page,
        (rect.x1 - 42, rect.y1 + 1, rect.x1 + 14, rect.y1 + 18),
        threshold=225,
    )
    glyphs = _segment_glyphs(mask)
    if len(glyphs) < 3:
        return None, 0.0

    candidates = []
    possible = sorted(
        {
            round(mapping["k"] * physical + mapping["c"])
            for physical in range(1, total_pages + 1)
            if 1 <= round(mapping["k"] * physical + mapping["c"]) <= 9999
        }
    )
    normalized_cache = {}
    for printed in possible:
        left, right = str(printed), str(printed + 1)
        if any(not templates[character] for character in left + right):
            continue
        expected_count = len(left) + 1 + len(right)
        if len(glyphs) < expected_count:
            continue
        observed = glyphs[-expected_count:]
        pairs = list(zip(observed[: len(left)], left))
        pairs += list(zip(observed[len(left) + 1 :], right))  # ignore slash glyph
        distances = []
        for glyph, character in pairs:
            cache_key = id(glyph)
            normalized = normalized_cache.get(cache_key)
            if normalized is None:
                normalized = _normalize_glyph(glyph)
                normalized_cache[cache_key] = normalized
            distances.append(min(_glyph_distance(normalized, template) for template in templates[character]))
        if distances:
            candidates.append((sum(distances) / len(distances), printed))
    if not candidates:
        return None, 0.0
    candidates.sort()
    best_score, best_number = candidates[0]
    next_score = candidates[1][0] if len(candidates) > 1 else 1.0
    margin = next_score - best_score
    if best_score > 0.23 or margin < 0.035:
        return None, max(0.0, 1.0 - best_score)
    confidence = min(0.995, max(0.72, 1.0 - best_score + min(0.12, margin)))
    return best_number, confidence


def analyze_catalog(source_pdf: Path, preferred_toc: int, temp_dir: Path) -> dict:
    tesseract = find_tesseract()
    with fitz.open(source_pdf) as doc:
        toc_page, rects = find_catalog_page(doc, preferred_toc)
        mapping = fit_printed_page_map(doc)
        digit_templates = learn_digit_templates(doc)
        zones = []
        page_number_hits = 0
        source_counts = Counter()
        if toc_page and rects:
            page = doc[toc_page - 1]
            for rect in rects:
                label_rect = fitz.Rect(
                    max(0, rect.x0 - 2),
                    max(0, rect.y1 - 1),
                    min(page.rect.width, rect.x1 + 14),
                    min(page.rect.height, rect.y1 + max(32, page.rect.height * 0.04)),
                )
                words = words_in_rect(page, label_rect)
                name_words = [w for w in words if not re.fullmatch(r"\d{1,4}\s*[/|]\s*\d{1,4}", w[4])]
                name = clean_name(" ".join(w[4] for w in name_words))
                extracted_text = " ".join(w[4] for w in words)
                printed, digit_confidence = recognize_label_from_templates(
                    page, rect, mapping, len(doc), digit_templates
                )
                number_source = "document-font"
                ocr_text = ""
                if not printed:
                    ocr_text = ocr_label(page, rect, tesseract, temp_dir)
                    printed = page_number_from_text(ocr_text)
                    number_source = "tesseract"
                    digit_confidence = 0.92 if printed else 0.0
                if not printed:
                    printed = spread_page_number_from_text(extracted_text)
                    number_source = "pdf-text"
                    digit_confidence = 0.98 if printed else 0.0
                if printed:
                    page_number_hits += 1
                    source_counts[number_source] += 1
                if not name:
                    name = clean_name(re.sub(r"\d{1,4}\s*[/|]\s*\d{1,4}", "", ocr_text)) or "未命名产品"
                label_bottom = max([w[3] for w in name_words], default=rect.y1)
                bottom = min(page.rect.height, max(rect.y1, label_bottom) + 3.0)
                # Use the real vector frame, then add the same small visual breathing
                # room on all four sides.  This keeps the very regular grid aligned.
                left = max(0, rect.x0 - 3.0)
                top = max(0, rect.y0 - 3.0)
                right = min(page.rect.width, rect.x1 + 3.0)
                target = map_printed_page(mapping, printed, len(doc))
                zones.append(
                    {
                        "page": toc_page,
                        "name": name,
                        "x": round(left / page.rect.width, 6),
                        "y": round(top / page.rect.height, 6),
                        "w": round((right - left) / page.rect.width, 6),
                        "h": round((bottom - top) / page.rect.height, 6),
                        "printedPage": printed or 0,
                        "targetPage": target,
                        "targetSource": "printed-map" if target else "none",
                        "confidence": round(digit_confidence, 3) if target else 0.65,
                        "geometrySource": "pdf-vector-frame",
                        "nameSource": "pdf-text" if name_words else "ocr",
                        "pageNumberSource": number_source if printed else "none",
                        "manualAdjusted": False,
                    }
                )
        return {
            "tocPage": toc_page,
            "zones": zones,
            "pageMap": mapping,
            "catalogRectCount": len(rects),
            "printedPageHits": page_number_hits,
            "pageNumberSources": dict(source_counts),
            "documentFontOcr": bool(np is not None and any(digit_templates.values())),
            "tesseract": bool(tesseract),
        }


def detect_risky_pages(source_pdf: Path) -> list[int]:
    risky = []
    with fitz.open(source_pdf) as doc:
        for number, page in enumerate(doc, start=1):
            drawings = page.get_drawings(extended=True)
            kinds = Counter(d.get("type") for d in drawings)
            images = len(page.get_images(full=True))
            # The three branches cover, respectively: very large mesh-gradient graphs;
            # a shading-only page with no ordinary image; and blend/group-heavy artwork
            # with very few source images.  False positives are safe: they merely use an
            # independently rendered high-resolution compatibility image.
            mesh_heavy = kinds["group"] > 100
            shading_only = images == 0 and len(drawings) <= 5 and (kinds["f"] + kinds["fs"] > 0)
            blend_heavy = kinds["group"] >= 4 and images <= 2 and len(drawings) >= 50
            if mesh_heavy or shading_only or blend_heavy:
                risky.append(number)
    return risky


def ghostscript_compress(source: Path, output: Path, profile: str, gs: str) -> None:
    options = PROFILE_OPTIONS[profile]
    dpi, jpeg = options["dpi"], options["jpeg"]
    command = [
        gs,
        "-q",
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.7",
        "-dDetectDuplicateImages=true",
        "-dCompressFonts=true",
        "-dSubsetFonts=true",
        "-dEmbedAllFonts=true",
        "-dDownsampleColorImages=true",
        "-dColorImageDownsampleType=/Bicubic",
        f"-dColorImageResolution={dpi}",
        "-dAutoFilterColorImages=false",
        "-dColorImageFilter=/DCTEncode",
        f"-dJPEGQ={jpeg}",
        "-dDownsampleGrayImages=true",
        "-dGrayImageDownsampleType=/Bicubic",
        f"-dGrayImageResolution={dpi}",
        "-dAutoFilterGrayImages=false",
        "-dGrayImageFilter=/DCTEncode",
        "-dDownsampleMonoImages=true",
        "-dMonoImageDownsampleType=/Subsample",
        f"-dMonoImageResolution={max(300, dpi * 3)}",
        "-sColorConversionStrategy=LeaveColorUnchanged",
        "-dPassThroughJPEGImages=false",
        "-dPassThroughJPXImages=false",
        f"-sOutputFile={output}",
        str(source),
    ]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=900)


def pymupdf_compress(source: Path, output: Path, profile: str) -> None:
    options = PROFILE_OPTIONS[profile]
    # MuPDF is the portable fallback.  A slightly lower target than Ghostscript is
    # intentional: it does not deduplicate/re-encode masks as aggressively.
    portable_dpi = {"quality": 150, "balanced": 120, "small": 96}[profile]
    quality = options["jpeg"]
    with fitz.open(source) as doc:
        doc.rewrite_images(
            dpi_threshold=portable_dpi + 1,
            dpi_target=portable_dpi,
            quality=quality,
            lossy=True,
            lossless=True,
            bitonal=False,
            color=True,
            gray=True,
        )
        doc.subset_fonts()
        doc.save(output, garbage=4, clean=True, deflate=True, deflate_images=True, deflate_fonts=True)


def compress_pdf(source: Path, output: Path, profile: str) -> str:
    if profile == "original":
        shutil.copyfile(source, output)
        return "original"
    gs = find_ghostscript()
    if gs:
        ghostscript_compress(source, output, profile, gs)
        return "ghostscript"
    pymupdf_compress(source, output, profile)
    return "pymupdf"


def render_webp_pages(source_pdf: Path, pages: list[int], output_dir: Path, profile: str) -> dict[int, Path]:
    from PIL import Image

    options = PROFILE_OPTIONS[profile]
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = {}
    if pdfium is not None:
        # PDFium is intentionally independent from both PDF.js and MuPDF.  On the
        # supplied Illustrator/InDesign sample it removes the mesh seams on page 2
        # and reproduces the blend result on page 6, while remaining easy to bundle
        # into a Windows portable build.
        doc = pdfium.PdfDocument(str(source_pdf))
        try:
            for number in pages:
                if not 1 <= number <= len(doc):
                    continue
                page = doc[number - 1]
                width, _ = page.get_size()
                scale = options["webp_width"] / max(1, width)
                image = page.render(scale=scale, rev_byteorder=True).to_pil().convert("RGB")
                path = output_dir / f"page-{number}.webp"
                image.save(path, "WEBP", quality=options["webp_quality"], method=6)
                outputs[number] = path
        finally:
            doc.close()
    else:
        # Last-resort fallback.  It keeps the workflow operational, but the report
        # records that the truly independent compatibility renderer was unavailable.
        with fitz.open(source_pdf) as doc:
            for number in pages:
                if not 1 <= number <= len(doc):
                    continue
                page = doc[number - 1]
                scale = options["webp_width"] / max(1, page.rect.width)
                pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
                image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                path = output_dir / f"page-{number}.webp"
                image.save(path, "WEBP", quality=options["webp_quality"], method=6)
                outputs[number] = path
    return outputs


def build_prepared_zip(source_pdf: Path, output_zip: Path, profile: str, preferred_toc: int, temp_dir: Path) -> dict:
    compressed_pdf = temp_dir / "catalog.pdf"
    engine = compress_pdf(source_pdf, compressed_pdf, profile)
    analysis = analyze_catalog(source_pdf, preferred_toc, temp_dir)
    risky_pages = detect_risky_pages(source_pdf)
    rendered = render_webp_pages(source_pdf, risky_pages, temp_dir / "compat", profile)
    analysis.update(
        {
            "profile": profile,
            "compressionEngine": engine,
            "sourceBytes": source_pdf.stat().st_size,
            "outputPdfBytes": compressed_pdf.stat().st_size,
            "specialPages": sorted(rendered),
            "compatibilityRenderer": "pdfium" if pdfium is not None else "pymupdf-fallback",
        }
    )
    with zipfile.ZipFile(output_zip, "w") as bundle:
        bundle.write(compressed_pdf, "catalog.pdf", compress_type=zipfile.ZIP_STORED)
        bundle.writestr("analysis.json", json.dumps(analysis, ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
        for number, path in rendered.items():
            bundle.write(path, f"compat/page-{number}.webp", compress_type=zipfile.ZIP_STORED)
    return analysis


class EnhancedHandler(SimpleHTTPRequestHandler):
    server_version = "FlipbookForge/3.7"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print("[server] " + fmt % args)

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/capabilities":
            self.send_json(
                {
                    "enhanced": fitz is not None,
                    "pymupdf": fitz is not None,
                    "pdfium": pdfium is not None,
                    "documentFontOcr": np is not None and Image is not None,
                    "ghostscript": bool(find_ghostscript()),
                    "tesseract": bool(find_tesseract()),
                    "error": FITZ_IMPORT_ERROR,
                }
            )
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/preprocess":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if fitz is None:
            self.send_json({"error": "PyMuPDF 不可用: " + FITZ_IMPORT_ERROR}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_UPLOAD:
            self.send_json({"error": "PDF 为空或超过 600MB 限制"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        query = parse_qs(parsed.query)
        profile = query.get("profile", ["balanced"])[0]
        if profile not in PROFILE_OPTIONS:
            profile = "balanced"
        try:
            preferred_toc = int(query.get("tocPage", ["0"])[0] or 0)
        except ValueError:
            preferred_toc = 0
        try:
            with tempfile.TemporaryDirectory(prefix="flipbook-forge-") as work:
                temp_dir = Path(work)
                source_pdf = temp_dir / "source.pdf"
                remaining = length
                with source_pdf.open("wb") as stream:
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("上传中断")
                        stream.write(chunk)
                        remaining -= len(chunk)
                output_zip = temp_dir / "prepared.zip"
                build_prepared_zip(source_pdf, output_zip, profile, preferred_toc, temp_dir)
                size = output_zip.stat().st_size
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with output_zip.open("rb") as stream:
                    shutil.copyfileobj(stream, self.wfile, length=1024 * 1024)
        except subprocess.TimeoutExpired:
            self.send_json({"error": "增强预处理超时"}, HTTPStatus.GATEWAY_TIMEOUT)
        except Exception as exc:
            self.send_json({"error": f"增强预处理失败: {type(exc).__name__}: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> int:
    parser = argparse.ArgumentParser(description="FLIPBOOK_FORGE v3.7 enhanced local server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if fitz is None:
        # Keep the bootstrap failure ASCII-safe.  GitHub's Windows runner can
        # redirect output through cp1252, where printing Chinese text would
        # otherwise raise UnicodeEncodeError and hide the real import error.
        print("PyMuPDF is unavailable. Install requirements.txt or repair the bundled runtime.")
        print("Import error:", ascii(FITZ_IMPORT_ERROR))
        return 2
    server = ThreadingHTTPServer((args.host, args.port), EnhancedHandler)
    url = f"http://{args.host}:{args.port}/index.html"
    print(f"FLIPBOOK_FORGE v3.7 已启动: {url}")
    print("关闭此窗口即可停止。所有处理仅发生在本机。")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
