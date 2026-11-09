"""OCR service for the k-ocr bill page. POST the image bytes to /ocr; boxes are in image pixels.

PP-OCRv5 mobile finds text lines, VietOCR reads them (PP-OCR's latin recognizer re-reads number lines):
           {"lines": [[{"text", "bbox": {x0, y0, x1, y1}}]], "texts": [str], "polys": [[[x, y] x 4]]}. lines is the shape
           Tesseract.js gives, so the page snaps model boxes onto it unchanged; texts holds each line, polys its corners
           (tl, tr, br, bl), which tell the page how far a photo is tilted.
           PP-OCRv5's own recognizers lack 90 of the 134 accented Vietnamese letters ("Cộng" came out "Cng"); on the
           5 test bills this lifts values read exactly from 102/137 to 126/137, at ~1 s instead of ~0.3 s per bill.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from paddleocr import TextDetection, TextRecognition
from PIL import Image
from textmerge import merge
from vietocr.tool.config import Cfg
from vietocr.tool.predictor import Predictor

# unclip 0.9 (default 1.5): line boxes fit the text (IoU with drawn boxes 0.63 -> 0.79 on the test bills).
det = TextDetection(model_name='PP-OCRv5_mobile_det', unclip_ratio=0.9, device='cpu')
cfg = Cfg.load_config_from_name('vgg_seq2seq')
cfg['device'] = 'cpu'
cfg['cnn']['pretrained'] = False  # the VietOCR weights replace the ImageNet backbone; skip its 548 MB download
cfg['predictor']['beamsearch'] = False
rec = Predictor(cfg)
latin = TextRecognition(model_name='latin_PP-OCRv5_mobile_rec', device='cpu')
# ...but the recognizer needs the accents above and below the line: crop 15% of the line height wider (119 vs 107/137).
CROP_PAD = 0.15
MAX_BYTES = 20 * 1024 * 1024
# The models run on one fixed worker thread: Paddle predictors fail now and then ("RuntimeError: std::exception",
# 1 call in 30) when called from a new thread each time, even one at a time.
ocr_worker = ThreadPoolExecutor(1)


def word(text, box):
    x0, y0, x1, y1 = map(int, box)
    # A lone digit ("2" in "2 x 36.000") a few px wide: widen it to a clickable ~0.6 line height.
    pad = max(0, int((y1 - y0) * 0.6) - (x1 - x0)) // 2
    return {'text': text, 'bbox': {'x0': max(0, x0 - pad), 'y0': y0, 'x1': x1 + pad, 'y1': y1}}


def read_lines(image):
    polys = det.predict(image)[0]['dt_polys']
    # Reading order: boxes whose centres sit within half a line of the row's first box share a row, read left to right.
    rows = []
    for p in sorted(polys, key=lambda p: p[:, 1].mean()):
        if rows and abs(p[:, 1].mean() - rows[-1][0][:, 1].mean()) < (p[:, 1].max() - p[:, 1].min()) / 2:
            rows[-1].append(p)
        else:
            rows.append([p])
    polys = [p for row in rows for p in sorted(row, key=lambda p: p[:, 0].min())]
    boxes = [(*p.min(0).astype(int), *p.max(0).astype(int)) for p in polys]
    crops = [rotated_crop(image, p) for p in polys]
    texts = rec.predict_batch([Image.fromarray(cv2.cvtColor(c, cv2.COLOR_BGR2RGB)) for c in crops]) if crops else []
    # VietOCR misreads digits ("Quầy: 03" -> "Quầy:00", "2 x 32.000" -> "22 12 020000") that PP-OCR's latin
    # recognizer gets right: re-read every line with a digit in it and take latin's digits, VietOCR's letters.
    numeric = [i for i, t in enumerate(texts) if any(c.isdigit() for c in t)]
    for i, r in zip(numeric, latin.predict([crops[i] for i in numeric]) if numeric else []):
        texts[i] = merge(texts[i], r['rec_text'])
    return texts, boxes, polys


def rotated_crop(image, poly):
    # Straighten the line (tilted photos, handwriting) instead of cutting its axis-aligned box, which drags in
    # the neighbouring lines; pad it so the accents above and below stay in. poly is [tl, tr, br, bl].
    tl, tr, br, bl = poly.astype(np.float32)
    w = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl), 1)
    h = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr), 1)
    ux, uy = (tr - tl) / max(np.linalg.norm(tr - tl), 1), (bl - tl) / max(np.linalg.norm(bl - tl), 1)
    pad = h * CROP_PAD
    src = np.float32([tl - pad * (ux + uy), tr + pad * (ux - uy), br + pad * (ux + uy), bl - pad * (ux - uy)])
    W, H = int(w + 2 * pad), int(h + 2 * pad)
    m = cv2.getPerspectiveTransform(src, np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
    return cv2.warpPerspective(image, m, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def split_words(text, box):
    # VietOCR reads whole lines: give each word its share of the line box by character count.
    x0, y0, x1, y1 = box
    words, at = [], 0
    for t in text.split():
        i = text.index(t, at)
        at = i + len(t)
        words.append(word(t, (x0 + (x1 - x0) * i / len(text), y0, x0 + (x1 - x0) * at / len(text), y1)))
    return words


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.reply(200, {'ok': True}) if self.path == '/health' else self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/ocr':
            return self.reply(404, {'error': 'not found'})
        size = int(self.headers.get('Content-Length') or 0)
        if not 0 < size <= MAX_BYTES:
            return self.reply(413, {'error': f'body must be 1..{MAX_BYTES} bytes'})
        image = cv2.imdecode(np.frombuffer(self.rfile.read(size), np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return self.reply(400, {'error': 'not an image'})
        texts, boxes, polys = ocr_worker.submit(read_lines, image).result()
        self.reply(200, {'lines': [split_words(t, b) for t, b in zip(texts, boxes)], 'texts': texts, 'polys': [p.astype(int).tolist() for p in polys]})

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', 8866))), Handler).serve_forever()
