#!/usr/bin/env bash
set -euo pipefail

# Hato 发行版打包脚本：校验类型与测试 -> 构建前后端 -> 打包最小运行时归档并生成 SHA256SUMS

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${1:-$(node -p "require('./package.json').version")}"
TAG="v${VERSION#v}"
ARCHIVE_NAME="hato-${TAG}.tar.gz"
RELEASE_DIR="${ROOT_DIR}/release"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

echo "[release] 目标版本: ${TAG}"

echo "[release] 1/5 类型检查..."
npm run typecheck

echo "[release] 2/5 运行自动化测试..."
npm test

echo "[release] 3/5 构建后端与 Web Console..."
npm run build:web
npm run build

echo "[release] 4/5 组装发行版文件..."
PKG_DIR="${STAGE_DIR}/hato-${TAG}"
mkdir -p "${PKG_DIR}/config" "${PKG_DIR}/scripts"

cp -R "${ROOT_DIR}/dist" "${PKG_DIR}/dist"
mkdir -p "${PKG_DIR}/web"
cp -R "${ROOT_DIR}/web/dist" "${PKG_DIR}/web/dist"
cp -R "${ROOT_DIR}/prompts" "${PKG_DIR}/prompts"

cp "${ROOT_DIR}/package.json" "${PKG_DIR}/package.json"
if [[ -f "${ROOT_DIR}/package-lock.json" ]]; then
  cp "${ROOT_DIR}/package-lock.json" "${PKG_DIR}/package-lock.json"
fi
cp "${ROOT_DIR}/README.md" "${PKG_DIR}/README.md"
cp "${ROOT_DIR}/.env.example" "${PKG_DIR}/.env.example"
cp "${ROOT_DIR}/config/mcp.example.toml" "${PKG_DIR}/config/mcp.example.toml"
cp "${ROOT_DIR}/scripts/install.sh" "${PKG_DIR}/scripts/install.sh"
chmod +x "${PKG_DIR}/scripts/install.sh"

if [[ -f "${ROOT_DIR}/docs/architecture.md" ]]; then
  mkdir -p "${PKG_DIR}/docs"
  cp "${ROOT_DIR}/docs/architecture.md" "${PKG_DIR}/docs/architecture.md"
fi

echo "[release] 5/5 生成压缩包与 SHA256 校验..."
mkdir -p "$RELEASE_DIR"
tar -czf "${RELEASE_DIR}/${ARCHIVE_NAME}" -C "$STAGE_DIR" "hato-${TAG}"

if command -v shasum >/dev/null 2>&1; then
  (cd "$RELEASE_DIR" && shasum -a 256 "${ARCHIVE_NAME}" > SHA256SUMS)
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$RELEASE_DIR" && sha256sum "${ARCHIVE_NAME}" > SHA256SUMS)
fi

echo "[release] 发行版生成完成:"
ls -lh "${RELEASE_DIR}/${ARCHIVE_NAME}" "${RELEASE_DIR}/SHA256SUMS"
