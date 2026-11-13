-- CreateEnum
CREATE TYPE "staff_status" AS ENUM ('active', 'on_leave', 'left');

-- CreateEnum
CREATE TYPE "student_status" AS ENUM ('enrolled', 'on_leave', 'graduated', 'withdrawn', 'completed');

-- DropIndex
DROP INDEX "person_dept_person_id_dept_id_key";

-- AlterTable
ALTER TABLE "person" ADD COLUMN     "address" TEXT,
ADD COLUMN     "birth_date" DATE,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "id_number" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "person_dept" ADD COLUMN     "end_date" DATE,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'staff',
ADD COLUMN     "post_id" UUID,
ADD COLUMN     "start_date" DATE NOT NULL DEFAULT CURRENT_DATE;

-- CreateTable
CREATE TABLE "staff_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "employee_no" TEXT NOT NULL,
    "hire_date" DATE NOT NULL,
    "status" "staff_status" NOT NULL DEFAULT 'active',
    "employment_type" TEXT NOT NULL DEFAULT 'full_time',
    "pending_status" "staff_status",
    "pending_effective_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "staff_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "student_no" TEXT NOT NULL,
    "campus_id" UUID NOT NULL,
    "enroll_term" TEXT,
    "academic_status" "student_status" NOT NULL DEFAULT 'enrolled',
    "degree_type" TEXT,
    "program" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "student_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_contact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phone2" TEXT,
    "email" TEXT,
    "address" TEXT,
    "postal_code" TEXT,
    "is_guardian" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_profile_person_id_key" ON "staff_profile"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profile_tenant_id_employee_no_key" ON "staff_profile"("tenant_id", "employee_no");

-- CreateIndex
CREATE UNIQUE INDEX "student_profile_person_id_key" ON "student_profile"("person_id");

-- CreateIndex
CREATE INDEX "student_profile_tenant_id_campus_id_idx" ON "student_profile"("tenant_id", "campus_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_profile_tenant_id_student_no_key" ON "student_profile"("tenant_id", "student_no");

-- CreateIndex
CREATE INDEX "emergency_contact_tenant_id_person_id_idx" ON "emergency_contact"("tenant_id", "person_id");

-- CreateIndex
CREATE INDEX "person_dept_person_id_idx" ON "person_dept"("person_id");

-- AddForeignKey
ALTER TABLE "staff_profile" ADD CONSTRAINT "staff_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profile" ADD CONSTRAINT "staff_profile_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手写部分：查重用的唯一索引、行级安全、旧数据补档案
-- ============================================================================
-- 同一租户里工作邮箱、证件号不能重复（没删除的人员之间；邮箱不分大小写）
CREATE UNIQUE INDEX "person_work_email_key" ON biz."person"("tenant_id", lower("work_email")) WHERE "work_email" IS NOT NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "person_id_number_key" ON biz."person"("tenant_id", "id_number") WHERE "id_number" IS NOT NULL AND "deleted_at" IS NULL;

ALTER TABLE biz."staff_profile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."staff_profile" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."student_profile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."student_profile" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."emergency_contact" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."emergency_contact" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

-- 已有的"教职员工"类型人员补一份员工档案（工号用临时编号，hire_date 取创建日期）；学生没有校区，不补
INSERT INTO biz."staff_profile" ("tenant_id", "person_id", "employee_no", "hire_date")
  SELECT p.tenant_id, p.id, 'LEGACY-' || substr(p.id::text, 1, 8), p.created_at::date FROM biz."person" p
  WHERE p.type = 'staff' AND p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM biz."staff_profile" s WHERE s.person_id = p.id);
