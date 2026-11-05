"""文件：migrations/env.py
作用：Alembic（数据库迁移工具）的运行环境。
主要思想：迁移是同步执行的，并且用“库所有者”账号（STARIT_MIGRATION_DATABASE_URL），
因为建表、建角色、授权需要所有者权限；应用日常运行用的是低权限的 ai_app 账号。
没有 SQLAlchemy 模型，迁移都是手写的 SQL，所以 target_metadata 为空。
离线模式只生成 SQL 文本，在线模式直接连库执行。
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool
from starit_core.config import get_settings

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# No SQLAlchemy models yet: migrations are written by hand, so there is no metadata.
target_metadata = None


def run_migrations_offline() -> None:
    """离线模式：不连数据库，把迁移 SQL 输出出来（参数按名字内联）。"""
    context.configure(
        url=get_settings().migration_database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：连数据库并在一个事务里执行迁移；连接池用 NullPool，用完即关。"""
    engine = create_engine(get_settings().migration_database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
