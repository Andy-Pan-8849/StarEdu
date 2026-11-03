"""The object-storage client against the real S3-compatible service (make up)."""

import uuid

import pytest
from starit_core.config import get_settings
from starit_core.storage import S3Storage

pytestmark = pytest.mark.integration


@pytest.fixture
async def storage() -> S3Storage:
    settings = get_settings().model_copy(update={"s3_bucket": f"test-{uuid.uuid4().hex[:10]}"})
    client = S3Storage(settings)
    try:
        await client.ensure_bucket()
    except Exception:
        pytest.skip("object storage is not reachable")
    return client


async def test_put_and_get_round_trip(storage: S3Storage) -> None:
    await storage.put("documents/X/1.0/file.bin", b"\x00\x01 original bytes \xff")
    assert await storage.get("documents/X/1.0/file.bin") == b"\x00\x01 original bytes \xff"


async def test_ensure_bucket_can_run_twice(storage: S3Storage) -> None:
    await storage.ensure_bucket()
    await storage.put("a", b"1")
    assert await storage.get("a") == b"1"


async def test_a_missing_key_is_file_not_found(storage: S3Storage) -> None:
    with pytest.raises(FileNotFoundError):
        await storage.get("no/such/key")
