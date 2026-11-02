"""Needs a migrated Postgres (make up && make migrate, or the CI service)."""

from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.config import get_settings
from starit_core.db import check_database, create_engine

pytestmark = pytest.mark.integration


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    engine = create_engine(get_settings())
    if not await check_database(engine):
        await engine.dispose()
        pytest.skip("database is not reachable")
    yield engine
    await engine.dispose()


async def test_baseline_migration_applied(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        schemas = {
            row[0]
            for row in await conn.execute(
                text("SELECT schema_name FROM information_schema.schemata")
            )
        }
        extensions = {
            row[0] for row in await conn.execute(text("SELECT extname FROM pg_extension"))
        }
    assert {"ai", "biz"} <= schemas
    assert "vector" in extensions
