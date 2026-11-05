# 文件：deploy/docker/python.Dockerfile
# 作用：构建工作区里任意一个 Python 服务的镜像，用 --build-arg APP=api|worker|mcp-server
#   选择。
# 主要思想：先只拷各个 pyproject.toml 和 uv.lock 装依赖，再拷源码——只改代码时依赖那层走缓存，
# 不用重新下载所有包。用 uv 的 --frozen 严格按锁文件安装，保证每次构建的版本一致。

# Builds one Python service of the workspace: docker build --build-arg APP=api ...
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_HTTP_TIMEOUT=120 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first, from the manifests alone: this layer (and uv's download cache) is reused
# when only source code changes, so a rebuild does not download every package again.
COPY pyproject.toml uv.lock ./
COPY packages/core/pyproject.toml ./packages/core/pyproject.toml
COPY apps/api/pyproject.toml ./apps/api/pyproject.toml
COPY apps/worker/pyproject.toml ./apps/worker/pyproject.toml
COPY apps/mcp-server/pyproject.toml ./apps/mcp-server/pyproject.toml
COPY eval/pyproject.toml ./eval/pyproject.toml
ARG APP
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package "starit-${APP}"

COPY packages ./packages
COPY apps ./apps
COPY alembic.ini ./
COPY migrations ./migrations
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package "starit-${APP}"

ENV PATH="/app/.venv/bin:$PATH"
