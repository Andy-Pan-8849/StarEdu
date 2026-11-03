"""What the assistant may know about the business data: the views, who can use them, and the
text that describes them to the model.

The views in the `ai_sql` schema do the real filtering (docs/design/02-data-model.md, section 5).
The role table here is only used to refuse early and to tell the model what exists; a test keeps
it in step with the views.
"""

from dataclasses import dataclass

from starit_core.auth import Identity

ALL_ROLES = frozenset({"student", "staff", "manager", "hr", "finance", "Admin", "RAGETLAdmin"})
STAFF_SIDE = frozenset({"staff", "manager", "hr", "finance"})
EVERYONE_WITH_DATA = frozenset({"student", "staff", "manager", "hr", "finance"})

CAMPUSES = {
    "BJ": "Beijing (headquarters)",
    "SH": "Shanghai",
    "SZ": "Shenzhen",
    "GZ": "Guangzhou",
    "HZ": "Hangzhou",
    "CD": "Chengdu",
    "WH": "Wuhan",
    "XA": "Xi'an",
}


@dataclass(frozen=True)
class View:
    name: str
    description: str
    columns: tuple[tuple[str, str, str], ...]  # (name, SQL type, note)
    roles: frozenset[str]  # roles that can see any row of it at all


VIEWS: dict[str, View] = {
    v.name: v
    for v in (
        View(
            "campuses",
            "The eight campuses.",
            (
                ("campus_id", "text", "BJ, SH, SZ, GZ, HZ, CD, WH, XA"),
                ("name", "text", ""),
                ("city_tier", "integer", "1 or 2; hotel and meal limits depend on it"),
                ("region", "text", ""),
                ("opened_year", "integer", ""),
            ),
            ALL_ROLES,
        ),
        View(
            "assignments",
            "Course assignments.",
            (
                (
                    "assignment_id",
                    "text",
                    "JA-A01.. (java), PY-A01.. (python), TY-A01.. (typescript)",
                ),
                ("program", "text", "java, python or typescript"),
                ("title", "text", ""),
                ("due_date", "date", ""),
            ),
            ALL_ROLES,
        ),
        View(
            "students",
            "Students.",
            (
                ("student_id", "text", "S0001.."),
                ("name", "text", ""),
                ("campus_id", "text", ""),
                ("program", "text", "java, python or typescript"),
                ("cohort", "text", "for example 2026S1"),
                ("status", "text", "active or withdrawn"),
            ),
            EVERYONE_WITH_DATA,
        ),
        View(
            "submissions",
            "Assignment submissions with late penalties.",
            (
                ("submission_id", "text", ""),
                ("student_id", "text", ""),
                ("assignment_id", "text", ""),
                ("submitted_at", "timestamp", ""),
                ("hours_late", "integer", "0 when on time"),
                ("raw_score", "integer", "before the late penalty"),
                ("late_penalty_pct", "integer", "0, 10, 20, 30 or 100"),
                ("final_score", "integer", "after the late penalty"),
            ),
            EVERYONE_WITH_DATA,
        ),
        View(
            "support_tickets",
            "Helpdesk tickets. A ticket belongs to the campus of the person who opened it.",
            (
                ("ticket_id", "text", ""),
                ("requester_type", "text", "student or staff"),
                ("requester_id", "text", "a student_id or an employee_id"),
                ("campus_id", "text", ""),
                ("category", "text", "login, environment, portal, git, network, hardware"),
                ("priority", "text", "P1, P2 or P3"),
                ("created_at", "timestamp", ""),
                ("first_response_minutes", "integer", ""),
                ("resolution_minutes", "integer", ""),
                ("status", "text", ""),
            ),
            EVERYONE_WITH_DATA,
        ),
        View(
            "employees",
            "Employees.",
            (
                ("employee_id", "text", "E0001.."),
                ("name", "text", ""),
                ("campus_id", "text", ""),
                (
                    "department",
                    "text",
                    "Campus Management, Academic, Admissions and Student Services, "
                    "Career Services, Campus Operations, Human Resources, Finance, "
                    "IT and Technical Support, Academic Office",
                ),
                ("title", "text", ""),
                ("level", "text", "I1-I5 instructors, S1-S3 staff, M2-M3 managers"),
                ("hire_date", "date", ""),
                ("status", "text", "active"),
            ),
            STAFF_SIDE,
        ),
        View(
            "expense_claims",
            "Expense claims.",
            (
                ("claim_id", "text", "C0001.."),
                ("employee_id", "text", "who submitted it"),
                ("campus_id", "text", "the submitter's campus"),
                (
                    "category",
                    "text",
                    "TRAVEL-HOTEL, TRAVEL-MEAL, TRAVEL-TRANSPORT, ENTERTAIN (entertainment), "
                    "TEACH (teaching supplies), CERT (certification)",
                ),
                ("city", "text", "for hotel claims: the city name, for example Chengdu"),
                ("nights_or_days", "integer", "nights for hotels, days for meals"),
                ("guests", "integer", "for entertainment"),
                ("amount_cny", "integer", "total claimed, in CNY"),
                ("expense_date", "date", ""),
                ("submitted_date", "date", ""),
                ("preapproved", "text", "yes, no, or NULL when not applicable"),
                ("status", "text", "paid, approved, pending or rejected"),
                ("approver_role", "text", ""),
            ),
            STAFF_SIDE,
        ),
    )
}

VIEW_ROLES: dict[str, frozenset[str]] = {name: view.roles for name, view in VIEWS.items()}


def can_use_view(roles: frozenset[str], view: str) -> bool:
    return bool(VIEW_ROLES[view] & roles)


def schema_prompt(identity: Identity) -> str:
    """The description of the data, for the SQL-writing model."""
    lines = ["Views (always write them as ai_sql.<name>):", ""]
    for view in VIEWS.values():
        lines.append(f"ai_sql.{view.name} - {view.description}")
        for column, sql_type, note in view.columns:
            lines.append(f"  {column} {sql_type}" + (f"  -- {note}" if note else ""))
        lines.append("")
    lines.append(
        "Campus codes: " + ", ".join(f"{code} = {name}" for code, name in CAMPUSES.items())
    )
    lines.append("")
    who = [f"roles: {', '.join(sorted(identity.roles)) or 'none'}"]
    if identity.campus_id:
        who.append(f"campus_id: {identity.campus_id}")
    if identity.employee_id:
        who.append(f"employee_id: {identity.employee_id}")
    if identity.student_id:
        who.append(f"student_id: {identity.student_id}")
    lines.append("The person asking: " + "; ".join(who) + ". 'My' means these ids.")
    lines.append(
        "The views only contain what this person is allowed to see, so counts and totals "
        "describe that data, not necessarily the whole company."
    )
    return "\n".join(lines)
