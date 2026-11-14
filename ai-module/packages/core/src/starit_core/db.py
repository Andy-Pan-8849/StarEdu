"""文件：db.py
作用：创建异步数据库引擎，并提供健康检查。
应用只用低权限账号 `ai_app` 连接（见 README 的“数据库账号”）；迁移和播种用库所有者账号。
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from starit_core.config import Settings


def create_engine(settings: Settings) -> AsyncEngine:
    """按配置创建异步引擎；pool_pre_ping 让失效的连接在使用前被发现并换掉。"""
    return create_async_engine(settings.database_url, pool_pre_ping=True)


async def check_database(engine: AsyncEngine) -> bool:
    """执行一条最简单的查询，数据库能回答返回 True。给 /healthz 使用。"""
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        return False
    return True


def create_business_engine(settings: Settings) -> AsyncEngine:
    """业务模式下读业务库的引擎：登录角色 ai_reader；
    每次查询在事务里写入身份设置后切到 ai_sql_ro。
    """
    return create_async_engine(settings.business_database_url, pool_pre_ping=True)
