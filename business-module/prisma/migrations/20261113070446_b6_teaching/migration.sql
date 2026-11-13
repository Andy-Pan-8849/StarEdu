-- CreateEnum
CREATE TYPE "term_status" AS ENUM ('planned', 'enrolling', 'in_progress', 'ended');

-- CreateEnum
CREATE TYPE "section_status" AS ENUM ('draft', 'open', 'in_progress', 'ended', 'cancelled');

-- CreateEnum
CREATE TYPE "enrollment_status" AS ENUM ('enrolled', 'voided', 'withdrawn', 'completed');

-- CreateTable
CREATE TABLE "term" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "enroll_open_date" DATE,
    "enroll_close_date" DATE,
    "drop_deadline" DATE,
    "status" "term_status" NOT NULL DEFAULT 'planned',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "major" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "degree_type" TEXT,
    "dept_id" UUID,
    "total_credits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "elective_min_credits" DECIMAL(6,1) NOT NULL DEFAULT 0,
    "description" TEXT,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "major_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credits" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "dept_id" UUID,
    "syllabus" TEXT,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_prerequisite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "prerequisite_id" UUID NOT NULL,

    CONSTRAINT "course_prerequisite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "major_course" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "major_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "suggested_term" INTEGER,
    "note" TEXT,

    CONSTRAINT "major_course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_major" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "major_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'primary',
    "declared_on" DATE NOT NULL DEFAULT CURRENT_DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "student_major_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "campus_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'onsite',
    "schedule" JSONB NOT NULL DEFAULT '[]',
    "status" "section_status" NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_instructor" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'lead',

    CONSTRAINT "section_instructor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "status" "enrollment_status" NOT NULL DEFAULT 'enrolled',
    "method" TEXT NOT NULL DEFAULT 'self',
    "reason" TEXT,
    "overrides" JSONB NOT NULL DEFAULT '[]',
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dropped_at" TIMESTAMP(3),
    "passed" BOOLEAN,
    "created_by" UUID,

    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_material" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'slides',
    "url" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "section_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "term_tenant_id_code_key" ON "term"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "major_tenant_id_code_key" ON "major"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "course_tenant_id_code_key" ON "course"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "course_prerequisite_course_id_prerequisite_id_key" ON "course_prerequisite"("course_id", "prerequisite_id");

-- CreateIndex
CREATE UNIQUE INDEX "major_course_major_id_course_id_key" ON "major_course"("major_id", "course_id");

-- CreateIndex
CREATE INDEX "student_major_tenant_id_person_id_idx" ON "student_major"("tenant_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_major_person_id_major_id_key" ON "student_major"("person_id", "major_id");

-- CreateIndex
CREATE INDEX "section_tenant_id_campus_id_idx" ON "section"("tenant_id", "campus_id");

-- CreateIndex
CREATE UNIQUE INDEX "section_course_id_term_id_number_key" ON "section"("course_id", "term_id", "number");

-- CreateIndex
CREATE INDEX "section_instructor_tenant_id_person_id_idx" ON "section_instructor"("tenant_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "section_instructor_section_id_person_id_key" ON "section_instructor"("section_id", "person_id");

-- CreateIndex
CREATE INDEX "enrollment_tenant_id_student_person_id_idx" ON "enrollment"("tenant_id", "student_person_id");

-- CreateIndex
CREATE INDEX "enrollment_section_id_idx" ON "enrollment"("section_id");

-- CreateIndex
CREATE INDEX "section_material_section_id_idx" ON "section_material"("section_id");

-- CreateIndex
CREATE INDEX "outbox_event_tenant_id_processed_at_idx" ON "outbox_event"("tenant_id", "processed_at");

-- AddForeignKey
ALTER TABLE "term" ADD CONSTRAINT "term_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "major" ADD CONSTRAINT "major_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course" ADD CONSTRAINT "course_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_prerequisite" ADD CONSTRAINT "course_prerequisite_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_prerequisite" ADD CONSTRAINT "course_prerequisite_prerequisite_id_fkey" FOREIGN KEY ("prerequisite_id") REFERENCES "course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "major_course" ADD CONSTRAINT "major_course_major_id_fkey" FOREIGN KEY ("major_id") REFERENCES "major"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "major_course" ADD CONSTRAINT "major_course_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_major" ADD CONSTRAINT "student_major_major_id_fkey" FOREIGN KEY ("major_id") REFERENCES "major"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_instructor" ADD CONSTRAINT "section_instructor_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_material" ADD CONSTRAINT "section_material_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手写部分：行级安全、约束、触发器
-- ============================================================================
ALTER TABLE biz."term" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."term" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."major" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."major" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."course" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."course" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."course_prerequisite" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."course_prerequisite" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."major_course" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."major_course" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."student_major" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."student_major" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."section" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."section" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."section_instructor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."section_instructor" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."enrollment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."enrollment" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."section_material" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."section_material" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."outbox_event" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."outbox_event" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

-- 同一个学生在同一个班级里同时只能有一条"已选"记录（重复选课的兜底；重修是新学期的另一个班）
CREATE UNIQUE INDEX "enrollment_active_key" ON biz."enrollment"("section_id", "student_person_id") WHERE "status" = 'enrolled';

-- 同一个人在同一个班级里不能既是老师又是学生：两边各加一个触发器
CREATE FUNCTION biz.enrollment_not_instructor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('enrolled', 'completed') AND EXISTS (
    SELECT 1 FROM biz."section_instructor" i WHERE i.section_id = NEW.section_id AND i.person_id = NEW.student_person_id
  ) THEN
    RAISE EXCEPTION 'a person cannot be both instructor and student in the same section' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrollment_not_instructor BEFORE INSERT OR UPDATE OF status ON biz."enrollment"
  FOR EACH ROW EXECUTE FUNCTION biz.enrollment_not_instructor();

CREATE FUNCTION biz.instructor_not_student() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM biz."enrollment" e WHERE e.section_id = NEW.section_id AND e.student_person_id = NEW.person_id AND e.status IN ('enrolled', 'completed')
  ) THEN
    RAISE EXCEPTION 'a person cannot be both instructor and student in the same section' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instructor_not_student BEFORE INSERT OR UPDATE OF person_id ON biz."section_instructor"
  FOR EACH ROW EXECUTE FUNCTION biz.instructor_not_student();
