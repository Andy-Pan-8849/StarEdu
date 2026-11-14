-- AlterTable
ALTER TABLE "account" ADD COLUMN     "locale" TEXT;

-- AlterTable
ALTER TABLE "outbox_event" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failed_at" TIMESTAMP(3),
ADD COLUMN     "last_error" TEXT;

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "title" TEXT,
    "body" TEXT,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "dedupe_key" TEXT NOT NULL,
    "email_status" TEXT NOT NULL DEFAULT 'none',
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scope_kind" TEXT NOT NULL,
    "campus_id" UUID,
    "section_id" UUID,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMP(3),

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_announcement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_account_id_created_at_idx" ON "notification"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_account_id_dedupe_key_key" ON "notification"("account_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_account_id_category_key" ON "notification_preference"("account_id", "category");

-- CreateIndex
CREATE INDEX "announcement_tenant_id_created_at_idx" ON "announcement"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_announcement_starts_at_ends_at_idx" ON "platform_announcement"("starts_at", "ends_at");

-- 手写部分：行级安全、约束、索引、平台表的权限
ALTER TABLE biz."notification" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."notification" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."notification_preference" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."notification_preference" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."announcement" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."announcement" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."notification" ADD CONSTRAINT "notification_email_status_check" CHECK (email_status IN ('none', 'pending', 'sent', 'failed'));
ALTER TABLE biz."announcement" ADD CONSTRAINT "announcement_scope_check" CHECK (scope_kind IN ('tenant', 'campus', 'section'));
ALTER TABLE biz."platform_announcement" ADD CONSTRAINT "platform_announcement_window_check" CHECK (ends_at > starts_at);
-- 出站箱的消费者只找没处理、没放弃的事件；邮件发送只找排队中的
CREATE INDEX "outbox_event_pending_idx" ON biz."outbox_event" (created_at) WHERE processed_at IS NULL AND failed_at IS NULL;
CREATE INDEX "notification_email_pending_idx" ON biz."notification" (created_at) WHERE email_status = 'pending';
-- 平台表：租户的数据库账号不能碰
REVOKE ALL ON biz."platform_announcement" FROM biz_app;
