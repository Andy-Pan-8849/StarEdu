-- B25: 公开试用站的保护要知道"这家公司是不是演示公司"。
-- 租户表对应用账号只开放"自己"，而保护发生在识别租户之后的中间件里，所以和 resolve_tenant 一样用一个受限函数（只返回一个布尔值）。
-- 不修改 resolve_tenant：它"只返回四个字段"有测试守着。
CREATE FUNCTION biz.is_demo_tenant(p_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = biz AS $$
  SELECT COALESCE((SELECT t.is_demo FROM biz."tenant" t WHERE t.id = p_id), false)
$$;
REVOKE ALL ON FUNCTION biz.is_demo_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION biz.is_demo_tenant(uuid) TO biz_app;
