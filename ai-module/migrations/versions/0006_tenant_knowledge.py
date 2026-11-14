"""知识库的租户隔离（业务模式）。

文件：migrations/versions/0006_tenant_knowledge.py
作用：给 documents 和 document_chunks 各加一列 tenant_id（文本，业务模块的租户 id）。
空 = 独立模式的文档（样本公司）；非空 = 业务模式里某个租户自己的文档。检索只返回和提问者同租户的块
（独立模式的提问者只看到空租户的块），所以一个租户的文档永远不会被另一个租户检索到。
权限漂移检查视图也把 tenant_id 纳入比较。

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-14
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """加列和索引，并重建漂移检查视图。"""
    op.execute("ALTER TABLE ai.documents ADD COLUMN tenant_id text")
    op.execute("ALTER TABLE ai.document_chunks ADD COLUMN tenant_id text")
    op.execute("CREATE INDEX chunks_tenant_idx ON ai.document_chunks (tenant_id)")
    op.execute("DROP VIEW IF EXISTS ai.v_chunk_permission_drift")
    op.execute(
        """
        CREATE VIEW ai.v_chunk_permission_drift AS
        SELECT c.id AS chunk_id, c.document_id
        FROM ai.document_chunks c
        JOIN ai.documents d ON d.id = c.document_id
        WHERE (c.allowed_roles, c.allowed_users, c.campus_scope, c.min_level_rank,
               c.status, c.effective_date, c.doc_code, c.version, c.tenant_id)
              IS DISTINCT FROM
              (d.allowed_roles, d.allowed_users, d.campus_scope, d.min_level_rank,
               d.status, d.effective_date, d.doc_code, d.version, d.tenant_id)
        """
    )
    op.execute("GRANT SELECT ON ai.v_chunk_permission_drift TO ai_app")


def downgrade() -> None:
    """恢复原来的视图，删除列。"""
    op.execute("DROP VIEW IF EXISTS ai.v_chunk_permission_drift")
    op.execute(
        """
        CREATE VIEW ai.v_chunk_permission_drift AS
        SELECT c.id AS chunk_id, c.document_id
        FROM ai.document_chunks c
        JOIN ai.documents d ON d.id = c.document_id
        WHERE (c.allowed_roles, c.allowed_users, c.campus_scope, c.min_level_rank,
               c.status, c.effective_date, c.doc_code, c.version)
              IS DISTINCT FROM
              (d.allowed_roles, d.allowed_users, d.campus_scope, d.min_level_rank,
               d.status, d.effective_date, d.doc_code, d.version)
        """
    )
    op.execute("DROP INDEX IF EXISTS ai.chunks_tenant_idx")
    op.execute("ALTER TABLE ai.document_chunks DROP COLUMN tenant_id")
    op.execute("ALTER TABLE ai.documents DROP COLUMN tenant_id")
