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
