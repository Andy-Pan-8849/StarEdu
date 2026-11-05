"""文件：packages/core/tests/integration/conftest.py
作用：需要已迁移 Postgres 的集成测试夹具（make up，或 CI 里的数据库服务）。
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
    # Start from an empty knowledge base even when the dev database holds ingested documents;
    # the rollback at the end brings them back.
    await conn.execute(text("DELETE FROM ai.documents"))
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


# The scratch database fixture (`scratch_urls`) is in the conftest.py at the root of ai-module.
# The ingestion pipeline and the worker commit as they go, so they cannot run inside the
# rolled-back transaction above. They run in a throwaway database instead.

from sqlalchemy.ext.asyncio import AsyncEngine  # noqa: E402


@pytest.fixture
async def engines(scratch_urls: tuple[str, str]) -> AsyncIterator[tuple[AsyncEngine, AsyncEngine]]:
    """(owner engine, application engine) on the scratch database, emptied before each test."""
    owner = create_async_engine(scratch_urls[0])
    app = create_async_engine(scratch_urls[1])
    async with owner.begin() as conn:
        await conn.execute(
            text(
                "TRUNCATE ai.documents, ai.audit_log, ai.ingestion_jobs, ai.conversations RESTART IDENTITY CASCADE"
            )
        )
    try:
        yield owner, app
    finally:
        await owner.dispose()
        await app.dispose()
