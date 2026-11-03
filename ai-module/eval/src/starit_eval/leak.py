"""An independent check that a search returned nothing the asker may not read.

Written from the documented access model (sample-data/README.md) and the document manifest,
and deliberately not sharing code with starit_core.permissions: the point is two separate
implementations that have to agree.
"""

from collections.abc import Iterable, Mapping

READABLE_BY: Mapping[str, frozenset[str]] = {
    "students-and-staff": frozenset({"student", "staff", "manager", "hr", "finance"}),
    "all-staff": frozenset({"staff", "manager", "hr", "finance"}),
    "staff": frozenset({"staff", "manager", "hr", "finance"}),
    "managers": frozenset({"manager", "hr", "finance"}),
    "finance-and-hr": frozenset({"hr", "finance"}),
    "hr-only": frozenset({"hr"}),
}


def may_read(
    roles: Iterable[str],
    doc_code: str,
    version: str,
    manifest: Mapping[tuple[str, str], Mapping[str, str]],
) -> bool:
    row = manifest.get((doc_code, version))
    if row is None:
        return False  # unknown documents are never allowed
    return bool(READABLE_BY[row["access"]] & set(roles))
