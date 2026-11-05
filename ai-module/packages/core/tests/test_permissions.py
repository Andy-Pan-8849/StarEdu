"""文件：测试——文档权限的常量与映射
测什么：清单里有 28 份文档；access 展开的角色与评测用的访问模型一致；
  清单里的权限级别都是已知的；
职级到职等的映射与文档一致，示例数据里每个职级都有职等，演示账号的职等列与代码一致；
缺失或未知职级无职等；总部职能角色。
"""

import csv
from pathlib import Path

import pytest
from starit_core.permissions import (
    ACCESS_LEVEL_ROLES,
    COMPANY_WIDE_ROLES,
    LEVEL_GRADE,
    expand_access_level,
    grade_of,
    has_all_campuses,
)

SAMPLE_DATA = Path(__file__).resolve().parents[3] / "sample-data"

# The access model of the evaluation set, written out independently of the code under test
# (sample-data/README.md, "Policy documents: access by role").
ROLE_CAN_READ = {
    "student": {"students-and-staff"},
    "staff": {"all-staff", "staff", "students-and-staff"},
    "manager": {"all-staff", "staff", "students-and-staff", "managers"},
    "hr": {"all-staff", "staff", "students-and-staff", "managers", "hr-only", "finance-and-hr"},
    "finance": {"all-staff", "staff", "students-and-staff", "managers", "finance-and-hr"},
}


def manifest_rows() -> list[dict[str, str]]:
    with open(SAMPLE_DATA / "documents" / "manifest.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_manifest_has_28_documents() -> None:
    assert len(manifest_rows()) == 28


@pytest.mark.parametrize("row", manifest_rows(), ids=lambda r: r["doc_id"])
def test_expansion_matches_the_evaluation_access_model(row: dict[str, str]) -> None:
    expanded = set(expand_access_level(row["access"]))
    for role, readable in ROLE_CAN_READ.items():
        assert (role in expanded) == (row["access"] in readable), (row["doc_id"], role)
    # Management roles never appear: they do not grant the right to read content.
    assert not expanded & {"Admin", "RAGETLAdmin"}


def test_every_access_level_in_the_manifest_is_known() -> None:
    assert {r["access"] for r in manifest_rows()} <= set(ACCESS_LEVEL_ROLES)


def test_unknown_access_level_is_rejected() -> None:
    with pytest.raises(ValueError):
        expand_access_level("everyone")


def test_grade_table_matches_the_documented_mapping() -> None:
    assert LEVEL_GRADE == {
        "S1": 1, "I1": 1, "S2": 2, "I2": 2, "S3": 3, "I3": 3,
        "I4": 4, "I5": 5, "M2": 6, "M3": 7,
    }  # fmt: skip


def test_every_level_in_the_sample_data_has_a_grade() -> None:
    with open(SAMPLE_DATA / "structured" / "employees.csv", newline="", encoding="utf-8") as f:
        levels = {row["level"] for row in csv.DictReader(f)}
    assert levels <= set(LEVEL_GRADE)


def test_demo_accounts_grade_column_agrees_with_the_code() -> None:
    with open(SAMPLE_DATA / "demo-accounts.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            expected = str(grade_of(row["level"])) if row["level"] else ""
            assert (expected if expected != "0" else "") == row["level_rank"], row["username"]


def test_missing_or_unknown_level_has_no_grade() -> None:
    assert grade_of(None) == 0
    assert grade_of("Z9") == 0


def test_company_wide_roles() -> None:
    assert {"hr", "finance"} == COMPANY_WIDE_ROLES
    assert has_all_campuses({"finance"})
    assert not has_all_campuses({"staff", "manager", "Admin"})
