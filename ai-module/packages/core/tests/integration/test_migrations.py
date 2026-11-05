"""文件：测试——迁移
测什么：迁移能在空库上应用、能退回、能再次应用（可逆且可重复）。
"""

import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from sqlalchemy.engine import make_url
from starit_core.config import get_settings

pytestmark = pytest.mark.integration

AI_MODULE = Path(__file__).resolve().parents[4]


def alembic(url: str, *args: str) -> None:
    env = {**os.environ, "STARIT_MIGRATION_DATABASE_URL": url}
    subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=AI_MODULE, env=env, check=True, capture_output=True, text=True,
    )  # fmt: skip


def test_upgrade_downgrade_upgrade_on_an_empty_database() -> None:
    owner = make_url(get_settings().migration_database_url)
    admin_dsn = owner.set(drivername="postgresql", database="postgres").render_as_string(False)
    scratch = f"scratch_{uuid.uuid4().hex[:8]}"
    try:
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            admin.execute(f'CREATE DATABASE "{scratch}"')
    except psycopg.OperationalError:
        pytest.skip("database is not reachable")

    sqlalchemy_url = owner.set(database=scratch).render_as_string(False)
    url = owner.set(drivername="postgresql", database=scratch).render_as_string(False)
    try:
        alembic(sqlalchemy_url, "upgrade", "head")
        alembic(sqlalchemy_url, "downgrade", "0001")
        alembic(sqlalchemy_url, "upgrade", "head")
        with psycopg.connect(url) as conn:
            tables = {
                r[0]
                for r in conn.execute(
                    "SELECT schemaname || '.' || tablename FROM pg_tables "
                    "WHERE schemaname IN ('ai', 'biz')"
                )
            }
        assert {"ai.documents", "ai.document_chunks", "ai.audit_log", "biz.employees"} <= tables
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{scratch}" WITH (FORCE)')
