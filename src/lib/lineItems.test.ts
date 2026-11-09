import assert from 'node:assert/strict';
import { splitQtyTimesPrice, type LineTable } from './lineItems';

const fields = [
  { key: 'item_name', label: 'item_name' },
  { key: 'quantity', label: 'quantity' },
  { key: 'unit_price', label: 'unit_price' },
  { key: 'amount', label: 'amount' },
];
const values = (t: LineTable) => t.rows.map((r) => Object.fromEntries(r.cells.map((c) => [c.key, c.value])));

// The minimart bill as the 4B model returned it: shifted one column, amount empty.
const shifted: LineTable = {
  type: 'array',
  fields,
  rows: [
    { cells: [{ key: 'item_name', value: 'Sữa tươi Vinamilk 1L' }, { key: 'quantity', value: '2 x 36.000', box_2d: [1, 2, 3, 4] }, { key: 'unit_price', value: '72.000', box_2d: [5, 6, 7, 8] }] },
    { cells: [{ key: 'item_name', value: 'Mì Hảo Hảo' }, { key: 'quantity', value: '5 x 4.500' }, { key: 'unit_price', value: '22.500' }] },
  ],
};
splitQtyTimesPrice([shifted]);
assert.deepEqual(values(shifted), [
  { item_name: 'Sữa tươi Vinamilk 1L', quantity: '2', unit_price: '36.000', amount: '72.000' },
  { item_name: 'Mì Hảo Hảo', quantity: '5', unit_price: '4.500', amount: '22.500' },
]);
// Boxes travel with the text they came from (Tesseract then narrows each one).
assert.deepEqual(shifted.rows[0].cells.find((c) => c.key === 'amount')?.box_2d, [5, 6, 7, 8]);
assert.deepEqual(shifted.rows[0].cells.find((c) => c.key === 'unit_price')?.box_2d, [1, 2, 3, 4]);

// Vietnamese field names, amount already in the right column.
const vi: LineTable = {
  type: 'array',
  fields: [{ key: 'ten_mon', label: 'Tên món' }, { key: 'sl', label: 'Số lượng' }, { key: 'don_gia', label: 'Đơn giá' }, { key: 'thanh_tien', label: 'Thành tiền' }],
  rows: [{ cells: [{ key: 'ten_mon', value: 'Bia Saigon' }, { key: 'sl', value: '6 x 18.000' }, { key: 'thanh_tien', value: '108.000' }] }],
};
splitQtyTimesPrice([vi]);
assert.deepEqual(values(vi), [{ ten_mon: 'Bia Saigon', sl: '6', don_gia: '18.000', thanh_tien: '108.000' }]);

// A number that is not quantity x price is never moved into the amount column.
const mismatch: LineTable = { type: 'array', fields, rows: [{ cells: [{ key: 'quantity', value: '2 x 36.000' }, { key: 'amount', value: '70.000' }] }] };
splitQtyTimesPrice([mismatch]);
assert.deepEqual(values(mismatch), [{ amount: '70.000', quantity: '2', unit_price: '36.000' }]);

// Rows already split, and object tables, are left alone.
const fine: LineTable = { type: 'array', fields, rows: [{ cells: [{ key: 'quantity', value: '2' }, { key: 'unit_price', value: '36.000' }, { key: 'amount', value: '72.000' }] }] };
const header: LineTable = { type: 'object', fields, rows: [{ cells: [{ key: 'quantity', value: '2 x 36.000' }] }] };
splitQtyTimesPrice([fine, header]);
assert.deepEqual(values(fine), [{ quantity: '2', unit_price: '36.000', amount: '72.000' }]);
assert.deepEqual(values(header), [{ quantity: '2 x 36.000' }]);

console.log('lineItems tests passed');
