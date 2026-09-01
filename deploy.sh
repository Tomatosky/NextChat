#!/usr/bin/env bash

set -Eeuo pipefail

readonly NODE_IMAGE="node:22-bookworm-slim"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_DIR="${NEXTCHAT_REPO_DIR:-$SCRIPT_DIR}"
readonly DEPLOY_DIR="${NEXTCHAT_DEPLOY_DIR:-$HOME/docker/next-chat}"
readonly APP_DIR="$DEPLOY_DIR/app"
readonly COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
readonly COMPOSE_PROJECT="next-chat"

log() {
  printf '[NextChat] %s\n' "$*"
}

fail() {
  printf '[NextChat] 错误：%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

compose() {
  docker compose \
    --project-directory "$DEPLOY_DIR" \
    --project-name "$COMPOSE_PROJECT" \
    --file "$COMPOSE_FILE" \
    "$@"
}

wait_until_ready() {
  local status
  local attempt
  local probe_output=""

  for attempt in {1..30}; do
    status="$(docker inspect \
      --format '{{.State.Status}}' \
      next-chat 2>/dev/null || true)"

    case "$status" in
      running)
        if probe_output="$(docker exec next-chat node -e '
          (async () => {
            const response = await fetch("http://127.0.0.1:3000/api/config", {
              signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) {
              const body = await response.text();
              throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
            }
          })().catch((error) => {
            console.error(error.message);
            process.exit(1);
          });
        ' 2>&1)"; then
          return 0
        fi
        ;;
      exited | dead)
        log "容器状态异常：$status"
        return 1
        ;;
    esac

    sleep 2
  done

  log "应用健康检查超时，容器状态：${status:-不存在}"
  if [[ -n "$probe_output" ]]; then
    printf '[NextChat] 最后一次探测错误：%s\n' "$probe_output" >&2
  fi

  return 1
}

require_command git
require_command docker
docker compose version >/dev/null 2>&1 || fail "需要 Docker Compose 插件（docker compose）"

[[ -d "$REPO_DIR/.git" ]] || fail "源码目录不是 Git 仓库：$REPO_DIR"

mkdir -p -- "$DEPLOY_DIR"

[[ -f "$COMPOSE_FILE" ]] || \
  fail "找不到 $COMPOSE_FILE，请先用仓库根目录的 docker-compose.deploy.yml 替换它"
chmod 600 "$COMPOSE_FILE"

if [[ "${NEXTCHAT_DEPLOY_AFTER_PULL:-0}" != "1" ]]; then
  log "拉取最新代码"
  git -C "$REPO_DIR" pull --ff-only

  # 重新读取 git pull 后的脚本，确保本次部署使用最新逻辑。
  exec env NEXTCHAT_DEPLOY_AFTER_PULL=1 \
    NEXTCHAT_REPO_DIR="$REPO_DIR" \
    NEXTCHAT_DEPLOY_DIR="$DEPLOY_DIR" \
    bash "$REPO_DIR/deploy.sh"
fi

log "使用 $NODE_IMAGE 安装依赖并构建"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --env HUSKY=0 \
  --env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  --volume "$REPO_DIR:/workspace" \
  --workdir /workspace \
  "$NODE_IMAGE" \
  sh -lc 'corepack yarn install --frozen-lockfile && corepack yarn build'

[[ -f "$REPO_DIR/.next/standalone/server.js" ]] || \
  fail "构建完成，但未找到 .next/standalone/server.js"

stage_dir="$(mktemp -d "$DEPLOY_DIR/.app.new.XXXXXX")"
previous_dir="$DEPLOY_DIR/.app.previous.$(date +%Y%m%d%H%M%S)"
failed_dir=""

cleanup() {
  if [[ -n "${stage_dir:-}" && -d "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
  fi
}
trap cleanup EXIT

log "整理 standalone 运行产物"
cp -a "$REPO_DIR/.next/standalone/." "$stage_dir/"
mkdir -p \
  "$stage_dir/.next/cache" \
  "$stage_dir/.next/static" \
  "$stage_dir/.next/server" \
  "$stage_dir/public"
cp -a "$REPO_DIR/.next/static/." "$stage_dir/.next/static/"
cp -a "$REPO_DIR/.next/server/." "$stage_dir/.next/server/"
cp -a "$REPO_DIR/public/." "$stage_dir/public/"

if [[ -f "$REPO_DIR/app/mcp/mcp_config.default.json" ]]; then
  mkdir -p "$stage_dir/app/mcp"
  cp -a \
    "$REPO_DIR/app/mcp/mcp_config.default.json" \
    "$stage_dir/app/mcp/mcp_config.json"
fi

if [[ -e "$APP_DIR" || -L "$APP_DIR" ]]; then
  mv -- "$APP_DIR" "$previous_dir"
fi
mv -- "$stage_dir" "$APP_DIR"
stage_dir=""

log "重建 next-chat 容器"
if compose up --detach --force-recreate && wait_until_ready; then
  if [[ -d "$previous_dir" ]]; then
    rm -rf -- "$previous_dir"
  fi
  log "部署完成，next-chat 已通过健康检查"
  exit 0
fi

log "新版本启动失败，恢复上一版本"
compose logs --tail 100 next-chat >&2 || true
failed_dir="$DEPLOY_DIR/.app.failed.$(date +%Y%m%d%H%M%S)"
mv -- "$APP_DIR" "$failed_dir"

if [[ -d "$previous_dir" ]]; then
  mv -- "$previous_dir" "$APP_DIR"
  compose up --detach --force-recreate || true
  fail "部署失败，已恢复上一版本；失败产物保留在 $failed_dir"
fi

fail "首次部署启动失败；失败产物保留在 $failed_dir"
