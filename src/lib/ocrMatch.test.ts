import assert from 'node:assert/strict';
import { findBox, snapBoxes, type OcrWord, type SnapTable } from './ocrMatch';

// A 1000x1000 image so pixel coordinates equal normalized ones.
const word = (text: string, x0: number, y0: number, x1: number, y1: number): OcrWord => ({ text, bbox: { x0, y0, x1, y1 } });
const lines: OcrWord[][] = [
  [word('Tạm', 20, 100, 80, 120), word('tính', 90, 100, 160, 120), word('218.000', 800, 100, 950, 120)],
  [word('Tra', 20, 200, 70, 220), word('dao', 80, 200, 140, 220)], // OCR dropped the diacritics
  [word('1', 40, 240, 50, 260), word('x', 60, 240, 70, 260), word('45.000', 80, 240, 200, 260), word('45.000', 800, 240, 950, 260)],
  [word('Banh', 20, 300, 90, 320), word('croissant', 100, 300, 260, 320)],
  [word('1', 40, 340, 50, 360), word('x', 60, 340, 70, 360), word('32.000', 80, 340, 200, 360), word('32.000', 800, 340, 950, 360)],
];

// Value found on its own line, label excluded.
assert.deepEqual(findBox('218.000', lines, 1000, 1000), [100, 800, 120, 950]);
// Multi-word span with diacritics restored by the model.
assert.deepEqual(findBox('Trà đào', lines, 1000, 1000), [200, 20, 220, 140]);
// Duplicate text: the model's rough guess picks the right-hand amount.
assert.deepEqual(findBox('45.000', lines, 1000, 1000, [230, 780, 270, 960]), [240, 800, 260, 950]);
// OCR glued "2 x" into "2x": the quantity still gets a box, over the left half of that word.
const glued: OcrWord[][] = [[word('2x', 40, 500, 80, 520), word('36.000', 90, 500, 200, 520), word('22.000', 800, 500, 950, 520)]];
assert.deepEqual(findBox('2', glued, 1000, 1000), [500, 40, 520, 60]);
// ...but "2" never matches the start of a number like "22.000".
assert.equal(findBox('2', [[word('22.000', 800, 500, 950, 520)]], 1000, 1000), undefined);
// Text not on the bill: no box.
assert.equal(findBox('Cappuccino', lines, 1000, 1000), undefined);

// Model boxes drifted a line up (onto "Trà đào"); snapping lands the item row on its own lines.
const tables: SnapTable[] = [
  {
    type: 'array',
    rows: [
      {
        cells: [
          { value: 'Bánh croissant', box_2d: [200, 20, 220, 260] },
          { value: '1', box_2d: [240, 40, 260, 50] },
          { value: '32.000', box_2d: [240, 800, 260, 950] },
        ],
      },
    ],
  },
];
snapBoxes(tables, lines, 1000, 1000);
assert.deepEqual(
  tables[0].rows[0].cells.map((c) => c.box_2d),
  [
    [300, 20, 320, 260],
    [340, 40, 360, 50],
    [340, 800, 360, 950],
  ],
);

// Small-model hints: right column, wrong row. "36.000" is the unit price on row 1 and the amount on row 2;
// row 2's amount must stay on row 2, and its equal unit price and amount on row 3 get one box each.
const bill: OcrWord[][] = [
  [word('Sữa', 20, 100, 80, 120)],
  [word('2', 40, 130, 50, 150), word('x', 60, 130, 70, 150), word('36.000', 400, 130, 500, 150), word('72.000', 800, 130, 950, 150)],
  [word('Lavie', 20, 300, 100, 320)],
  [word('6', 40, 330, 50, 350), word('x', 60, 330, 70, 350), word('6.000', 400, 330, 500, 350), word('36.000', 800, 330, 950, 350)],
  [word('Dầu', 20, 400, 80, 420), word('ăn', 90, 400, 130, 420)],
  [word('1', 40, 430, 50, 450), word('x', 60, 430, 70, 450), word('58.000', 400, 430, 500, 450), word('58.000', 800, 430, 950, 450)],
];
const guessed: SnapTable[] = [
  {
    type: 'array',
    rows: [
      { cells: [{ value: 'Lavie', box_2d: [300, 20, 320, 100] }, { value: '6.000', box_2d: [330, 400, 350, 500] }, { value: '36.000', box_2d: [130, 400, 150, 500] }] },
      // Both hints on the amount column: the unit price (first field) still ends up on the left.
      { cells: [{ value: 'Dầu ăn', box_2d: [400, 20, 420, 130] }, { value: '58.000', box_2d: [430, 800, 450, 950] }, { value: '58.000', box_2d: [430, 800, 450, 950] }] },
    ],
  },
];
snapBoxes(guessed, bill, 1000, 1000);
assert.deepEqual(guessed[0].rows[0].cells[2].box_2d, [330, 800, 350, 950]);
assert.deepEqual(guessed[0].rows[1].cells.slice(1).map((c) => c.box_2d), [
  [430, 400, 450, 500],
  [430, 800, 450, 950],
]);

console.log('ocrMatch tests passed');
