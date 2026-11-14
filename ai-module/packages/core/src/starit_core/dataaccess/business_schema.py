"""文件：dataaccess/business_schema.py
作用：业务模式下助手能了解的业务数据：业务库 ai_sql 模式里的视图和列，以及给写 SQL 的模型看的说明。
说明：视图由业务模块的迁移建立（业务库里），按调用者的数据范围过滤行——这里只描述它们，不重复任何规则。
这是一小组视图（学生、班级、选课、作业、提交、最终成绩、校区）；样本数据和评测题集的对齐在 B13。
"""

from starit_core.auth import Identity
from starit_core.dataaccess.schema import View

ANY = frozenset({"student", "staff", "manager", "hr", "finance", "Admin", "RAGETLAdmin"})

BUSINESS_VIEWS: dict[str, View] = {
    v.name: v
    for v in (
        View(
            "campuses",
            "The company's campuses.",
            (
                ("campus_id", "uuid", ""),
                ("code", "text", "for example HQ"),
                ("name", "text", ""),
                ("timezone", "text", ""),
                ("status", "text", "normal, stop_new or closed"),
            ),
            ANY,
        ),
        View(
            "students",
            "Students.",
            (
                ("person_id", "uuid", ""),
                ("student_no", "text", ""),
                ("name", "text", ""),
                ("campus_id", "uuid", "join ai_sql.campuses"),
                ("status", "text", "enrolled, on_leave, graduated, withdrawn or completed"),
            ),
            ANY,
        ),
        View(
            "sections",
            "Class sections: a course taught in a term on a campus.",
            (
                ("section_id", "uuid", ""),
                ("name", "text", "for example CS101-01 · 2026 Fall"),
                ("number", "text", ""),
                ("status", "text", "draft, open, in_progress, ended or cancelled"),
                ("capacity", "integer", ""),
                ("mode", "text", "onsite, online or hybrid"),
                ("course_code", "text", ""),
                ("course_name", "text", ""),
                ("credits", "numeric", ""),
                ("term_code", "text", ""),
                ("term_name", "text", ""),
                ("campus_id", "uuid", ""),
            ),
            ANY,
        ),
        View(
            "enrollments",
            "A student's seat in a section.",
            (
                ("enrollment_id", "uuid", ""),
                ("section_id", "uuid", "join ai_sql.sections"),
                ("student_person_id", "uuid", "join ai_sql.students.person_id"),
                ("status", "text", "enrolled, withdrawn (dropped after the deadline), completed"),
                ("method", "text", "self or registrar"),
                ("enrolled_at", "timestamp", ""),
                ("dropped_at", "timestamp", ""),
                ("passed", "boolean", "NULL until the final grade is published"),
            ),
            ANY,
        ),
        View(
            "assignments",
            "Assignments of a section.",
            (
                ("assignment_id", "uuid", ""),
                ("section_id", "uuid", ""),
                ("title", "text", ""),
                ("due_date", "date", "the due day (23:59 campus time)"),
                ("max_score", "numeric", "sum of the rubric"),
                ("manual_only", "boolean", "scored by hand, nothing to submit"),
                ("published", "boolean", ""),
            ),
            ANY,
        ),
        View(
            "submissions",
            "Assignment submissions. A student sees scores only after the teacher publishes them.",
            (
                ("submission_id", "uuid", ""),
                ("section_id", "uuid", ""),
                ("assignment_id", "uuid", ""),
                ("student_person_id", "uuid", ""),
                ("status", "text", "submitted, grading or published"),
                ("submitted_at", "timestamp", ""),
                ("is_late", "boolean", ""),
                ("hours_late", "numeric", "0 when on time"),
                ("raw_score", "numeric", "before the late penalty"),
                ("late_penalty_pct", "integer", "0, 10, 20, 30 or 100 by default"),
                ("final_score", "numeric", "after the late penalty"),
            ),
            ANY,
        ),
        View(
            "final_grades",
            "Final grades per enrollment. Students only see published ones.",
            (
                ("final_grade_id", "uuid", ""),
                ("enrollment_id", "uuid", ""),
                ("section_id", "uuid", ""),
                ("student_person_id", "uuid", ""),
                ("total", "numeric", "0-100, one decimal"),
                ("grade", "text", "A, B, C, D, F (the company's own scale)"),
                ("grade_points", "numeric", ""),
                ("passed", "boolean", ""),
                ("published_at", "timestamp", "NULL = draft"),
            ),
            ANY,
        ),
    )
}

BUSINESS_VIEW_NAMES = frozenset(BUSINESS_VIEWS)


def business_schema_prompt(identity: Identity) -> str:
    """给写 SQL 的模型看的业务库说明：视图、列，以及提问者是谁。"""
    lines = ["Views (always write them as ai_sql.<name>):", ""]
    for view in BUSINESS_VIEWS.values():
        lines.append(f"ai_sql.{view.name} - {view.description}")
        for column, sql_type, note in view.columns:
            lines.append(f"  {column} {sql_type}" + (f"  -- {note}" if note else ""))
        lines.append("")
    access = identity.business
    who = [f"kind: {access.kind if access else 'unknown'}"]
    if access and access.person_id:
        who.append(f"person_id: {access.person_id}")
    lines.append("The person asking: " + "; ".join(who) + ". 'My' means this person_id.")
    lines.append(
        "Ids are uuids: show names, course codes and student numbers to the person, not ids. "
        "The views only contain what this person is allowed to see, so counts and totals "
        "describe that data, not necessarily the whole company."
    )
    return "\n".join(lines)
