-- B23: 演示公司标记。只有带这个标记的公司，才允许生成演示账号和演示角色、才允许一键重置；生产公司永远是 false。
ALTER TABLE biz."tenant" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;
