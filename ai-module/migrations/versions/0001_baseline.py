"""基线：启用 pgvector 扩展，创建 ai 和 biz 两个模式。

文件：migrations/versions/0001_baseline.py
作用：最初的一步。ai 模式放 AI 模块自己的表；biz 模式放供只读 SQL 工具查询的示例业务数据。
downgrade 反向删除。

Revision ID: 0001
Revises:
Create Date: 2026-11-02
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """安装向量扩展，建 ai、biz 两个模式。"""
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    # ai: tables owned by the AI module (see docs/design/02-data-model.md)
    op.execute("CREATE SCHEMA IF NOT EXISTS ai")
    # biz: seed business data that the read-only SQL tools query
    op.execute("CREATE SCHEMA IF NOT EXISTS biz")


def downgrade() -> None:
    """删除 biz、ai 两个模式。"""
    op.execute("DROP SCHEMA IF EXISTS biz")
    op.execute("DROP SCHEMA IF EXISTS ai")
