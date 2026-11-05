"""会话、运行记录、只增不改的审计日志、评测表，以及权限漂移检查视图。

文件：migrations/versions/0003_conversation_audit_eval.py
作用与思想：
  - conversations / runs / messages：会话、每次助手运行（结局、模型、token、耗时）、消息和引用。
  - audit_log：审计日志。应用账号只被授予 INSERT，没有 UPDATE/DELETE/SELECT，
    所以应用代码无法修改或删除审计记录（这是不可抵赖性的数据库层保证）。
  - eval_runs / eval_results：评测运行与逐题结果。
  - v_chunk_permission_drift：检查视图，列出权限字段与所属文档不一致的文本块（应当永远为空）。

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-02
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """建会话/运行/消息/审计/评测表和漂移视图，并授权（审计表只给 INSERT）。"""
    op.execute(
        """
        CREATE TABLE ai.conversations (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     text NOT NULL,
            title       text,
            archived    boolean NOT NULL DEFAULT false,
            created_at  timestamptz NOT NULL DEFAULT now(),
            updated_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX conversations_user_idx ON ai.conversations (user_id, updated_at DESC)")

    op.execute(
        """
        CREATE TABLE ai.runs (
            id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id  uuid NOT NULL REFERENCES ai.conversations (id) ON DELETE CASCADE,
            user_id          text NOT NULL,
            started_at       timestamptz NOT NULL DEFAULT now(),
            ended_at         timestamptz,
            end_state        text CHECK (end_state IN (
                                 'answered', 'need_clarification', 'no_permission',
                                 'not_found', 'refused', 'error')),
            end_reason       text,
            model            text,
            tokens_in        int,
            tokens_out       int,
            latency_ms       int,
            trace_id         text
        )
        """
    )

    op.execute(
        """
        CREATE TABLE ai.messages (
            id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id  uuid NOT NULL REFERENCES ai.conversations (id) ON DELETE CASCADE,
            run_id           uuid REFERENCES ai.runs (id) ON DELETE SET NULL,
            role             text NOT NULL CHECK (role IN ('user', 'assistant')),
            content          text NOT NULL,
            citations        jsonb NOT NULL DEFAULT '[]',
            created_at       timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX messages_conversation_idx ON ai.messages (conversation_id, created_at)"
    )

    op.execute(
        """
        CREATE TABLE ai.audit_log (
            id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            ts              timestamptz NOT NULL DEFAULT now(),
            user_id         text,
            roles           jsonb NOT NULL DEFAULT '[]',
            action          text NOT NULL,
            run_id          uuid,
            query_text      text,
            doc_ids         text[] NOT NULL DEFAULT '{}',
            filtered_count  int,
            ip              text,
            details         jsonb NOT NULL DEFAULT '{}'
        )
        """
    )
    op.execute("CREATE INDEX audit_user_idx ON ai.audit_log (user_id, ts)")
    op.execute("CREATE INDEX audit_action_idx ON ai.audit_log (action, ts)")

    op.execute(
        """
        CREATE TABLE ai.eval_runs (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            started_at  timestamptz NOT NULL DEFAULT now(),
            git_sha     text,
            config      jsonb NOT NULL DEFAULT '{}',
            summary     jsonb NOT NULL DEFAULT '{}'
        )
        """
    )
    op.execute(
        """
        CREATE TABLE ai.eval_results (
            run_id             uuid NOT NULL REFERENCES ai.eval_runs (id) ON DELETE CASCADE,
            question_id        text NOT NULL,
            role               text,
            answer             text,
            passed             boolean,
            retrieved_doc_ids  text[] NOT NULL DEFAULT '{}',
            latency_ms         int,
            notes              text,
            PRIMARY KEY (run_id, question_id, role)
        )
        """
    )

    # Chunks must carry the same permission, status and version fields as their document.
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

    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai TO ai_app")
    # 审计表单独收紧：先撤销全部权限，再只给 INSERT
    # The audit log is append-only for the application: it may insert and nothing else.
    op.execute("REVOKE ALL ON ai.audit_log FROM ai_app")
    op.execute("GRANT INSERT ON ai.audit_log TO ai_app")


def downgrade() -> None:
    """按依赖的反向顺序删除本迁移建的对象。"""
    op.execute("DROP VIEW IF EXISTS ai.v_chunk_permission_drift")
    op.execute("DROP TABLE IF EXISTS ai.eval_results")
    op.execute("DROP TABLE IF EXISTS ai.eval_runs")
    op.execute("DROP TABLE IF EXISTS ai.audit_log")
    op.execute("DROP TABLE IF EXISTS ai.messages")
    op.execute("DROP TABLE IF EXISTS ai.runs")
    op.execute("DROP TABLE IF EXISTS ai.conversations")
