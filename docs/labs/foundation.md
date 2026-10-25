# W0：实验基础与并行开发

Agent UI Lab 是面向前端开发者的交互式学习与参考实现仓库。本章说明实验注册、公共运行契约、原始记录关联与 worktree 运行隔离；你可以先打开[实验接入示例](#labs/foundation)，再对照源码添加自己的实验。

## 目标与当前范围

W0 为后续任务恢复、人工确认、A2UI、MCP Apps 等独立实验提供入口。当前三协议仍使用原有确定性引擎和教学子集，协议行为保持原样。示例不使用新协议，也没有接入模型、持久任务或审批。

操作顺序：修改文字 → 运行 → 查看结果 → 点击“定位本次结果记录” → 对照 `shared/labs/foundation/engine.ts`。检查器显示原始请求或响应，关联 ID 位于载荷之外。

## 新增实验的最小结构

```text
src/labs/<lab-id>/manifest.ts
src/labs/<lab-id>/Lab.tsx
src/labs/<lab-id>/lab.module.css
shared/labs/<lab-id>/engine.ts
docs/labs/<lab-id>.md
tests/labs/<lab-id>.test.ts
e2e/labs/<lab-id>.spec.ts
```

实验 ID 使用小写字母、数字和连字符，如 `task-recovery`。新增 `manifest.ts` 会由注册表自动发现，驱动导航、排序、元信息、文档链接和懒加载。一个实验可包含零个、一个或多个协议。`#labs/<id>` 是标准入口，`#agui`、`#a2ui`、`#mcp` 继续兼容。

manifest 使用 `LabDefinition`，声明 `id`、`title`、`description`、`topicIds`、`protocols`、`protocolVersions`、`order`、`status`、`modes`、`docs`、`sourceReferences`、`presentation` 与 `load`。类型位于 `src/labs/types.ts`，通用数据契约位于 `shared/lab-contract.ts`。

```ts
load: () => import('./Lab');
```

浏览器 manifest 只导入元信息和浏览器模块，不能导入 Express、数据库驱动或 Node 内置模块。实验组件通过动态 import 加载，未打开的实验不会执行其初始化逻辑。

## 公共运行接口

`LabComponentProps` 包含 `runtime`、`active` 与 `onResetTrace`。`runtime` 提供：

- `mode`：`local` 或 `pages`。
- `identity`：`labId` 与可选 thread、turn、task、run 身份。
- `request(path, options)`：调用本地 HTTP 或 Pages 静态 handler，自动合并实验销毁信号。
- `signal`：实验卸载时取消。组件自己创建的资源也必须在清理函数中释放。
- `trace(entry)`：记录原始载荷，并在外层补齐关联身份和 transport。
- `focusTrace(selector)`：按实验、运行、事件类型、序号或具体记录定位。

`active=false` 表示正在读文档、返回聊天等暂时隐藏状态，应暂停自动播放、焦点移动等界面活动。隐藏不等于销毁；聊天与最后一个独立实验各保留一个实例，往返不会重新挂载表单或 MCP iframe。聊天已发起的请求继续执行；W1 隐藏时暂停接流，返回后查询 checkpoint 恢复任务。切换到另一个独立实验会卸载旧实验并触发清理。重置按钮可以清理实验局部状态与记录；它不能替代服务端取消确认。

现有三实验通过 `src/labs/legacy.tsx` 适配自己的 `onTrace` / `onResetTrace` 和聊天接口。后续模块使用新的运行接口，避免依赖旅行专用上下文。

## 聊天接入可选

manifest 可提供 `chat`：提示词、起始文案、后续建议、源码线索与懒加载聊天组件。现有实验使用 `protocol` 接入旧规则路由；新实验可提供 `resolve` 和可选 `match`，返回实验 ID、上下文和解释。手动选择会调用对应 resolver，自动匹配后再回退到旅行规则路由。

聊天请求使用 `LabChatRequest`，上下文是按命名空间保存的 `LabContext`。旅行适配器只读写 `context.trip`；新场景使用自己的命名空间，并在 adapter 边界校验结构。交互回调只提交本次改变的字段；`mergeLabContext` 将命名空间对象的一层字段合并到最新上下文，数组、标量与 null 则整体替换，避免旧轮次覆盖后来修改的数据。路由等待期间成功交互提交的字段优先于路由请求时的快照；路由返回后，新回复和共享上下文使用同一份合并结果。对话历史、上下文和 task 是不同对象；本基础层没有实现长期记忆或持久聊天会话。

## 原始记录与应用身份

原始协议消息保存在 `TraceInput.payload` 中。应用字段 `labId`、`threadId`、`turnId`、`taskId`、`runId`、`eventType`、`seq` 位于记录外层。这里的 `seq` 属于应用事件关联，不能冒充每个协议的原生字段。原协议自己的 message、tool、surface ID 原样留在 payload。

`focusTrace({ labId, runId, eventType })` 不依赖中文展示标签。已有学习面板的 label / occurrence 定位暂时通过兼容适配器保留，逐个协议深化时可以迁移。

thread 表示会话，turn 表示一次用户交互，task 表示用户目标，run 表示一次执行。W0 不为每条消息伪造持久 task。重放仍属于同一 run；重新执行应使用新的 run。AG-UI 记录复用实际请求和 RUN_STARTED 中的身份。

## HTTP 与静态入口

新的业务接口使用 `/api/labs/<id>/...`。`server/labs/index.ts` 是本地注册点，`shared/labs/static-handlers.ts` 是静态注册点；两端调用浏览器安全的同一 engine / schema。后续接口登记由整合负责人统一完成。

接入示例的请求为 `POST /api/labs/foundation/run`，输入 `{ text: string }`，返回规范化文字、Unicode 字符数与确定性引擎标记。空值或非法结构被拒绝。本地证明 HTTP 请求，Pages 证明浏览器内计算；两者不会暗示服务端授权或持久写入。

## W1 / W2 的任务契约与存储

`shared/lab-contract.ts` 固定应用层 `TaskSnapshot`、`TaskCommand`、`TaskStatus`、`EventCursor`、`TaskEvent`、`TaskCheckpoint`、`CommandResult` 与最小 `TaskStore` 接口。

任务包含版本、状态、当前 run 和业务状态。命令包含 commandId、taskId、expectedVersion；结果区分 accepted、conflict、rejected。checkpoint 关联恢复状态与最后事件序号。[W1](./task-recovery.md) 已实现 SQLite 任务存储、checkpoint 与事件重放；[W2](./human-approval.md) 已实现审批内容、有效期、教学会话绑定及幂等业务写入。

两者共享 `server/storage/sqlite.ts` 基础设施，各自保留业务表、存储适配器与版本语义。`server/labs/index.ts` 创建或接收宿主注入的 `LabDatabase`，初始化迁移，统一清理模块；`app.locals.closeLabs()` 先停止模块、结束恢复事件流，再关闭自有连接。调用者注入的数据库由调用者最终关闭。测试创建 `createServer()` 时应使用临时数据目录，并在关闭 HTTP server 前调用清理函数。Pages 只提供可重置的内存模拟。

## Worktree 配置隔离

所有启动入口读取同一运行配置，优先级为进程环境变量 → `.env.local` → `.env` → 默认值。默认端口仍是 5173 / 3100 / 4173；多个 worktree 需要各自设置不同端口。

```dotenv
LAB_WEB_PORT=5181
LAB_API_PORT=3111
LAB_PREVIEW_PORT=4181
LAB_INSTANCE_ID=recovery
LAB_DATA_DIR=.lab-data/recovery
```

`LAB_WEB_PORT`、`LAB_API_PORT`、`LAB_PREVIEW_PORT` 同时驱动启动、代理、Origin 校验与测试地址。`PORT` 保留为 API 端口兼容别名。`LAB_INSTANCE_ID` 可显式设置，默认根据 checkout 路径生成，避免不同 worktree 的实例混淆。数据目录按 worktree 隔离，已加入忽略规则；本地服务在此创建 W1/W2 共用的 `lab.sqlite`，Pages 不创建数据库。

在配置好的目录执行 `npm run dev`。`npm run dev:web`、`npm run dev:server`、`npm start`、`npm run preview:pages` 使用相同配置。端口冲突时会失败，不会自动连到别的服务。`/api/health` 返回实例身份；前端和浏览器测试检查当前响应是否属于预期实例。

Playwright 默认自己启动服务。需要复用自己的运行实例时显式设置 `LAB_REUSE_EXISTING_SERVER=1`，测试仍校验身份。普通构建与 Pages 构建都写同一个 `dist`，同一 worktree 中按顺序执行。

## 文档发现与验证

新增 `docs/labs/<id>.md` 自动进入阅读器、搜索和章节导航。一级标题用作文档名，首个段落用作简介。章节 slug 为 `labs/<id>`，用 `docHref('labs/<id>')` 生成编码后的 hash。相对 Markdown 链接按照当前文档目录解析；未知文件与越界路径不会变成有效文档链接。

验证包括：原有三实验回归、注册表的无效 / 重复 ID、没有协议的新实验、按身份定位且载荷不变、HTTP / 静态合约一致、嵌套文档搜索与深链接、两实例端口和 health 隔离。

继续阅读：[学习地图](../README.md)、[真实开发路径](../04-real-development.md)。
