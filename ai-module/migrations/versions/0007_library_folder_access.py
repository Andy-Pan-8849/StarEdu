"""知识库权限与业务模块的文档库对齐（业务模式）。

文件：migrations/versions/0007_library_folder_access.py
作用：给 documents 加 folder_id、classification，给 document_chunks 加 folder_id
（业务模块文档库的文件夹 id 和密级）。
folder_id 为空 = 原来的权限方式（独立模式的角色/校区/职等；业务模式里课程大纲、
课件清单这类文档的过渡角色）；非空 = 这份文档来自文档库文件，谁能读由业务模块按文件夹授权
实时回答（检索时带上"能读的文件夹 id 列表"）。
文本块上的 folder_id 和别的权限字段一样冗余在块里，检索只查一张表；漂移检查视图也纳入比较。
可回滚：downgrade 先删掉来自文档库的文档（它们是业务模块的镜像，可由事件重新同步），
再恢复视图、删列。

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-14
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

_OLD_COLUMNS = (
    "allowed_roles, allowed_users, campus_scope, min_level_rank, "
    "status, effective_date, doc_code, version, tenant_id"
)


def _drift_view(extra: str) -> str:
    cols = _OLD_COLUMNS + extra
    prefixed = lambda alias: ", ".join(f"{alias}.{c.strip()}" for c in cols.split(","))  # noqa: E731
    return f"""
        CREATE VIEW ai.v_chunk_permission_drift AS
        SELECT c.id AS chunk_id, c.document_id
        FROM ai.document_chunks c
        JOIN ai.documents d ON d.id = c.document_id
        WHERE ({prefixed("c")}) IS DISTINCT FROM ({prefixed("d")})
    """


def upgrade() -> None:
    """加列、索引，并重建漂移检查视图（加入 folder_id）。"""
    op.execute("ALTER TABLE ai.documents ADD COLUMN folder_id text, ADD COLUMN classification text")
    op.execute("ALTER TABLE ai.document_chunks ADD COLUMN folder_id text")
    op.execute("CREATE INDEX chunks_folder_idx ON ai.document_chunks (folder_id)")
    # 文档库来源的文档必须属于某个租户（folder_id 只在业务模式下有意义）
    op.execute(
        "ALTER TABLE ai.documents ADD CONSTRAINT documents_folder_tenant_check "
        "CHECK (folder_id IS NULL OR tenant_id IS NOT NULL)"
    )
    op.execute("DROP VIEW IF EXISTS ai.v_chunk_permission_drift")
    op.execute(_drift_view(", folder_id"))
    op.execute("GRANT SELECT ON ai.v_chunk_permission_drift TO ai_app")


def downgrade() -> None:
    """删除文档库来源的文档（可由事件重新同步），恢复视图，删列。"""
    op.execute("DELETE FROM ai.documents WHERE folder_id IS NOT NULL")
    op.execute("DROP VIEW IF EXISTS ai.v_chunk_permission_drift")
    op.execute(_drift_view(""))
    op.execute("GRANT SELECT ON ai.v_chunk_permission_drift TO ai_app")
    op.execute("ALTER TABLE ai.documents DROP CONSTRAINT documents_folder_tenant_check")
    op.execute("DROP INDEX IF EXISTS ai.chunks_folder_idx")
    op.execute("ALTER TABLE ai.document_chunks DROP COLUMN folder_id")
    op.execute("ALTER TABLE ai.documents DROP COLUMN classification, DROP COLUMN folder_id")
