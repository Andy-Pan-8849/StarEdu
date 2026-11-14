# 业务模块常用命令（在 business-module/ 下运行）
COMPOSE = docker compose --env-file .env -f deploy/compose/biz.yaml
COMPOSE_KAFKA = docker compose --env-file .env -f deploy/compose/biz.yaml -f deploy/compose/kafka.yaml

.PHONY: install up down logs migrate test lint typecheck smoke reset biz-up-kafka biz-down-kafka test-events

install:
	pnpm install

up:
	$(COMPOSE) up -d --wait

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail 100

migrate:
	pnpm migrate

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

# 可选的 Kafka 事件总线（单节点 KRaft）；用它时在 .env 里设 BIZ_EVENT_BUS=kafka
biz-up-kafka:
	$(COMPOSE_KAFKA) up -d --wait kafka

biz-down-kafka:
	$(COMPOSE_KAFKA) stop kafka

# 需要 Kafka 容器的测试（先 make biz-up-kafka）
test-events:
	pnpm test:events

# 冒烟：建一个临时租户域，验证令牌声明、密码策略、锁定参数、邮件到 Mailpit，然后移除该域
smoke:
	pnpm smoke

# 连本模块的本地数据卷一起清掉（Postgres、Redis、Keycloak、对象存储），不动 AI 模块
reset:
	$(COMPOSE_KAFKA) down --volumes
