-- 字典类型名称的翻译键改成 dict.type.<编码>，避免和条目的键 dict.<编码>.<值> 在 JSON 里冲突（一个键既是文字又是对象）
UPDATE biz."dict_type" SET "name_key" = 'dict.type.' || "code" WHERE "tenant_id" IS NULL;
