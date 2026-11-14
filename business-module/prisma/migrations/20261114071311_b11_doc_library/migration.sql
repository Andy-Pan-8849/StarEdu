-- CreateTable
CREATE TABLE "doc_folder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "ancestors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL,
    "owner_dept_id" UUID,
    "classification" TEXT NOT NULL DEFAULT 'internal',
    "inherit_acl" BOOLEAN NOT NULL DEFAULT true,
    "preview_only" BOOLEAN NOT NULL DEFAULT false,
    "log_access" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_acl" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "principal_type" TEXT NOT NULL,
    "principal_id" UUID,
    "include_sub" BOOLEAN NOT NULL DEFAULT false,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "expires_at" TIMESTAMP(3),
    "granted_by" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_acl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_file" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "doc_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_file_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_file_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_upload" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "file_id" UUID,
    "storage_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_access_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "account_id" UUID,
    "action" TEXT NOT NULL,
    "folder_id" UUID,
    "file_id" UUID,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "doc_folder_tenant_id_parent_id_idx" ON "doc_folder"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "doc_folder_ancestors_idx" ON "doc_folder" USING GIN ("ancestors");

-- CreateIndex
CREATE INDEX "doc_acl_tenant_id_folder_id_idx" ON "doc_acl"("tenant_id", "folder_id");

-- CreateIndex
CREATE INDEX "doc_file_tenant_id_folder_id_idx" ON "doc_file"("tenant_id", "folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "doc_file_version_storage_key_key" ON "doc_file_version"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "doc_file_version_file_id_version_key" ON "doc_file_version"("file_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "doc_upload_storage_key_key" ON "doc_upload"("storage_key");

-- CreateIndex
CREATE INDEX "doc_access_log_tenant_id_folder_id_created_at_idx" ON "doc_access_log"("tenant_id", "folder_id", "created_at");

-- ============================================================================
-- 手写部分：行级安全、约束、触发器、索引
-- ============================================================================
ALTER TABLE biz."doc_folder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."doc_folder" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."doc_acl" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."doc_acl" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."doc_file" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."doc_file" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."doc_file_version" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."doc_file_version" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."doc_upload" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."doc_upload" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
ALTER TABLE biz."doc_access_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."doc_access_log" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());

ALTER TABLE biz."doc_folder" ADD CONSTRAINT "doc_folder_classification_check" CHECK (classification IN ('public', 'internal', 'confidential'));
-- 机密文件夹：不继承、必记日志
ALTER TABLE biz."doc_folder" ADD CONSTRAINT "doc_folder_confidential_check" CHECK (classification <> 'confidential' OR (NOT inherit_acl AND log_access));
ALTER TABLE biz."doc_folder" ADD CONSTRAINT "doc_folder_preview_only_check" CHECK (NOT preview_only OR classification = 'confidential');
ALTER TABLE biz."doc_acl" ADD CONSTRAINT "doc_acl_level_check" CHECK (level IN ('view', 'edit', 'manage'));
ALTER TABLE biz."doc_acl" ADD CONSTRAINT "doc_acl_principal_check" CHECK (
  (principal_type IN ('everyone', 'all_staff') AND principal_id IS NULL)
  OR (principal_type IN ('dept', 'role', 'user') AND principal_id IS NOT NULL));
ALTER TABLE biz."doc_acl" ADD CONSTRAINT "doc_acl_source_check" CHECK (source IN ('default', 'manual'));
ALTER TABLE biz."doc_file" ADD CONSTRAINT "doc_file_size_check" CHECK (size >= 0);
-- 存储键必须在本租户的文档库前缀下
ALTER TABLE biz."doc_file" ADD CONSTRAINT "doc_file_key_check" CHECK (storage_key LIKE 'tenant/' || tenant_id::text || '/library/%');
ALTER TABLE biz."doc_file_version" ADD CONSTRAINT "doc_file_version_key_check" CHECK (storage_key LIKE 'tenant/' || tenant_id::text || '/library/%');
ALTER TABLE biz."doc_upload" ADD CONSTRAINT "doc_upload_key_check" CHECK (storage_key LIKE 'tenant/' || tenant_id::text || '/library/%');
-- 同一个上级下文件夹名字不重复（不分大小写）
CREATE UNIQUE INDEX "doc_folder_name_key" ON biz."doc_folder" (tenant_id, coalesce(parent_id::text, ''), lower(name));
-- 同一个文件夹里没删除的文件名字不重复
CREATE UNIQUE INDEX "doc_file_name_key" ON biz."doc_file" (folder_id, lower(name)) WHERE deleted_at IS NULL;

-- 文件夹祖先链（含自己）：新增或换上级时计算；换上级后同步子树；不能移到自己的子树里（和部门树同样做法）
CREATE FUNCTION biz.doc_folder_set_ancestors() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_anc text[];
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.ancestors := ARRAY[NEW.id::text];
    RETURN NEW;
  END IF;
  SELECT ancestors INTO parent_anc FROM biz."doc_folder" WHERE id = NEW.parent_id AND tenant_id = NEW.tenant_id;
  IF parent_anc IS NULL THEN
    RAISE EXCEPTION 'parent folder not found in this tenant' USING ERRCODE = '23503';
  END IF;
  IF NEW.id::text = ANY (parent_anc) THEN
    RAISE EXCEPTION 'a folder cannot be moved under itself' USING ERRCODE = '23514';
  END IF;
  NEW.ancestors := parent_anc || NEW.id::text;
  RETURN NEW;
END
$$;
CREATE TRIGGER doc_folder_ancestors_before BEFORE INSERT OR UPDATE OF parent_id ON biz."doc_folder"
  FOR EACH ROW EXECUTE FUNCTION biz.doc_folder_set_ancestors();

CREATE FUNCTION biz.doc_folder_fix_descendants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ancestors IS DISTINCT FROM OLD.ancestors THEN
    UPDATE biz."doc_folder" d
       SET ancestors = NEW.ancestors || d.ancestors[array_position(d.ancestors, NEW.id::text) + 1:]
     WHERE d.tenant_id = NEW.tenant_id AND d.id <> NEW.id AND d.ancestors @> ARRAY[NEW.id::text];
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER doc_folder_ancestors_after AFTER UPDATE OF parent_id ON biz."doc_folder"
  FOR EACH ROW EXECUTE FUNCTION biz.doc_folder_fix_descendants();
