-- AlterTable
ALTER TABLE "assignment" ADD COLUMN     "manual_only" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "assignment_group" ADD COLUMN     "weight" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "grading_scale_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "grade" TEXT NOT NULL,
    "min_percent" DECIMAL(5,1) NOT NULL,
    "points" DECIMAL(3,1) NOT NULL,
    "passing" BOOLEAN NOT NULL,

    CONSTRAINT "grading_scale_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_grade" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "points" DECIMAL(7,2) NOT NULL,
    "entered_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "final_grade" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "total" DECIMAL(5,1) NOT NULL,
    "grade" TEXT NOT NULL,
    "grade_points" DECIMAL(3,1) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "breakdown" JSONB NOT NULL DEFAULT '[]',
    "computed_by" UUID,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "final_grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_change" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "reason" TEXT,
    "changed_by" UUID,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grade_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_issue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "doc_number" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "generated_by" UUID,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "grading_scale_item_tenant_id_grade_key" ON "grading_scale_item"("tenant_id", "grade");

-- CreateIndex
CREATE UNIQUE INDEX "manual_grade_assignment_id_student_person_id_key" ON "manual_grade"("assignment_id", "student_person_id");

-- CreateIndex
CREATE UNIQUE INDEX "final_grade_enrollment_id_key" ON "final_grade"("enrollment_id");

-- CreateIndex
CREATE INDEX "grade_change_enrollment_id_idx" ON "grade_change"("enrollment_id");

-- CreateIndex
CREATE INDEX "transcript_issue_tenant_id_student_person_id_idx" ON "transcript_issue"("tenant_id", "student_person_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_issue_tenant_id_doc_number_key" ON "transcript_issue"("tenant_id", "doc_number");

-- 手写部分：行级安全、约束
ALTER TABLE biz."grading_scale_item" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."grading_scale_item" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."manual_grade" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."manual_grade" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."final_grade" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."final_grade" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."grade_change" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."grade_change" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."transcript_issue" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."transcript_issue" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."assignment_group" ADD CONSTRAINT "assignment_group_weight_check" CHECK (weight BETWEEN 0 AND 100);
ALTER TABLE biz."grading_scale_item" ADD CONSTRAINT "grading_scale_percent_check" CHECK (min_percent BETWEEN 0 AND 100);
ALTER TABLE biz."final_grade" ADD CONSTRAINT "final_grade_total_check" CHECK (total BETWEEN 0 AND 100);
ALTER TABLE biz."manual_grade" ADD CONSTRAINT "manual_grade_points_check" CHECK (points >= 0);
ALTER TABLE biz."transcript_issue" ADD CONSTRAINT "transcript_issue_version_check" CHECK (version IN ('informal', 'formal'));
