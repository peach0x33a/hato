# Hato

> 面向个人使用的 1v1 私聊型 Personal Agent —— 兼顾长期情感陪伴（时间感知、跨轮记忆、拟真气泡节奏、主动关怀）与安全隔离的工程任务委托执行。

---

## 核心特性

- **防污染「三道墙」架构**：将对话入口拆分为 **Persona（人设陪伴）** 与 **Neutral Router（中立轻路由器）**，Worker 通过签发的只读 `context_id` 按需拉取原始上下文区间，避免传话筒失真，同时物理隔离人设提示词、情感记忆与宿主机执行权限。
- **多渠道网关**：内置 Telegram (`grammY`) 私聊适配器，支持防抖聚批、气泡分段发送、Inline 确认按钮及媒体附件处理；架构上预留 QQ 官方 Bot 接入能力。
- **5 角色槽位模型路由**：支持为 `persona` / `router` / `worker` / `curator` / `vision` 等槽位独立配置 Provider 与模型，支持 `/model` 热切换与自动重试。
- **双区能力与外部 CLI 调度**：Skills 与 MCP 按 `personal` / `worker` 物理隔离；Worker 支持内置 `builtin-pi` 及外部 CLI（`codex-cli`、`claude-code`、`antigravity-cli`、`opencode-v2`、`external-pi`），通过 Overlay 隔离个人凭据与配置。
- **长期记忆与定时任务**：支持 MemoryEcho / Hindsight 双 Bank 记忆提炼与按关键词级联遗忘，配合 Croner 定时脚本与 Open Loops 主动关怀。
- **内置 Web Console**：提供开箱即用的可视化控制台（默认 `http://127.0.0.1:3820`），支持实时对话测试、Prompt 分块预览编辑、Provider/模型管理、MCP 配置、Token 统计与系统状态监控。

---

## 系统架构概览

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

更详细的系统设计与模块划分请参阅 [系统架构与工程设计文档](docs/architecture.md)。

---

## 目录结构

```text
.
├── src/                  # 服务端 TypeScript 源码
│   ├── browser/          # Playwright 浏览器任务运行时
│   ├── bus/              # Event Bus 与 Per-User Actor Lock
│   ├── cli/              # CLI 入口（setup 向导、statics 统计）
│   ├── commands/         # 内置斜杠命令（/help, /model, /reload 等）
│   ├── config/           # 配置加载、模型注册表、Scoped Proxy、~/.hato 路径解析
│   ├── db/               # SQLite + Drizzle ORM 数据层
│   ├── dispatch/         # Neutral Router 与工单协调器
│   ├── gateway/          # Telegram / QQ 渠道适配器
│   ├── mcp/              # Personal / Worker 双区 MCP 客户端池
│   ├── memory/           # 记忆提炼、上下文压缩与向量存储对接
│   ├── persona/          # Persona Agent 与气泡分段发送
│   ├── setup/            # 交互式初始化向导与连通性探测
│   ├── web-console/      # 内置 Web Console HTTP/SSE 服务
│   └── worker/           # Worker 执行器与外部 CLI Overlay 隔离
├── web/                  # Web Console 前端（React 19 + Vite + Tailwind CSS v4）
├── prompts/              # 分层提示词模板（system / soul / persona / router / curator）
├── config/               # 示例配置（mcp.example.toml）
├── scripts/              # 安装与发行版打包脚本
├── docs/                 # 架构文档
└── tests/                # 自动化测试套件
```

---

## 环境要求

- **Node.js**：`>= 22.0.0`
- **构建原生模块依赖**（`better-sqlite3`）：如无预编译二进制包，需本机具备 `python3`、`make` 与 C++ 编译工具链（macOS 安装 Xcode Command Line Tools，Linux 安装 `build-essential`）。
- **可选**：`playwright-core` 浏览器内核（如需启用浏览器任务）、外部编码 CLI（Codex / Claude Code / Pi 等）。

---

## 快速开始

### 方式一：使用安装脚本（推荐）

支持从发行版压缩包或源码目录一键安装，并支持**临时启用中国镜像源**（仅在本次安装进程生效，不会修改系统全局 `~/.npmrc`）：

```bash
# 从源码目录或解压后的发行包目录执行
bash scripts/install.sh

# 中国大陆网络环境（临时使用 npmmirror 镜像源）
bash scripts/install.sh --cn
```

常用安装参数：
- `--cn` / `--mirror`：临时启用中国镜像源（`npmmirror`）安装依赖。
- `--dir <path>`：指定安装目标目录（默认在发行包/源码当前目录就地安装，或指定如 `~/.local/share/hato`）。
- `--skip-setup`：跳过安装完成后的交互式配置向导。

### 方式二：手动从源码构建

1. **安装依赖并构建前后端**

```bash
npm install
npm --prefix web install
npm run build:web
npm run build
```

2. **运行交互式配置向导**

```bash
npm run setup
```

向导会在 `~/.hato/`（可通过环境变量 `HATO_HOME` 覆盖）下生成或更新配置文件：
- `~/.hato/hato.toml`：应用主配置、网关、Web Console、记忆与防抖参数
- `~/.hato/models.toml`：模型 Provider 与各角色槽位配置
- `~/.hato/mcp.toml`：Personal / Worker 双区 MCP Server 配置（可参考 [config/mcp.example.toml](config/mcp.example.toml)）
- `~/.hato/.env`：API Key 与 Bot Token 等敏感凭据（可参考 [.env.example](.env.example)）

> **Provider API Key 自动推导规则**：环境变量名按 `models.toml` 中 Provider 的 `slug` 自动推导为 `<UPPER_SNAKE(slug)>_API_KEY`（例如 `[providers.deepseek]` 对应 `DEEPSEEK_API_KEY`）。

3. **启动服务**

```bash
npm start
```

服务启动后，默认可通过 `http://127.0.0.1:3820` 访问 Web Console（可在 `hato.toml` 的 `[web.console]` 中调整 `host`、`port` 与 `auth_token_env`）。

---

## 常用命令

### 全局 CLI 命令（`hato`）

通过安装脚本或 `npm link` 注册全局命令后，可在任意目录直接运行：

| 命令 | 说明 |
| --- | --- |
| `hato` / `hato start` | 启动 Hato 服务（Telegram 网关 + Web Console） |
| `hato setup` | 运行交互式配置向导 |
| `hato statics` | 查看运行与 Token 用量统计（别名：`hato stats`） |
| `hato -v` / `hato --version` | 显示当前版本号 |
| `hato -h` / `hato --help` | 显示命令行帮助 |

### npm 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 监听 `src/main.ts` 并热重启后端开发服务 |
| `npm run dev:web` | 启动 Web Console Vite 前端开发服务器 |
| `npm run setup` | 启动交互式配置向导 |
| `npm run statics` | 查看本地运行与用量统计 |
| `npm run build:web` | 构建 Web Console 前端静态产物至 `web/dist/` |
| `npm run build` | 编译 TypeScript 后端至 `dist/` |
| `npm start` | 启动生产构建（`node dist/main.js`） |
| `npm run typecheck` | 运行 TypeScript 类型检查 |
| `npm test` | 运行全量自动化测试 |
| `npm run release:pack` | 构建并打包发行版压缩包至 `release/` |

### 对话斜杠指令（Telegram / Web Console）

- `/help`：查看可用系统指令说明
- `/new`：清空当前对话上下文，开启新会话
- `/sethome`：将当前私聊设为 Home Channel（主动关怀与定时通知默认入口）
- `/trace`：查看上一轮上下文、时间卡、协议与 Prompt Cache 命中情况
- `/model list` / `/model set <slot> <provider/model>`：查看或热切换槽位模型
- `/reload`：热重载 `hato.toml` 与 `models.toml`
- `/compact`：手动触发一次热区上下文压缩
- `/memory [sync|retry]`：查看长期记忆状态/配额，或立即提炼同步
- `/forget <关键词>`：按关键词级联遗忘长期记忆

---

## 制作发行版

项目提供了本地打包脚本，会自动完成类型检查、测试、前后端构建，并将运行所需的最小文件集（`dist/`、`web/dist/`、`prompts/`、`scripts/install.sh`、`config/mcp.example.toml`、`.env.example`、`package.json`、`package-lock.json`、`README.md`）打包为 `.tar.gz` 并生成 `SHA256SUMS`（严格排除 `.env`、本地 `config/*.toml`、`data/`、`*.db` 等敏感或运行时文件）：

```bash
npm run release:pack
```

产物将输出至 `release/hato-v<version>.tar.gz` 与 `release/SHA256SUMS`。
