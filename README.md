# K-OCR – Đọc hoá đơn

Split out of k-mer's `sab-ai-prototype` (`/ocr` page). Three columns: the schema to read (object / array tables), the
bill image with pan-zoom and boxes, and the extracted data in AG Grid; clicking a cell zooms to its box, clicking a box
selects its cell.

## Readers

| Reader | How it reads | Needs |
|---|---|---|
| PP-OCRv5 mobile + VietOCR (default) | `ppocr/` service finds and reads text lines; `src/lib/receiptRules.ts` turns them into tables or fills the schema, no LLM (~2 s per bill on CPU) | the OCR service |
| Gemini (Google) | `gemini-2.5-flash` fills the schema from the image; boxes are snapped onto the OCR service's word boxes (Tesseract.js in the browser when it is down) | `GEMINI_API_KEY` |

## Run

```bash
cp .env.example .env        # set GEMINI_API_KEY if you use Gemini, PPOCR_URL if the service is elsewhere
npm install
npm run dev                 # http://127.0.0.1:3200
```

OCR service (CPU, ~4.4 GB image; it downloads its models at build time):

```bash
docker build -t k-ocr-ppocr ppocr
docker run -d --name k-ocr-ppocr --restart unless-stopped -p 127.0.0.1:8866:8866 k-ocr-ppocr
```

## Check

```bash
npm run lint
npm test
```

`npm test` runs the box matching, line-item and receipt-rule tests (`src/lib/*.test.ts`) and the OCR text merge test
(`ppocr/test_textmerge.py`).
