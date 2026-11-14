-- B15: 租户配额。空 = 不限。只有平台入口能改（租户表对应用账号只读自己），
-- 租户请求要查自己的上限时走受限函数（以库所有者身份执行，只返回当前租户的两个数）。
ALTER TABLE biz."tenant" ADD COLUMN "max_accounts" INTEGER;
ALTER TABLE biz."tenant" ADD COLUMN "max_storage_mb" INTEGER;
ALTER TABLE biz."tenant" ADD CONSTRAINT tenant_max_accounts_check CHECK (max_accounts IS NULL OR max_accounts > 0);
ALTER TABLE biz."tenant" ADD CONSTRAINT tenant_max_storage_mb_check CHECK (max_storage_mb IS NULL OR max_storage_mb > 0);

CREATE FUNCTION biz.tenant_limits()
RETURNS TABLE (max_accounts int, max_storage_mb int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = biz AS $$
  SELECT t.max_accounts, t.max_storage_mb FROM biz."tenant" t WHERE t.id = biz.current_tenant_id()
$$;
REVOKE ALL ON FUNCTION biz.tenant_limits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION biz.tenant_limits() TO biz_app;
