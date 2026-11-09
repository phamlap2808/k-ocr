// Receipts print quantity and unit price as one span ("2 x 36.000") and the line amount on its own.
// Models map spans to columns one-to-one, so the row shifts: quantity="2 x 36.000", unit_price=amount.
// This splits the span and moves the cell whose value equals quantity x price into the amount column.

type Cell = { key: string; value: string; box_2d?: number[] };
type Field = { key: string; label: string };
export type LineTable = { type: 'object' | 'array'; fields: Field[]; rows: { cells: Cell[] }[] };

const QTY_TIMES_PRICE = /^\s*(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d[\d.,]*)\s*$/i;

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

// Vietnamese receipts: "36.000" is thirty-six thousand, "1,5" is one and a half.
function num(s: string) {
  const t = s.trim();
  return /^\d{1,3}(\.\d{3})+$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t.replace(',', '.'));
}

function findField(fields: Field[], pattern: RegExp, except: (string | undefined)[] = []) {
  return fields.find((f) => !except.includes(f.key) && pattern.test(plain(`${f.key} ${f.label}`)))?.key;
}

export function splitQtyTimesPrice(tables: LineTable[]) {
  for (const t of tables) {
    if (t.type !== 'array') continue;
    const amountKey = findField(t.fields, /amount|total|thanh.?tien|line/);
    const unitKey = findField(t.fields, /unit|price|don.?gia|gia/, [amountKey]);
    const qtyKey = findField(t.fields, /qty|quantity|so.?luong|\bsl\b|count/, [amountKey, unitKey]);
    if (!qtyKey || !unitKey) continue;
    for (const row of t.rows) {
      const span = row.cells.find((c) => QTY_TIMES_PRICE.test(c.value));
      if (!span) continue;
      const [, qty, price] = span.value.match(QTY_TIMES_PRICE)!;
      const expected = num(qty) * num(price);
      const amount = amountKey
        ? row.cells.find((c) => c !== span && c.value.trim() && Math.abs(num(c.value) - expected) < 0.5)
        : undefined;
      const moved = new Set<Cell>([span, ...(amount ? [amount] : [])]);
      const replaced = new Set([qtyKey, unitKey, ...(amount ? [amountKey] : [])]);
      row.cells = [
        ...row.cells.filter((c) => !moved.has(c) && !replaced.has(c.key)),
        { key: qtyKey, value: qty, box_2d: span.box_2d },
        { key: unitKey, value: price, box_2d: span.box_2d },
        ...(amount && amountKey ? [{ key: amountKey, value: amount.value, box_2d: amount.box_2d }] : []),
      ];
    }
  }
  return tables;
}
