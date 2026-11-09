// Reads a receipt from OCR text lines with rules, no LLM: header facts, line items and totals become the
// bill page's tables. With a schema it fills that schema; without one it proposes one, like the LLM readers do.
// Boxes use Gemini's convention: [ymin, xmin, ymax, xmax] normalized 0-1000.

export type OcrLine = { text: string; poly: number[][] }; // poly: [tl, tr, br, bl] in image pixels
type FieldDef = { key: string; label: string };
export type RuleTableDef = { key: string; label: string; type: 'object' | 'array'; fields: FieldDef[] };
type Cell = { key: string; value: string; box_2d?: number[] };
export type RuleTable = RuleTableDef & { rows: { cells: Cell[] }[] };

const MONEY = /^-?\d{1,3}(?:[.,]\d{3})+$/; // 850.000  2.060.000  -20.000
const QTY_X_PRICE = /^(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d[\d.,]*)$/i; // 2 x 36.000
const SMALL_INT = /^\d{1,3}$/;
const BARCODE = /^\d{8,14}$/;
const DATE = /\d{1,2}\/\d{1,2}\/\d{2,4}/;
const COLUMN = /^(stt|tt|món|tên món|tên hàng|tên hàng hóa|mặt hàng|sản phẩm|sl|số lượng|đvt|đơn giá|giá|thành tiền)$/;
const TOTAL = /tổng|tạm tính|cộng|thanh toán|giảm giá|chiết khấu|vat|thuế|phí|tiền khách|tiền thối|tiền thừa|total/;
const PREFIX = /^(sđt|sdt|đt|dt|hotline|tel|mst|ngày|giờ)\.?\s+(.+)$/i; // "SDT 0938 456 123", "Ngày 18/10/2026"
const ADDRESS = /,|\b(q|p|tp)\.|đường|phường|quận|huyện/i;
const LABEL = /(?:^|[\s\-|,])((?:\p{L}+\.?\s?){1,5}?)\s*:\s*/gu; // "Ngày: ..."  "MST: ... -DT: ..."

const lower = (s: string) => s.normalize('NFC').toLowerCase().trim();
export const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const hasLetters = (s: string) => /\p{L}.*\p{L}/u.test(s);

type Line = { text: string; box: number[]; x: number; y: number; h: number };
type Field = { key: string; label: string; value: string; box: number[] };
type Item = { name?: Field; qty?: Field; unit?: Field; price?: Field; amount?: Field };
type Role = keyof Item | 'skip';

// "Ngày: 22/10 Quầy: 03" -> [{label: "Ngày", value: "22/10"}, {label: "Quầy", value: "03"}]
function labelled(text: string) {
  const found = [...text.matchAll(LABEL)];
  return found.map((m, i) => ({
    label: m[1].trim(),
    value: text.slice(m.index! + m[0].length, found[i + 1]?.index ?? text.length).replace(/^[\s\-|,]+|[\s\-|,]+$/g, ''),
  }));
}

export function readReceipt(ocrLines: OcrLine[], width: number, height: number): RuleTable[] {
  // Photos are tilted: measure the skew on long lines and read positions in the straightened frame.
  const angles = ocrLines
    .filter(({ poly: [tl, tr, , bl] }) => Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) > 3 * Math.hypot(bl[0] - tl[0], bl[1] - tl[1]))
    .map(({ poly: [tl, tr] }) => Math.atan2(tr[1] - tl[1], tr[0] - tl[0]))
    .sort((a, b) => a - b);
  const skew = angles.length ? angles[angles.length >> 1] : 0;
  const [cos, sin] = [Math.cos(skew), Math.sin(skew)];
  const lines: Line[] = ocrLines
    .filter((l) => l.text.trim())
    .map(({ text, poly }) => {
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      const cx = xs.reduce((a, b) => a + b) / 4, cy = ys.reduce((a, b) => a + b) / 4;
      return {
        text: text.trim(),
        box: [(Math.min(...ys) / height) * 1000, (Math.min(...xs) / width) * 1000, (Math.max(...ys) / height) * 1000, (Math.max(...xs) / width) * 1000].map(Math.round),
        x: cx * cos + cy * sin,
        y: -cx * sin + cy * cos,
        h: Math.hypot(poly[3][0] - poly[0][0], poly[3][1] - poly[0][1]),
      };
    });
  const lineH = [...lines.map((l) => l.h)].sort((a, b) => a - b)[lines.length >> 1] ?? 1;

  // Rows: lines whose straightened centres sit within half a line height.
  const rows: Line[][] = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y)) {
    const row = rows.at(-1);
    if (row && Math.abs(l.y - row[0].y) < lineH / 2) row.push(l);
    else rows.push([l]);
  }
  rows.forEach((r) => r.sort((a, b) => a.x - b.x));
  const rowText = (r: Line[]) => lower(r.map((l) => l.text).join(' '));
  const isMoneyRow = (r: Line[]) => r.some((l) => MONEY.test(l.text) || QTY_X_PRICE.test(l.text));
  const isLabelled = (l: Line) => labelled(l.text).length > 0 || PREFIX.test(l.text);

  // Item columns: a row of at least two column titles ("Món  SL  Thành tiền").
  const headerAt = rows.findIndex((r) => r.filter((l) => COLUMN.test(lower(l.text))).length >= 2);
  const firstMoney = rows.findIndex(isMoneyRow);
  let itemsFrom = headerAt + 1;
  if (headerAt < 0) {
    // No titles: items start after the last labelled header line above the first price.
    itemsFrom = 1;
    for (let i = 0; i < (firstMoney < 0 ? rows.length : firstMoney); i++) if (rows[i].some((l) => isLabelled(l) || DATE.test(l.text))) itemsFrom = i + 1;
  }
  let totalsFrom = rows.findIndex((r, i) => i >= itemsFrom && hasLetters(rowText(r)) && (TOTAL.test(rowText(r)) || r.some((l) => labelled(l.text).length)));
  if (totalsFrom < 0) totalsFrom = rows.length;

  const info: Field[] = [];
  const add = (label: string, value: string, box: number[]) => {
    const base = slug(label) || 'gia_tri';
    let key = base;
    for (let n = 2; info.some((f) => f.key === key); n++) key = `${base}_${n}`;
    info.push({ key, label, value, box });
  };

  // Header: name, address, labelled facts.
  rows.slice(0, headerAt < 0 ? itemsFrom : headerAt).forEach((row, i) => {
    if (i === 0 && !row.some(isLabelled)) {
      const text = row.map((l) => l.text).join(' ');
      const box = [Math.min(...row.map((l) => l.box[0])), Math.min(...row.map((l) => l.box[1])), Math.max(...row.map((l) => l.box[2])), Math.max(...row.map((l) => l.box[3]))];
      return /hóa đơn|hoá đơn|invoice|receipt/i.test(text) ? add('Tiêu đề', text, box) : add('Tên cửa hàng', text, box);
    }
    row.forEach((l, j) => {
      const pairs = labelled(l.text);
      const prefix = l.text.match(PREFIX);
      if (pairs.length) {
        for (const p of pairs) {
          // "Đơn vị bán:" with its value in the next line of the row.
          const next = !p.value && row[j + 1] && !isLabelled(row[j + 1]) ? row[j + 1] : null;
          add(p.label, next ? next.text : p.value, (next ?? l).box);
          if (next) next.text = '';
        }
      } else if (prefix) add(prefix[1], prefix[2], l.box);
      else if (DATE.test(l.text)) add('Ngày', l.text, l.box);
      else if (l.text && ADDRESS.test(l.text) && !info.some((f) => f.key === 'dia_chi')) add('Địa chỉ', l.text, l.box);
    });
  });

  // Items.
  const columns: { x: number; role: Role }[] = headerAt < 0 ? [] : rows[headerAt].flatMap((l) => {
    const t = lower(l.text);
    const role: Role | null = /^(stt|tt)$/.test(t) ? 'skip' : /^(sl|số lượng)$/.test(t) ? 'qty' : t === 'đvt' ? 'unit'
      : /giá$/.test(t) && t !== 'thành tiền' ? 'price' : t === 'thành tiền' ? 'amount' : COLUMN.test(t) ? 'name' : null;
    return role ? [{ x: l.x, role }] : [];
  });
  const items: Item[] = [];
  for (const row of rows.slice(itemsFrom, totalsFrom)) {
    const item: Item = {};
    for (const l of row) {
      const f = (value: string): Field => ({ key: '', label: '', value, box: l.box });
      const qxp = l.text.match(QTY_X_PRICE);
      let role: Role;
      if (columns.length) role = columns.reduce((a, b) => (Math.abs(b.x - l.x) < Math.abs(a.x - l.x) ? b : a)).role;
      else if (qxp) role = 'qty';
      else if (MONEY.test(l.text)) role = 'amount';
      else if (SMALL_INT.test(l.text)) role = 'qty';
      else if (BARCODE.test(l.text) || !hasLetters(l.text)) role = 'skip';
      else role = 'name';
      if (role === 'skip') continue;
      if (qxp && (role === 'qty' || role === 'price')) {
        item.qty = f(qxp[1]);
        item.price = f(qxp[2]);
      } else if (role === 'name') {
        const lead = l.text.match(/^(\d{1,3})\s+(\p{L}.*)$/u); // handwritten "3 Bún bò đặc biệt"
        if (lead && !columns.length) item.qty ??= f(lead[1]);
        item.name = f(lead && !columns.length ? lead[2] : l.text);
      } else if (role === 'amount' && item.amount && !columns.length) {
        // Two prices on a line without columns: unit price, then amount.
        item.price ??= item.amount;
        item.amount = f(l.text);
      } else item[role] = f(l.text);
    }
    const last = items.at(-1);
    // A row without a name continues the item above ("2 x 36.000   72.000" under "Sữa tươi Vinamilk 1L").
    if (!item.name && last && Object.keys(item).every((k) => !last[k as keyof Item])) Object.assign(last, item);
    else if (Object.keys(item).length) items.push(item);
  }

  // Totals and footer: "label value" rows, labelled lines, or a label whose amount drifted to the next row.
  let pending: { label: string; box: number[] } | null = null;
  for (const row of rows.slice(totalsFrom)) {
    const money = row.filter((l) => MONEY.test(l.text));
    const words = row.filter((l) => !MONEY.test(l.text) && hasLetters(l.text));
    const pairs = words.flatMap((l) => labelled(l.text).map((p) => ({ ...p, box: l.box })));
    if (pairs.length && pairs.every((p) => p.value)) {
      pairs.forEach((p) => add(p.label, p.value, p.box));
      continue;
    }
    const label = words.map((l) => l.text).join(' ').replace(/:\s*$/, '');
    if (label && money.length) add(label, money.at(-1)!.text, money.at(-1)!.box);
    else if (label && TOTAL.test(lower(label))) pending = { label, box: words[0].box };
    else if (!label && money.length && pending) {
      add(pending.label, money.at(-1)!.text, money.at(-1)!.box);
      pending = null;
    }
  }

  const itemFields: [keyof Item, string, string][] = [
    ['name', 'ten_hang', 'Tên hàng'],
    ['qty', 'so_luong', 'Số lượng'],
    ['unit', 'dvt', 'ĐVT'],
    ['price', 'don_gia', 'Đơn giá'],
    ['amount', 'thanh_tien', 'Thành tiền'],
  ];
  const used = itemFields.filter(([role]) => role !== 'unit' || items.some((it) => it.unit));
  return [
    {
      key: 'thong_tin',
      label: 'Thông tin',
      type: 'object',
      fields: info.map(({ key, label }) => ({ key, label })),
      rows: [{ cells: info.map(({ key, value, box }) => ({ key, value, box_2d: box })) }],
    },
    {
      key: 'mat_hang',
      label: 'Mặt hàng',
      type: 'array',
      fields: used.map(([, key, label]) => ({ key, label })),
      rows: items.map((it) => ({ cells: used.flatMap(([role, key]) => (it[role] ? [{ key, value: it[role]!.value, box_2d: it[role]!.box }] : [])) })),
    },
  ];
}

// Concepts shared by the rule fields and an LLM-made or hand-made schema, matched on "key label" in slug form.
const CONCEPTS: [string, RegExp][] = [
  ['store', /store|shop|merchant|seller|cua_hang|nha_hang|don_vi_ban/],
  ['address', /address|dia_chi/],
  ['phone', /phone|hotline|tel|dien_thoai|sdt|(^|_)dt($|_)/],
  ['tax', /tax_code|mst|ma_so_thue/],
  ['date', /date|ngay/],
  ['invoice', /invoice|receipt_no|bill_no|so_hd|(^|_)hd($|_)|phieu|so_hoa_don/],
  ['total', /^total|grand_total|total_amount|tong_cong|thanh_toan|tong_tien($|_thanh)/],
];
const ITEM_ROLES: [string, RegExp][] = [
  ['thanh_tien', /amount|total|thanh_tien|line/],
  ['don_gia', /unit_price|price|don_gia|gia/],
  ['so_luong', /qty|quantity|so_luong|(^|_)sl($|_)|count/],
  ['dvt', /dvt|uom|unit|don_vi/],
  ['ten_hang', /name|ten|mon|hang|item|product|desc/],
];
const concept = (f: FieldDef) => CONCEPTS.find(([, re]) => re.test(`${f.key} ${slug(f.label)}`))?.[0];

// Fills the given schema from the rule tables: same key first, then same label, then the same concept.
export function fitSchema(read: RuleTable[], defs: RuleTableDef[]): RuleTable[] {
  const [info, items] = read;
  const infoCells = info.rows[0].cells;
  return defs.map((def) => {
    if (def.type === 'array') {
      const source = def.fields.map((f) => ITEM_ROLES.find(([, re]) => re.test(`${slug(f.key)}_${slug(f.label)}`))?.[0]);
      return {
        ...def,
        rows: items.rows.map((r) => ({
          cells: def.fields.flatMap((f, i) => {
            const c = r.cells.find((c) => c.key === f.key) ?? r.cells.find((c) => c.key === source[i]);
            return c ? [{ ...c, key: f.key }] : [];
          }),
        })),
      };
    }
    const taken = new Set<string>();
    const cells = def.fields.flatMap((f) => {
      const free = info.fields.filter((g) => !taken.has(g.key));
      const own = free.find((g) => g.key === f.key) ?? free.find((g) => slug(g.label) === slug(f.label)) ?? free.find((g) => concept(f) && concept(g) === concept(f));
      const c = own && infoCells.find((c) => c.key === own.key);
      if (!c) return [];
      taken.add(c.key);
      return [{ ...c, key: f.key }];
    });
    return { ...def, rows: [{ cells }] };
  });
}
