"""Fixtures for tests that need the migrated Postgres (make up, or the CI service).

Each test runs as the database owner inside one transaction that is rolled back at the end,
so nothing is left behind. Inside it, `SET LOCAL ROLE ai_app` (or ai_sql_ro) gives exactly that
role's privileges, so grants can be tested without separate logins.
"""

from collections.abc import AsyncIterator, Callable
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from starit_core.auth import Identity
from starit_core.config import get_settings

AI_MODULE = Path(__file__).resolve().parents[4]
SAMPLE_DATA = AI_MODULE / "sample-data"


@pytest.fixture
async def owner_conn() -> AsyncIterator[AsyncConnection]:
    engine = create_async_engine(get_settings().migration_database_url)
    try:
        conn = await engine.connect()
    except Exception:
        await engine.dispose()
        pytest.skip("database is not reachable")
    transaction = await conn.begin()
    try:
        ready = (await conn.execute(text("SELECT to_regclass('ai_sql.employees')"))).scalar()
    except Exception:
        ready = None
    if ready is None:
        await transaction.rollback()
        await conn.close()
        await engine.dispose()
        pytest.skip("database is not migrated to head (make migrate)")
    try:
        yield conn
    finally:
        await transaction.rollback()
        await conn.close()
        await engine.dispose()


def _make_identity(
    roles: set[str] | frozenset[str],
    *,
    user_id: str = "user-1",
    campus_id: str | None = None,
    level: str | None = None,
    employee_id: str | None = None,
    student_id: str | None = None,
) -> Identity:
    return Identity(
        user_id=user_id,
        username=None,
        name=None,
        roles=frozenset(roles),
        campus_id=campus_id,
        level=level,
        employee_id=employee_id,
        student_id=student_id,
    )


@pytest.fixture
def make_identity() -> Callable[..., Identity]:
    return _make_identity


# --- a scratch database, for tests whose code commits its own transactions -------------------
# The ingestion pipeline and the worker commit as they go, so they cannot run inside the
# rolled-back transaction above. They run in a throwaway database instead.

import os  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import uuid  # noqa: E402
from collections.abc import Iterator  # noqa: E402

import psycopg  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncEngine  # noqa: E402


@pytest.fixture(scope="module")
def scratch_urls() -> Iterator[tuple[str, str]]:
    """(owner URL, application URL) of a freshly migrated scratch database."""
    settings = get_settings()
    owner = make_url(settings.migration_database_url)
    admin_dsn = owner.set(drivername="postgresql", database="postgres").render_as_string(False)
    name = f"scratch_{uuid.uuid4().hex[:8]}"
    try:
        with psycopg.connect(admin_dsn, autocommit=True, connect_timeout=3) as admin:
            admin.execute(f'CREATE DATABASE "{name}"')
    except psycopg.OperationalError:
        pytest.skip("database is not reachable")
    owner_url = owner.set(database=name).render_as_string(False)
    app_url = make_url(settings.database_url).set(database=name).render_as_string(False)
    try:
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=AI_MODULE,
            env={**os.environ, "STARIT_MIGRATION_DATABASE_URL": owner_url},
            check=True,
            capture_output=True,
            text=True,
        )
        yield owner_url, app_url
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture
async def engines(scratch_urls: tuple[str, str]) -> AsyncIterator[tuple[AsyncEngine, AsyncEngine]]:
    """(owner engine, application engine) on the scratch database, emptied before each test."""
    owner = create_async_engine(scratch_urls[0])
    app = create_async_engine(scratch_urls[1])
    async with owner.begin() as conn:
        await conn.execute(
            text("TRUNCATE ai.documents, ai.audit_log, ai.ingestion_jobs RESTART IDENTITY CASCADE")
        )
    try:
        yield owner, app
    finally:
        await owner.dispose()
        await app.dispose()
