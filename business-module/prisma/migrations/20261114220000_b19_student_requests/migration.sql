-- B19: 学生申请（成绩复评、作业延期）。同一份成绩/同一次作业同一个学生同时只能有一条待处理的申请。
CREATE TABLE biz."student_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "section_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "enrollment_id" UUID,
    "assignment_id" UUID,
    "days" INTEGER,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decision_note" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "student_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "student_request_kind_check" CHECK ("kind" IN ('grade_appeal', 'extension')),
    CONSTRAINT "student_request_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
    CONSTRAINT "student_request_days_check" CHECK ("days" IS NULL OR "days" BETWEEN 1 AND 3),
    CONSTRAINT "student_request_target_check" CHECK (
      ("kind" = 'grade_appeal' AND "enrollment_id" IS NOT NULL AND "assignment_id" IS NULL AND "days" IS NULL) OR
      ("kind" = 'extension' AND "assignment_id" IS NOT NULL AND "days" IS NOT NULL AND "enrollment_id" IS NULL))
);
CREATE INDEX "student_request_tenant_id_section_id_status_idx" ON biz."student_request"("tenant_id", "section_id", "status");
CREATE INDEX "student_request_tenant_id_student_person_id_idx" ON biz."student_request"("tenant_id", "student_person_id");
CREATE UNIQUE INDEX "student_request_pending_appeal_key" ON biz."student_request"("enrollment_id") WHERE "status" = 'pending' AND "kind" = 'grade_appeal';
CREATE UNIQUE INDEX "student_request_pending_extension_key" ON biz."student_request"("assignment_id", "student_person_id") WHERE "status" = 'pending' AND "kind" = 'extension';
ALTER TABLE biz."student_request" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."student_request" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
