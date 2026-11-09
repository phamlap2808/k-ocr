"""python3 ppocr/test_textmerge.py"""
from textmerge import merge

# Readings of the minimart bill's lines (VietOCR, PP-OCR latin).
assert merge('Phiếu: MM-TB-778120 Quầy:00', 'Phiu: MM-TB-778120 Quy: 03') == 'Phiếu: MM-TB-778120 Quầy: 03'
assert merge('22 12 020000', '2 x 32.000') == '2 x 32.000'  # mostly digits: latin as is
assert merge('Nước mắm Nam Ngư 500ml', 'Nưc mm Nam Ngư 500ml') == 'Nước mắm Nam Ngư 500ml'  # accents kept
# Latin never replaces letters, even where it reads a digit for one.
assert merge('Số lượng: 28', 'S lưng: 2B') == 'Số lượng: 28'
assert merge('Hotline:008832 1199', 'Hotline: 028 3822 1199') == 'Hotline: 028 3822 1199'
print('textmerge tests passed')
