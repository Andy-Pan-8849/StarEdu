"""Database roles and the knowledge-base tables (docs/design/02-data-model.md, section 2).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-02
"""

from alembic import op
from sqlalchemy import text
from starit_core.config import get_settings

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # ai_app: the ordinary account the application connects with. Only migrations use the owner.
    create_or_alter = conn.execute(
        text(
            "SELECT format("
            "CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_app') "
            "THEN 'ALTER ROLE ai_app LOGIN PASSWORD %L' "
            "ELSE 'CREATE ROLE ai_app LOGIN PASSWORD %L' END, CAST(:pw AS text))"
        ),
        {"pw": get_settings().app_db_password},
    ).scalar_one()
    op.execute(create_or_alter)
    # ai_sql_ro: cannot log in. The application switches to it (SET LOCAL ROLE) to run SQL
    # Agent queries, so those queries only ever see the whitelisted views.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_sql_ro') THEN
                CREATE ROLE ai_sql_ro NOLOGIN;
            END IF;
        END
        $$
        """
    )
    op.execute("GRANT ai_sql_ro TO ai_app")

    op.execute("GRANT USAGE ON SCHEMA ai TO ai_app")
    op.execute(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA ai "
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_app"
    )

    # array_to_string is only STABLE, which a generated column rejects. For text[] it is
    # deterministic, so this wrapper is declared IMMUTABLE.
    op.execute(
        """
        CREATE FUNCTION ai.text_array_join(text[]) RETURNS text
        LANGUAGE sql IMMUTABLE PARALLEL SAFE
        AS $$ SELECT array_to_string($1, ' ') $$
        """
    )

    op.execute(
        """
        CREATE TABLE ai.documents (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            doc_code        text NOT NULL,
            title           text NOT NULL,
            domain          text NOT NULL,
            version         text NOT NULL,
            status          text NOT NULL CHECK (status IN ('active', 'superseded', 'draft')),
            effective_date  date,
            access_level    text NOT NULL,
            allowed_roles   text[] NOT NULL DEFAULT '{}',
            allowed_users   text[] NOT NULL DEFAULT '{}',
            campus_scope    text[] NOT NULL DEFAULT '{all}',
            min_level_rank  smallint CHECK (min_level_rank BETWEEN 1 AND 7),
            object_key      text,
            format          text NOT NULL CHECK (format IN ('docx', 'pdf', 'md', 'txt')),
            content_hash    text,
            ingest_status   text NOT NULL DEFAULT 'queued'
                            CHECK (ingest_status IN ('queued', 'running', 'ready', 'failed')),
            uploaded_by     text,
            supersedes_id   uuid REFERENCES ai.documents (id),
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            UNIQUE (doc_code, version)
        )
        """
    )
    op.execute("CREATE INDEX documents_status_idx ON ai.documents (status)")

    op.execute(
        """
        CREATE TABLE ai.document_chunks (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id     uuid NOT NULL REFERENCES ai.documents (id) ON DELETE CASCADE,
            chunk_index     int NOT NULL,
            text            text NOT NULL,
            heading_path    text[] NOT NULL DEFAULT '{}',
            page            int,
            token_count     int NOT NULL DEFAULT 0,
            identifiers     text[] NOT NULL DEFAULT '{}',
            tsv             tsvector GENERATED ALWAYS AS (
                                to_tsvector('english'::regconfig,
                                            text || ' ' || ai.text_array_join(identifiers))
                            ) STORED,
            -- Copied from the document so retrieval filters one table (kept in step by
            -- starit_core.documents; ai.v_chunk_permission_drift lists any mismatch).
            allowed_roles   text[] NOT NULL,
            allowed_users   text[] NOT NULL DEFAULT '{}',
            campus_scope    text[] NOT NULL DEFAULT '{all}',
            min_level_rank  smallint,
            status          text NOT NULL,
            effective_date  date,
            doc_code        text NOT NULL,
            version         text NOT NULL,
            UNIQUE (document_id, chunk_index)
        )
        """
    )
    op.execute("CREATE INDEX chunks_tsv_idx ON ai.document_chunks USING gin (tsv)")
    op.execute("CREATE INDEX chunks_roles_idx ON ai.document_chunks USING gin (allowed_roles)")
    op.execute("CREATE INDEX chunks_campus_idx ON ai.document_chunks USING gin (campus_scope)")

    op.execute(
        """
        CREATE TABLE ai.chunk_embeddings (
            chunk_id    uuid PRIMARY KEY REFERENCES ai.document_chunks (id) ON DELETE CASCADE,
            model       text NOT NULL,
            dimensions  int NOT NULL,
            embedding   vector(1536) NOT NULL
        )
        """
    )

    op.execute(
        """
        CREATE TABLE ai.chunk_derived (
            id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            chunk_id  uuid NOT NULL REFERENCES ai.document_chunks (id) ON DELETE CASCADE,
            kind      text NOT NULL CHECK (kind IN ('summary', 'question', 'keyword')),
            text      text NOT NULL,
            tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, text)) STORED
        )
        """
    )
    op.execute("CREATE INDEX chunk_derived_chunk_idx ON ai.chunk_derived (chunk_id)")
    op.execute("CREATE INDEX chunk_derived_tsv_idx ON ai.chunk_derived USING gin (tsv)")

    op.execute(
        """
        CREATE TABLE ai.ingestion_jobs (
            id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id    uuid NOT NULL REFERENCES ai.documents (id) ON DELETE CASCADE,
            status         text NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
            stage          text CHECK (stage IN ('parse', 'chunk', 'derive', 'embed', 'write')),
            attempt        int NOT NULL DEFAULT 0,
            max_attempts   int NOT NULL DEFAULT 3,
            run_after      timestamptz NOT NULL DEFAULT now(),
            locked_by      text,
            locked_at      timestamptz,
            config         jsonb NOT NULL DEFAULT '{}',
            error_code     text,
            error_message  text,
            started_at     timestamptz,
            finished_at    timestamptz
        )
        """
    )
    op.execute("CREATE INDEX ingestion_jobs_claim_idx ON ai.ingestion_jobs (status, run_after)")

    # The tables above were created after the default privileges were set, but grant explicitly
    # as well so the result does not depend on the order of statements.
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai TO ai_app")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS ai.ingestion_jobs")
    op.execute("DROP TABLE IF EXISTS ai.chunk_derived")
    op.execute("DROP TABLE IF EXISTS ai.chunk_embeddings")
    op.execute("DROP TABLE IF EXISTS ai.document_chunks")
    op.execute("DROP TABLE IF EXISTS ai.documents")
    op.execute("DROP FUNCTION IF EXISTS ai.text_array_join(text[])")
    # Roles are cluster-wide, so they are kept: another database on the same server may use
    # them. Only this database's privileges are removed. Upgrading again re-uses the roles.
    op.execute("DROP OWNED BY ai_app")
    op.execute("DROP OWNED BY ai_sql_ro")
