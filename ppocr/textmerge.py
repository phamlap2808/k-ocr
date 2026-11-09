"""Merge two readings of one text line: VietOCR's (right accents, shaky digits) and PP-OCR latin's (right digits,
no stacked accents). "Phiếu: MM-TB-778120 Quầy:00" + "Phiu: MM-TB-778120 Quy: 03" -> "Phiếu: MM-TB-778120 Quầy: 03"."""
import re
import unicodedata
from difflib import SequenceMatcher

NUMERIC = re.compile(r'^[\d\s.,:;/\-+%()]*$')  # digits and the punctuation around them, no letters


def base(c):
    return 'd' if c in 'đĐ' else unicodedata.normalize('NFD', c)[0]


def digit_share(text):
    chars = [c for c in text if not c.isspace()]
    return sum(c.isdigit() for c in chars) / max(1, len(chars))


def merge(viet, latin):
    # A line that is mostly digits ("2 x 32.000", where VietOCR read "22 12 020000"): latin wins outright.
    if digit_share(latin) >= 0.5:
        return latin
    # Align on accent-free letters (one base letter per character keeps the indices in step), then take latin's
    # spans wherever both readings hold only digits, spaces and punctuation there.
    out = []
    for op, i1, i2, j1, j2 in SequenceMatcher(None, ''.join(map(base, viet)), latin, autojunk=False).get_opcodes():
        v, l = viet[i1:i2], latin[j1:j2]
        out.append(l if op != 'equal' and NUMERIC.match(v) and NUMERIC.match(l) else v)
    return ''.join(out)
