#!/usr/bin/env bash
set -euo pipefail

# Hato 发行版打包脚本（Bun 运行时）：类型检查 -> 测试 -> 构建 Web Console -> 打包最小归档并生成 SHA256SUMS

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${1:-$(bun -e "console.log(require('./package.json').version)")}"
if [[ "$VERSION" =~ ^[0-9] ]]; then
  TAG="v${VERSION}"
else
  TAG="$VERSION"
fi
ARCHIVE_NAME="hato-${TAG}.tar.gz"
RELEASE_DIR="${ROOT_DIR}/release"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

echo "[release] 目标版本: ${TAG}"

echo "[release] 1/4 类型检查..."
bun run typecheck

echo "[release] 2/4 运行自动化测试..."
bun test --timeout 20000 tests/

echo "[release] 3/4 构建 Web Console..."
bun run build:web

echo "[release] 4/4 组装发行版文件并生成校验..."
PKG_DIR="${STAGE_DIR}/hato-${TAG}"
mkdir -p "${PKG_DIR}/config" "${PKG_DIR}/scripts" "${PKG_DIR}/web"

cp -R "${ROOT_DIR}/src" "${PKG_DIR}/src"
cp -R "${ROOT_DIR}/web/dist" "${PKG_DIR}/web/dist"
cp -R "${ROOT_DIR}/prompts" "${PKG_DIR}/prompts"

cp "${ROOT_DIR}/package.json" "${PKG_DIR}/package.json"
if [[ -f "${ROOT_DIR}/bun.lock" ]]; then
  cp "${ROOT_DIR}/bun.lock" "${PKG_DIR}/bun.lock"
fi
cp "${ROOT_DIR}/tsconfig.json" "${PKG_DIR}/tsconfig.json"
cp "${ROOT_DIR}/README.md" "${PKG_DIR}/README.md"
cp "${ROOT_DIR}/.env.example" "${PKG_DIR}/.env.example"
cp "${ROOT_DIR}/config/mcp.example.toml" "${PKG_DIR}/config/mcp.example.toml"
cp "${ROOT_DIR}/scripts/install.sh" "${PKG_DIR}/scripts/install.sh"
chmod +x "${PKG_DIR}/scripts/install.sh"
chmod +x "${PKG_DIR}/src/cli/hato.ts"

if [[ -f "${ROOT_DIR}/docs/architecture.md" ]]; then
  mkdir -p "${PKG_DIR}/docs"
  cp "${ROOT_DIR}/docs/architecture.md" "${PKG_DIR}/docs/architecture.md"
fi

mkdir -p "$RELEASE_DIR"
tar -czf "${RELEASE_DIR}/${ARCHIVE_NAME}" -C "$STAGE_DIR" "hato-${TAG}"

if command -v shasum >/dev/null 2>&1; then
  (cd "$RELEASE_DIR" && shasum -a 256 "${ARCHIVE_NAME}" > SHA256SUMS)
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$RELEASE_DIR" && sha256sum "${ARCHIVE_NAME}" > SHA256SUMS)
fi

echo "[release] 发行版生成完成:"
ls -lh "${RELEASE_DIR}/${ARCHIVE_NAME}" "${RELEASE_DIR}/SHA256SUMS"
