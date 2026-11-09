import assert from 'node:assert/strict';
import { fitSchema, readReceipt, type OcrLine } from './receiptRules';

// A 1000x1000 image so pixels equal the 0-1000 boxes; `tilt` px per 1000 px of x mimics a photo taken at an angle.
const line = (text: string, x0: number, y0: number, x1: number, tilt = 0): OcrLine => {
  const dy = (x: number) => (x * tilt) / 1000;
  return { text, poly: [[x0, y0 + dy(x0)], [x1, y0 + dy(x1)], [x1, y0 + 20 + dy(x1)], [x0, y0 + 20 + dy(x0)]] };
};
const values = (t: { rows: { cells: { key: string; value: string }[] }[] }) => t.rows.map((r) => Object.fromEntries(r.cells.map((c) => [c.key, c.value])));

// Minimart layout: name line, then "Q x P   amount" under it; labelled header facts; totals.
const shop = readReceipt(
  [
    line('MINIMART 24H', 300, 20, 700),
    line('312 Cộng Hòa, P.13', 300, 50, 700),
    line('MST: 0312345678 -DT: 1900 6868', 200, 80, 800),
    line('Sữa tươi Vinamilk 1L', 50, 130, 400),
    line('8934673001234', 60, 160, 280),
    line('2 x 36.000', 540, 160, 680),
    line('72.000', 840, 160, 950),
    line('Tổng tiền', 50, 220, 260),
    line('72.000', 840, 220, 950),
  ],
  1000,
  1000,
);
assert.deepEqual(values(shop[0]), [{ ten_cua_hang: 'MINIMART 24H', dia_chi: '312 Cộng Hòa, P.13', mst: '0312345678', dt: '1900 6868', tong_tien: '72.000' }]);
assert.deepEqual(values(shop[1]), [{ ten_hang: 'Sữa tươi Vinamilk 1L', so_luong: '2', don_gia: '36.000', thanh_tien: '72.000' }]);
assert.deepEqual(shop[1].fields.map((f) => f.key), ['ten_hang', 'so_luong', 'don_gia', 'thanh_tien']);

// Restaurant photo tilted ~5 degrees, with column titles: amounts sit a line lower than their names unless deskewed.
const tilt = 90;
const photo = readReceipt(
  [
    line('NHÀ HÀNG BIỂN ĐÔNG', 100, 20, 900, tilt),
    line('Bàn: 12', 100, 60, 250, tilt),
    line('Món', 100, 120, 180, tilt),
    line('SL', 500, 120, 540, tilt),
    line('Thành tiền', 750, 120, 900, tilt),
    line('Tôm hùm nướng', 100, 160, 400, tilt),
    line('1', 510, 160, 525, tilt),
    line('850.000', 780, 160, 900, tilt),
    line('Ghẹ hấp bia', 100, 200, 330, tilt),
    line('2', 510, 200, 525, tilt),
    line('440.000', 780, 200, 900, tilt),
    line('THANH TOÁN', 100, 260, 350, tilt),
    line('1.290.000', 740, 260, 900, tilt),
  ],
  1000,
  1000,
);
assert.deepEqual(values(photo[1]), [
  { ten_hang: 'Tôm hùm nướng', so_luong: '1', thanh_tien: '850.000' },
  { ten_hang: 'Ghẹ hấp bia', so_luong: '2', thanh_tien: '440.000' },
]);
assert.equal(values(photo[0])[0].thanh_toan, '1.290.000');

// Handwritten: quantity written before the name, label "Cộng:" whose amount drifted to the next row.
const hand = readReceipt(
  [line('Quán Cô Ba', 100, 20, 500), line('Ngày 18/10/2026', 100, 60, 400), line('3 Bún bò đặc biệt', 100, 120, 450), line('195.000', 700, 120, 850), line('Cộng:', 100, 200, 220), line('195.000', 700, 240, 850)],
  1000,
  1000,
);
assert.deepEqual(values(hand[1]), [{ ten_hang: 'Bún bò đặc biệt', so_luong: '3', thanh_tien: '195.000' }]);
assert.deepEqual(values(hand[0]), [{ ten_cua_hang: 'Quán Cô Ba', ngay: '18/10/2026', cong: '195.000' }]);

// A schema made by an LLM run (English keys) is filled by concept; unknown fields stay empty.
const fitted = fitSchema(shop, [
  { key: 'header', label: 'Store info', type: 'object', fields: [{ key: 'store_name', label: 'Store Name' }, { key: 'tax_code', label: 'Tax code' }, { key: 'total_amount', label: 'Total' }, { key: 'cashier', label: 'Cashier' }] },
  { key: 'items', label: 'Items', type: 'array', fields: [{ key: 'item_name', label: 'Name' }, { key: 'quantity', label: 'Qty' }, { key: 'unit_price', label: 'Unit price' }, { key: 'amount', label: 'Amount' }] },
]);
assert.deepEqual(values(fitted[0]), [{ store_name: 'MINIMART 24H', tax_code: '0312345678', total_amount: '72.000' }]);
assert.deepEqual(values(fitted[1]), [{ item_name: 'Sữa tươi Vinamilk 1L', quantity: '2', unit_price: '36.000', amount: '72.000' }]);
// Its own schema maps back onto itself unchanged.
assert.deepEqual(values(fitSchema(shop, shop)[1]), values(shop[1]));

console.log('receiptRules tests passed');
