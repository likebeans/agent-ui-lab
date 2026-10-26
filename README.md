# Agent UI Lab

**面向前端开发者的 Agent UI 交互式学习与参考实现仓库。**

从实际操作出发，追溯消息、状态和源码，再把能力迁移到自己的业务。Agent UI Lab 提供聊天工作台、独立能力实验和学习文档。它把 **AG-UI、A2UI、MCP Apps** 放进可操作的旅行对话中：你可以规划行程、填写生成表单、打开工具 App，再沿真实协议消息追到状态变化和源码实现。

无需模型密钥即可运行。当前 Agent 使用确定性规则与样本数据，**没有调用大语言模型（LLM）**。本地模式实际执行 HTTP、服务器发送事件（SSE）、MCP 工具调用和 iframe 通信；GitHub Pages 静态学习版在浏览器内运行同一套生成与校验逻辑，并保留真实的 App / Host 通信。

[在线体验](https://likebeans.github.io/agent-ui-lab/) · [快速开始](#快速开始) · [协议对比](#三个协议分别做什么) · [界面演示](#在一段对话中体验三种能力) · [学习路径](#怎样用这个项目学习) · [部署说明](#部署与-github-pages)

![Agent 聊天首页：从旅行对话进入 AG-UI、A2UI 和 MCP Apps 三种交互示例](public/readme/screenshots/agent-chat.png)

> 本文图片均从本地运行中的项目直接截图，包含真实操作后的状态。[GitHub Pages 静态学习版](https://likebeans.github.io/agent-ui-lab/) 已上线，无需 API 服务或模型密钥；部署步骤见下文。

## 为什么学习 Agent UI

Agent UI 关注的是：**当 Agent 在执行任务时，用户怎样看见过程、补充信息，并通过界面参与下一步。** 它不只涉及聊天气泡，还涉及执行进度、工具状态、动态表单、共享状态和嵌入式应用。

这个项目帮助你回答几个开发中会遇到的问题：

- 回复还没生成完，文字、任务卡片和工具状态怎样分别更新？
- 服务端只发组件与数据描述，前端怎样把它们变成可填写的表单？
- 工具怎样关联自己的 UI 资源，App 又怎样通过宿主调用工具？
- 一次 UI 变化对应哪条消息、哪个状态字段、哪段代码？

适合已经了解 JavaScript / TypeScript 和基础 React，希望开始开发 Agent 前端、生成式 UI 或 MCP 工具界面的开发者。旅行只是贯穿示例的业务场景，学习重点是协议与渲染机制。

## 三个协议分别做什么

Agent UI 是这里讨论的交互方向，AG-UI、A2UI 和 MCP Apps 则分别约定不同层的通信与呈现方式。

| 协议         | 主要回答的问题                       | 本项目中的界面                         | 沿什么线索学习                                    |
| ------------ | ------------------------------------ | -------------------------------------- | ------------------------------------------------- |
| **AG-UI**    | Agent 执行过程中发生了什么？         | 流式文字、任务进度、工具调用、行程卡片 | 事件 → reducer → 状态 → React                     |
| **A2UI**     | 应该出现哪些组件，它们绑定什么数据？ | 可填写、可提交的生成式表单             | 组件声明 + 数据模型 → Renderer → action           |
| **MCP Apps** | MCP 工具怎样提供可交互的应用？       | 消息中的城市活动 App                   | 工具元数据 → UI 资源 → App / Host 握手 → 工具结果 |

它们可以在产品中组合使用。本项目先让每轮回复聚焦一种协议，分别跑通边界；当前没有把 A2UI 或 MCP Apps 消息封装进 AG-UI。MCP 指 Model Context Protocol，Host 是承载工具应用、代理其能力请求的宿主。

## 在一段对话中体验三种能力

### 1. AG-UI：让执行过程成为可观察的界面

发送：**“帮我规划杭州三日游，喜欢慢节奏和本地小吃”**。

文本、任务进度、工具调用和行程会随事件到达而更新。打开右侧协议检查器，可以把界面变化与 `TEXT_MESSAGE_CONTENT`、`TOOL_CALL_ARGS`、`STATE_DELTA` 等实际消息对应起来。

![AG-UI 行程回复：左侧任务与行程卡片由事件驱动，右侧展示 STATE_DELTA 的真实载荷](public/readme/screenshots/ag-ui-events.png)

你可以暂停展示、单步回放、比较更新前后的状态，再修改一条事件运行同一个 reducer。暂停展示时后台仍接收真实事件；“取消运行”与“中断 HTTP”也有不同的终止表现。

进一步阅读：[AG-UI：从事件到界面](docs/01-ag-ui.md)。

### 2. A2UI：从组件描述生成可以操作的表单

继续发送：**“把这些出行需求做成一个表单”**。也可以直接发送 **“生成带预算的杭州三日游表单”**。

服务端下发 `createSurface`、`updateDataModel`、`updateComponents`，前端将受支持的组件映射为 React 控件。填写姓名、修改目的地或预算，再点击“生成计划”，可以检查解析后的 `action.context` 和服务端回显。

![A2UI 生成的旅行表单：实际输入框与右侧 days 组件声明及其绑定路径对应](public/readme/screenshots/a2ui-form.png)

展开“声明如何变成 React 组件”，可从组件 ID 定位实际控件。Workshop 还支持编辑声明与模型、验证错误绑定，以及新增预算字段并完成真实提交。服务端输出的是声明数据，浏览器不会执行它生成的任意 JavaScript。

进一步阅读：[A2UI：从声明到组件](docs/02-a2ui.md)。完成基础操作后，可进入独立实验 **“A2UI 兼容与编辑冲突”**（`/#labs/a2ui-compatibility`），验证未知 catalog 的文字降级、动态字段校验、草稿冲突选择，以及过期动作被拒绝后的版本与计数。操作步骤见 [W3 教程](docs/labs/a2ui-compatibility.md)；本地两个页面共享服务端文档，Pages 使用各页面独立的内存模拟。

### 3. MCP Apps：在聊天里打开工具自带的应用

继续发送：**“打开这个城市的活动应用”**，或直接发送 **“打开上海的城市活动应用”**。

宿主发现工具关联的 `ui://` 资源，读取 HTML，将 App 放进沙箱 iframe，完成握手后传入工具结果。在 App 中切换城市，会通过 Host 发起实际的 MCP 工具调用。

![MCP Apps 深色界面：消息内嵌城市活动 App，右侧 tools/list 返回工具与 UI 资源关联](public/readme/screenshots/mcp-app.png)

这里有两个可以对照的实验：只更新工具结果，沿用现有 App；读取另一份布局资源，重建 App 并复用最后的工具数据。运行后可比较 `resources/read`、iframe 挂载与 `tools/call` 的真实计数，理解“数据更新”和“UI 资源更新”的区别。

进一步阅读：[MCP Apps：从工具到应用](docs/03-mcp-apps.md)。

前面的表单和 App 会留在各自消息里，可以继续操作。成功的表单提交与 App 操作也会更新聊天的旅行上下文，供后续轮次使用。等待回复时可以继续编辑下一条草稿；路由失败或超时会在原消息下显示原因与“重试这条消息”，保留当前草稿，重试也不会清空输入框。

## 怎样用这个项目学习

项目的学习循环是 **追溯原因 → 修改输入 → 预测并验证**。

| 学习动作       | 可以操作什么                           | 用什么检查理解                       |
| -------------- | -------------------------------------- | ------------------------------------ |
| **追溯原因**   | 从文字、工具卡片或表单控件定位消息     | 原始载荷、状态差异、绑定路径和源函数 |
| **修改并观察** | 编辑事件、组件声明、工具输入或布局资源 | 实际预览、表单、App 与调用记录       |
| **预测并验证** | 先回答问题，再运行本轮实验             | 执行结果与证据；失败时不判分         |

![AG-UI 学习实验：先预测文本增量的行为，再通过真实 reducer 结果和协议记录验证](public/readme/screenshots/ag-ui-learning.png)

建议先用 [第一次学习：30 分钟对话](docs/00-first-session.md) 跑通三个场景，再按 [从观察到独立开发](docs/07-learning-method.md) 完成事件编辑、A2UI 预算字段和 MCP 资源对比实验。接着完成三个独立进阶实验，再从 [练习清单](docs/05-exercises.md) 选一个源码改动，尝试迁移到自己的业务。

| 进阶实验            | 入口与教程                                                               | 应验证的结果                                             |
| ------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| A2UI 兼容与编辑冲突 | `/#labs/a2ui-compatibility` · [W3 教程](docs/labs/a2ui-compatibility.md) | 能力降级、字段校验、保留草稿、拒绝过期动作               |
| 任务恢复与事件重放  | `/#labs/task-recovery` · [W1 教程](docs/labs/task-recovery.md)           | 断流后接续同一 run，恢复已提交的本地工具结果             |
| 人工确认与业务事实  | `/#labs/human-approval` · [W2 教程](docs/labs/human-approval.md)         | 确认已审阅内容，丢失响应后查询事实，原命令重试不重复报名 |

本地 W1/W2 共用宿主管理的 SQLite 连接，各自保留独立业务表和状态机。Pages 使用刷新后清空的内存模拟；W3 的远端文档在本地由服务进程共享，在 Pages 中仅属于当前页面。

### 在界面里直接读完整教程

顶部书本图标、侧栏“学习文档”和回复底部的协议教程链接，都可打开阅读器。它包含全文搜索、章节导航、本章目录和可复制的标题链接。搜索结果会标出命中小节，点击后定位内容并短暂突出关键词。

![中文教程阅读器：左侧章节与全文搜索，中间操作教程，右侧本章目录](public/readme/screenshots/learning-docs.png)

阅读器直接加载 `docs/` 和本 README，开发环境修改 Markdown 后由 Vite 热更新，生产预览需要重新构建。返回工作区时会保留当前表单、App、学习结果和协议记录。文档、实验工作区或单个实验模块加载失败时，会显示局部恢复入口；可检查连接后重试，或返回其他工作区继续操作。桌面端与手机端均可操作，并支持深浅主题。

![375px 手机上的深色 MCP App：城市切换和活动列表位于聊天消息中](public/readme/screenshots/mobile-chat.png)

### 中文学习资料

| 内容                                           | 适合什么时候读                       |
| ---------------------------------------------- | ------------------------------------ |
| [学习地图](docs/README.md)                     | 先分清模型、协议、业务服务与前端宿主 |
| [第一次学习](docs/00-first-session.md)         | 按步骤完成第一段对话                 |
| [从观察到独立开发](docs/07-learning-method.md) | 追溯、修改、预测与提交练习           |
| [AG-UI](docs/01-ag-ui.md)                      | 事件流、状态与生命周期               |
| [A2UI](docs/02-a2ui.md)                        | 组件目录、数据绑定与用户动作         |
| [MCP Apps](docs/03-mcp-apps.md)                | 工具、资源、App / Host 握手          |
| [消息对照速查](docs/06-protocol-reference.md)  | 对照消息方向、字段与实验记录         |
| [练习清单](docs/05-exercises.md)               | 从前端实验走向源码修改               |
| [真实开发路径](docs/04-real-development.md)    | 接入真实 Agent、业务服务与持久会话   |

## 快速开始

需要 **Node.js 22.13+**、npm 和浏览器。本地任务恢复与人工确认使用 Node 内置 SQLite；无需额外安装数据库服务。克隆仓库后启动本地模式：

```bash
git clone https://github.com/likebeans/agent-ui-lab.git
cd agent-ui-lab
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。该命令同时启动 Vite 前端与 Express API / MCP 服务：

| 服务      | 地址                    | 用途                                      |
| --------- | ----------------------- | ----------------------------------------- |
| 前端      | `http://127.0.0.1:5173` | 聊天、协议检查器、独立实验和文档          |
| API / MCP | `http://127.0.0.1:3100` | 规则 Agent、SSE、表单动作、工具与 UI 资源 |

两个端口都需要空闲，启动器会在冲突时失败，不会自动换端口。前端将 `/api` 和 `/mcp` 代理到本地后端，无需配置模型密钥。首页是聊天，标准实验入口为 `/#labs/agui`、`/#labs/a2ui`、`/#labs/mcp`，原有 `/#agui`、`/#a2ui`、`/#mcp` 继续兼容；文档入口为 `/#docs/map`。

### 多 worktree 并行开发

每个 worktree 可把 `.env.example` 复制为 `.env.local`，设置独立端口与实例名：

```dotenv
LAB_WEB_PORT=5181
LAB_API_PORT=3111
LAB_PREVIEW_PORT=4181
LAB_INSTANCE_ID=recovery
LAB_DATA_DIR=.lab-data/recovery
```

优先级为进程环境变量 → `.env.local` → `.env` → 默认值。开发、生产预览、Pages 预览、代理、Origin 校验、测试和截图都使用同一配置。`/api/health` 返回实例身份，界面和测试会检查连接归属。未设置实例名时按 checkout 路径生成。

Playwright 默认自己启动服务；需要复用当前 worktree 的开发服务时设置 `LAB_REUSE_EXISTING_SERVER=1`，仍会验证 HTML 与 API 身份。各 worktree 使用独立数据和构建目录，同一 worktree 的普通 / Pages 构建按顺序执行。

新增实验从 `src/labs/<id>/manifest.ts` 接入导航和懒加载，教程放在 `docs/labs/<id>.md` 自动进入搜索与阅读器。完整接口、目录归属和示例见 [W0：实验基础与并行开发](docs/labs/foundation.md)，也可在界面打开“实验接入示例”。

### 检查与构建

```bash
npm run check         # 协议与集成测试、类型检查、前端构建
npm run test:e2e      # Chrome 中的交互与协议闭环测试
npm run format:check  # 格式检查
npm run build         # 构建前端到 dist/
npm start             # 用本地 Node 服务预览构建产物
```

`npm start` 后访问 <http://127.0.0.1:3100>。需要换预览端口时使用 `PORT=4000 npm start`。服务当前仅监听本机；这一步用于本地预览，不会发布网站。

浏览器测试和截图脚本使用本机 Google Chrome 的独立浏览器上下文。没有 Chrome 时，可先运行 `npx playwright install chrome`。

`.github/workflows/ci.yml` 提供可复用的完整 CI：检查格式、单测、类型与普通构建，再顺序运行本地 HTTP 和 Pages 子路径浏览器套件。PR 和手动校验会运行这些检查；`main` 推送由 Pages 工作流调用同一套 CI，自动发布和手动发布都必须通过校验后才能构建发布产物，失败或取消时不会部署。W1 的断流恢复、取消、新 run 隔离、checkpoint 恢复记录定位及 Pages 重置已纳入日常发现；进程中断与 SQLite 重启测试由 `npm test` 执行。

### 更新 README 截图

保持 `npm run dev` 运行，在另一个终端执行：

```bash
npm run screenshots:readme
```

脚本会实际操作三种协议、运行学习实验、打开文档，并将截图保存到 `public/readme/screenshots/`。图片使用仓库内的相对路径，GitHub README 可直接显示，构建后也可由前端阅读器加载。脚本默认访问配置中的前端地址，可通过 `README_BASE_URL` 指定地址；截图前会验证 HTML 和 API 实例身份。

## 实现结构与技术栈

```text
浏览器：ChatWorkspace / 独立实验
  ├─ AG-UI：HTTP + SSE → 事件校验 → reducer → 文字 / 工具 / 任务卡片
  ├─ A2UI：HTTP → 组件声明 + 数据模型 → Renderer → action 回传
  └─ MCP Apps：MCP Client → 工具 / UI 资源 → AppBridge ↔ iframe App
                               ↓
                  Express 服务 + 本地规则与旅行样本
```

前端使用 React 19、TypeScript 和 Vite，服务端使用 Express。AG-UI 使用官方事件 schema 与教学 reducer；A2UI 使用手写的有限组件 Renderer；MCP Apps 使用官方 App、AppBridge 和 MCP v2 SDK。测试使用 Vitest 与 Playwright，文档通过 React Markdown 渲染。

```text
src/
  ChatWorkspace.tsx             聊天消息、上下文和每轮协议检查器
  components/AguiChatTurn.tsx   事件驱动的回复
  components/AguiLearningPanel.tsx  回放、状态差异与 reducer 实验
  components/A2uiWorkshop.tsx   声明编辑与预算提交练习
  labs/registry.ts             自动发现 manifest、兼容路由与懒加载
  labs/<id>/                   实验定义、界面、可选聊天适配与局部样式
  labs/legacy.tsx              现有三协议实验的兼容适配
  mcp-app.ts                   iframe 中的工具应用
  DocsReader.tsx               中文文档阅读器
server/
  chat.ts · agui.ts · a2ui.ts   本地 HTTP / SSE 路由
  mcp.ts                       MCP HTTP 传输
  mcp-resource.ts              自包含 App HTML 构建
shared/
  chat-agent.ts                确定性路由与上下文解析
  agui-agent.ts                事件生成、取消与故障
  a2ui-agent.ts                组件声明生成与动作校验
  mcp-server.ts                工具、资源与只读样本
  static-api.ts                静态版浏览器内逻辑路由
  runtime.ts                   运行模式与 trace 传输标记
  lab-contract.ts              实验身份、运行接口与预留任务契约
  labs/                        浏览器安全的实验逻辑与静态适配
  …                            协议模型、校验与状态转换
config/runtime.ts             统一端口、实例身份和环境配置
scripts/runtime.ts            启动与端口预检
docs/                          中文教程与练习；labs/ 自动发现
public/readme/screenshots/     README 实际截图
scripts/capture-readme.mjs     可重复执行的截图脚本
tests/ · e2e/                  协议、通信集成与浏览器验证
```

### 协议基线与实现范围

| 部分     | 当前基线                                                          | 实现范围                                                                                 |
| -------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AG-UI    | 协议 1.0，`@ag-ui/core` 1.0.3                                     | 官方 schema、真实 SSE、本实验事件子集；状态补丁教学实现仅支持安全的 `replace`            |
| A2UI     | v0.9.1                                                            | `Card`、`Column`、`Text`、`TextField`、`ChoicePicker`、`Button` 六种组件及绑定、动作校验 |
| MCP Apps | `@modelcontextprotocol/ext-apps` 2.0.3，MCP client / server 2.3.1 | 官方 SDK、两个本地 UI 资源、一个只读工具和受控宿主                                       |

具体依赖以 `package-lock.json` 为准。三个协议仍在演进，阅读资料时需要核对版本；A2UI 与面向 Agent 间通信的 A2A 是不同的协议。

## 部署与 GitHub Pages

**GitHub Pages 版可以直接体验聊天、三种协议、学习实验与全文教程，无需 API 服务或模型密钥。** 它使用独立的静态构建模式。界面会显示“静态学习版”，协议检查器和导出的 trace 也会记录实际传输方式。

| 能力                | 本地模式：`npm run dev`                     | Pages 模式：`npm run build:pages`                                               |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| AG-UI               | Express 通过 HTTP / SSE 发送事件            | 同一事件引擎在浏览器内生成事件，用 `ReadableStream` 演示 SSE 编码；没有网络 SSE |
| A2UI                | HTTP 请求声明、提交动作，后端校验并返回更新 | 同一 builder 与动作校验器在浏览器内执行，保留组件、绑定和预算练习               |
| MCP Client / Server | 官方 Streamable HTTP 传输                   | 官方 `InMemoryTransport` 在浏览器内传递 JSON-RPC                                |
| MCP App / Host      | 官方 AppBridge、沙箱 iframe、`postMessage`  | 相同握手与工具代理；HTML 资源在构建时生成，由静态站点提供                       |
| 学习与文档          | 追溯、修改、预测、回放、全文搜索            | 相同功能                                                                        |

Pages 模式中的 `POST /api/...` trace 标签表示对应的教学逻辑路由，**没有向该地址发送 HTTP 请求**。记录中的方向会变为 `client→browser-agent` / `browser-agent→client`，`transport` 为 `browser-memory`；App / Host 消息仍标为 `postMessage`。协议的角色边界依然存在，但浏览器内的业务校验不能作为生产服务端的权限边界。

### 发布到 GitHub Pages

1. 将**本目录的内容作为仓库根目录**推送到 GitHub，包含 `package.json` 和 `.github/workflows/` 中的工作流。当前工作流默认监听 `main`；使用其他默认分支时同步修改工作流中的分支条件。
2. 在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。
3. 推送到 `main`，或在 **Actions → Deploy GitHub Pages → Run workflow** 手动运行。
4. 工作流先验证本次发布提交的格式、单元与集成测试、类型、普通构建，以及本地 HTTP 和 Pages 子路径浏览器套件。完整 CI 通过后，才允许构建、验证并上传使用实际 Pages 路径的静态产物，发布到 `github-pages` 环境。访问地址显示在该次部署中。手动发布也遵守相同门禁，校验与发布必须使用同一个提交。仅允许发布 `main`，部署前再次确认提交仍是 `main` 的最新版本；重跑旧提交不会覆盖更新的站点。

工作流从 Pages 配置读取 `base_path`，自动设置 Vite `base`，适用于 `https://<用户名>.github.io/<仓库名>/`，也支持根站点或已配置的自定义域名。无需把仓库名写入源码。聊天、独立实验和文档使用 hash 路由，刷新深链接不需要服务器回退规则。

### 在本地预览静态版

```bash
npm run build:pages
npm run preview:pages
```

打开 <http://127.0.0.1:4173>，无需启动 3100 端口的后端。要模拟仓库子路径，在构建和预览时都传入相同的 `PAGES_BASE_PATH`：

```bash
PAGES_BASE_PATH=/agent-ui-lab/ npm run build:pages
PAGES_BASE_PATH=/agent-ui-lab/ npm run preview:pages
```

然后访问 `http://127.0.0.1:4173/agent-ui-lab/`。`npm run test:pages` 会自动在 `/pages-test/` 下构建并验证静态版，断言无 `/api` 或 `/mcp` 网络请求、无失败资源和浏览器异常。测试使用 Chrome；CI 使用 Playwright Chromium。

普通 `npm run build && npm start` 仍用于带真实后端的本地预览。两种构建都会写入 `dist/`，切换模式时重新构建。仅复制普通构建的 `dist/` 到 Pages 无法使用 API 交互；发布静态站点必须使用 `build:pages`。

## 当前边界与后续方向

当前业务包括本地旅行样本与工作坊报名教学记录，不产生真实预订、支付或外部写操作。聊天路由根据关键词或手动选择决定协议，尚未接入模型自主规划、长期记忆或任意工具组合。

聊天和基础协议实验的状态保存在内存中：阅读文档、进入独立实验后返回聊天，会保留消息、表单草稿、MCP App 和协议记录；聊天中已发起的请求继续执行，隐藏页面停止自动回放。返回上次独立实验也会保留其界面。刷新或新建对话会重置聊天，切换不同独立实验仍会重新建立该实验界面。W1 任务、事件与 checkpoint，以及 W2 提议、命令收据与报名事实，在本地保存到 `LAB_DATA_DIR` 下的 SQLite。W2 的教学会话和待确认命令可保存在当前浏览器中作为恢复线索，权威结果仍需查询；Pages 的业务事实仅在页面内存中，刷新后清空。主题偏好保存在浏览器本地。

A2UI Renderer 和 MCP Host 都有明确的教学范围。MCP App 只加载项目自带资源，不能直接作为任意第三方应用的生产托管器。真实开发需要进一步补齐鉴权、会话隔离、持久化、部署与宿主策略，详见 [真实开发路径](docs/04-real-development.md)。

后续计划：

- [x] GitHub Pages 静态学习模式、子路径验证与发布流程。
- [x] SQLite 任务恢复、checkpoint 与事件重放实验。
- [x] 人工确认、幂等报名与未知结果查询实验。
- [x] A2UI 能力兼容、草稿冲突与过期动作实验。
- [ ] 可配置的远程 API / MCP 服务地址。
- [ ] 真实 Agent 接入示例。
- [ ] 持久聊天会话与跨实验协议组合示例。

欢迎通过 Issue 反馈难以理解的协议步骤、教程问题和可复现的缺陷，也欢迎提交带验证结果的教学示例。仓库当前尚未包含 `LICENSE`，开源前需由维护者确定许可。

## 官方资料

- [AG-UI 协议文档](https://docs.ag-ui.com) · [AG-UI 源码](https://github.com/ag-ui-protocol/ag-ui)
- [A2UI 协议文档](https://a2ui.org) · [A2UI 源码](https://github.com/a2ui-project/a2ui)
- [MCP Apps 扩展文档](https://modelcontextprotocol.io/docs/extensions/apps) · [MCP Apps SDK 与示例](https://github.com/modelcontextprotocol/ext-apps)
