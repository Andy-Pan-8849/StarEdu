"""文件：ingest/business_events.py
作用：订阅业务模块的 Kafka 主题 business.events，把"课程大纲/课件清单变了"的事件交给
BusinessKnowledgeSync 同步进知识库。AI 模块是一个独立的消费组（<前缀>.ai-knowledge），
和业务模块自己的通知消费组各读一遍，互不影响。
可靠性：处理完才提交偏移（崩溃会重复处理，同步本身是幂等的：内容没变就不动）；一条消息处理失败
重试几次，仍失败就连同原因发到死信主题 business.events.dlq，继续处理后面的，不卡住。
"""

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

from confluent_kafka import Consumer, KafkaError, Message, Producer

from starit_core.business_knowledge import HANDLED_TYPES, BusinessKnowledgeSync
from starit_core.config import Settings

log = logging.getLogger("starit.business-events")


def topics(settings: Settings) -> tuple[str, str]:
    """（业务事件主题, 死信主题）。"""
    prefix = settings.kafka_topic_prefix
    return f"{prefix}business.events", f"{prefix}business.events.dlq"


async def handle_message(
    raw: bytes | None,
    sync: BusinessKnowledgeSync,
    dead_letter: Callable[[bytes | None, str], None],
    *,
    attempts: int = 3,
    pause: float = 0.2,
) -> str:
    """处理一条消息，返回结果：synced / ignored / dead。

    格式不对的消息不重试，直接进死信；相关事件处理失败重试 attempts 次后进死信。
    """
    try:
        event: dict[str, Any] = json.loads((raw or b"").decode("utf-8"))
        if not (event.get("id") and event.get("type") and event.get("tenantId")):
            raise ValueError("not an event envelope")
    except ValueError as exc:
        dead_letter(raw, f"{exc}")
        return "dead"
    if event["type"] not in HANDLED_TYPES:
        return "ignored"
    last = ""
    for attempt in range(1, attempts + 1):
        try:
            await sync.handle(event)
            return "synced"
        except Exception as exc:
            last = str(exc)[:300] or exc.__class__.__name__
            if attempt < attempts:
                await asyncio.sleep(pause * attempt)
    dead_letter(raw, last)
    return "dead"


async def run_business_events(
    settings: Settings, sync: BusinessKnowledgeSync, *, stop: asyncio.Event | None = None
) -> None:
    """常驻的消费循环；stop 被设置后退出。Kafka 暂时不可用时 librdkafka 自己重连。"""
    topic, dlq = topics(settings)
    consumer = Consumer(
        {
            "bootstrap.servers": settings.kafka_brokers,
            "group.id": f"{settings.kafka_group_prefix}.ai-knowledge",
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
        }
    )
    producer = Producer({"bootstrap.servers": settings.kafka_brokers, "enable.idempotence": True})

    def dead_letter(raw: bytes | None, reason: str) -> None:
        log.warning("event sent to %s: %s", dlq, reason)
        body = json.dumps(
            {
                "raw": (raw or b"").decode("utf-8", "replace")[:4000],
                "error": reason,
                "source": {"topic": topic, "group": f"{settings.kafka_group_prefix}.ai-knowledge"},
            }
        )
        producer.produce(
            dlq, value=body.encode("utf-8"), headers=[("error", reason[:200].encode())]
        )
        producer.flush(10)

    consumer.subscribe([topic])
    stop = stop or asyncio.Event()
    try:
        while not stop.is_set():
            message: Message | None = await asyncio.to_thread(consumer.poll, 1.0)
            if message is None:
                continue
            error = message.error()
            if error is not None:
                if error.code() != KafkaError._PARTITION_EOF:
                    log.warning("kafka: %s", error)
                continue
            await handle_message(message.value(), sync, dead_letter)
            await asyncio.to_thread(consumer.commit, message=message, asynchronous=False)
    finally:
        consumer.close()
