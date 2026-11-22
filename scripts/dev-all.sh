#!/usr/bin/env bash
# 一键启动 / 停止 / 查看 StarEdu 的两个模块（业务模块 + AI 模块，业务模式）。
# One command to start, stop or check both StarEdu modules (business + AI, in business mode).
#
#   scripts/dev-all.sh start    准备配置 → 起容器 → 建表和登录域 → 装演示数据 → 后台启动三个网页/接口进程
#   scripts/dev-all.sh stop     停掉后台进程和两边的容器（数据卷保留）
#   scripts/dev-all.sh status   看端口、进程和容器
#   scripts/dev-all.sh wire     只做配置：补 .env、让两边共享同一个内部密钥、打开业务模式
#
# 在项目根目录运行；通常通过根目录的 Makefile：make start-all / stop-all / status。
# 可重复运行：已经做过的步骤会再做一遍但不会出错。日志在 .run/*.log，进程号在 .run/*.pid。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIZ="$ROOT/business-module"
AI="$ROOT/ai-module"
RUN="$ROOT/.run"
BIZ_ENV="$BIZ/.env"
AI_ENV="$AI/.env"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# 把 KEY=VALUE 写进 .env（已有的同名行先删掉再追加；不碰注释行）
set_kv() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  grep -v -E "^${key}=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# 读 .env 里的值（没有则为空）
get_kv() { grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

# 返回 0 表示这次新生成了业务模块的内部密钥
KEY_CREATED=0
wire() {
  say "Preparing .env files"
  [ -f "$BIZ_ENV" ] || cp "$BIZ/.env.example" "$BIZ_ENV"
  [ -f "$AI_ENV" ] || cp "$AI/.env.example" "$AI_ENV"

  local key
  key="$(get_kv "$BIZ_ENV" INTERNAL_API_KEY)"
  if [ -z "$key" ] || [ "$key" = "change-me" ]; then
    key="$(openssl rand -hex 24)"
    set_kv "$BIZ_ENV" INTERNAL_API_KEY "$key"
    KEY_CREATED=1
    echo "business-module/.env: INTERNAL_API_KEY generated"
  fi

  set_kv "$AI_ENV" STARIT_IDENTITY_MODE business
  set_kv "$AI_ENV" STARIT_OIDC_TENANT_ISSUER_BASE http://localhost:8180/realms
  set_kv "$AI_ENV" STARIT_BUSINESS_INTERNAL_KEY "$key"
  set_kv "$AI_ENV" STARIT_CORS_ORIGINS "http://localhost:3000,http://hq.localhost:3000,http://riverside-franchise.localhost:3000"
  echo "ai-module/.env: business mode on, same internal key as the business module"

  if [ -z "$(get_kv "$AI_ENV" OPENAI_API_KEY)" ]; then
    echo "NOTE: OPENAI_API_KEY in ai-module/.env is empty. Everything starts, but the AI assistant cannot answer until you fill it in."
  fi
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. See TRY-IT.md section 2."; }

up_pid() { # 进程是否还活着
  local f="$RUN/$1.pid"
  [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null
}

start_bg() { # 名字 目录 命令...
  local name="$1" dir="$2"; shift 2
  if up_pid "$name"; then echo "$name already running (pid $(cat "$RUN/$name.pid"))"; return; fi
  mkdir -p "$RUN"
  # 子 shell 里先 cd，再让进程自成进程组（set -m），这样 $! 就是进程组组长，stop 时可以整组结束
  (cd "$dir" && set -m && { nohup "$@" >"$RUN/$name.log" 2>&1 </dev/null & echo $! >"$RUN/$name.pid"; })
  echo "$name started (log: .run/$name.log)"
}

wait_http() { # 地址 名字 最长秒数
  local url="$1" name="$2" max="${3:-120}" i=0
  while [ "$i" -lt "$max" ]; do
    if curl -s -o /dev/null --max-time 3 "$url"; then echo "  $name is up"; return 0; fi
    sleep 2; i=$((i + 2))
  done
  echo "  $name did not answer within ${max}s; look at .run/ logs" >&2
  return 1
}

start() {
  need docker; need node; need pnpm; need uv; need curl; need openssl
  docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop first."
  wire

  say "Business module: containers, tables, login realm"
  (cd "$BIZ" && pnpm install && make up && pnpm migrate && pnpm realm)

  say "Business module: demo data"
  if [ "$KEY_CREATED" = 1 ]; then
    # 新密钥意味着之前开通的公司没有 AI 助手用的登录客户端；重置演示公司即可补上
    (cd "$BIZ" && pnpm seed && pnpm demo:reset)
  else
    (cd "$BIZ" && pnpm demo)
  fi

  say "AI module: containers, tables, sample knowledge base"
  (cd "$AI" && make sync && make up && make migrate && make seed)
  [ -d "$AI/web/node_modules" ] || (cd "$AI" && make web-install)

  say "Starting the three long-running processes"
  start_bg biz-api "$BIZ" pnpm dev:api
  start_bg biz-web "$BIZ" pnpm dev:web
  start_bg ai-web "$AI" make web-dev

  say "Waiting for them"
  local ok=0
  wait_http http://localhost:4000/healthz "business api (4000)" || ok=1
  wait_http http://hq.localhost:3001 "business web (3001)" || ok=1
  wait_http http://localhost:3000 "AI web (3000)" || ok=1
  summary
  return "$ok"
}

summary() {
  cat <<'TXT'

Ready. Open:
  Company back office   http://hq.localhost:3001            demo.teacher / demo.student1 ... (password in TRY-IT.md)
  Platform console      http://platform.localhost:3001/     demo.operator
  Mail (Mailpit)        http://localhost:8125
  Keycloak admin        http://localhost:8180               admin / admin
  AI assistant          click "AI assistant" in the back office

Stop everything:  make stop-all        Check state:  make status
TXT
}

stop() {
  say "Stopping background processes"
  for name in biz-api biz-web ai-web; do
    if up_pid "$name"; then
      kill -- "-$(cat "$RUN/$name.pid")" 2>/dev/null || kill "$(cat "$RUN/$name.pid")" 2>/dev/null || true
      echo "$name stopped"
    fi
    rm -f "$RUN/$name.pid"
  done
  say "Stopping containers (data volumes are kept)"
  (cd "$AI" && make down) || true
  (cd "$BIZ" && make down) || true
}

status() {
  for name in biz-api biz-web ai-web; do
    if up_pid "$name"; then echo "$name  running (pid $(cat "$RUN/$name.pid"))"; else echo "$name  not running"; fi
  done
  for pair in "4000 business-api" "3001 business-web" "3000 ai-web" "8180 keycloak(biz)" "8080 keycloak(ai)" "8000 ai-api"; do
    set -- $pair
    if curl -s -o /dev/null --max-time 2 "http://localhost:$1"; then echo "port $1  $2  answers"; else echo "port $1  $2  no answer"; fi
  done
  docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null | grep -E '^starit' || echo "(no starit containers)"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  wire) wire ;;
  *) echo "usage: scripts/dev-all.sh {start|stop|status|wire}" >&2; exit 2 ;;
esac
