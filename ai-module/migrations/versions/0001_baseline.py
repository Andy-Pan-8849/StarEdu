"""Baseline: pgvector extension and the ai / biz schemas.

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
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    # ai: tables owned by the AI module (see docs/design/02-data-model.md)
    op.execute("CREATE SCHEMA IF NOT EXISTS ai")
    # biz: seed business data that the read-only SQL tools query
    op.execute("CREATE SCHEMA IF NOT EXISTS biz")


def downgrade() -> None:
    op.execute("DROP SCHEMA IF EXISTS biz")
    op.execute("DROP SCHEMA IF EXISTS ai")
