// Replaces LLM-guessed boxes with boxes measured by an OCR engine (Tesseract words), matched by text.
// Boxes use Gemini's convention: [ymin, xmin, ymax, xmax] normalized 0-1000.

export type OcrWord = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } };
export type SnapCell = { value: string; box_2d?: number[] };
export type SnapTable = { type: 'object' | 'array'; rows: { cells: SnapCell[] }[] };

// OCR often drops Vietnamese diacritics and punctuation, so compare on bare lowercase letters and digits.
const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');

function similarity(a: string, b: string) {
  if (a === b) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

const center = (b: number[]) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

const sameBox = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);

// `taken`: boxes other cells already use; skipped while another match is left ("22.000" as both unit price and amount).
export function findBox(value: string, lines: OcrWord[][], width: number, height: number, hint?: number[], taken: number[][] = []) {
  const v = norm(value);
  if (!v) return undefined;
  const min = v.length <= 3 ? 1 : 0.75; // short values ("1", "x2") must match exactly
  const found: { score: number; box: number[] }[] = [];
  for (const words of lines) {
    for (let i = 0; i < words.length; i++) {
      // OCR glues "2 x 36.000" into "2x": let a short value match the start of a word, boxed by its share of the letters.
      const w = norm(words[i].text);
      if (v.length <= 3 && w.length > v.length && w.startsWith(v) && !/\d/.test(w[v.length])) {
        const b = words[i].bbox;
        const x1 = b.x0 + ((b.x1 - b.x0) * v.length) / w.length;
        found.push({ score: 0.99, box: [(b.y0 / height) * 1000, (b.x0 / width) * 1000, (b.y1 / height) * 1000, (x1 / width) * 1000].map(Math.round) });
      }
      let text = '';
      for (let j = i; j < words.length && text.length <= v.length * 1.5 + 2; j++) {
        text += norm(words[j].text);
        const score = similarity(text, v);
        if (score < min) continue;
        const span = words.slice(i, j + 1).map((w) => w.bbox);
        found.push({
          score,
          box: [
            (Math.min(...span.map((b) => b.y0)) / height) * 1000,
            (Math.min(...span.map((b) => b.x0)) / width) * 1000,
            (Math.max(...span.map((b) => b.y1)) / height) * 1000,
            (Math.max(...span.map((b) => b.x1)) / width) * 1000,
          ].map(Math.round),
        });
      }
    }
  }
  if (!found.length) return undefined;
  const best = Math.max(...found.map((f) => f.score));
  const good = found.filter((f) => f.score >= best - 0.05);
  const free = good.filter((f) => !taken.some((t) => sameBox(t, f.box)));
  const top = free.length ? free : good;
  if (!hint) return top[0].box;
  // The same text can appear twice ("45.000" as unit price and amount): take the one nearest the model's guess.
  // Rows matter more than columns: small models put a box in the right column of the wrong row far more often than the reverse.
  const [hy, hx] = center(hint);
  const dist = (b: number[]) => Math.hypot((center(b)[0] - hy) * 4, center(b)[1] - hx);
  return top.reduce((a, b) => (dist(b.box) < dist(a.box) ? b : a)).box;
}

// Mutates box_2d in place; cells with no confident match keep the model's box.
export function snapBoxes(tables: SnapTable[], lines: OcrWord[][], width: number, height: number) {
  for (const t of tables) {
    for (const row of t.rows) {
      // In an item row every cell sits on the same line(s): anchor on the most distinctive (longest) value first.
      let anchor: number[] | undefined;
      const taken: number[][] = [];
      for (const cell of [...row.cells].sort((a, b) => norm(b.value).length - norm(a.value).length)) {
        const model = cell.box_2d?.length === 4 ? cell.box_2d : undefined;
        const hint = t.type === 'array' && anchor ? [anchor[0], model?.[1] ?? anchor[1], anchor[2], model?.[3] ?? anchor[3]] : model;
        const box = findBox(cell.value, lines, width, height, hint, taken);
        if (!box) continue;
        cell.box_2d = box;
        taken.push(box);
        anchor ??= box;
      }
      // Cells with the same text (unit price = amount when qty is 1) take their boxes left to right in field order.
      for (const v of new Set(row.cells.map((c) => norm(c.value)))) {
        const same = row.cells.filter((c) => norm(c.value) === v && c.box_2d?.length === 4);
        const boxes = same.map((c) => c.box_2d!).sort((a, b) => a[1] - b[1]);
        same.forEach((c, i) => (c.box_2d = boxes[i]));
      }
    }
  }
  return tables;
}
