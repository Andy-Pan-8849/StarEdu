-- CreateTable
CREATE TABLE "dict_type" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "dict_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dict_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "type_id" UUID NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "label_key" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "dict_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_param" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "sys_param_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "account_id" UUID,
    "username" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "ip" TEXT,
    "params" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dict_type_tenant_id_code_key" ON "dict_type"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "dict_item_type_id_value_key" ON "dict_item"("type_id", "value");

-- CreateIndex
CREATE UNIQUE INDEX "sys_param_tenant_id_key_key" ON "sys_param"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "operation_log_tenant_id_created_at_idx" ON "operation_log"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "dict_type" ADD CONSTRAINT "dict_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dict_item" ADD CONSTRAINT "dict_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dict_item" ADD CONSTRAINT "dict_item_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "dict_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sys_param" ADD CONSTRAINT "sys_param_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_log" ADD CONSTRAINT "operation_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手写部分：平台行唯一、行级安全、平台提供的字典和参数
-- ============================================================================
CREATE UNIQUE INDEX "dict_type_platform_code_key" ON biz."dict_type"("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "sys_param_platform_key_key" ON biz."sys_param"("key") WHERE "tenant_id" IS NULL;

-- 平台提供的行所有租户可读、只有平台能写；租户只能写自己的行
ALTER TABLE biz."dict_type" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."dict_type" FOR SELECT USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."dict_type" FOR INSERT WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."dict_type" FOR UPDATE USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."dict_type" FOR DELETE USING (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."dict_item" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."dict_item" FOR SELECT USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."dict_item" FOR INSERT WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."dict_item" FOR UPDATE USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."dict_item" FOR DELETE USING (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."sys_param" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."sys_param" FOR SELECT USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."sys_param" FOR INSERT WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."sys_param" FOR UPDATE USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."sys_param" FOR DELETE USING (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."operation_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."operation_log" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

-- 平台提供的字典（翻译键在界面里按语言取文字）
INSERT INTO biz."dict_type" ("code", "name", "name_key") VALUES
  ('gender', 'Gender', 'dict.gender'),
  ('employment_type', 'Employment type', 'dict.employment_type');
INSERT INTO biz."dict_item" ("type_id", "value", "label", "label_key", "sort")
  SELECT t.id, v.value, v.label, v.label_key, v.sort FROM biz."dict_type" t
  JOIN (VALUES
    ('gender', 'male', 'Male', 'dict.gender.male', 1),
    ('gender', 'female', 'Female', 'dict.gender.female', 2),
    ('gender', 'other', 'Other', 'dict.gender.other', 3),
    ('gender', 'unknown', 'Prefer not to say', 'dict.gender.unknown', 4),
    ('employment_type', 'full_time', 'Full time', 'dict.employment_type.full_time', 1),
    ('employment_type', 'part_time', 'Part time', 'dict.employment_type.part_time', 2)
  ) AS v(code, value, label, label_key, sort) ON v.code = t.code
  WHERE t.tenant_id IS NULL;

-- 平台提供的参数
INSERT INTO biz."sys_param" ("key", "value", "name", "name_key") VALUES
  ('system.ui.defaultLocale', 'en', 'Default language', 'param.system.ui.defaultLocale'),
  ('system.list.pageSize', '20', 'Default page size', 'param.system.list.pageSize');
