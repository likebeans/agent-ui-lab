# W1：任务恢复与事件重放

[任务恢复实验](#labs/task-recovery)演示一个确定性任务：创建任务、开始运行、逐步记录 AG-UI 文本与本地样本工具结果，最后显示固定卡片。断开事件连接后，后台任务独立推进；客户端重新读取 checkpoint 与后续记录，恢复同一个 run 的投影。本实验没有 LLM，也没有接入聊天。

## 先区分任务、执行和连接

thread 是任务所属的会话，task 是持续追踪的工作目标，run 是一次执行。task 的 `currentRunId` 指向当前执行；重新执行仍属于同一个 task，但必须分配全新的 run ID。重放已有记录继续使用原来的 run ID。

服务端维护 `TaskSnapshot`，包含 `version`、`status`、`currentRunId` 和业务状态。页面维护 `RecoveryProjection`，包含 task、run、已连续应用的 `afterSeq` 与呈现状态。服务端快照是最近查询时点的权威值；客户端投影只反映它已收到且确认连续的记录。断线时二者可以暂时不同。

SSE 是读取事件的连接，不是任务的生命周期。页面的 `AbortController.abort()` 关闭连接；任务是否取消，需要向服务端发送 `cancel` 命令，再读取服务端确认。

| 操作     | 任务 / run                                   | 客户端观察                         |
| -------- | -------------------------------------------- | ---------------------------------- |
| 新建任务 | 创建 queued task，尚未开始 run               | 可以开始执行或按身份查询           |
| 开始执行 | 仅 queued 接受 start；创建新 run             | 恢复初始记录并接流                 |
| 断开接流 | 任务继续独立推进                             | 只关闭 SSE，投影可能落后           |
| 查询任务 | 读取已有任务和恢复记录                       | 重建投影，保持未接流               |
| 恢复连接 | 查询 checkpoint + events，然后按 cursor 接流 | 继续当前 run；终态无需维持连接     |
| 取消任务 | 仅 running 接受 cancel                       | 先显示请求中，服务端返回后确认结果 |
| 重新执行 | 仅终态 task 接受 retry；创建新 run           | 新 run 从新投影开始；旧 run 被隔离 |

当前终态为 `succeeded`、`failed`、`cancelled`。`waiting-input` 是公共任务契约预留状态，本确定性样本没有等待人工输入步骤。

## 实验一：断开连接后恢复

1. 打开实验，保留自动生成的 Thread ID。Task ID 留空，点击“新建任务”。
2. 确认服务端状态为 queued，点击“开始执行”。观察当前 run、接流状态、cursor 和文字逐步变化。
3. 趁任务尚在运行，点击“断开接流”。接流状态显示断开，取消确认仍独立显示；服务端后台不会因这次断连而取消。
4. 等待片刻，点击“查询任务”。页面读取服务端权威状态并通过恢复响应重建投影，保持未接流。
5. 点击“恢复连接”。如果任务仍在运行，继续接收同一个 run；如果已完成，则显示终态与固定结果卡片。
6. 比较 `toolExecutionCount`。重复查询、恢复或重放已有记录不会再次执行本地工具。

“服务端权威状态”显示最近读取时间，不会把旧快照标成实时状态。接流过程中 cursor 可以继续前进，而服务端一列要等下一次查询或命令响应才更新。连接自然结束时，页面会再次查询权威状态；仅凭 EOF 不推断任务成功。

## 实验二：刷新与身份恢复

本地模式把 thread/task 身份写在 URL query 的 `recoveryThread` 和 `recoveryTask`，保留实验 hash。URL 不保存状态、结果、版本或 cursor，也不是访问控制凭据。本实验不把任务事实写入 localStorage。

页面首次挂载、返回实验或从文档回来时，使用 URL 或当前选择的身份查询已有任务，通过同一个恢复响应中的 checkpoint 和后续 events 重建投影。然后从恢复的 cursor 接流。输入 Task ID 为空时，“查询任务”会列出此 thread 的任务；有多个结果时，选择一个恢复。新建另一个任务前，清空或更换 Task ID，避免重复创建已存在的 ID。

本地 SQLite 数据位于该 worktree 的 `LAB_DATA_DIR`。刷新后，只要使用同一份数据库和有效身份，就能重新读取任务。关闭浏览器不关闭服务端 runner；服务端退出期间没有任务执行，重启后 adapter 从已保存的未终止任务继续推进。服务端进程和数据目录的生命周期由 host 管理。

**Pages 使用 `memory-fixture` 内存模拟。刷新会重新创建样本，清空任务、事件、checkpoint 与工具记录；URL 留下的身份不能恢复已经清空的数据。** 断开接流、阅读文档和返回实验可在当前页面生命周期内演示恢复。刷新后查询旧 ID 会提示找不到任务，请新建任务。页面提供的“重置内存样本”调用 `DELETE /api/labs/task-recovery/fixture`，同样会清空这一页全部 W1 样本；未提供该可选接口的 host 会明确返回错误。

## 实验三：取消必须得到确认

开始一个任务，在 running 时点击“取消任务”。界面先显示“取消请求中，尚未确认”，同时禁用依赖当前操作的按钮。只有服务端返回并确认 `cancelled` 才显示“服务端已确认取消”。

任务可能在查询版本与提交命令之间继续推进。命令遇到 `expectedVersion` 冲突时，页面重新查询状态并展示冲突原因，等待下一次明确操作，不会自动重试命令。如果请求中断或结果未知，界面显示“取消未确认，请查询任务状态”；这时任务可能已取消，也可能继续执行，需查询事实。

取消前已经提交的本地工具结果仍保留。如果工具尚未执行，取消不会补执行工具。`cancelled` 表示任务的已确认终态，不承诺回滚已经发生的副作用。

## 实验四：重复、旧 run 和序号缺口

打开“投递故障实验”。这些按钮只改变浏览器如何投递已有记录，不修改服务端任务或事件，也不会发送开始或重试命令。

- **重复事件**：重新读取一条已应用的真实事件，再交给 `deliverRecoveryEvent`。返回 `duplicate`，cursor、文字、卡片和工具计数保持不变。
- **迟到旧 run**：先完成或取消一次执行，再点击“重新执行（新 run）”。页面保存前一次 run 的真实事件，之后投递到新 run 的投影。返回 `stale-run`，旧结果不会覆盖当前执行。这个内存中的注入样本不跨刷新保留。
- **序号缺口**：使用真实事件模拟从头接流时漏收第 1 条记录。页面创建仅用于本地实验的空投影，然后先投递第 2 条。返回 `gap` 时 cursor 保持 0；随后按 cursor 补拉 replay，再查询 checkpoint 校准并恢复连接。实验说明会明确显示暂时重建投影的过程。

正常接流也使用同一投递边界。其他 task、旧 run 与重复序号不能推进投影；不是下一个连续序号的事件触发 gap，页面暂停当前接流并恢复。补拉不可用或仍有缺口时，查询原子的 checkpoint + events 响应；不会简单跳过缺失记录或用一份旧权威状态掩盖不完整的重放。

组件用异步 generation、任务身份与 run/cursor 校验保护请求和接流。切换身份、新命令、断连、隐藏或卸载会使旧连接失效；旧回调不能修改当前选择的任务。阅读文档等 `active=false` 状态下暂停展示和注入，返回时重新查询；隐藏或卸载不是取消命令。

## checkpoint、事件与 AG-UI 的边界

应用事件 envelope 保存关联身份与连续序号，AG-UI 消息位于 `payload`。例如：

```json
{
  "taskId": "task-example",
  "runId": "run-example",
  "seq": 4,
  "payload": {
    "type": "TEXT_MESSAGE_CONTENT",
    "messageId": "message-example",
    "delta": "正在读取本地任务样本。"
  }
}
```

`seq`、task 与应用关联信息不注入官方 AG-UI payload。payload 使用 `@ag-ui/core/schemas` 的官方 schema 校验，事件 reducer 只处理本实验支持的确定性事件。实验会产生开始、文本片段、工具调用 / 参数 / 结果、状态快照与完成事件；取消也通过已记录的终态事件恢复。

`GET /tasks/:taskId/recovery` 在一次读取快照内返回权威 task、checkpoint 和 checkpoint 后的 events。客户端从 checkpoint 恢复初始投影，再按序应用 events，核对任务、run、连续序号、版本和最终状态。恢复响应校验失败时显示错误，不将不完整事件当作恢复成功。

SQLite adapter 将本地工具结果记录、事件、reducer 状态、checkpoint 与版本放在同一事务里推进。检查点周期为 `CHECKPOINT_INTERVAL`，终态也会保存 checkpoint；客户端无需假设每次恢复都有增量事件。SSE 每帧的 `data` 是完整 envelope，`id` 为 `<runId>:<seq>`；页面用 `consumeSse` 处理帧与网络 chunk 边界，用显式 query cursor 接续。流捕获指定 run，不随 task 的新 run 悄悄切换。

点击“定位最近事件记录”可用 task、run、seq 和事件类型定位到检查器。`runtime.trace` 的协议记录保持 `payload: event.payload`，外层保存 `threadId`、`taskId`、`runId` 和 `seq`；HTTP 查询、命令及恢复说明另有应用 trace。检查器中的原始载荷因此可以直接与官方事件对照。

## 命令、幂等与计数的精确范围

命令携带 `commandId`、`taskId`、`expectedVersion` 与 action。相同 commandId 和相同输入返回原收据；同键异参拒绝，幂等判断先于版本校验。start 只接受 queued，retry 只接受终态，cancel 只接受 running；所有 run ID 全局唯一。界面每次明确执行新的命令生成新的 commandId；查询、重放和重新连接不会生成执行命令。

`toolExecutionCount` 统计此 task 中本地模拟工具记录的真实执行次数，会跨该 task 的新 run 累计。重新执行会产生一个新的工具结果；恢复同一 run 不会增加计数。此处只证明本实验 SQLite 中的本地业务写入与记录一致，不承诺支付、邮件、远程 API 等外部副作用的 exactly-once。Pages 计数属于当前内存 fixture，没有持久化保证。

实验没有用户认证、跨设备同步、分布式调度、外部工具执行或生产级任务队列。thread/task ID 用于教学关联；本地数据库、原子记录与可恢复投影的边界需要与真实应用的授权、幂等和副作用设计分别处理。

## 源码与集成入口

- `shared/labs/task-recovery/contract.ts`：冻结类型、schema、状态与接口常量。
- `shared/labs/task-recovery/engine.ts`：确定性事件计划与纯 reducer。
- `shared/labs/task-recovery/client.ts`：checkpoint 投影、投递去重和恢复校验。
- `shared/labs/task-recovery/memory.ts`：浏览器安全、刷新重置的 Pages fixture。
- `server/labs/task-recovery/store.ts` 与 `index.ts`：SQLite 事务、后台推进、HTTP / SSE adapter。
- `src/labs/task-recovery/manifest.ts`：自动发现的导航和学习元信息。
- `src/labs/task-recovery/Lab.tsx`、`useRecoverySession.ts`、`lab.module.css`：界面、连接生命周期与局部主题样式。

浏览器依赖只使用 shared 和 src，Node SQLite 与 Express 留在 server。W1 没有新增依赖，不修改公共 CSS 或配置；实验通过 `runtime.request` 接入本地 HTTP 或 Pages handler。

公共 adapter 已在 `server/labs/index.ts` 与 `shared/labs/static-handlers.ts` 登记，普通 `npm run dev` 与 Pages 均可使用。服务启动创建 W1/W2 共用数据库，shutdown 停止 runner、关闭事件流并释放自有连接。日常本地与 Pages 浏览器测试使用正式入口；专项测试服务也不再注入另一套 router 或 fixture。manifest 自动发现只负责导航，新增模块仍须登记两端 adapter。
