"""文件：leak.py
作用：独立地检查“搜索结果里有没有提问者无权读的文档”。
主要思想：这里依据文档里记录的访问模型(sample-data/README.md)和清单重新写了一遍判断，
故意不与 starit_core.permissions 共用代码——两份独立实现必须得出一致的结论，
才能说明权限没有写错；不一致就是 bug。
"""

from collections.abc import Iterable, Mapping

# 每种访问级别能读的角色（与 permissions.ACCESS_LEVEL_ROLES 是各自独立写的）
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
    """这些角色能不能读这份（文档, 版本）；清单里没有的文档一律不允许。"""
    row = manifest.get((doc_code, version))
    if row is None:
        return False  # unknown documents are never allowed
    return bool(READABLE_BY[row["access"]] & set(roles))
