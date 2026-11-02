# Developer commands for the AI module. Run from the ai-module/ directory.
COMPOSE = docker compose --env-file .env -f deploy/compose/compose.yaml

.PHONY: help env sync lint fmt test up down logs migrate ps token clean

help:
	@echo "make env      create .env from .env.example if missing"
	@echo "make sync     install Python dependencies (uv)"
	@echo "make lint     ruff + mypy"
	@echo "make fmt      format code with ruff"
	@echo "make test     run tests (integration tests need make up + make migrate)"
	@echo "make up       start Postgres, Redis, object storage and the API"
	@echo "make migrate  apply database migrations"
	@echo "make token ACCOUNT=staff.sh   print an access token for a demo account"
	@echo "make down     stop the services (data volumes are kept)"
	@echo "make clean    stop the services AND delete their data volumes"

env:
	@test -f .env || cp .env.example .env

sync:
	uv sync --all-packages

lint:
	uv run ruff check .
	uv run ruff format --check .
	uv run mypy packages apps

fmt:
	uv run ruff check --fix .
	uv run ruff format .

test:
	uv run pytest

up: env
	$(COMPOSE) up -d --build --wait

migrate: env
	set -a; . ./.env; set +a; uv run alembic upgrade head

down: env
	$(COMPOSE) down

ps: env
	$(COMPOSE) ps

logs: env
	$(COMPOSE) logs -f --tail=100

token: env
	@set -a; . ./.env; set +a; scripts/token.sh $(ACCOUNT)

clean: env
	$(COMPOSE) down -v
