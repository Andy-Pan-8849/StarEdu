"""Pull exact identifiers (error codes, document numbers, tax numbers) out of text.

Keyword search must find these exactly, so they are stored in their own column and indexed
beside the text. Case is kept as written.
"""

import re
from collections.abc import Iterable

# Hyphenated codes such as ERR-PORTAL-403, TS-NET-009, FIN-REIM-002, STC-2.
_HYPHENATED = re.compile(r"\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b")
# Long mixed letter-and-digit numbers such as the 18-character tax ID 91510000FAKE00001X.
_LONG_ALNUM = re.compile(r"\b(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{12,}\b")


def extract_identifiers(text: str, extra: Iterable[str] = ()) -> list[str]:
    found: dict[str, None] = {}
    for value in extra:
        found.setdefault(value, None)
    for pattern in (_HYPHENATED, _LONG_ALNUM):
        for match in pattern.finditer(text):
            found.setdefault(match.group(0), None)
    return list(found)
