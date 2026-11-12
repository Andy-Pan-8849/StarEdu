-- 平台表只给平台专用的数据库连接（库所有者账号）用；租户请求用的应用账号 biz_app 完全碰不到它们。
-- 租户的 Prisma 客户端连的是 biz_app，所以即使租户侧代码有漏洞，也读写不了平台账号、平台日志和任务。
REVOKE ALL ON biz."platform_account", biz."platform_role", biz."platform_account_role", biz."platform_role_menu",
  biz."platform_audit_log", biz."scheduled_job", biz."job_run" FROM biz_app;
