"""文件：测试——数据库迁移与应用账号（集成）
测什么：迁移已应用；应用是以普通低权限账号 ai_app 连接的，不是库所有者。
前提：需要已迁移的 Postgres（make up && make migrate，或 CI 的服务）。
"""

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


async def test_migrations_applied(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        schemas = {row[0] for row in await conn.execute(text("SELECT nspname FROM pg_namespace"))}
        extensions = {
            row[0] for row in await conn.execute(text("SELECT extname FROM pg_extension"))
        }
    assert {"ai", "biz", "ai_sql", "ai_auth"} <= schemas
    assert "vector" in extensions


async def test_application_connects_as_an_ordinary_role(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        user, is_super = (
            await conn.execute(
                text(
                    "SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)"
                )
            )
        ).one()
    assert user == "ai_app"
    assert is_super is False
