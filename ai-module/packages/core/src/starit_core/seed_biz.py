"""Load the sample business tables (sample-data/structured/*.csv) into the biz schema."""

import csv
from pathlib import Path

from sqlalchemy import Connection, text

# table -> [(column, Postgres type)], in the CSV's column order. Empty CSV cells become NULL.
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
    """Replace the contents of every biz table with the CSV data. Returns row counts."""
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
