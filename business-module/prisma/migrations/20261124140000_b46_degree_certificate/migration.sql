-- 学位类型字典补一个"证书"（演示数据里有专业用的是它）
INSERT INTO biz."dict_item" ("type_id", "value", "label", "label_key", "sort")
  SELECT t.id, 'certificate', 'Certificate', 'dict.degree_type.certificate', 0 FROM biz."dict_type" t
  WHERE t.code = 'degree_type' AND t.tenant_id IS NULL;
