"""Conversation state: whether the assistant is waiting for the user to clarify a question.

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
    op.execute(
        "ALTER TABLE ai.conversations DROP COLUMN clarify_count, "
        "DROP COLUMN pending_question, DROP COLUMN session_mode"
    )
