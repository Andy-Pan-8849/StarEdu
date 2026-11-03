"""Business sample tables, whitelisted SQL views with data-scope filters, set_config guard.

Who may see which rows is defined in docs/design/02-data-model.md, section 5. The views read
the caller's identity from session settings (app.user_id, app.roles, app.campus_id,
app.employee_id, app.student_id), which the application sets inside a transaction before it
switches to the ai_sql_ro role. Without those settings every view returns no rows.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-02
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

BIZ_TABLES = [
    """
    CREATE TABLE biz.campuses (
        campus_id    text PRIMARY KEY,
        name         text NOT NULL,
        city_tier    int NOT NULL,
        region       text NOT NULL,
        opened_year  int NOT NULL
    )
    """,
    """
    CREATE TABLE biz.employees (
        employee_id  text PRIMARY KEY,
        name         text NOT NULL,
        campus_id    text NOT NULL REFERENCES biz.campuses (campus_id),
        department   text NOT NULL,
        title        text NOT NULL,
        level        text NOT NULL,
        hire_date    date NOT NULL,
        status       text NOT NULL
    )
    """,
    """
    CREATE TABLE biz.students (
        student_id  text PRIMARY KEY,
        name        text NOT NULL,
        campus_id   text NOT NULL REFERENCES biz.campuses (campus_id),
        program     text NOT NULL,
        cohort      text NOT NULL,
        status      text NOT NULL
    )
    """,
    """
    CREATE TABLE biz.assignments (
        assignment_id  text PRIMARY KEY,
        program        text NOT NULL,
        title          text NOT NULL,
        due_date       date NOT NULL
    )
    """,
    """
    CREATE TABLE biz.submissions (
        submission_id     text PRIMARY KEY,
        student_id        text NOT NULL REFERENCES biz.students (student_id),
        assignment_id     text NOT NULL REFERENCES biz.assignments (assignment_id),
        submitted_at      timestamp NOT NULL,
        hours_late        int NOT NULL,
        raw_score         int NOT NULL,
        late_penalty_pct  int NOT NULL,
        final_score       int NOT NULL
    )
    """,
    """
    CREATE TABLE biz.expense_claims (
        claim_id        text PRIMARY KEY,
        employee_id     text NOT NULL REFERENCES biz.employees (employee_id),
        campus_id       text NOT NULL REFERENCES biz.campuses (campus_id),
        category        text NOT NULL,
        city            text,
        nights_or_days  int,
        guests          int,
        amount_cny      int NOT NULL,
        expense_date    date NOT NULL,
        submitted_date  date NOT NULL,
        preapproved     text,
        status          text NOT NULL,
        approver_role   text NOT NULL
    )
    """,
    """
    CREATE TABLE biz.support_tickets (
        ticket_id               text PRIMARY KEY,
        requester_type          text NOT NULL,
        requester_id            text NOT NULL,
        campus_id               text NOT NULL REFERENCES biz.campuses (campus_id),
        category                text NOT NULL,
        priority                text NOT NULL,
        created_at              timestamp NOT NULL,
        first_response_minutes  int NOT NULL,
        resolution_minutes      int NOT NULL,
        status                  text NOT NULL
    )
    """,
]

AUTH_FUNCTIONS = """
CREATE FUNCTION ai_auth.setting(name text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting(name, true), '') $$;

CREATE FUNCTION ai_auth.user_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT ai_auth.setting('app.user_id') $$;

CREATE FUNCTION ai_auth.campus_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT ai_auth.setting('app.campus_id') $$;

CREATE FUNCTION ai_auth.employee_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT ai_auth.setting('app.employee_id') $$;

CREATE FUNCTION ai_auth.student_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT ai_auth.setting('app.student_id') $$;

CREATE FUNCTION ai_auth.has_role(r text) RETURNS boolean
LANGUAGE sql STABLE AS
$$ SELECT coalesce(r = ANY (string_to_array(ai_auth.setting('app.roles'), ',')), false) $$;

-- Headquarters functions see every campus.
CREATE FUNCTION ai_auth.company_wide() RETURNS boolean
LANGUAGE sql STABLE AS
$$ SELECT ai_auth.has_role('hr') OR ai_auth.has_role('finance') $$;

-- Staff and managers work within their own campus.
CREATE FUNCTION ai_auth.campus_role() RETURNS boolean
LANGUAGE sql STABLE AS
$$ SELECT ai_auth.has_role('staff') OR ai_auth.has_role('manager') $$;
"""

VIEWS = [
    # Any signed-in user.
    """
    CREATE VIEW ai_sql.campuses WITH (security_barrier = true) AS
    SELECT * FROM biz.campuses WHERE ai_auth.user_id() IS NOT NULL
    """,
    """
    CREATE VIEW ai_sql.assignments WITH (security_barrier = true) AS
    SELECT * FROM biz.assignments WHERE ai_auth.user_id() IS NOT NULL
    """,
    # Students: own record. Staff and managers: own campus. hr and finance: everything.
    """
    CREATE VIEW ai_sql.students WITH (security_barrier = true) AS
    SELECT s.* FROM biz.students s
    WHERE ai_auth.company_wide()
       OR (ai_auth.campus_role() AND s.campus_id = ai_auth.campus_id())
       OR (ai_auth.has_role('student') AND s.student_id = ai_auth.student_id())
    """,
    """
    CREATE VIEW ai_sql.submissions WITH (security_barrier = true) AS
    SELECT sub.* FROM biz.submissions sub
    WHERE ai_auth.company_wide()
       OR (ai_auth.campus_role() AND EXISTS (
              SELECT 1 FROM biz.students st
              WHERE st.student_id = sub.student_id AND st.campus_id = ai_auth.campus_id()))
       OR (ai_auth.has_role('student') AND sub.student_id = ai_auth.student_id())
    """,
    # A ticket belongs to the campus of the person who opened it.
    """
    CREATE VIEW ai_sql.support_tickets WITH (security_barrier = true) AS
    SELECT t.* FROM biz.support_tickets t
    WHERE ai_auth.company_wide()
       OR (ai_auth.campus_role() AND t.campus_id = ai_auth.campus_id())
       OR (ai_auth.has_role('student') AND t.requester_type = 'student'
           AND t.requester_id = ai_auth.student_id())
    """,
    # Employees and expense claims: staff see only their own rows, managers their campus.
    """
    CREATE VIEW ai_sql.employees WITH (security_barrier = true) AS
    SELECT e.* FROM biz.employees e
    WHERE ai_auth.company_wide()
       OR (ai_auth.has_role('manager') AND e.campus_id = ai_auth.campus_id())
       OR (ai_auth.has_role('staff') AND e.employee_id = ai_auth.employee_id())
    """,
    """
    CREATE VIEW ai_sql.expense_claims WITH (security_barrier = true) AS
    SELECT c.* FROM biz.expense_claims c
    WHERE ai_auth.company_wide()
       OR (ai_auth.has_role('manager') AND c.campus_id = ai_auth.campus_id())
       OR (ai_auth.has_role('staff') AND c.employee_id = ai_auth.employee_id())
    """,
]

VIEW_NAMES = [
    "campuses",
    "assignments",
    "students",
    "submissions",
    "support_tickets",
    "employees",
    "expense_claims",
]


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS ai_auth")
    op.execute("CREATE SCHEMA IF NOT EXISTS ai_sql")
    for ddl in BIZ_TABLES:
        op.execute(ddl)
    for statement in AUTH_FUNCTIONS.split(";\n\n"):
        if statement.strip():
            op.execute(statement.strip().rstrip(";"))
    for ddl in VIEWS:
        op.execute(ddl)

    # ai_sql_ro may read the whitelisted views. The views run with their owner's rights, so it
    # needs no access to the biz tables. It does need to execute the small helper functions the
    # views call (they run with the caller's rights); they only read the caller's own identity
    # settings, so exposing them gives a query nothing it could not already see.
    op.execute("GRANT USAGE ON SCHEMA ai_sql TO ai_sql_ro")
    op.execute("GRANT SELECT ON ALL TABLES IN SCHEMA ai_sql TO ai_sql_ro")
    op.execute("GRANT USAGE ON SCHEMA ai_auth TO ai_sql_ro")
    op.execute("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ai_auth TO ai_sql_ro")

    # A query must not be able to rewrite its own identity settings, so set_config is limited
    # to the owner and the application, which set them before switching to ai_sql_ro.
    op.execute("REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO ai_app")


def downgrade() -> None:
    op.execute("GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO PUBLIC")
    for name in VIEW_NAMES:
        op.execute(f"DROP VIEW IF EXISTS ai_sql.{name}")
    op.execute("DROP SCHEMA IF EXISTS ai_sql")
    op.execute("DROP SCHEMA IF EXISTS ai_auth CASCADE")
    for table in [
        "support_tickets",
        "expense_claims",
        "submissions",
        "assignments",
        "students",
        "employees",
        "campuses",
    ]:
        op.execute(f"DROP TABLE IF EXISTS biz.{table}")
