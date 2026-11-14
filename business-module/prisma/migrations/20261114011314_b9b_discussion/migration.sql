-- CreateTable
CREATE TABLE "discussion_post" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "parent_id" UUID,
    "author_person_id" UUID NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "discussion_post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discussion_post_section_id_created_at_idx" ON "discussion_post"("section_id", "created_at");

-- CreateIndex
CREATE INDEX "discussion_post_parent_id_idx" ON "discussion_post"("parent_id");

-- 手写部分：行级安全、约束
ALTER TABLE biz."discussion_post" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."discussion_post" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
-- 帖子要有标题，回复不能有标题；回复不能置顶、不能标记已解决
ALTER TABLE biz."discussion_post" ADD CONSTRAINT "discussion_post_shape_check" CHECK (
  (parent_id IS NULL AND title IS NOT NULL) OR (parent_id IS NOT NULL AND title IS NULL AND NOT pinned AND NOT resolved)
);
