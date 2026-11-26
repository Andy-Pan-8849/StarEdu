-- 讨论的"已读"：每个人对每个讨论帖（根帖）最后一次打开的时间。
-- 帖子里有别人在这个时间之后的发言（或帖子本身是别人发的、我还没打开过）就是"未读"。
-- CreateTable
CREATE TABLE "discussion_read" (
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_read_pkey" PRIMARY KEY ("person_id", "thread_id")
);

-- CreateIndex
CREATE INDEX "discussion_read_tenant_id_idx" ON "discussion_read"("tenant_id");

-- 手写部分：行级安全
ALTER TABLE biz."discussion_read" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."discussion_read" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
