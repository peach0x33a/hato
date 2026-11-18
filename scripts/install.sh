#!/usr/bin/env bash
set -euo pipefail

# Hato 安装脚本（Bun 运行时，支持 curl 一键安装与临时中国镜像源）

CN_MIRROR="${HATO_CN_MIRROR:-0}"
TARGET_DIR=""
VERSION="${HATO_VERSION:-}"
RELEASE_BASE_URL="${HATO_RELEASE_BASE_URL:-}"
SKIP_SETUP=0
WITH_PLAYWRIGHT=0
INSTALL_BIN=1

REPO_SLUG="peach0x33a/hato"
DEFAULT_INSTALL_DIR="${HOME}/.local/share/hato"

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SOURCE_ROOT=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

usage() {
  cat <<'EOF'
用法:
  bash scripts/install.sh [选项]
  curl -fsSL https://raw.githubusercontent.com/peach0x33a/hato/main/scripts/install.sh | bash -s -- [选项]

选项:
  --cn, --mirror            临时使用中国镜像源 (npmmirror) 安装依赖，不修改全局配置
  --dir <path>              指定安装目标目录（curl 安装默认 ~/.local/share/hato）
  --version <tag>           指定要下载的发行版标签（如 v0.1.0 或 nightly，默认获取 latest）
  --nightly                 安装最新的 nightly 预览版（等效于 --version nightly）
  --release-url <base_url>  自定义发行版下载基础 URL（可用于镜像加速）
  --with-playwright         同时安装 Playwright Chromium 浏览器内核
  --skip-setup              跳过安装后的交互式配置向导 (setup)
  --no-bin                  不在 ~/.local/bin/hato 创建快捷启动脚本
  -h, --help                显示此帮助信息

环境变量:
  HATO_CN_MIRROR=1          等效于 --cn
  HATO_VERSION=<tag>        等效于 --version
  HATO_RELEASE_BASE_URL     等效于 --release-url
  HATO_HOME=<path>          自定义配置与数据目录（默认 ~/.hato）
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
    --version)
      if [[ $# -lt 2 ]]; then
        log_err "--version 需要指定版本号"
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --nightly)
      VERSION="nightly"
      shift
      ;;
    --release-url)
      if [[ $# -lt 2 ]]; then
        log_err "--release-url 需要指定基础 URL"
        exit 1
      fi
      RELEASE_BASE_URL="$2"
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

# 1. 检查 Bun 运行时
if ! command -v bun >/dev/null 2>&1; then
  log_err "未检测到 bun，请先安装 Bun（https://bun.sh）: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

BUN_VERSION="$(bun --version)"
log_info "检测到 Bun v${BUN_VERSION}"

# 2. 配置临时中国镜像源（仅作用于当前脚本子进程，不写入全局配置文件）
if [[ "$CN_MIRROR" == "1" ]]; then
  export npm_config_registry="https://registry.npmmirror.com"
  export BUN_CONFIG_REGISTRY="https://registry.npmmirror.com"
  export PLAYWRIGHT_DOWNLOAD_HOST="https://npmmirror.com/mirrors/playwright"
  log_info "已临时启用中国镜像源 (npmmirror)，本次安装结束后自动失效"
fi

# 3. 判断是本地仓库/发行包执行，还是远程 curl 一键安装
TMP_DOWNLOAD_DIR=""
cleanup() {
  if [[ -n "$TMP_DOWNLOAD_DIR" && -d "$TMP_DOWNLOAD_DIR" ]]; then
    rm -rf "$TMP_DOWNLOAD_DIR"
  fi
}
trap cleanup EXIT

HAS_LOCAL_SOURCE=0
if [[ -n "$SOURCE_ROOT" && -f "${SOURCE_ROOT}/package.json" ]]; then
  HAS_LOCAL_SOURCE=1
fi

if [[ "$HAS_LOCAL_SOURCE" == "0" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    log_err "远程安装需要 curl，请先安装 curl"
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    log_err "远程安装需要 tar，请先安装 tar"
    exit 1
  fi

  if [[ -z "$VERSION" ]]; then
    log_info "正在查询最新发行版本..."
    VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
    if [[ -z "$VERSION" ]]; then
      VERSION="v0.1.0"
      log_warn "未能从 GitHub API 获取最新版本，回退至 ${VERSION}"
    fi
  fi
  if [[ "$VERSION" =~ ^[0-9] ]]; then
    TAG="v${VERSION}"
  else
    TAG="$VERSION"
  fi
  ARCHIVE_NAME="hato-${TAG}.tar.gz"
  BASE_URL="${RELEASE_BASE_URL:-https://github.com/${REPO_SLUG}/releases/download/${TAG}}"
  DOWNLOAD_URL="${BASE_URL%/}/${ARCHIVE_NAME}"

  TMP_DOWNLOAD_DIR="$(mktemp -d)"
  log_info "正在下载发行包: ${DOWNLOAD_URL}"
  curl -fL --progress-bar "$DOWNLOAD_URL" -o "${TMP_DOWNLOAD_DIR}/${ARCHIVE_NAME}"
  tar -xzf "${TMP_DOWNLOAD_DIR}/${ARCHIVE_NAME}" -C "$TMP_DOWNLOAD_DIR"

  SOURCE_ROOT="${TMP_DOWNLOAD_DIR}/hato-${TAG}"
  if [[ ! -f "${SOURCE_ROOT}/package.json" ]]; then
    log_err "解压后的发行包缺少 package.json: ${SOURCE_ROOT}"
    exit 1
  fi

  if [[ -z "$TARGET_DIR" ]]; then
    TARGET_DIR="$DEFAULT_INSTALL_DIR"
  fi
fi

# 4. 确定安装目录并同步文件
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

# 5. 安装依赖（区分预编译发行包模式与源码构建模式）
IS_RELEASE_BUNDLE=0
if [[ -f "${INSTALL_DIR}/web/dist/index.html" && ! -d "${INSTALL_DIR}/web/src" ]]; then
  IS_RELEASE_BUNDLE=1
fi

if [[ "$IS_RELEASE_BUNDLE" == "1" ]]; then
  log_info "检测到发行包，正在安装生产依赖..."
  if [[ -f "${INSTALL_DIR}/bun.lock" ]]; then
    bun install --frozen-lockfile --production
  else
    bun install --production
  fi
else
  log_info "检测到源码目录，正在安装依赖并构建 Web Console..."
  if [[ -f "${INSTALL_DIR}/bun.lock" ]]; then
    bun install --frozen-lockfile
  else
    bun install
  fi
  if [[ -f "${INSTALL_DIR}/web/package.json" ]]; then
    bun install --cwd "${INSTALL_DIR}/web"
    bun run build:web
  fi
fi

if [[ "$WITH_PLAYWRIGHT" == "1" ]]; then
  log_info "正在安装 Playwright Chromium 内核..."
  bunx playwright install chromium
fi

# 6. 初始化 ~/.hato 配置目录（不覆盖已有配置）
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

# 7. 创建全局快捷命令 ~/.local/bin/hato
if [[ -f "${INSTALL_DIR}/src/cli/hato.ts" ]]; then
  chmod +x "${INSTALL_DIR}/src/cli/hato.ts"
fi

if [[ "$INSTALL_BIN" == "1" ]]; then
  BIN_DIR="${HOME}/.local/bin"
  if mkdir -p "$BIN_DIR" 2>/dev/null; then
    BIN_PATH="${BIN_DIR}/hato"
    cat > "$BIN_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec bun "${INSTALL_DIR}/src/cli/hato.ts" "\$@"
EOF
    chmod +x "$BIN_PATH"
    log_ok "已创建快捷命令: ${BIN_PATH}（请确保 ${BIN_DIR} 已加入 PATH）"
  fi
fi

log_ok "Hato 安装完成！"

# 8. 引导运行交互式配置向导
if [[ "$SKIP_SETUP" == "0" ]]; then
  if [[ -t 1 && ( -t 0 || -r /dev/tty ) ]]; then
    log_info "即将启动交互式配置向导 (hato setup)..."
    bun "${INSTALL_DIR}/src/cli/hato.ts" setup </dev/tty
  else
    log_info "当前为非交互终端，请稍后手动执行: bun \"${INSTALL_DIR}/src/cli/hato.ts\" setup"
  fi
else
  log_info "已跳过配置向导。启动前请先运行: bun \"${INSTALL_DIR}/src/cli/hato.ts\" setup"
fi
