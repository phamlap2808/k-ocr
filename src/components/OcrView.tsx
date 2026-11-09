import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type CellClickedEvent, type ColDef, type GridApi } from 'ag-grid-community';
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import { ChevronDown, Loader2, Maximize, Play, Plus, Trash2, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '../lib/utils';
import { snapBoxes, type OcrWord } from '../lib/ocrMatch';
import { splitQtyTimesPrice } from '../lib/lineItems';
import { fitSchema, readReceipt } from '../lib/receiptRules';

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid draws its own chrome: match the app's font, bottle green and green-grey rules.
const gridTheme = themeQuartz.withParams({
  fontFamily: 'Be Vietnam Pro, sans-serif',
  fontSize: 13,
  accentColor: '#1a6248',
  foregroundColor: '#1d2a24',
  borderColor: '#d9dfdb',
  headerBackgroundColor: '#f6f8f7',
  headerTextColor: '#55625b',
  headerFontWeight: 500,
  rowHoverColor: '#f6f8f7',
  borderRadius: 6,
  wrapperBorderRadius: 6,
});

const GEMINI_MODEL = 'gemini-2.5-flash';
// Gemini fills the schema straight from the image; PP-OCRv5 + VietOCR (ppocr/server.py) reads the text lines and
// src/lib/receiptRules.ts turns them into the tables, with no LLM.
const READERS = { ppocr: 'PP-OCRv5 mobile + VietOCR', gemini: 'Gemini (Google)' } as const;
type Reader = keyof typeof READERS;
type FieldDef = { key: string; label: string };
type TableDef = { key: string; label: string; type: 'object' | 'array'; fields: FieldDef[] };
// box_2d follows Gemini's convention: [ymin, xmin, ymax, xmax] normalized to 0-1000.
type Cell = { value: string; box_2d?: number[] };
type Row = Record<string, Cell>;
type Target = { table: string; row: number; field: string };

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: ['tables'],
  properties: {
    tables: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['key', 'label', 'type', 'fields', 'rows'],
        properties: {
          key: { type: 'STRING' },
          label: { type: 'STRING' },
          type: { type: 'STRING', enum: ['object', 'array'] },
          fields: {
            type: 'ARRAY',
            items: { type: 'OBJECT', required: ['key', 'label'], properties: { key: { type: 'STRING' }, label: { type: 'STRING' } } },
          },
          rows: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['cells'],
              properties: {
                cells: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    // box_2d must be required: under constrained decoding, optional fields get skipped.
                    required: ['key', 'value', 'box_2d'],
                    properties: {
                      key: { type: 'STRING' },
                      value: { type: 'STRING' },
                      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, minItems: 4, maxItems: 4 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

function buildPrompt(title: string, description: string, defs: TableDef[]) {
  const head = [
    'You are an OCR engine for bills/receipts. Read the image and return JSON.',
    title && `Document: ${title}.`,
    description && `Context: ${description}`,
    `Copy every value verbatim as text. For every value give box_2d = [ymin, xmin, ymax, xmax] normalized 0-1000 tightly around that text in the image.`,
    'A value is the data printed next to a label, never the label itself: for "Tổng cộng 213.840" the value is "213.840" and box_2d covers only "213.840".',
    "A table of type 'object' has exactly 1 row; a table of type 'array' has one row per item.",
  ].filter(Boolean).join('\n');
  if (defs.length) {
    return `${head}\nExtract EXACTLY these tables and fields, keeping the same keys, labels and types. Use an empty value when a field is not found:\n${JSON.stringify(defs)}`;
  }
  return `${head}\nNo schema is given, design one: an 'object' table for header info (store name, address, phone, date, invoice number, totals...) and an 'array' table for line items (name, quantity, unit price, amount...). Use snake_case keys, and for each label a short name of at most 4 words in the bill's language, with no translation.`;
}

type OcrTable = TableDef & { rows: { cells: (Cell & { key: string })[] }[] };

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? json?.error ?? `HTTP ${res.status}`);
  return json;
}

// Long side 1280 for Tesseract, the in-browser fallback: small bills need the extra pixels, big phone photos get
// cheaper. Boxes are normalized, so they still map onto the original image.
async function toTesseractImage(file: File) {
  const bmp = await createImageBitmap(file);
  const k = 1280 / Math.max(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(32, Math.round((bmp.width * k) / 32) * 32);
  canvas.height = Math.max(32, Math.round((bmp.height * k) / 32) * 32);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

// Gemini's boxes are guesses; an OCR engine measures where the text really is. PP-OCRv5 + VietOCR (ppocr/server.py)
// finds more values than Tesseract, handwriting included; Tesseract.js is the in-browser fallback.
// The service gets the original file: upscaled to 1280px, small bills make the line detector break handwritten
// lines into single words.
async function postImage<T>(path: string, file: File): Promise<T> {
  const res = await fetch(`/api/ppocr/${path}`, { method: 'POST', body: file });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `OCR service: HTTP ${res.status}`);
  return json;
}
async function imageSize(file: File) {
  const bmp = await createImageBitmap(file);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}
type WordLines = { lines: OcrWord[][]; width: number; height: number }; // boxes in pixels of a width x height image
let tesseract: Promise<import('tesseract.js').Worker> | undefined;
async function readWordLines(file: File): Promise<WordLines> {
  try {
    const [{ lines }, size] = await Promise.all([postImage<{ lines: OcrWord[][] }>('ocr', file), imageSize(file)]);
    return { lines, ...size };
  } catch (e) {
    console.warn('PP-OCR unavailable - using Tesseract', e);
  }
  const image = await toTesseractImage(file);
  tesseract ??= import('tesseract.js').then(({ createWorker }) => createWorker('vie+eng'));
  const { data } = await (await tesseract).recognize(image.url, {}, { blocks: true });
  return { lines: (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => l.words))), width: image.width, height: image.height };
}

// Bump the version when the stored result changes shape or meaning (v3: "2 x 36.000" split into quantity and unit price).
const CACHE_PREFIX = 'ocr-cache:v3:';

const fileDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

// shortcut: per-browser localStorage (~5MB, a few KB per bill); move to a server-side store if results must be shared.
async function cacheKey(...parts: string[]) {
  if (!crypto.subtle) return null; // only in secure contexts (https or localhost)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\n')));
  return CACHE_PREFIX + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function runGemini(
  file: File,
  prompt: string,
  force: boolean,
  // Prompt the next run will send once the generated schema is filled in, so re-running the same bill hits the cache.
  nextPrompt?: (tables: OcrTable[]) => string,
) {
  const dataUrl = await fileDataUrl(file);
  const key = await cacheKey('gemini', GEMINI_MODEL, prompt, dataUrl);
  if (key && !force) {
    try {
      const hit = localStorage.getItem(key);
      if (hit) return { tables: JSON.parse(hit) as OcrTable[], cached: true };
    } catch {
      // storage blocked or corrupt entry: fall through to a fresh run
    }
  }
  // Runs in parallel with the model call; boxes are best-effort, so an OCR failure keeps the model's boxes.
  const wordLines = readWordLines(file).catch((e): WordLines => {
    console.warn('OCR failed, keeping model boxes', e);
    return { lines: [], width: 1000, height: 1000 };
  });
  const json = await postJson(`/api/gemini/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    contents: [{ parts: [{ inline_data: { mime_type: file.type, data: dataUrl.split(',')[1] } }, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
  });
  const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Model returned no content');
  const tables = JSON.parse(text).tables as OcrTable[];
  splitQtyTimesPrice(tables);
  const words = await wordLines;
  snapBoxes(tables, words.lines, words.width, words.height);
  const keys = [key, nextPrompt && (await cacheKey('gemini', GEMINI_MODEL, nextPrompt(tables), dataUrl))];
  try {
    for (const k of keys) if (k) localStorage.setItem(k, JSON.stringify(tables));
  } catch {
    // quota full or storage blocked: the result is still shown, just not cached
  }
  return { tables, cached: false };
}

async function runPpocr(file: File, defs: TableDef[], force: boolean) {
  const key = await cacheKey('ppocr', JSON.stringify(defs), await fileDataUrl(file));
  if (key && !force) {
    try {
      const hit = localStorage.getItem(key);
      if (hit) return { tables: JSON.parse(hit) as OcrTable[], cached: true };
    } catch {
      // storage blocked or corrupt entry: fall through to a fresh run
    }
  }
  const { width: w, height: h } = await imageSize(file);
  // No Tesseract fallback here: the user picked PP-OCR, so an outage is an error, not a silent switch.
  const { lines, texts, polys } = await postImage<{ lines: OcrWord[][]; texts: string[]; polys: number[][][] }>('ocr', file);
  const read = readReceipt(texts.map((text, i) => ({ text, poly: polys[i] })), w, h);
  const tables: OcrTable[] = defs.length ? fitSchema(read, defs) : read;
  // Rule cells carry their whole line's box ("MST: 0312345678 -DT: ..."): narrow each onto its own words.
  snapBoxes(tables, lines, w, h);
  try {
    if (key) localStorage.setItem(key, JSON.stringify(tables));
  } catch {
    // quota full or storage blocked: the result is still shown, just not cached
  }
  return { tables, cached: false };
}

const inputCls = 'w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none';
// Borderless input that fills a schema-table cell; the cell border draws the grid.
const cellInputCls = 'w-full min-w-0 bg-transparent px-2 py-1.5 text-sm focus:bg-brand-50 focus:outline-none';
const thCls = 'border-b border-slate-200 bg-slate-50 px-2 py-1 text-left text-xs font-medium text-slate-500';

// Column divider: drag or use the arrow keys to resize the column on its `side`.
function Splitter({ label, onResize }: { label: string; onResize: (dx: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      className="group hidden cursor-col-resize items-center justify-center focus:outline-none lg:flex"
      onPointerDown={(e) => {
        e.preventDefault();
        let x = e.clientX;
        const move = (ev: PointerEvent) => {
          onResize(ev.clientX - x);
          x = ev.clientX;
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onResize(e.key === 'ArrowLeft' ? -20 : 20);
        }
      }}
    >
      <div className="h-10 w-1 rounded-full bg-slate-300 group-hover:bg-brand-600 group-focus:bg-brand-600" />
    </div>
  );
}

export function OcrView() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // PP-OCR by default: it needs no API key.
  const [reader, setReader] = useState<Reader>('ppocr');
  const [defs, setDefs] = useState<TableDef[]>([]);
  const [data, setData] = useState<Record<string, Row[]>>({});
  const [tab, setTab] = useState<string | null>(null);
  const [active, setActive] = useState<Target | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cached, setCached] = useState(false);
  // Outer column widths in px; the image column takes the rest.
  const [cols, setCols] = useState({ left: 360, right: 520 });
  const gridRef = useRef<HTMLDivElement>(null);
  const resize = (side: 'left' | 'right') => (dx: number) =>
    setCols((c) => {
      // Keep at least 280px for the image column (+ 2 dividers, gaps and padding).
      const max = (gridRef.current?.clientWidth ?? 1600) - c[side === 'left' ? 'right' : 'left'] - 280 - 50;
      return { ...c, [side]: Math.min(max, Math.max(260, c[side] + (side === 'left' ? dx : -dx))) };
    });
  const imageUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => imageUrl && URL.revokeObjectURL(imageUrl), [imageUrl]);

  const zoomRef = useRef<ReactZoomPanPinchRef>(null);
  const boxRefs = useRef(new Map<string, HTMLDivElement>());
  const gridApi = useRef<GridApi | null>(null);
  const addMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!addMenuRef.current?.contains(e.target as Node)) addMenuRef.current?.removeAttribute('open');
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const updateTable = (i: number, patch: Partial<TableDef>) =>
    setDefs((d) => d.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const si = Math.max(0, defs.findIndex((t) => t.key === tab));
  const st = defs[si];

  const run = async (force = false) => {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const toDefs = (tables: OcrTable[]) => tables.map(({ key, label, type, fields }) => ({ key, label, type, fields }));
      const { tables, cached } = reader === 'ppocr'
        ? await runPpocr(file, defs, force)
        : await runGemini(file, buildPrompt(title, description, defs), force, defs.length ? undefined : (t) => buildPrompt(title, description, toDefs(t)));
      setCached(cached);
      const nextDefs = defs.length ? defs : toDefs(tables);
      const next: Record<string, Row[]> = {};
      for (const def of nextDefs) {
        const found = tables.find((t) => t.key === def.key);
        next[def.key] = (found?.rows ?? []).map((r) => Object.fromEntries(r.cells.map(({ key, ...cell }) => [key, cell])));
      }
      setDefs(nextDefs);
      setData(next);
      setTab(nextDefs[0]?.key ?? null);
      setActive(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const boxes = defs.flatMap((t) =>
    (data[t.key] ?? []).flatMap((row, r) =>
      Object.entries(row)
        .filter(([, c]) => c.box_2d?.length === 4)
        .map(([field, c]) => ({ id: `${t.key}|${r}|${field}`, target: { table: t.key, row: r, field }, box: c.box_2d!, value: c.value })),
    ),
  );
  const activeId = active && `${active.table}|${active.row}|${active.field}`;

  useEffect(() => {
    const el = activeId && boxRefs.current.get(activeId);
    // Fit the box, but stop at 1.5x: a lone digit would otherwise fill the view at the wrapper's 8x cap.
    if (el) zoomRef.current?.zoomToElement(el, { maxScale: 1.5, animationTime: 300 });
  }, [activeId]);

  const tabDef = defs.find((t) => t.key === tab);
  const rows = (tab && data[tab]) || [];
  // Object tables render vertically (one grid row per field); array tables one grid row per item.
  const { columnDefs, rowData } = useMemo(() => {
    if (!tabDef) return { columnDefs: [] as ColDef[], rowData: [] };
    if (tabDef.type === 'object') {
      return {
        columnDefs: [
          { field: 'label', headerName: 'Field', flex: 1, minWidth: 100 },
          { field: 'value', headerName: 'Value', flex: 2, minWidth: 120 },
        ] as ColDef[],
        rowData: tabDef.fields.map((f) => ({ key: f.key, label: f.label, value: rows[0]?.[f.key]?.value ?? '' })),
      };
    }
    return {
      columnDefs: [
        { headerName: '#', valueGetter: 'node.rowIndex + 1', width: 60 },
        ...tabDef.fields.map((f) => ({ field: f.key, headerName: f.label, minWidth: 120, flex: 1 })),
      ] as ColDef[],
      rowData: rows.map((r) => Object.fromEntries(tabDef.fields.map((f) => [f.key, r[f.key]?.value ?? '']))),
    };
  }, [tabDef, rows]);

  const focusActive = (api: GridApi | null) => {
    if (!api || api.isDestroyed() || !active || !tabDef || active.table !== tabDef.key) return;
    const isObj = tabDef.type === 'object';
    const rowIndex = isObj ? tabDef.fields.findIndex((f) => f.key === active.field) : active.row;
    const colKey = isObj ? 'value' : active.field;
    if (rowIndex < 0) return;
    api.ensureIndexVisible(rowIndex);
    api.ensureColumnVisible(colKey);
    api.setFocusedCell(rowIndex, colKey);
    const node = api.getDisplayedRowAtIndex(rowIndex);
    if (node) api.flashCells({ rowNodes: [node], columns: [colKey] });
  };
  useEffect(() => focusActive(gridApi.current), [active, tabDef]);

  const onCellClicked = (e: CellClickedEvent) => {
    if (!tabDef || e.rowIndex == null) return;
    const field = tabDef.type === 'object' ? e.data.key : e.colDef.field;
    const row = tabDef.type === 'object' ? 0 : e.rowIndex;
    if (field) setActive({ table: tabDef.key, row, field });
  };

  return (
    <div
      ref={gridRef}
      className="grid h-full grid-cols-1 gap-3 p-3 lg:grid-cols-[var(--ocr-left)_8px_minmax(0,1fr)_8px_var(--ocr-right)] lg:gap-x-1"
      style={{ '--ocr-left': `${cols.left}px`, '--ocr-right': `${cols.right}px` } as React.CSSProperties}
    >
      {/* Col 1: template + schema definition */}
      <section className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-md border border-slate-200 bg-white p-4">
        <label className="text-xs font-semibold text-slate-500">
          Tiêu đề
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Hoá đơn nhà hàng" />
        </label>
        <label className="text-xs font-semibold text-slate-500">
          Mô tả
          <textarea className={inputCls} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 py-3 text-sm text-slate-600 hover:border-brand-600">
          <Upload size={16} />
          {file ? file.name : 'Chọn ảnh hoá đơn'}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setData({});
              setActive(null);
              setCached(false);
            }}
          />
        </label>

        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-900">Các bảng cần đọc</span>
          {/* Native <details> gives the open/close toggle and keyboard support without extra state. */}
          <details ref={addMenuRef} className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
              <Plus size={12} /> Thêm bảng <ChevronDown size={12} />
            </summary>
            <div className="absolute right-0 z-10 mt-1 w-32 rounded-md border border-slate-200 bg-white p-1 shadow-md">
              {(['object', 'array'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-xs hover:bg-slate-100"
                  onClick={() => {
                    const key = `table_${defs.length + 1}`;
                    setDefs((d) => [...d, { key, label: `Table ${d.length + 1}`, type, fields: [] }]);
                    setTab(key);
                    addMenuRef.current?.removeAttribute('open');
                  }}
                >
                  <Plus size={12} /> {type}
                </button>
              ))}
            </div>
          </details>
        </div>
        {/* Shares `tab` with the data grid, so picking a table here or a box on the image shows the same table in both. */}
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Schema tables">
          {defs.map((t, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === si}
              onClick={() => setTab(t.key)}
              className={cn('rounded-md px-2.5 py-1 text-xs font-semibold', i === si ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200')}
            >
              {t.label || t.key || `Table ${i + 1}`} <span className="opacity-60">({t.type})</span>
            </button>
          ))}
        </div>
        {!st && <p className="text-xs text-slate-400">Chưa có bảng nào. Đọc hoá đơn một lần để có bảng gợi ý, hoặc thêm bảng.</p>}
        {st && (
          <div className="overflow-hidden rounded-md border border-slate-200" role="tabpanel">
            <table className="w-full table-fixed border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>Tên bảng</th>
                  <th className={thCls}>Key</th>
                  <th className={cn(thCls, 'w-24')}>Kiểu</th>
                  <th className={cn(thCls, 'w-8')} />
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-200">
                  <td className="border-r border-slate-200">
                    <input className={cellInputCls} value={st.label} onChange={(e) => updateTable(si, { label: e.target.value })} aria-label="Table label" placeholder="label" />
                  </td>
                  <td className="border-r border-slate-200">
                    <input
                      className={cellInputCls}
                      value={st.key}
                      placeholder="key"
                      aria-label="Table key"
                      onChange={(e) => {
                        updateTable(si, { key: e.target.value });
                        setTab(e.target.value);
                      }}
                    />
                  </td>
                  <td className="border-r border-slate-200">
                    <select className={cellInputCls} value={st.type} onChange={(e) => updateTable(si, { type: e.target.value as TableDef['type'] })} aria-label="Table type">
                      <option value="object">object</option>
                      <option value="array">array</option>
                    </select>
                  </td>
                  <td className="text-center">
                    <button type="button" aria-label="Remove table" className="p-1 text-slate-400 hover:text-rose-500" onClick={() => setDefs((d) => d.filter((_, j) => j !== si))}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <table className="w-full table-fixed border-collapse">
              <thead>
                <tr>
                  <th className={cn(thCls, 'w-8 text-center')}>#</th>
                  <th className={thCls}>Key</th>
                  <th className={thCls}>Tên hiển thị</th>
                  <th className={cn(thCls, 'w-8')} />
                </tr>
              </thead>
              <tbody>
                {st.fields.map((f, k) => (
                  <tr key={k} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                    <td className="border-r border-slate-100 text-center text-xs text-slate-400 tabular-nums">{k + 1}</td>
                    <td className="border-r border-slate-100">
                      <input className={cellInputCls} value={f.key} placeholder="key" aria-label="Field key" title={f.key}
                        onChange={(e) => updateTable(si, { fields: st.fields.map((x, j) => (j === k ? { ...x, key: e.target.value } : x)) })} />
                    </td>
                    <td className="border-r border-slate-100">
                      <input className={cellInputCls} value={f.label} placeholder="label" aria-label="Field label" title={f.label}
                        onChange={(e) => updateTable(si, { fields: st.fields.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)) })} />
                    </td>
                    <td className="text-center">
                      <button type="button" aria-label="Remove field" className="p-1 text-slate-400 hover:text-rose-500"
                        onClick={() => updateTable(si, { fields: st.fields.filter((_, j) => j !== k) })}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="w-full border-t border-slate-200 px-2 py-1.5 text-left text-xs font-medium text-brand-700 hover:bg-slate-50"
              onClick={() => updateTable(si, { fields: [...st.fields, { key: '', label: '' }] })}>
              + Thêm trường
            </button>
          </div>
        )}

        <div className="mt-auto grid gap-1">
          <label className="text-xs font-semibold text-slate-500">
            Mô hình đọc
            <select className={inputCls} value={reader} onChange={(e) => setReader(e.target.value as Reader)} aria-label="Reader model">
              {Object.entries(READERS).map(([value, name]) => (
                <option key={value} value={value}>{name}</option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          disabled={!file || loading}
          onClick={() => run()}
          className="flex items-center justify-center gap-2 rounded-md bg-brand-700 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          Đọc hoá đơn
        </button>
        {cached && !loading && (
          <p className="text-xs text-slate-500">
            Kết quả lấy từ cache.{' '}
            <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => run(true)}>
              Chạy lại
            </button>
          </p>
        )}
        {error && <p className="text-xs text-rose-600">{error}</p>}
      </section>
      <Splitter label="Đổi độ rộng cột cấu hình" onResize={resize('left')} />

      {/* Col 2: image + bounding boxes */}
      <section className="relative min-h-[420px] overflow-hidden rounded-md border border-slate-200 bg-slate-100">
        {imageUrl ? (
          <TransformWrapper ref={zoomRef} maxScale={8} centerOnInit>
            <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }}>
              <div className="relative">
                <img src={imageUrl} alt="Bill" className="block max-h-[80vh] max-w-full" draggable={false} />
                {boxes.map((b) => (
                  <div
                    key={b.id}
                    ref={(el) => {
                      if (el) boxRefs.current.set(b.id, el);
                      else boxRefs.current.delete(b.id);
                    }}
                    title={b.value}
                    onClick={() => {
                      setTab(b.target.table);
                      setActive(b.target);
                    }}
                    className={cn(
                      'absolute cursor-pointer border',
                      b.id === activeId ? 'border-2 border-amber-500 bg-amber-300/30' : 'border-brand-500/70 bg-brand-400/10 hover:bg-brand-400/25',
                    )}
                    style={{
                      top: `${b.box[0] / 10}%`,
                      left: `${b.box[1] / 10}%`,
                      height: `${(b.box[2] - b.box[0]) / 10}%`,
                      width: `${(b.box[3] - b.box[1]) / 10}%`,
                    }}
                  />
                ))}
              </div>
            </TransformComponent>
          </TransformWrapper>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">Chọn ảnh hoá đơn ở cột bên trái</div>
        )}
        {imageUrl && (
          <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
            {([
              ['Phóng to', ZoomIn, () => zoomRef.current?.zoomIn()],
              ['Thu nhỏ', ZoomOut, () => zoomRef.current?.zoomOut()],
              ['Vừa khung', Maximize, () => zoomRef.current?.resetTransform()],
            ] as const).map(([label, Icon, onClick]) => (
              <button key={label} type="button" title={label} aria-label={label} onClick={onClick}
                className="p-2 text-slate-600 hover:bg-slate-100 hover:text-brand-700 focus-visible:bg-slate-100 focus-visible:outline-none [&:not(:last-child)]:border-b [&:not(:last-child)]:border-slate-200">
                <Icon size={16} />
              </button>
            ))}
          </div>
        )}
      </section>
      <Splitter label="Đổi độ rộng cột dữ liệu" onResize={resize('right')} />

      {/* Col 3: extracted data */}
      <section className="flex min-h-[420px] flex-col gap-2 rounded-md border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap gap-1" role="tablist">
          {defs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn('rounded-md px-3 py-1 text-xs font-semibold', tab === t.key ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200')}
            >
              {t.label} <span className="opacity-60">({t.type})</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          {tabDef ? (
            <AgGridReact
              theme={gridTheme}
              key={tabDef.key}
              columnDefs={columnDefs}
              rowData={rowData}
              onGridReady={(e) => (gridApi.current = e.api)}
              onFirstDataRendered={(e) => focusActive(e.api)}
              onCellClicked={onCellClicked}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">Chưa có dữ liệu</div>
          )}
        </div>
      </section>
    </div>
  );
}
