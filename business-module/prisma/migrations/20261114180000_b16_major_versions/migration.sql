-- B16: 培养方案版本。专业的课程设置按"入学年份"分版本：学生按入学年份落在哪个版本就用哪个版本的课程设置和学分要求。
-- 版本从某个入学年份起生效，到下一个版本生效前截止；入学年份早于最早版本的学生按最早版本。
CREATE TABLE biz."major_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "major_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "effective_year" INTEGER NOT NULL,
    "total_credits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "elective_min_credits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    CONSTRAINT "major_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "major_version_year_check" CHECK ("effective_year" BETWEEN 1900 AND 2200)
);
CREATE UNIQUE INDEX "major_version_major_id_effective_year_key" ON biz."major_version"("major_id", "effective_year");
CREATE INDEX "major_version_tenant_id_major_id_idx" ON biz."major_version"("tenant_id", "major_id");
ALTER TABLE biz."major_version" ADD CONSTRAINT "major_version_major_id_fkey" FOREIGN KEY ("major_id") REFERENCES biz."major"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE biz."major_version" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."major_version" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

-- 每个已有专业补一个初始版本（2000 年起生效，覆盖所有已有学生），学分沿用专业上的数
INSERT INTO biz."major_version" (tenant_id, major_id, label, effective_year, total_credits, elective_min_credits)
SELECT tenant_id, id, 'Initial', 2000, total_credits, elective_min_credits FROM biz."major";

ALTER TABLE biz."major_course" ADD COLUMN "version_id" UUID;
UPDATE biz."major_course" mc SET version_id = v.id FROM biz."major_version" v WHERE v.major_id = mc.major_id;
ALTER TABLE biz."major_course" ALTER COLUMN "version_id" SET NOT NULL;
ALTER TABLE biz."major_course" ADD CONSTRAINT "major_course_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES biz."major_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX biz."major_course_major_id_course_id_key";
CREATE UNIQUE INDEX "major_course_version_id_course_id_key" ON biz."major_course"("version_id", "course_id");

ALTER TABLE biz."student_major" ADD COLUMN "entry_year" INTEGER;
UPDATE biz."student_major" SET entry_year = EXTRACT(YEAR FROM declared_on)::int;
ALTER TABLE biz."student_major" ALTER COLUMN "entry_year" SET NOT NULL;
