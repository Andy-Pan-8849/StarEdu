"""文件：seed_biz.py
作用：把示例业务表(sample-data/structured/*.csv)载入 biz 模式，供数据问答使用。
主要思想：BIZ_SCHEMA 用“表 -> [(列, 类型)]”描述每张表，载入时按它转换类型；
CSV 里的空格子变成 NULL；先清空再插入，所以可重复运行；父表在前，满足外键顺序。
"""

import csv
from pathlib import Path

from sqlalchemy import Connection, text

# table -> [(column, Postgres type)], in the CSV's column order. Empty CSV cells become NULL.
# 表结构：列顺序与 CSV 一致，类型是 Postgres 类型
BIZ_SCHEMA: dict[str, list[tuple[str, str]]] = {
    "campuses": [("campus_id", "text"), ("name", "text"), ("city_tier", "int"),
                 ("region", "text"), ("opened_year", "int")],
    "employees": [("employee_id", "text"), ("name", "text"), ("campus_id", "text"),
                  ("department", "text"), ("title", "text"), ("level", "text"),
                  ("hire_date", "date"), ("status", "text")],
    "students": [("student_id", "text"), ("name", "text"), ("campus_id", "text"),
                 ("program", "text"), ("cohort", "text"), ("status", "text")],
    "assignments": [("assignment_id", "text"), ("program", "text"), ("title", "text"),
                    ("due_date", "date")],
    "submissions": [("submission_id", "text"), ("student_id", "text"), ("assignment_id", "text"),
                    ("submitted_at", "timestamp"), ("hours_late", "int"), ("raw_score", "int"),
                    ("late_penalty_pct", "int"), ("final_score", "int")],
    "expense_claims": [("claim_id", "text"), ("employee_id", "text"), ("campus_id", "text"),
                       ("category", "text"), ("city", "text"), ("nights_or_days", "int"),
                       ("guests", "int"), ("amount_cny", "int"), ("expense_date", "date"),
                       ("submitted_date", "date"), ("preapproved", "text"), ("status", "text"),
                       ("approver_role", "text")],
    "support_tickets": [("ticket_id", "text"), ("requester_type", "text"),
                        ("requester_id", "text"), ("campus_id", "text"), ("category", "text"),
                        ("priority", "text"), ("created_at", "timestamp"),
                        ("first_response_minutes", "int"), ("resolution_minutes", "int"),
                        ("status", "text")],
}  # fmt: skip


def load_biz(conn: Connection, csv_dir: Path) -> dict[str, int]:
    """清空并重新载入全部业务表。参数：conn 同步连接；csv_dir CSV 所在目录。返回：各表行数。"""
    conn.execute(text("TRUNCATE " + ", ".join(f"biz.{t}" for t in BIZ_SCHEMA)))
    counts: dict[str, int] = {}
    for table, columns in BIZ_SCHEMA.items():  # parents come before the tables that refer to them
        with open(csv_dir / f"{table}.csv", newline="", encoding="utf-8") as handle:
            rows = [
                {name: (row[name] if row[name] != "" else None) for name, _type in columns}
                for row in csv.DictReader(handle)
            ]
        names = ", ".join(name for name, _type in columns)
        values = ", ".join(f"CAST(:{name} AS {pg_type})" for name, pg_type in columns)
        conn.execute(text(f"INSERT INTO biz.{table} ({names}) VALUES ({values})"), rows)
        counts[table] = len(rows)
    return counts
