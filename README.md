<div align="center">

# 🕊️ Hato

**面向个人使用的 1v1 私聊型 Personal Agent**

兼顾长期情感陪伴（时间感知、跨轮记忆、拟真气泡节奏、主动关怀）与安全隔离的工程任务委托执行

[![Release](https://img.shields.io/github/v/release/peach0x33a/hato?style=flat-square&color=blue)](https://github.com/peach0x33a/hato/releases)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.2-fbf0df?style=flat-square&logo=bun&logoColor=black)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[快速开始](#-快速开始) · [核心特性](#-核心特性) · [常用命令](#-常用命令) · [架构文档](docs/architecture.md)

</div>

---

## ✨ 核心特性

- **防污染「三道墙」架构**
  将对话入口拆分为 **Persona（人设陪伴）** 与 **Neutral Router（中立轻路由器）**；Worker 凭借签发的只读 `context_id` 按需拉取原始上下文区间，避免传话筒失真，同时物理隔离人设提示词、情感记忆与宿主机执行权限。
- **多渠道网关**
  内置 Telegram (`grammY`) 私聊适配器，支持防抖聚批、拟真气泡分段发送、Inline 确认按钮与媒体附件处理。
- **5 角色槽位模型路由**
  支持为 `persona` / `router` / `worker` / `curator` / `vision` 等槽位独立配置 Provider 与模型，支持 `/model` 热切换与自动重试。
- **双区能力 & 外部 CLI 调度**
  Skills 与 MCP 按 `personal` / `worker` 物理隔离；Worker 支持内置 `builtin-pi` 与外部 CLI（`codex-cli`、`claude-code`、`antigravity-cli`、`opencode-v2`、`external-pi`），通过 Overlay 隔离个人凭据。
- **长期记忆 & 定时关怀**
  支持 MemoryEcho / Hindsight 双 Bank 记忆提炼与按关键词级联遗忘，配合 Croner 定时任务与 Open Loops 主动关怀。
- **内置 Web Console**
  开箱即用的可视化控制台（默认 `http://127.0.0.1:3820`），支持实时对话、Prompt 分块预览编辑、Provider/模型管理、MCP 配置与 Token 用量统计。

---

## 🧭 架构概览

```text
Telegram / Web Console
        │  (防抖聚批 + Actor Lock)
        ▼
  Persona Agent (pi-agent-core) ──▶ 只读微工具 / Personal MCP / read_skill
        │
        │ delegate(hint)
        ▼
  Neutral Router ──▶ 圈定 [from_msg_id .. to_msg_id] 区间 & 签发 context_id
        │
        ▼
  Worker Dispatcher (builtin-pi / external-cli) ──▶ 按 context_id 拉取原文切片执行
```

> 详细设计请参阅 [系统架构与工程设计文档](docs/architecture.md)。

---

## 🚀 快速开始

### 环境要求

- **Bun** `>= 1.2`（内置 `bun:sqlite` 与原生 TypeScript 运行时，无需 C++ 编译工具链）

### 方式一：一键安装（推荐）

自动拉取最新发行版、安装依赖、初始化 `~/.hato/` 并注册 `hato` 命令：

```bash
# 标准安装
curl -fsSL https://raw.githubusercontent.com/peach0x33a/hato/main/scripts/install.sh | bash

# 中国大陆网络环境（仅在本次安装进程临时启用 npmmirror 镜像源，不修改全局 ~/.npmrc）
curl -fsSL https://raw.githubusercontent.com/peach0x33a/hato/main/scripts/install.sh | bash -s -- --cn
```

若已下载发行包或克隆源码，也可在项目目录内直接执行 `bash scripts/install.sh`（或加 `--cn`）。

<details>
<summary>安装脚本常用参数</summary>

- `--cn` / `--mirror`：临时启用中国镜像源（`npmmirror`）
- `--dir <path>`：指定安装目录（`curl` 远程安装默认 `~/.local/share/hato`）
- `--version <tag>`：指定发行版标签（如 `v0.1.0`）
- `--release-url <base_url>`：自定义发行版下载基础 URL
- `--with-playwright`：同时安装 Playwright Chromium 内核
- `--skip-setup`：跳过安装完成后的配置向导
- `--no-bin`：不在 `~/.local/bin/hato` 创建快捷启动脚本

</details>

### 方式二：从源码手动构建

```bash
bun install
bun install --cwd web
bun run build:web
bun link          # 注册全局 hato 命令（可选）
hato setup        # 运行交互式配置向导
hato              # 启动服务
```

> **配置目录**：默认位于 `~/.hato/`（可通过 `HATO_HOME` 覆盖），包含 `hato.toml`、`models.toml`、`mcp.toml`（参考 [config/mcp.example.toml](config/mcp.example.toml)）与 `.env`（参考 [.env.example](.env.example)）。Provider API Key 按 `models.toml` 中的 `slug` 自动推导为 `<UPPER_SNAKE(slug)>_API_KEY`。

---

## ⌨️ 常用命令

### 全局 CLI（`hato`）

| 命令 | 说明 |
| --- | --- |
| `hato` / `hato start` | 启动 Hato 服务（Telegram 网关 + Web Console） |
| `hato setup` | 运行交互式配置向导 |
| `hato statics` | 查看运行与 Token 用量统计（别名：`hato stats`） |
| `hato -v` / `--version` | 显示版本号 |
| `hato -h` / `--help` | 显示帮助信息 |

<details>
<summary>开发与构建脚本（bun run）</summary>

| 命令 | 说明 |
| --- | --- |
| `bun run dev` | 监听 `src/main.ts` 热重启后端 |
| `bun run dev:web` | 启动 Web Console Vite 开发服务器 |
| `bun run build:web` | 构建前端产物至 `web/dist/` |
| `bun run typecheck` | 运行 TypeScript 类型检查 |
| `bun test` | 运行自动化测试 |
| `bun run release:pack` | 校验、构建并打包发行版至 `release/` |

</details>

<details>
<summary>对话斜杠指令（Telegram / Web Console）</summary>

- `/help`：查看可用系统指令说明
- `/new`：清空当前对话上下文，开启新会话
- `/sethome`：将当前私聊设为 Home Channel（主动关怀与定时通知默认入口）
- `/trace`：查看上一轮上下文、时间卡、协议与 Prompt Cache 命中情况
- `/model list` / `/model set <slot> <provider/model>`：查看或热切换槽位模型
- `/reload`：热重载 `hato.toml` 与 `models.toml`
- `/compact`：手动触发一次热区上下文压缩
- `/memory [sync|retry]`：查看长期记忆状态/配额，或立即提炼同步
- `/forget <关键词>`：按关键词级联遗忘长期记忆

</details>

---

## 🤖 For LLM

<details>
<summary>展开查看 AI Coding Agent / LLM 上下文与安装指导</summary>

### 仓库概览与约束
- **核心定位**：Bun (`>=1.2`) + TypeScript (ESM `NodeNext`) 编写的 1v1 个人助手；前端控制台位于 `web/`（React 19 + Vite + Tailwind CSS v4）。
- **关键入口**：
  - `src/cli/hato.ts`：全局 CLI 入口（`hato [start|setup|statics]`），启动前切换 `cwd` 至包根目录。
  - `src/main.ts`：主运行时（Gateway、EventBus/ActorLock、Persona、Router、Worker、Memory、Web Console）。
  - `src/web-console/server.ts`：内置 Web Console HTTP/SSE 服务（默认 `127.0.0.1:3820`）。
- **核心架构约束（修改代码时需遵守）**：
  - **三道墙隔离**：`src/persona/` 不得获得宿主机执行权限；`src/dispatch/`（Neutral Router）只圈定 `[from_msg_id .. to_msg_id]` 与签发 `context_id`，不向 Worker 泄露 `prompts/persona.md` 与情感记忆；`src/worker/` 通过 `context_id` 按需拉取原文切片。
  - **双区隔离**：Skills 与 MCP 严格区分 `personal` / `worker` 区，外部 CLI 通过 Overlay 隔离个人凭据。
- **配置与数据路径**：运行时配置统一位于 `~/.hato/`（可由 `HATO_HOME` 覆盖），包含 `hato.toml`、`models.toml`、`mcp.toml`、`.env`；持久化使用 `bun:sqlite` + Drizzle ORM（`src/db/`）。
- **校验命令**：修改后依次执行 `bun run typecheck`、`bun test`、`bun run build:web`。详细设计见 [docs/architecture.md](docs/architecture.md)。

### 自动化安装指导（供 Agent 为用户部署时参考）
1. **前置检查**：确认 `bun -v` 已安装；若需非交互安装，传入 `--skip-setup`。
2. **执行安装**：
   - 预编译发行版一键安装：`curl -fsSL https://raw.githubusercontent.com/peach0x33a/hato/main/scripts/install.sh | bash -s -- --skip-setup`（中国大陆环境追加 `--cn`）。
   - 本地源码目录安装：`bun install --frozen-lockfile && bun install --cwd web && bun run build:web && bun link`。
3. **配置与启动**：提示用户运行 `hato setup`（或编辑 `~/.hato/` 下的 `hato.toml`、`models.toml`、`.env`），随后运行 `hato` 启动服务。

</details>

