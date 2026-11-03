"""Load sample-data/structured/*.csv into the biz schema (run with: make seed-biz)."""

from pathlib import Path

from sqlalchemy import create_engine
from starit_core.config import get_settings
from starit_core.seed_biz import load_biz

CSV_DIR = Path(__file__).resolve().parent.parent / "sample-data" / "structured"


def main() -> None:
    # Owner connection: the biz tables are not readable by the application role.
    engine = create_engine(get_settings().migration_database_url)
    with engine.begin() as conn:
        counts = load_biz(conn, CSV_DIR)
    print("loaded:", ", ".join(f"{table}={n}" for table, n in counts.items()))


if __name__ == "__main__":
    main()
