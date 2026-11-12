-- CreateEnum
CREATE TYPE "scope_kind" AS ENUM ('all', 'own_dept', 'own_dept_tree', 'self', 'own_classes', 'custom');

-- CreateEnum
CREATE TYPE "login_result" AS ENUM ('success', 'denied');

-- AlterTable
ALTER TABLE "menu" ADD COLUMN     "code" TEXT;

-- CreateTable
CREATE TABLE "role_menu" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "role_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_scope_set" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "scope_kind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "data_scope_set_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_scope_set_node" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "set_id" UUID NOT NULL,
    "dept_id" UUID NOT NULL,
    "include_children" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_scope_set_node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_data_scope" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "role_id" UUID NOT NULL,
    "set_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_data_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_dept" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "dept_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_dept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "account_id" UUID,
    "username" TEXT,
    "entry" TEXT NOT NULL,
    "result" "login_result" NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "actor_account_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_menu_tenant_id_idx" ON "role_menu"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_menu_role_id_menu_id_key" ON "role_menu"("role_id", "menu_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_scope_set_tenant_id_code_key" ON "data_scope_set"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "data_scope_set_node_set_id_dept_id_key" ON "data_scope_set_node"("set_id", "dept_id");

-- CreateIndex
CREATE INDEX "role_data_scope_tenant_id_idx" ON "role_data_scope"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_data_scope_role_id_set_id_key" ON "role_data_scope"("role_id", "set_id");

-- CreateIndex
CREATE INDEX "person_dept_tenant_id_dept_id_idx" ON "person_dept"("tenant_id", "dept_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_dept_person_id_dept_id_key" ON "person_dept"("person_id", "dept_id");

-- CreateIndex
CREATE INDEX "login_log_tenant_id_created_at_idx" ON "login_log"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "role_menu" ADD CONSTRAINT "role_menu_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_menu" ADD CONSTRAINT "role_menu_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_menu" ADD CONSTRAINT "role_menu_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_scope_set" ADD CONSTRAINT "data_scope_set_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_scope_set_node" ADD CONSTRAINT "data_scope_set_node_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_scope_set_node" ADD CONSTRAINT "data_scope_set_node_set_id_fkey" FOREIGN KEY ("set_id") REFERENCES "data_scope_set"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_data_scope" ADD CONSTRAINT "role_data_scope_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_data_scope" ADD CONSTRAINT "role_data_scope_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_data_scope" ADD CONSTRAINT "role_data_scope_set_id_fkey" FOREIGN KEY ("set_id") REFERENCES "data_scope_set"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_dept" ADD CONSTRAINT "person_dept_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_dept" ADD CONSTRAINT "person_dept_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_log" ADD CONSTRAINT "login_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 以下为手写部分：唯一索引、行级安全、内置数据权限集。
-- ============================================================================

-- 平台提供的行（tenant_id 为空）不能重复
CREATE UNIQUE INDEX "menu_platform_code_key" ON biz."menu"("code") WHERE "tenant_id" IS NULL AND "code" IS NOT NULL;
CREATE UNIQUE INDEX "data_scope_set_platform_code_key" ON biz."data_scope_set"("code") WHERE "tenant_id" IS NULL;

-- 内置数据权限集：平台提供，租户只读（五种，全局固定）
INSERT INTO biz."data_scope_set" ("code", "name", "kind") VALUES
  ('all', 'All data', 'all'),
  ('own_dept', 'Own department', 'own_dept'),
  ('own_dept_tree', 'Own department and below', 'own_dept_tree'),
  ('self', 'Own records only', 'self'),
  ('own_classes', 'Classes I teach or attend', 'own_classes');

-- 严格按租户隔离的新表
ALTER TABLE biz."data_scope_set_node" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."data_scope_set_node"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."person_dept" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."person_dept"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."login_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."login_log"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."audit_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."audit_log"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

-- 平台提供的行所有租户可读，只有平台能写；租户只能写自己的行
ALTER TABLE biz."role_menu" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."role_menu" FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."role_menu" FOR INSERT WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."role_menu" FOR UPDATE
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."role_menu" FOR DELETE USING (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."role_data_scope" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."role_data_scope" FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."role_data_scope" FOR INSERT WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."role_data_scope" FOR UPDATE
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."role_data_scope" FOR DELETE USING (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."data_scope_set" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."data_scope_set" FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."data_scope_set" FOR INSERT WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."data_scope_set" FOR UPDATE
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."data_scope_set" FOR DELETE USING (tenant_id = biz.current_tenant_id());
