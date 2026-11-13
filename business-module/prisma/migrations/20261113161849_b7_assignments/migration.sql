-- CreateEnum
CREATE TYPE "submission_status" AS ENUM ('submitted', 'grading', 'published');

-- CreateTable
CREATE TABLE "assignment_group" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "group_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "due_date" DATE NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "allow_late" BOOLEAN NOT NULL DEFAULT true,
    "late_policy" JSONB NOT NULL,
    "max_score" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rubric_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "max_points" DECIMAL(6,2) NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rubric_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_extension" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "granted_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "status" "submission_status" NOT NULL DEFAULT 'submitted',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "hours_late" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "raw_score" DECIMAL(7,2),
    "late_penalty_pct" INTEGER,
    "final_score" DECIMAL(7,2),
    "feedback" TEXT,
    "graded_by" UUID,
    "graded_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "text_answer" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "is_late" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "submission_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_file" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "version_id" UUID,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_score" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "rubric_item_id" UUID NOT NULL,
    "points" DECIMAL(6,2) NOT NULL,
    "comment" TEXT,

    CONSTRAINT "submission_score_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assignment_group_section_id_name_key" ON "assignment_group"("section_id", "name");

-- CreateIndex
CREATE INDEX "assignment_section_id_idx" ON "assignment"("section_id");

-- CreateIndex
CREATE INDEX "rubric_item_assignment_id_idx" ON "rubric_item"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_extension_assignment_id_student_person_id_key" ON "assignment_extension"("assignment_id", "student_person_id");

-- CreateIndex
CREATE INDEX "submission_tenant_id_student_person_id_idx" ON "submission"("tenant_id", "student_person_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_assignment_id_student_person_id_key" ON "submission"("assignment_id", "student_person_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_version_submission_id_version_key" ON "submission_version"("submission_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "submission_file_storage_key_key" ON "submission_file"("storage_key");

-- CreateIndex
CREATE INDEX "submission_file_assignment_id_student_person_id_idx" ON "submission_file"("assignment_id", "student_person_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_score_submission_id_rubric_item_id_key" ON "submission_score"("submission_id", "rubric_item_id");

-- AddForeignKey
ALTER TABLE "assignment_group" ADD CONSTRAINT "assignment_group_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "assignment_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_item" ADD CONSTRAINT "rubric_item_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_extension" ADD CONSTRAINT "assignment_extension_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_version" ADD CONSTRAINT "submission_version_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_file" ADD CONSTRAINT "submission_file_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "submission_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_score" ADD CONSTRAINT "submission_score_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_score" ADD CONSTRAINT "submission_score_rubric_item_id_fkey" FOREIGN KEY ("rubric_item_id") REFERENCES "rubric_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手写部分：行级安全、约束
-- ============================================================================
ALTER TABLE biz."assignment_group" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."assignment_group" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."assignment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."assignment" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."rubric_item" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."rubric_item" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."assignment_extension" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."assignment_extension" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."submission" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."submission" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."submission_version" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."submission_version" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."submission_file" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."submission_file" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."submission_score" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."submission_score" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

-- 延期最多 3 天；分数不能为负
ALTER TABLE biz."assignment_extension" ADD CONSTRAINT "assignment_extension_days_check" CHECK (days BETWEEN 1 AND 3);
ALTER TABLE biz."rubric_item" ADD CONSTRAINT "rubric_item_points_check" CHECK (max_points > 0);
ALTER TABLE biz."submission_score" ADD CONSTRAINT "submission_score_points_check" CHECK (points >= 0);
ALTER TABLE biz."submission" ADD CONSTRAINT "submission_penalty_check" CHECK (late_penalty_pct IS NULL OR late_penalty_pct BETWEEN 0 AND 100);
ALTER TABLE biz."submission_file" ADD CONSTRAINT "submission_file_size_check" CHECK (size >= 0);
-- 存储键必须落在本租户的前缀下（和 tenant_id 一致）：跨租户的键写不进来
ALTER TABLE biz."submission_file" ADD CONSTRAINT "submission_file_key_prefix_check" CHECK (storage_key LIKE 'tenant/' || tenant_id::text || '/%');
