"""文件：scripts/seed_biz.py
作用：把 sample-data/structured/*.csv 载入 biz 模式（make seed-biz）。
说明：用库所有者账号连接，因为应用账号对 biz 表没有任何权限；真正的读取走 ai_sql 视图。
"""

from pathlib import Path

from sqlalchemy import create_engine
from starit_core.config import get_settings
from starit_core.seed_biz import load_biz

CSV_DIR = Path(__file__).resolve().parent.parent / "sample-data" / "structured"


def main() -> None:
    # Owner connection: the biz tables are not readable by the application role.
    """清空并重新载入全部业务表，打印各表行数。"""
    engine = create_engine(get_settings().migration_database_url)
    with engine.begin() as conn:
        counts = load_biz(conn, CSV_DIR)
    print("loaded:", ", ".join(f"{table}={n}" for table, n in counts.items()))


if __name__ == "__main__":
    main()
