-- B46：字典条目加备注（说明这个值是什么意思）；新增两个平台字典和四个平台参数。
-- 平台提供的字典、参数的备注文字走翻译键（界面按语言取），租户自建的备注直接存文字。
ALTER TABLE "biz"."dict_item" ADD COLUMN "remark" TEXT;

INSERT INTO biz."dict_type" ("code", "name", "name_key") VALUES
  ('relationship', 'Relationship', 'dict.type.relationship'),
  ('material_category', 'Material category', 'dict.type.material_category');
INSERT INTO biz."dict_item" ("type_id", "value", "label", "label_key", "sort")
  SELECT t.id, v.value, v.label, v.label_key, v.sort FROM biz."dict_type" t
  JOIN (VALUES
    ('relationship', 'parent', 'Parent', 'dict.relationship.parent', 1),
    ('relationship', 'spouse', 'Spouse', 'dict.relationship.spouse', 2),
    ('relationship', 'sibling', 'Sibling', 'dict.relationship.sibling', 3),
    ('relationship', 'guardian', 'Guardian', 'dict.relationship.guardian', 4),
    ('relationship', 'other', 'Other', 'dict.relationship.other', 5),
    ('material_category', 'slides', 'Slides', 'dict.material_category.slides', 1),
    ('material_category', 'reference', 'Reference', 'dict.material_category.reference', 2),
    ('material_category', 'syllabus', 'Syllabus', 'dict.material_category.syllabus', 3)
  ) AS v(code, value, label, label_key, sort) ON v.code = t.code
  WHERE t.tenant_id IS NULL;

INSERT INTO biz."sys_param" ("key", "value", "name", "name_key") VALUES
  ('edu.extension.maxDays', '3', 'Maximum assignment extension (days)', 'param.edu.extension.maxDays'),
  ('edu.submission.maxFiles', '10', 'Maximum files per submission', 'param.edu.submission.maxFiles'),
  ('edu.upload.maxMb', '20', 'Assignment file size limit (MB)', 'param.edu.upload.maxMb'),
  ('library.upload.maxMb', '50', 'Document library file size limit (MB)', 'param.library.upload.maxMb');
