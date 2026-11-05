"""文件：测试——SQL 校验器
测什么：只读 SELECT 通过；写入、DDL、多语句、表函数、非白名单的视图和函数全部拒绝；
注释不能藏第二条语句；执行的是解析器重新生成的语句；CTE 不能借名字逃逸；
角色与视图的访问矩阵；校区范围——非总部角色不能点名别的校区（编码、城市名、IN 列表都能识别），
但出差城市不会被误当成校区。
"""

import pytest
from starit_core.auth import Identity
from starit_core.dataaccess.sqlguard import AccessDenied, SqlRejected, validate_sql


def who(*roles: str, campus: str | None = "CD") -> Identity:
    return Identity(
        user_id="u", username="u", name="U", roles=frozenset(roles), campus_id=campus, level=None
    )


ACCEPTED = [
    "SELECT * FROM ai_sql.campuses",
    "select campus_id, name from ai_sql.campuses where city_tier = 1 order by name",
    "SELECT count(*) FROM ai_sql.students WHERE status = 'active'",
    "SELECT program, count(*) AS n FROM ai_sql.students GROUP BY program ORDER BY n DESC LIMIT 5",
    "SELECT avg(final_score), round(avg(raw_score), 1) FROM ai_sql.submissions",
    "SELECT s.name, sub.final_score FROM ai_sql.students s "
    "JOIN ai_sql.submissions sub ON sub.student_id = s.student_id",
    "WITH late AS (SELECT * FROM ai_sql.submissions WHERE hours_late > 0) SELECT count(*) FROM late",
    "SELECT campus_id FROM ai_sql.students UNION SELECT campus_id FROM ai_sql.employees",
    "SELECT sum(amount_cny) FROM ai_sql.expense_claims WHERE status = 'paid'",
    "SELECT coalesce(preapproved, 'n/a'), count(*) FROM ai_sql.expense_claims GROUP BY 1",
    "SELECT date_trunc('month', submitted_at) m, count(*) FROM ai_sql.submissions GROUP BY m",
    "SELECT CASE WHEN level LIKE 'I%' THEN 'instructor' ELSE 'other' END FROM ai_sql.employees",
    "SELECT * FROM ai_sql.students WHERE name ILIKE '%li%'",
    "SELECT * FROM ai_sql.employees WHERE hire_date > current_date - interval '1 year'",
    "SELECT 1;",
    "SELECT student_id FROM ai_sql.students WHERE student_id IN "
    "(SELECT student_id FROM ai_sql.submissions WHERE hours_late > 24)",
    "SELECT lower(name), upper(campus_id), length(name) FROM ai_sql.employees",
    "SELECT campus_id, string_agg(name, ', ') FROM ai_sql.employees GROUP BY campus_id",
    "SELECT extract(year FROM hire_date) FROM ai_sql.employees",
    "SELECT * FROM ai_sql.assignments ORDER BY due_date LIMIT 3 OFFSET 1",
]

REJECTED = {
    "": "empty",
    "   ;  ": "empty",
    "SELEC * FROM ai_sql.students WHERE": "syntax",
    "SELECT 1; SELECT 2": "multiple_statements",
    "SELECT 1; DROP TABLE ai_sql.students": "multiple_statements",
    "DROP TABLE ai_sql.students": "not_select",
    "DELETE FROM ai_sql.students": "not_select",
    "UPDATE ai_sql.students SET name = 'x'": "not_select",
    "INSERT INTO ai_sql.students VALUES (1)": "not_select",
    "TRUNCATE ai_sql.students": "not_select",
    "CREATE TABLE t (a int)": "not_select",
    "ALTER TABLE ai_sql.students ADD COLUMN x int": "not_select",
    "GRANT ALL ON ai_sql.students TO PUBLIC": "not_select",
    "SET ROLE starit": "not_select",
    "RESET ROLE": "not_select",
    "COPY ai_sql.students TO '/tmp/x'": "not_select",
    "EXPLAIN SELECT 1": "not_select",
    "SHOW ALL": "not_select",
    "SELECT * INTO t FROM ai_sql.students": "forbidden_construct",
    "SELECT * FROM ai_sql.students FOR UPDATE": "forbidden_construct",
    "WITH d AS (DELETE FROM ai_sql.students RETURNING *) SELECT * FROM d": "forbidden_construct",
    "WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i": "forbidden_construct",
    "SELECT * FROM students": "unqualified_table",
    "SELECT * FROM pg_user": "unqualified_table",
    "SELECT * FROM pg_catalog.pg_user": "table_not_allowed",
    "SELECT * FROM information_schema.tables": "table_not_allowed",
    "SELECT * FROM ai.audit_log": "table_not_allowed",
    "SELECT * FROM ai.messages": "table_not_allowed",
    "SELECT * FROM public.chunks": "table_not_allowed",
    "SELECT * FROM ai_sql.secrets": "table_not_allowed",
    "SELECT * FROM ai_auth.something": "table_not_allowed",
    "SELECT * FROM other.ai_sql.students": "table_not_allowed",
    "SELECT * FROM generate_series(1, 10)": "table_function",
    "SELECT * FROM ai_sql.students, generate_series(1, 1000000000)": "table_function",
    "SELECT pg_sleep(10)": "function_not_allowed",
    "SELECT set_config('app.roles', 'Admin', true)": "function_not_allowed",
    "SELECT current_setting('app.roles')": "function_not_allowed",
    "SELECT version()": "function_not_allowed",
    "SELECT pg_read_file('/etc/passwd')": "function_not_allowed",
    "SELECT lo_import('/etc/passwd')": "function_not_allowed",
    "SELECT dblink('x', 'select 1')": "function_not_allowed",
    "SELECT * FROM ai_sql.students WHERE pg_sleep(1) IS NULL": "function_not_allowed",
    "SELECT count(*) FROM ai_sql.students WHERE name = (SELECT pg_sleep(1))": "function_not_allowed",
    "SELECT 'a' || repeat('x', 100000000)": "function_not_allowed",
}


@pytest.mark.parametrize("sql", ACCEPTED)
def test_accepts_plain_reads(sql: str) -> None:
    checked = validate_sql(sql)
    assert checked.sql.upper().startswith(("SELECT", "WITH"))
    assert ";" not in checked.sql


@pytest.mark.parametrize(("sql", "code"), REJECTED.items())
def test_rejects(sql: str, code: str) -> None:
    with pytest.raises(SqlRejected) as caught:
        validate_sql(sql)
    assert caught.value.code == code


def test_too_long_is_rejected() -> None:
    with pytest.raises(SqlRejected) as caught:
        validate_sql("SELECT " + " + ".join(["1"] * 3000))
    assert caught.value.code == "too_long"


def test_comment_cannot_hide_a_second_statement() -> None:
    with pytest.raises(SqlRejected):
        validate_sql("SELECT 1 /* ; */; DROP TABLE x")


def test_runs_the_regenerated_statement_not_the_text() -> None:
    checked = validate_sql("select   count( * )  from ai_sql.students -- trailing\n;")
    assert checked.sql == "SELECT COUNT(*) FROM ai_sql.students"


def test_reports_the_views_it_reads() -> None:
    checked = validate_sql(
        "WITH x AS (SELECT * FROM ai_sql.students) "
        "SELECT * FROM x JOIN ai_sql.submissions s ON s.student_id = x.student_id"
    )
    assert checked.views == ("students", "submissions")


def test_a_cte_may_not_shadow_a_real_table_name_to_escape() -> None:
    # `pg_user` is not a CTE here, so it is an unqualified table and refused.
    with pytest.raises(SqlRejected):
        validate_sql("WITH a AS (SELECT 1) SELECT * FROM pg_user, a")


ROLE_VIEW = [
    ("student", "students", True),
    ("student", "submissions", True),
    ("student", "employees", False),
    ("student", "expense_claims", False),
    ("staff", "employees", True),
    ("staff", "expense_claims", True),
    ("manager", "expense_claims", True),
    ("hr", "employees", True),
    ("finance", "expense_claims", True),
    ("Admin", "students", False),
    ("Admin", "employees", False),
    ("Admin", "campuses", True),
    ("RAGETLAdmin", "expense_claims", False),
    ("RAGETLAdmin", "assignments", True),
]


@pytest.mark.parametrize(("role", "view", "allowed"), ROLE_VIEW)
def test_role_to_view_access(role: str, view: str, allowed: bool) -> None:
    sql = f"SELECT * FROM ai_sql.{view}"
    if allowed:
        validate_sql(sql, who(role))
    else:
        with pytest.raises(AccessDenied) as caught:
            validate_sql(sql, who(role))
        assert caught.value.code == "restricted_view"


def test_a_person_without_roles_is_denied_every_view() -> None:
    for view in ("students", "campuses"):
        with pytest.raises(AccessDenied):
            validate_sql(f"SELECT * FROM ai_sql.{view}", who())


def test_a_second_view_in_a_join_is_checked_too() -> None:
    with pytest.raises(AccessDenied):
        validate_sql(
            "SELECT * FROM ai_sql.students s JOIN ai_sql.employees e ON e.campus_id = s.campus_id",
            who("student"),
        )


@pytest.mark.parametrize("role", ["staff", "manager", "student"])
def test_campus_scoped_roles_cannot_name_another_campus(role: str) -> None:
    with pytest.raises(AccessDenied) as caught:
        validate_sql("SELECT * FROM ai_sql.students WHERE campus_id = 'SH'", who(role))
    assert caught.value.code == "campus_scope"


def test_campus_literal_is_found_in_any_form() -> None:
    forms = [
        "SELECT * FROM ai_sql.students WHERE 'SH' = campus_id",
        "SELECT * FROM ai_sql.students WHERE campus_id IN ('CD', 'SH')",
        "SELECT * FROM ai_sql.students WHERE campus_id = 'sh'",
        "SELECT * FROM ai_sql.students s WHERE s.campus_id = 'SH'",
        "SELECT * FROM ai_sql.students WHERE status = 'active' AND (campus_id = 'SH' OR 1 = 1)",
        "WITH x AS (SELECT * FROM ai_sql.students WHERE campus_id = 'SH') SELECT * FROM x",
        "SELECT * FROM ai_sql.students WHERE student_id IN "
        "(SELECT student_id FROM ai_sql.students WHERE campus_id = 'SH')",
    ]
    for sql in forms:
        with pytest.raises(AccessDenied):
            validate_sql(sql, who("manager"))


def test_own_campus_literal_is_fine() -> None:
    validate_sql("SELECT * FROM ai_sql.students WHERE campus_id = 'CD'", who("manager"))
    validate_sql("SELECT * FROM ai_sql.students WHERE campus_id = 'cd'", who("manager"))


@pytest.mark.parametrize("role", ["hr", "finance"])
def test_company_wide_roles_may_name_any_campus(role: str) -> None:
    validate_sql("SELECT * FROM ai_sql.employees WHERE campus_id = 'SH'", who(role))


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT count(*) FROM ai_sql.students s JOIN ai_sql.campuses c ON c.campus_id = s.campus_id "
        "WHERE c.name = 'Beijing'",
        "SELECT * FROM ai_sql.students WHERE campus_id IN (SELECT campus_id FROM ai_sql.campuses "
        "WHERE name ILIKE '%shanghai%')",
    ],
)
def test_a_campus_named_by_city_is_caught_when_the_campuses_view_is_read(sql: str) -> None:
    with pytest.raises(AccessDenied) as caught:
        validate_sql(sql, who("manager", campus="CD"))
    assert caught.value.code == "campus_scope"


def test_a_travel_city_is_not_mistaken_for_a_campus() -> None:
    validate_sql("SELECT * FROM ai_sql.expense_claims WHERE city = 'Beijing'", who("manager"))


def test_naming_your_own_campus_by_city_is_fine() -> None:
    validate_sql(
        "SELECT * FROM ai_sql.campuses WHERE name LIKE 'Chengdu%'", who("manager", campus="CD")
    )
