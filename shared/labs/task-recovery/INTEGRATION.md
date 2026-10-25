# W1 task-recovery 接口约定

任务恢复实验已接入普通本地服务和 Pages 总入口。应用事件 envelope 与 AG-UI payload 分开，实验的业务状态机独立于 W2 审批。

## HTTP / Pages adapter

路径前缀 `/api/labs/task-recovery`。

- `GET /tasks?threadId=...` → `{ tasks: RecoveryTask[], persistence }`。
- `POST /tasks`，`CreateRecoveryTask` → `{ task: RecoveryTask, persistence }`。相同 commandId/input 幂等；同键异参拒绝。
- `GET /tasks/:taskId` → `{ task: RecoveryTask, persistence }`。
- `GET /tasks/:taskId/recovery` → `RecoveryReadResult`，在同一读取快照内返回权威 task、checkpoint 和 checkpoint 后 events。
- `GET /tasks/:taskId/replay?runId=...&afterSeq=...` → `{ events: RecoveryEvent[], persistence }`。只返回指定 task/run；非法或超前 cursor 明确拒绝。
- `GET /tasks/:taskId/events?runId=...&afterSeq=...` → SSE，每帧 `id: <runId>:<seq>`，`data: <RecoveryEvent JSON>`。明确的 query cursor 是排他游标，`Last-Event-ID` 不覆盖它。流绑定指定 run；disconnect 只关连接，后台 runner 继续。
- `POST /tasks/:taskId/commands`，`RecoveryCommand` → `RecoveryCommandResult`。accepted 200；conflict 409；rejected 400。命令幂等先于 expectedVersion 校验；start 仅 queued，retry 仅 terminal 且使用新 run ID，cancel 仅 running。run ID 全局唯一。

默认任务产生官方 AG-UI 事件：开始、文本片段、工具调用/结果、快照与完成。`toolExecutionCount` 统计本地模拟工具记录的执行次数。工具记录、事件、reducer 状态、checkpoint 和版本位于同一 SQLite 事务；这不承诺任意外部服务的 exactly-once。

## 模块与资源所有权

- `contract.ts`：类型、schema、状态与应用事件 envelope。
- `engine.ts`：`recoveryPlan`、`reduceRecoveryState`，供两种适配使用。
- `client.ts`：checkpoint 恢复、事件投递与校验。重复、旧 run、其他 task 不改变状态；gap 不跳过 cursor。
- `memory.ts`：`createRecoveryFixture()`，包含 `handle`、`reset`、`close`。独立 timer/store，刷新重置，无 Node import。
- `server/storage/sqlite.ts`：`openLabDatabase({ dataDir, filename? })`，同步事务、带校验和的迁移与幂等关闭。异步回调在执行前拒绝，返回 thenable 时回滚同步写入。
- `server/labs/task-recovery/store.ts`：SQLite 恢复存储、同步读取与事务性推进。
- `server/labs/task-recovery/index.ts`：`createTaskRecoveryRouter({ database, stepDelayMs? })` 返回 router 与 close；close 停止 runner/stream，数据库由调用者管理。初始化时继续未终止任务。
- `src/labs/task-recovery/`：实验、manifest 与接流会话。URL 保存 thread/task 身份；浏览器不保存权威任务事实。

`server/labs/index.ts` 为 W1/W2 创建或注入同一 `LabDatabase`，初始化各自迁移并汇总清理。`app.locals.closeLabs()` 结束模块，再关闭自有连接；注入连接留给调用者关闭。监听失败、SIGINT/SIGTERM 和测试宿主都调用该入口。最低 Node 为 22.13，内置 SQLite 无需 npm 数据库依赖。

Pages 的 `shared/labs/static-handlers.ts` 登记一个页面内 recovery fixture。正式测试服务不再注入重复的 fixture 声明或优先挂载另一套 router；遗漏正式登记应直接导致回归失败。

## 版本、检查点与工具记录

创建版本为 1，尚无 run，checkpoint cursor 为 `{ runId: '', afterSeq: 0 }`。只有 queued/currentRunId=null 允许空 cursor；HTTP replay/SSE 仍要求真实 run ID。

start/retry 在一个事务内递增任务版本、建立不可变 run plan、记录 RUN_STARTED 并保存 seq=1 的 checkpoint，返回版本增加 2。后续每条事件递增版本 1，每四条和终态保存 checkpoint。cancel 追加 RUN_FINISHED/cancelled，递增版本 1 并保存终态 checkpoint。

recovery 响应中 `task.version - checkpoint.task.version === events.length`。客户端逐条连续重建，并将投影与权威状态比较。新 run 清空文本和卡片，保留累计工具计数。查询和恢复不推进 plan；已提交工具结果不会因恢复重复执行。

## 运行与验证

普通 `npm run dev` 后打开 `/#labs/task-recovery`。本地数据目录来自 `LAB_DATA_DIR`，在 worktree 之间隔离。

```bash
npm run check
npm run format:check
npm run test:e2e
npm run test:pages
```

日常 local/Pages 套件通过各自的 spec 入口复用 `recovery.browser.ts`，覆盖断流、恢复、重复事件、序号缺口、取消、新 run 隔离、刷新、文档往返与手机布局。Pages 另验证内存重置且没有恢复 API 网络请求。

保留专项配置用于单独调试，仍使用正式登记：

```bash
npx playwright test --config e2e/labs/task-recovery/playwright.config.ts
LAB_RECOVERY_TEST_MODE=pages npx playwright test --config e2e/labs/task-recovery/playwright.config.ts
```

专项 Pages 构建写到配置的数据目录，使用 `/w1-pages/` 子路径。普通与 Pages 默认构建共用 `dist`；同一工作区按顺序运行。并行套件应分开端口和测试产物目录。

`tests/labs/task-recovery-process.test.ts` 使用独立进程在工具提交前后中断并重启同一数据库。`tests/labs/integration.test.ts` 从正式 createServer 同时验证 W1/W2、活动事件流关闭、重启接续、独立业务事实和重复命令。
