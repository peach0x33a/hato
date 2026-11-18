#!/usr/bin/env bash
set -euo pipefail

# Hato 安装脚本（支持临时启用中国镜像源，不修改全局 npm 配置）

CN_MIRROR="${HATO_CN_MIRROR:-0}"
TARGET_DIR=""
SKIP_SETUP=0
WITH_PLAYWRIGHT=0
INSTALL_BIN=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
用法: bash scripts/install.sh [选项]

选项:
  --cn, --mirror       临时使用中国镜像源 (npmmirror) 安装依赖，不修改全局 ~/.npmrc
  --dir <path>         将 Hato 安装/复制到指定目录（默认在当前项目/发行包目录就地安装）
  --with-playwright    同时安装 Playwright Chromium 浏览器内核
  --skip-setup         跳过安装后的交互式配置向导 (setup)
  --no-bin             不在 ~/.local/bin/hato 创建快捷启动脚本
  -h, --help           显示此帮助信息

环境变量:
  HATO_CN_MIRROR=1     等效于 --cn
  HATO_HOME=<path>     自定义配置与数据目录（默认 ~/.hato）
EOF
}

log_info()  { printf '\033[1;34m[Hato]\033[0m %s\n' "$*"; }
log_ok()    { printf '\033[1;32m[Hato]\033[0m %s\n' "$*"; }
log_warn()  { printf '\033[1;33m[Hato]\033[0m %s\n' "$*"; }
log_err()   { printf '\033[1;31m[Hato]\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cn|--mirror)
      CN_MIRROR=1
      shift
      ;;
    --dir)
      if [[ $# -lt 2 ]]; then
        log_err "--dir 需要指定目标路径"
        exit 1
      fi
      TARGET_DIR="$2"
      shift 2
      ;;
    --with-playwright)
      WITH_PLAYWRIGHT=1
      shift
      ;;
    --skip-setup)
      SKIP_SETUP=1
      shift
      ;;
    --no-bin)
      INSTALL_BIN=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_err "未知参数: $1"
      usage
      exit 1
      ;;
  esac
done

# 1. 检查 Node.js >= 22 与 npm
if ! command -v node >/dev/null 2>&1; then
  log_err "未检测到 node，请先安装 Node.js >= 22.0.0"
  exit 1
fi

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 22 ]]; then
  log_err "当前 Node.js 版本为 v${NODE_VERSION}，Hato 需要 Node.js >= 22.0.0"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  log_err "未检测到 npm，请确认 Node.js 安装完整"
  exit 1
fi

log_info "检测到 Node.js v${NODE_VERSION} / npm $(npm -v)"

# 检查原生模块编译工具链（仅提示，不强制阻塞，因为多数平台可直接命中预编译包）
if ! command -v python3 >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
  log_warn "未检测到完整的 python3 / make 编译工具链；若 better-sqlite3 无预编译包，可能需要安装 Xcode CLT (macOS) 或 build-essential (Linux)"
fi

# 2. 配置临时中国镜像源（仅作用于当前脚本子进程，不写入 ~/.npmrc）
if [[ "$CN_MIRROR" == "1" ]]; then
  export npm_config_registry="https://registry.npmmirror.com"
  export npm_config_better_sqlite3_binary_host_mirror="https://npmmirror.com/mirrors/better-sqlite3"
  export PLAYWRIGHT_DOWNLOAD_HOST="https://npmmirror.com/mirrors/playwright"
  log_info "已临时启用中国镜像源 (npmmirror)，本次安装结束后自动失效"
fi

# 3. 确定安装目录
INSTALL_DIR="$SOURCE_ROOT"
if [[ -n "$TARGET_DIR" ]]; then
  mkdir -p "$TARGET_DIR"
  TARGET_ABS="$(cd "$TARGET_DIR" && pwd)"
  if [[ "$TARGET_ABS" != "$SOURCE_ROOT" ]]; then
    log_info "正在同步文件至目标目录: ${TARGET_ABS}"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --delete \
        --exclude 'node_modules' \
        --exclude 'web/node_modules' \
        --exclude '.git' \
        --exclude 'data' \
        --exclude 'release' \
        --exclude '.env' \
        --exclude 'config/hato.toml' \
        --exclude 'config/models.toml' \
        --exclude 'config/mcp.toml' \
        "${SOURCE_ROOT}/" "${TARGET_ABS}/"
    else
      cp -R "${SOURCE_ROOT}/." "${TARGET_ABS}/"
      rm -rf "${TARGET_ABS}/node_modules" "${TARGET_ABS}/web/node_modules" "${TARGET_ABS}/.git" "${TARGET_ABS}/data" "${TARGET_ABS}/release"
    fi
  fi
  INSTALL_DIR="$TARGET_ABS"
fi

cd "$INSTALL_DIR"

# 4. 安装依赖（区分预编译发行包模式与源码构建模式）
IS_RELEASE_BUNDLE=0
if [[ -f "${INSTALL_DIR}/dist/main.js" && -f "${INSTALL_DIR}/web/dist/index.html" && ! -d "${INSTALL_DIR}/src" ]]; then
  IS_RELEASE_BUNDLE=1
fi

if [[ "$IS_RELEASE_BUNDLE" == "1" ]]; then
  log_info "检测到预编译发行包，正在安装生产依赖..."
  if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
else
  log_info "检测到源码目录，正在安装依赖并构建前后端..."
  if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
    npm ci
  else
    npm install
  fi
  if [[ -f "${INSTALL_DIR}/web/package.json" ]]; then
    if [[ -f "${INSTALL_DIR}/web/package-lock.json" ]]; then
      npm --prefix "${INSTALL_DIR}/web" ci
    else
      npm --prefix "${INSTALL_DIR}/web" install
    fi
    npm run build:web
  fi
  npm run build
fi

# 可选安装 Playwright 浏览器内核
if [[ "$WITH_PLAYWRIGHT" == "1" ]]; then
  log_info "正在安装 Playwright Chromium 内核..."
  npx playwright install chromium
fi

# 5. 初始化 ~/.hato 配置目录（不覆盖已有配置）
HATO_HOME_DIR="${HATO_HOME:-${HOME}/.hato}"
if [[ "$HATO_HOME_DIR" == ~* ]]; then
  HATO_HOME_DIR="${HOME}${HATO_HOME_DIR#\~}"
fi
mkdir -p "$HATO_HOME_DIR"

if [[ ! -f "${HATO_HOME_DIR}/.env" && -f "${INSTALL_DIR}/.env.example" ]]; then
  cp "${INSTALL_DIR}/.env.example" "${HATO_HOME_DIR}/.env"
  log_info "已初始化凭据模板: ${HATO_HOME_DIR}/.env"
fi

if [[ ! -f "${HATO_HOME_DIR}/mcp.toml" && -f "${INSTALL_DIR}/config/mcp.example.toml" ]]; then
  cp "${INSTALL_DIR}/config/mcp.example.toml" "${HATO_HOME_DIR}/mcp.toml"
  log_info "已初始化 MCP 模板: ${HATO_HOME_DIR}/mcp.toml"
fi

# 6. 可选创建 ~/.local/bin/hato 快捷启动脚本
if [[ -f "${INSTALL_DIR}/dist/cli/hato.js" ]]; then
  chmod +x "${INSTALL_DIR}/dist/cli/hato.js"
fi

if [[ "$INSTALL_BIN" == "1" ]]; then
  BIN_DIR="${HOME}/.local/bin"
  if mkdir -p "$BIN_DIR" 2>/dev/null; then
    BIN_PATH="${BIN_DIR}/hato"
    cat > "$BIN_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${INSTALL_DIR}/dist/cli/hato.js" "\$@"
EOF
    chmod +x "$BIN_PATH"
    log_ok "已创建快捷命令: ${BIN_PATH}（请确保 ${BIN_DIR} 已加入 PATH）"
  fi
fi

log_ok "Hato 安装完成！"

# 7. 引导运行交互式配置向导
if [[ "$SKIP_SETUP" == "0" ]]; then
  if [[ -t 0 && -t 1 ]]; then
    log_info "即将启动交互式配置向导 (setup)..."
    node "${INSTALL_DIR}/dist/cli/setup.js"
  else
    log_info "当前为非交互终端，请稍后手动执行: cd \"${INSTALL_DIR}\" && node dist/cli/setup.js"
  fi
else
  log_info "已跳过配置向导。启动前请先配置 ${HATO_HOME_DIR} 或运行: node \"${INSTALL_DIR}/dist/cli/setup.js\""
fi
