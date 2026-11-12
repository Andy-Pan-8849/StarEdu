-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "notified_at" TIMESTAMP(3),
ADD COLUMN     "remark" TEXT,
ADD COLUMN     "suspended_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "platform_account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "username" TEXT NOT NULL,
    "email" TEXT,
    "keycloak_user_id" TEXT,
    "status" "account_status" NOT NULL DEFAULT 'pending',
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "platform_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'custom',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "platform_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_account_role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_account_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role_menu" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,

    CONSTRAINT "platform_role_menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_account_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_job" (
    "code" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_job_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "job_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_code" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "message" TEXT,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_account_username_key" ON "platform_account"("username");

-- CreateIndex
CREATE UNIQUE INDEX "platform_account_email_key" ON "platform_account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_account_keycloak_user_id_key" ON "platform_account"("keycloak_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_code_key" ON "platform_role"("code");

-- CreateIndex
CREATE UNIQUE INDEX "platform_account_role_account_id_role_id_key" ON "platform_account_role"("account_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_menu_role_id_menu_id_key" ON "platform_role_menu"("role_id", "menu_id");

-- CreateIndex
CREATE INDEX "platform_audit_log_created_at_idx" ON "platform_audit_log"("created_at");

-- CreateIndex
CREATE INDEX "job_run_job_code_started_at_idx" ON "job_run"("job_code", "started_at");

-- AddForeignKey
ALTER TABLE "platform_account_role" ADD CONSTRAINT "platform_account_role_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "platform_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_account_role" ADD CONSTRAINT "platform_account_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform_role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_menu" ADD CONSTRAINT "platform_role_menu_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform_role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_menu" ADD CONSTRAINT "platform_role_menu_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 内置角色"平台超级管理员"：自动拥有平台入口下全部操作权限，不可改删
INSERT INTO biz."platform_role" ("code", "name", "kind", "sort") VALUES ('platform-super', 'Platform super administrator', 'super', 0);
