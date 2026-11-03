"""Fixtures shared by every test directory."""

import os
import subprocess
import sys
import uuid
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from sqlalchemy.engine import make_url
from starit_core.config import get_settings

AI_MODULE = Path(__file__).resolve().parent


@pytest.fixture(scope="module")
def scratch_urls() -> Iterator[tuple[str, str]]:
    """(owner URL, application URL) of a freshly migrated scratch database.

    Tests whose code commits its own transactions run here instead of in the dev database.
    """
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
