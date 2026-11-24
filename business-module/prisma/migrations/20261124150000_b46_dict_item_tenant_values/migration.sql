-- 租户可以往平台字典里追加自己的条目：值要在"平台条目"之间唯一，也要在"同一租户的条目"之间唯一，
-- 但不同租户可以各自用同一个值（所以不能再是 (类型, 值) 全局唯一）。
-- 租户的值和平台已有的值重复，由接口检查并返回 409。
DROP INDEX IF EXISTS biz."dict_item_type_id_value_key";
CREATE UNIQUE INDEX "dict_item_platform_value_key" ON biz."dict_item"("type_id", "value") WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "dict_item_tenant_value_key" ON biz."dict_item"("type_id", "tenant_id", "value") WHERE "tenant_id" IS NOT NULL;
