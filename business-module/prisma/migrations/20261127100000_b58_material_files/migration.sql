-- 课件：说明（大段文字）、外部链接改为可选、可挂多个附件（文件在对象存储里）。
ALTER TABLE "section_material" ADD COLUMN "description" TEXT NOT NULL DEFAULT '';
ALTER TABLE "section_material" ALTER COLUMN "url" DROP NOT NULL;

-- CreateTable
CREATE TABLE "section_material_file" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "material_id" UUID,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "section_material_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "section_material_file_storage_key_key" ON "section_material_file"("storage_key");
CREATE INDEX "section_material_file_material_id_idx" ON "section_material_file"("material_id");
CREATE INDEX "section_material_file_section_id_idx" ON "section_material_file"("section_id");

-- AddForeignKey
ALTER TABLE "section_material_file" ADD CONSTRAINT "section_material_file_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "section_material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 手写部分：行级安全
ALTER TABLE biz."section_material_file" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON biz."section_material_file" USING (tenant_id = biz.current_tenant_id()) WITH CHECK (tenant_id = biz.current_tenant_id());
