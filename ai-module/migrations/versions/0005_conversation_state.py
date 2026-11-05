"""会话状态：助手是否正在等用户澄清一个问题。

文件：migrations/versions/0005_conversation_state.py
作用：给 conversations 加三列——session_mode（answering 正常 / need_clarification 在等澄清）、
pending_question（等待澄清的原问题）、clarify_count（已反问几次）。
助手据此实现“只反问一次”，并把用户下一句话与原问题合并。

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-03
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """给会话表加澄清状态的三列。"""
    op.execute(
        """
        ALTER TABLE ai.conversations
            ADD COLUMN session_mode text NOT NULL DEFAULT 'answering'
                CHECK (session_mode IN ('answering', 'need_clarification')),
            ADD COLUMN pending_question text,
            ADD COLUMN clarify_count int NOT NULL DEFAULT 0
        """
    )


def downgrade() -> None:
    """删除这三列。"""
    op.execute(
        "ALTER TABLE ai.conversations DROP COLUMN clarify_count, "
        "DROP COLUMN pending_question, DROP COLUMN session_mode"
    )
