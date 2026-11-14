-- B10：给 AI 模块读业务数据用的"白名单视图"（业务模式）。
--   - 只读角色 ai_sql_ro 只能读 ai_sql 里的视图，碰不到 biz 的任何表；AI 模块用登录角色 ai_reader 连库，
--     每次查询在事务里先写入调用者的身份设置（app.tenant_id / app.person_id / app.scopes），再 SET LOCAL ROLE ai_sql_ro。
--   - app.scopes 是业务模块内部权限接口给出的"每个权限字符下的数据范围"（JSON）；视图只负责把范围翻译成过滤条件，
--     规则本身只在 NestJS 里实现一份。没有设置身份或没有对应范围 = 一行都看不到。
--   - 视图以所有者身份运行（不受行级安全约束），所以每个视图自己带 tenant_id = 当前租户。
--   - 本地默认密码仅供演示，上线前必须 ALTER ROLE 修改。

CREATE SCHEMA IF NOT EXISTS ai_auth;
CREATE SCHEMA IF NOT EXISTS ai_sql;

DO $$ BEGIN
  CREATE ROLE ai_sql_ro NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE ai_reader LOGIN PASSWORD 'starit-ai-biz';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- ai_reader 能切换成 ai_sql_ro，但自己不继承它的权限
GRANT ai_sql_ro TO ai_reader WITH INHERIT FALSE, SET TRUE;

-- ---------------------------------------------------------------- 身份辅助函数（读会话设置）
CREATE FUNCTION ai_auth.setting(name text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting(name, true), '') $$;

CREATE FUNCTION ai_auth.tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT ai_auth.setting('app.tenant_id')::uuid $$;

CREATE FUNCTION ai_auth.person_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT ai_auth.setting('app.person_id')::uuid $$;

CREATE FUNCTION ai_auth.scope(perm text) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT (ai_auth.setting('app.scopes')::jsonb) -> perm $$;

CREATE FUNCTION ai_auth.scope_all(perm text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((ai_auth.scope(perm) ->> 'all')::boolean, false) $$;

CREATE FUNCTION ai_auth.scope_depts(perm text) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array(SELECT jsonb_array_elements_text(ai_auth.scope(perm) -> 'deptIds')::uuid), '{}'::uuid[])
$$;

CREATE FUNCTION ai_auth.scope_classes(perm text) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array(SELECT jsonb_array_elements_text(ai_auth.scope(perm) -> 'classIds')::uuid), '{}'::uuid[])
$$;

CREATE FUNCTION ai_auth.scope_self(perm text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT (ai_auth.scope(perm) ->> 'selfPersonId')::uuid $$;

-- 班级是否在某个权限字符的范围内。镜像业务模块的 SECTION_SCOPE：
--   全部 / 校区所在部门在范围内 / 本人任教或就读 / 在"本人任教就读班级"里
CREATE FUNCTION ai_auth.section_in_scope(sec uuid, perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, biz AS $$
  SELECT EXISTS (
    SELECT 1 FROM biz.section s JOIN biz.campus ca ON ca.id = s.campus_id
    WHERE s.id = sec AND s.tenant_id = ai_auth.tenant_id()
      AND (ai_auth.scope_all(perm)
        OR ca.dept_id = ANY (ai_auth.scope_depts(perm))
        OR s.id = ANY (ai_auth.scope_classes(perm))
        OR (ai_auth.scope_self(perm) IS NOT NULL AND (
              EXISTS (SELECT 1 FROM biz.section_instructor i WHERE i.section_id = s.id AND i.person_id = ai_auth.scope_self(perm))
           OR EXISTS (SELECT 1 FROM biz.enrollment e WHERE e.section_id = s.id AND e.student_person_id = ai_auth.scope_self(perm) AND e.status IN ('enrolled', 'completed')))))
  )
$$;

-- ---------------------------------------------------------------- 视图
CREATE VIEW ai_sql.campuses WITH (security_barrier = true) AS
SELECT c.id AS campus_id, c.code, c.name, c.timezone, c.status::text AS status
FROM biz.campus c
WHERE c.tenant_id = ai_auth.tenant_id() AND c.deleted_at IS NULL;

-- 学生：教务/人事按学生在组织树上的归属（生效中）和范围；学生自己只看自己
CREATE VIEW ai_sql.students WITH (security_barrier = true) AS
SELECT p.id AS person_id, sp.student_no, p.full_name AS name, sp.campus_id, sp.academic_status::text AS status
FROM biz.person p JOIN biz.student_profile sp ON sp.person_id = p.id
WHERE p.tenant_id = ai_auth.tenant_id() AND p.deleted_at IS NULL
  AND (ai_auth.scope_all('hr:student:list')
    OR EXISTS (SELECT 1 FROM biz.person_dept pd
               WHERE pd.person_id = p.id AND pd.kind = 'student' AND pd.dept_id = ANY (ai_auth.scope_depts('hr:student:list'))
                 AND pd.start_date <= CURRENT_DATE AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE))
    OR p.id = ai_auth.scope_self('hr:student:list')
    OR p.id = ai_auth.scope_self('portal:enroll:list'));

CREATE VIEW ai_sql.sections WITH (security_barrier = true) AS
SELECT s.id AS section_id, s.name, s.number, s.status::text AS status, s.capacity, s.mode,
       c.code AS course_code, c.name AS course_name, c.credits, t.code AS term_code, t.name AS term_name, s.campus_id
FROM biz.section s JOIN biz.course c ON c.id = s.course_id JOIN biz.term t ON t.id = s.term_id
WHERE s.tenant_id = ai_auth.tenant_id()
  AND (ai_auth.section_in_scope(s.id, 'edu:section:list') OR s.id = ANY (ai_auth.scope_classes('portal:enroll:list')));

-- 选课：教务/教师按班级范围；学生只看自己的
CREATE VIEW ai_sql.enrollments WITH (security_barrier = true) AS
SELECT e.id AS enrollment_id, e.section_id, e.student_person_id, e.status::text AS status, e.method, e.enrolled_at, e.dropped_at, e.passed
FROM biz.enrollment e
WHERE e.tenant_id = ai_auth.tenant_id()
  AND (ai_auth.section_in_scope(e.section_id, 'edu:enrollment:list') OR (e.student_person_id = ai_auth.scope_self('portal:enroll:list') AND e.status <> 'voided'));

-- 作业：教师/教务看范围内班级的全部；学生只看自己班里已发布的
CREATE VIEW ai_sql.assignments WITH (security_barrier = true) AS
SELECT a.id AS assignment_id, a.section_id, a.title, a.due_date, a.max_score, a.manual_only, a.published
FROM biz.assignment a
WHERE a.tenant_id = ai_auth.tenant_id()
  AND (ai_auth.section_in_scope(a.section_id, 'edu:assignment:list')
    OR (a.published AND a.section_id = ANY (ai_auth.scope_classes('portal:assignment:list'))));

-- 提交：教师/教务看范围内班级的；学生只看自己的，且得分发布后才可见
CREATE VIEW ai_sql.submissions WITH (security_barrier = true) AS
SELECT s.id AS submission_id, a.section_id, s.assignment_id, s.student_person_id, s.status::text AS status, s.submitted_at, s.is_late, s.hours_late,
       CASE WHEN staff.ok OR s.status = 'published' THEN s.raw_score END AS raw_score,
       CASE WHEN staff.ok OR s.status = 'published' THEN s.late_penalty_pct END AS late_penalty_pct,
       CASE WHEN staff.ok OR s.status = 'published' THEN s.final_score END AS final_score
FROM biz.submission s JOIN biz.assignment a ON a.id = s.assignment_id
CROSS JOIN LATERAL (SELECT ai_auth.section_in_scope(a.section_id, 'edu:submission:list') AS ok) staff
WHERE s.tenant_id = ai_auth.tenant_id()
  AND (staff.ok OR s.student_person_id = ai_auth.scope_self('portal:assignment:list'));

-- 最终成绩：教师/教务看范围内班级的（含草稿）；学生只看自己已发布的
CREATE VIEW ai_sql.final_grades WITH (security_barrier = true) AS
SELECT g.id AS final_grade_id, e.id AS enrollment_id, e.section_id, e.student_person_id, g.total, g.grade, g.grade_points, g.passed, g.published_at
FROM biz.final_grade g JOIN biz.enrollment e ON e.id = g.enrollment_id
WHERE g.tenant_id = ai_auth.tenant_id()
  AND (ai_auth.section_in_scope(e.section_id, 'edu:grade:list')
    OR (g.published_at IS NOT NULL AND e.student_person_id = ai_auth.scope_self('portal:grade:list')));

-- ---------------------------------------------------------------- 授权
GRANT USAGE ON SCHEMA ai_sql TO ai_sql_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA ai_sql TO ai_sql_ro;
GRANT USAGE ON SCHEMA ai_auth TO ai_sql_ro;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ai_auth TO ai_sql_ro;

-- 一条查询不能改写自己的身份设置：set_config 只给业务应用账号、AI 的登录账号（它们在切换角色之前写入设置）
-- 和数据库所有者。ai_sql_ro 执行不了它。
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO biz_app, ai_reader;
