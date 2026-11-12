/*
  Warnings:

  - You are about to drop the `system_info` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('provisioning', 'active', 'notified', 'suspended');

-- CreateEnum
CREATE TYPE "tenant_type" AS ENUM ('direct', 'franchise');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('pending', 'active', 'locked', 'disabled');

-- CreateEnum
CREATE TYPE "campus_type" AS ENUM ('hq', 'campus');

-- CreateEnum
CREATE TYPE "campus_status" AS ENUM ('normal', 'stop_new', 'closed');

-- CreateEnum
CREATE TYPE "role_kind" AS ENUM ('custom', 'tenant_admin', 'student');

-- CreateEnum
CREATE TYPE "menu_type" AS ENUM ('directory', 'menu', 'button', 'link');

-- CreateEnum
CREATE TYPE "person_type" AS ENUM ('staff', 'student');

-- DropTable
DROP TABLE "system_info";

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "type" "tenant_type" NOT NULL DEFAULT 'direct',
    "status" "tenant_status" NOT NULL DEFAULT 'provisioning',
    "provision_step" TEXT NOT NULL DEFAULT 'created',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "contact_name" TEXT,
    "contact_email" TEXT,
    "planned_suspend_at" TIMESTAMP(3),
    "notice_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_menu_grant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_menu_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" "person_type" NOT NULL,
    "full_name" TEXT NOT NULL,
    "work_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "person_id" UUID,
    "keycloak_user_id" TEXT,
    "status" "account_status" NOT NULL DEFAULT 'pending',
    "is_builtin_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_service" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "role_kind" NOT NULL DEFAULT 'custom',
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "template_id" UUID,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "parent_id" UUID,
    "name_key" TEXT,
    "name" TEXT NOT NULL,
    "type" "menu_type" NOT NULL,
    "route" TEXT,
    "component" TEXT,
    "perms" TEXT,
    "icon" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "applicable_statuses" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_menu" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "entry_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "entry_menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dept" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "ancestors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "dept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campus" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "dept_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "type" "campus_type" NOT NULL DEFAULT 'campus',
    "status" "campus_status" NOT NULL DEFAULT 'normal',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "campus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_code_key" ON "tenant"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_menu_grant_tenant_id_menu_id_key" ON "tenant_menu_grant"("tenant_id", "menu_id");

-- CreateIndex
CREATE INDEX "person_tenant_id_idx" ON "person"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_person_id_key" ON "account"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_keycloak_user_id_key" ON "account"("keycloak_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_tenant_id_username_key" ON "account"("tenant_id", "username");

-- CreateIndex
CREATE UNIQUE INDEX "account_tenant_id_email_key" ON "account"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_code_key" ON "role"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "account_role_account_id_role_id_key" ON "account_role"("account_id", "role_id");

-- CreateIndex
CREATE INDEX "menu_tenant_id_idx" ON "menu"("tenant_id");

-- CreateIndex
CREATE INDEX "menu_parent_id_idx" ON "menu"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "entry_code_key" ON "entry"("code");

-- CreateIndex
CREATE UNIQUE INDEX "entry_menu_entry_id_menu_id_tenant_id_key" ON "entry_menu"("entry_id", "menu_id", "tenant_id");

-- CreateIndex
CREATE INDEX "dept_tenant_id_idx" ON "dept"("tenant_id");

-- CreateIndex
CREATE INDEX "dept_parent_id_idx" ON "dept"("parent_id");

-- CreateIndex
CREATE INDEX "dept_ancestors_idx" ON "dept" USING GIN ("ancestors");

-- CreateIndex
CREATE UNIQUE INDEX "campus_dept_id_key" ON "campus"("dept_id");

-- CreateIndex
CREATE UNIQUE INDEX "campus_tenant_id_code_key" ON "campus"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "post_tenant_id_code_key" ON "post"("tenant_id", "code");

-- AddForeignKey
ALTER TABLE "tenant_menu_grant" ADD CONSTRAINT "tenant_menu_grant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_menu_grant" ADD CONSTRAINT "tenant_menu_grant_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_role" ADD CONSTRAINT "account_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_role" ADD CONSTRAINT "account_role_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_role" ADD CONSTRAINT "account_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu" ADD CONSTRAINT "menu_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu" ADD CONSTRAINT "menu_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "menu"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_menu" ADD CONSTRAINT "entry_menu_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_menu" ADD CONSTRAINT "entry_menu_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_menu" ADD CONSTRAINT "entry_menu_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dept" ADD CONSTRAINT "dept_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dept" ADD CONSTRAINT "dept_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "dept"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campus" ADD CONSTRAINT "campus_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campus" ADD CONSTRAINT "campus_dept_id_fkey" FOREIGN KEY ("dept_id") REFERENCES "dept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 以下为手写部分（Prisma 表达不了的东西）：触发器、行级安全、低权限账号、参考数据。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 租户代码开通后不可修改（登录网址、邮件链接都依赖它）
-- ---------------------------------------------------------------------------
CREATE FUNCTION biz.forbid_tenant_code_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'tenant code is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenant_code_immutable
  BEFORE UPDATE ON biz."tenant"
  FOR EACH ROW EXECUTE FUNCTION biz.forbid_tenant_code_change();

-- ---------------------------------------------------------------------------
-- 2. 部门祖先链（含自己）：新增或换上级时计算；换上级后同步子树
-- ---------------------------------------------------------------------------
CREATE FUNCTION biz.dept_set_ancestors() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_anc text[];
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.ancestors := ARRAY[NEW.id::text];
    RETURN NEW;
  END IF;
  SELECT ancestors INTO parent_anc
    FROM biz."dept" WHERE id = NEW.parent_id AND tenant_id = NEW.tenant_id;
  IF parent_anc IS NULL THEN
    RAISE EXCEPTION 'parent department not found in this tenant' USING ERRCODE = '23503';
  END IF;
  IF NEW.id::text = ANY (parent_anc) THEN
    RAISE EXCEPTION 'a department cannot be moved under itself' USING ERRCODE = '23514';
  END IF;
  NEW.ancestors := parent_anc || NEW.id::text;
  RETURN NEW;
END
$$;

CREATE TRIGGER dept_ancestors_before
  BEFORE INSERT OR UPDATE OF parent_id ON biz."dept"
  FOR EACH ROW EXECUTE FUNCTION biz.dept_set_ancestors();

CREATE FUNCTION biz.dept_fix_descendants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ancestors IS DISTINCT FROM OLD.ancestors THEN
    UPDATE biz."dept" d
       SET ancestors = NEW.ancestors || d.ancestors[array_position(d.ancestors, NEW.id::text) + 1:]
     WHERE d.tenant_id = NEW.tenant_id
       AND d.id <> NEW.id
       AND d.ancestors @> ARRAY[NEW.id::text];
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER dept_ancestors_after
  AFTER UPDATE OF parent_id ON biz."dept"
  FOR EACH ROW EXECUTE FUNCTION biz.dept_fix_descendants();

-- ---------------------------------------------------------------------------
-- 3. 平台提供的行（tenant_id 为空）不能重复
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "role_platform_code_key" ON biz."role"("code") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "entry_menu_platform_key" ON biz."entry_menu"("entry_id", "menu_id") WHERE "tenant_id" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. 参考数据：三个固定入口（平台提供，租户不能新建）
-- ---------------------------------------------------------------------------
INSERT INTO biz."entry" ("code", "name") VALUES
  ('admin', 'Admin console'),
  ('portal', 'Student portal'),
  ('platform', 'Platform console');

-- ---------------------------------------------------------------------------
-- 5. 应用账号 biz_app：低权限，受行级安全约束。
--    默认密码只用于本地演示，上线前必须 ALTER ROLE biz_app PASSWORD '...'。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'biz_app') THEN
    CREATE ROLE biz_app LOGIN PASSWORD 'starit-app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA biz TO biz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA biz TO biz_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA biz GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO biz_app;
-- 租户和入口由平台管理（迁移、开通脚本、以后的平台角色），应用账号只读
REVOKE INSERT, UPDATE, DELETE ON biz."tenant" FROM biz_app;
REVOKE INSERT, UPDATE, DELETE ON biz."entry" FROM biz_app;
DO $$
BEGIN
  -- 迁移历史表只对迁移账号开放（Prisma 的影子库里没有这张表，所以先判断）
  IF to_regclass('biz._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON biz."_prisma_migrations" FROM biz_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. 行级安全：当前租户来自会话变量 app.tenant_id（事务内 set_config 设置）。
--    没设置 = 空 = 什么都看不到（默认拒绝）。库所有者（迁移、开通脚本）不受约束，
--    因为只对表 ENABLE 而不 FORCE；应用账号不是所有者，受约束。
-- ---------------------------------------------------------------------------
CREATE FUNCTION biz.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION biz.current_tenant_id() TO biz_app;

-- 6a. 严格按租户隔离的表
ALTER TABLE biz."person" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."person"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."account" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."account"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."account_role" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."account_role"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."tenant_menu_grant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."tenant_menu_grant"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."dept" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."dept"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."campus" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."campus"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."post" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."post"
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

-- 6b. 平台提供的行（tenant_id 为空）所有租户可读，只有平台能写；租户只能写自己的行
ALTER TABLE biz."role" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."role" FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."role" FOR INSERT
  WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."role" FOR UPDATE
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."role" FOR DELETE
  USING (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."menu" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."menu" FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."menu" FOR INSERT
  WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."menu" FOR UPDATE
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."menu" FOR DELETE
  USING (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."entry_menu" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON biz."entry_menu" FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_insert ON biz."entry_menu" FOR INSERT
  WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_update ON biz."entry_menu" FOR UPDATE
  USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
CREATE POLICY tenant_delete ON biz."entry_menu" FOR DELETE
  USING (tenant_id = biz.current_tenant_id());

-- 6c. 租户表：应用账号只能看到自己的租户
ALTER TABLE biz."tenant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON biz."tenant" FOR SELECT USING (id = biz.current_tenant_id());

-- ---------------------------------------------------------------------------
-- 7. 按主机名找租户：租户表对应用账号只开放"自己"，而识别租户发生在知道"自己是谁"之前，
--    所以用一个受限的函数（以库所有者身份执行，只返回四个字段）。
-- ---------------------------------------------------------------------------
CREATE FUNCTION biz.resolve_tenant(p_code text)
RETURNS TABLE (id uuid, code text, name text, status biz.tenant_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = biz AS $$
  SELECT t.id, t.code, t.name, t.status FROM biz."tenant" t WHERE t.code = p_code
$$;
REVOKE ALL ON FUNCTION biz.resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION biz.resolve_tenant(text) TO biz_app;
