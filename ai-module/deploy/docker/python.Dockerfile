# Builds one Python service of the workspace: docker build --build-arg APP=api ...
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_HTTP_TIMEOUT=120 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY packages ./packages
COPY apps ./apps
COPY alembic.ini ./
COPY migrations ./migrations

ARG APP
RUN uv sync --frozen --no-dev --package "starit-${APP}"

ENV PATH="/app/.venv/bin:$PATH"
