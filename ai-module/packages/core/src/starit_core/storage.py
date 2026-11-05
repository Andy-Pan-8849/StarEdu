"""文件：storage.py
作用：原始文档的对象存储（S3 兼容；Compose 里用 MinIO）。
主要思想：上层只依赖 `ObjectStorage` 接口（建桶/存/取/删）；boto3 是同步库，
这里用 asyncio.to_thread 放到线程里，不阻塞事件循环。测试用 InMemoryStorage。
"""

import asyncio
from typing import Any, Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from starit_core.config import Settings


class ObjectStorage(Protocol):
    """对象存储接口：ensure_bucket 建桶，put 存，
    get 取（不存在抛 FileNotFoundError），delete 删。
    """

    async def ensure_bucket(self) -> None: ...

    async def put(self, key: str, data: bytes) -> None: ...

    async def get(self, key: str) -> bytes: ...

    async def delete(self, key: str) -> None: ...


class S3Storage:
    """用 boto3 访问 S3 兼容服务。path 寻址风格是为了兼容 MinIO。"""

    def __init__(self, settings: Settings) -> None:
        self._bucket = settings.s3_bucket
        self._client: Any = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            region_name="us-east-1",
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3}),
        )

    async def ensure_bucket(self) -> None:
        """桶不存在就创建（幂等）。"""
        await asyncio.to_thread(self._ensure_bucket)

    def _ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self._bucket)
        except ClientError:
            self._client.create_bucket(Bucket=self._bucket)

    async def put(self, key: str, data: bytes) -> None:
        await asyncio.to_thread(self._client.put_object, Bucket=self._bucket, Key=key, Body=data)

    async def get(self, key: str) -> bytes:
        """读取对象；键不存在统一转成 FileNotFoundError。"""
        try:
            response = await asyncio.to_thread(
                self._client.get_object, Bucket=self._bucket, Key=key
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                raise FileNotFoundError(key) from exc
            raise
        body: bytes = await asyncio.to_thread(response["Body"].read)
        return body

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._client.delete_object, Bucket=self._bucket, Key=key)


class InMemoryStorage:
    """内存实现，用于测试。"""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def ensure_bucket(self) -> None:
        return None

    async def put(self, key: str, data: bytes) -> None:
        self.objects[key] = data

    async def get(self, key: str) -> bytes:
        try:
            return self.objects[key]
        except KeyError:
            raise FileNotFoundError(key) from None

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)
