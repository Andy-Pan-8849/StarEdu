# 文件：Makefile
# 作用：开发者常用命令的入口（在 ai-module/ 目录里运行）。`make help` 列出全部命令。
# 分组：环境(env, sync) / 检查(lint, fmt, test, web-check, e2e) / 运行(up, down, logs, clean,
#   up-obs, up-langfuse) /
# 数据(migrate, seed, seed-dump, seed-biz, ingest-samples) / 评测(eval) / 其他(token)。
# COMPOSE 变量把几个 compose 文件叠加起来：核心 + 监控 + Langfuse。

# Developer commands for the AI module. Run from the ai-module/ directory.
COMPOSE = docker compose --env-file .env -f deploy/compose/compose.yaml
OBS = $(COMPOSE) -f deploy/compose/observability.yaml
LANGFUSE = $(OBS) -f deploy/compose/langfuse.yaml
# Every file, so `down` and `clean` also take away the optional parts.
EVERYTHING = $(LANGFUSE)

.PHONY: seed seed-dump up-obs up-langfuse help env sync lint fmt test up down logs migrate seed-biz ingest-samples eval ps token clean web-install web-dev web-check e2e

help:
	@echo "make env      create .env from .env.example if missing"
	@echo "make sync     install Python dependencies (uv)"
	@echo "make lint     ruff + mypy"
	@echo "make up-obs    also start traces and metrics (Collector, Tempo, Prometheus, Grafana)"
	@echo "make up-langfuse  up-obs plus Langfuse (heavy)"
	@echo "make web-dev  run the front end on port 3000 (needs make up for the API)"
	@echo "make web-check  front end: lint, types, tests, build"
	@echo "make e2e      browser smoke tests (needs make up)"
	@echo "make fmt      format code with ruff"
	@echo "make test     run tests (integration tests need make up + make migrate)"
	@echo "make up       start Postgres, Redis, object storage and the API"
	@echo "make migrate  apply database migrations (as the database owner)"
	@echo "make seed      business tables + knowledge base from the dump (no model key) + original files"
	@echo "make seed-dump  write the knowledge base to seed/ai-seed.jsonl.gz (after a real ingestion)"
	@echo "make seed-biz load the sample business tables (sample-data/structured) into the biz schema"
	@echo "make token ACCOUNT=staff.sh   print an access token for a demo account"
	@echo "make ingest-samples [ARGS=--wait]   register and queue the 28 sample documents (the worker container processes them)"
	@echo "make eval ARGS=\"retrieval --all-modes\"   run the retrieval evaluation (prints the estimated cost and asks first)"
	@echo "make down     stop the services (data volumes are kept)"
	@echo "make clean    stop the services AND delete their data volumes"

env:
	@test -f .env || cp .env.example .env

sync:
	uv sync --all-packages

lint:
	uv run ruff check .
	uv run ruff format --check .
	uv run mypy packages apps eval

fmt:
	uv run ruff check --fix .
	uv run ruff format .

test:
	uv run pytest

web-install:
	cd web && npm ci

web-dev:
	cd web && npm run dev

web-check:
	cd web && npm run lint && npm run typecheck && npm run format:check && npm test && npm run build

# The worker is switched to fake embeddings for the run (an upload costs nothing), then back.
e2e: env
	EMBEDDING_PROVIDER=fake $(COMPOSE) up -d --force-recreate worker
	cd web && npx playwright install chromium && npm run e2e; status=$$?; \
	  cd .. && $(COMPOSE) up -d --force-recreate worker; exit $$status

up: env
	$(COMPOSE) up -d --build --wait

migrate: env
	set -a; . ./.env; set +a; uv run alembic upgrade head

seed-biz: env
	set -a; . ./.env; set +a; uv run python scripts/seed_biz.py

seed: env
	set -a; . ./.env; set +a; uv run python scripts/seed.py $(ARGS)

seed-dump: env
	set -a; . ./.env; set +a; uv run python scripts/seed_dump.py

ingest-samples: env
	set -a; . ./.env; set +a; uv run python scripts/ingest_samples.py $(ARGS)

eval: env
	set -a; . ./.env; set +a; uv run starit-eval $(ARGS)

up-obs: env
	$(OBS) up -d --build --wait

up-langfuse: env
	$(LANGFUSE) up -d --build --wait

down: env
	$(EVERYTHING) down

ps: env
	$(COMPOSE) ps

logs: env
	$(COMPOSE) logs -f --tail=100

token: env
	@set -a; . ./.env; set +a; scripts/token.sh $(ACCOUNT)

clean: env
	$(EVERYTHING) down -v
