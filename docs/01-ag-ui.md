# AG-UI：从事件流到真实界面

本章对应独立实验 `/#agui`。浏览器会把标准 `RunAgentInput` POST 到本地 Express 服务，服务端通过真实 HTTP/SSE 逐条发送 AG-UI 事件，前端在网络边界用官方 schema 校验，再用一个手写 reducer 投影成消息、工具卡片和任务状态。

首页聊天复用相同的服务与 reducer，并增加暂停展示、事件回放、状态差异和本地事件编辑。聊天中的“暂停展示并观察”只冻结展示，后台仍继续接收；“取消运行”才请求服务端结束运行。具体操作见 [从观察到独立开发](07-learning-method.md)。本章的输入框和“协议取消”等按钮名对应独立实验。

GitHub Pages 静态学习版复用 `shared/agui-agent.ts` 的事件引擎，在浏览器内生成相同事件并通过本地 `ReadableStream` 演示 SSE 编码，没有真实 HTTP / SSE 连接。取消、断流、reducer 和回放仍可操作；检查器标记 `browser-memory`。本章网络说明对应本地模式，模式差异见 [运行与部署](04-real-development.md#5-准备部署)。

## 版本与实验边界

- npm 包：`@ag-ui/core@1.0.3`
- 协议声明：`protocolVersion: "1.0"`
- 传输：HTTP POST + `text/event-stream`
- Agent：确定性 TypeScript 状态机，不调用 LLM
- 工具：本地 `lookup_trip_fixture` 函数，只读取杭州、成都、上海的 fixture
- 前端：教学用有限 reducer，不是完整 AG-UI client

选择确定性 Agent 是为了把两类变量拆开：先观察稳定、可重复的协议行为，再在真实开发阶段替换 Agent 决策层。输入仍然会影响输出：城市、天数和偏好会进入 `RunAgentInput`、分段工具参数及 fixture 排序。

## 一次成功运行的时序

```text
Browser                          Express / deterministic Agent
   |  POST /api/agui (JSON)                    |
   |------------------------------------------>|
   |  RUN_STARTED                              |
   |<------------------------------------------|
   |  STATE_SNAPSHOT                           |
   |<------------------------------------------|
   |  TEXT_MESSAGE_START                       |
   |  TEXT_MESSAGE_CONTENT ...                 |
   |  TEXT_MESSAGE_END                         |
   |<------------------------------------------|
   |  TOOL_CALL_START                          |
   |  TOOL_CALL_ARGS (fragment 1)              |
   |  TOOL_CALL_ARGS (fragment 2)              |
   |  TOOL_CALL_END                            |
   |<------------------------------------------|
   |           local fixture tool executes     |
   |  TOOL_CALL_RESULT                         |
   |  STATE_DELTA (RFC 6902 patch)             |
   |<------------------------------------------|
   |  more text + state events                 |
   |<------------------------------------------|
   |  RUN_FINISHED { outcome: {type:"success"} }|
   |<------------------------------------------|
   |  response body closes                     |
```

重要区别：`TOOL_CALL_END` 表示参数流已经完整，不表示工具执行已有结果。结果由单独的 `TOOL_CALL_RESULT` 事件承载。

## HTTP/SSE 的职责

请求体是一个 UTF-8 JSON `RunAgentInput`，客户端发送：

```http
POST /api/agui
Content-Type: application/json
Accept: text/event-stream
```

成功启动后，响应是 `200 text/event-stream`。每个 SSE `data` 字段包含一个完整 JSON 协议事件：

```text
data: {"type":"RUN_STARTED","threadId":"...","runId":"...","protocolVersion":"1.0"}

```

SSE chunk 边界和事件边界不是一回事。因此 `shared/sse.ts` 会缓存未完成 frame；它也接受 CRLF、忽略注释，并在最后残留半个 frame 时报告截断。

服务端在每次写入前调用 `EventSchemas.parse(event)`。客户端收到 JSON 后再次调用官方 `EventSchemas`，随后才进入教学 reducer。双端校验不是协议要求的唯一架构，而是实验为了让错误更靠近来源。

## 生命周期与终止

本实验遵守 AG-UI 1.0 生命周期规则：

- 流从 `RUN_STARTED` 或 `RUN_ERROR` 开始。
- 正常或取消运行以 `RUN_FINISHED` 结束。
- 运行失败以 `RUN_ERROR` 结束；`RUN_ERROR` 没有 `runId` 字段。
- `RUN_FINISHED` 之前必须关闭已打开的文本消息和工具调用。
- `RUN_ERROR` 会终止并隐式关闭仍开放的项，因此 reducer 不要求错误前补发所有 `END`。
- HTTP 状态 `200` 只说明流成功打开，不能代表 Agent 成功。
- SSE 在终止事件之前断开就是截断运行，不能推断为成功。

### 取消不是断网

实验提供两个按钮来刻意展示不同语义。

“协议取消”调用实验扩展端点：

```http
POST /api/agui/:runId/cancel
```

服务端设置取消标记，保持原 SSE 连接，补齐当前开放消息或工具调用的结束事件，最后发送：

```json
{
  "type": "RUN_FINISHED",
  "threadId": "...",
  "runId": "...",
  "outcome": { "type": "cancelled" }
}
```

“中断 HTTP”则调用浏览器 `AbortController.abort()`。这只是传输层断开，前端显示 `truncated`，绝不会伪造一个 `cancelled` 结果。组件卸载也采用这条清理路径，并用 mounted/sequence 守卫阻止卸载后的状态更新。

标准 HTTP/SSE 传输本身没有规定这个 cancel endpoint；它是本实验的服务端控制扩展。真正产品可以使用自己的取消通道，但应继续用协议终止事件表达最终结果。

## 手写 reducer 支持什么

`shared/agui.ts` 有意只实现本页需要的有限集合：

- `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`
- `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`
- `STATE_SNAPSHOT`, `STATE_DELTA`

它检查对应关系和顺序，例如 content 必须找到开放的 message，工具 args 必须先拼接成完整 JSON，成功终止时不能还有开放项。未实现的合法 AG-UI 事件会被明确拒绝，不会悄悄忽略。

这不是完整 client。它没有实现 reasoning、step、activity、subagent、interrupt、message snapshot、多运行复用流等能力。生产项目应采用完整 SDK/client 或系统性实现官方状态机，不要把这个教学 reducer 直接复制成通用协议层。

## STATE_DELTA：只支持 replace

AG-UI 的 `STATE_DELTA.delta` 是 RFC 6902 JSON Patch。协议 schema 允许 `add`、`remove`、`replace`、`move`、`copy`、`test`，但本实验的 patch applier只支持：

- `op: "replace"`
- 目标必须已经存在
- 合法且防原型污染的 RFC 6901 JSON Pointer
- JSON 值

它支持对象和数组路径，例如 `/tasks/1/status`；遇到其他操作会抛出明确错误。这里绝不声称实现了通用 RFC 6902。选择小而安全的子集，目的是让状态变化容易追踪，同时避免一个不完整实现伪装成标准实现。

## 错误与重试

错误分为三层：

1. **启动前 HTTP 错误**：无效 `RunAgentInput`、超限、重复 `runId`，返回 JSON 4xx/429，不打开 SSE。
2. **协议内失败**：选择“模拟错误”后，流已经开始，服务端发送 `RUN_ERROR`。
3. **传输/客户端错误**：网络断开、截断 frame、schema 或 reducer 拒绝，前端进入 `truncated` 并提供重试。

每次重试会创建新的 `runId`。服务端同时维护有上限的活动运行表和短时 recent ID 表，防止并发泄漏和重复 ID；响应关闭后会清理活动运行。写 SSE 时处理 `response.write()` 背压，连接断开则停止延迟与后续事件。

## 建议的操作顺序

1. 选择上海、2 天，偏好填写“想看展”，运行并观察工具参数分成两个 `TOOL_CALL_ARGS`。
2. 在检查器中比较 `STATE_SNAPSHOT` 与后续 `STATE_DELTA`。
3. 改成“慢节奏、散步”，确认工具参数和第一天安排变化。
4. 运行后点“协议取消”，找到 cancelled 的 `RUN_FINISHED`。
5. 再运行并点“中断 HTTP”，比较 `truncated` 与 `cancelled`。
6. 选择“模拟错误”，确认最后是 `RUN_ERROR`，且没有 `RUN_FINISHED`。
7. 运行 `npm test -- tests/agui.test.ts`，对照测试理解协议不变量。

## 从哪里继续读

按数据流顺序阅读：

1. `src/labs/AguiLab.tsx`：组装请求、消费 SSE、区分取消与中断。
2. `shared/agui-agent.ts`：输入限制、确定性 Agent、本地工具与事件生成；`server/agui.ts` 负责 HTTP / SSE 写入与清理。
3. `shared/agui.ts`：官方 schema 边界、教学 reducer、replace-only patch。
4. `tests/agui.test.ts`：成功、错误、取消、截断和非法输入的可执行规范。

阅读聊天学习功能时，再看 `src/components/AguiChatTurn.tsx` 如何保存实际事件前后的状态、`shared/agui-learning.ts` 如何解释差异，以及 `src/components/AguiLearningPanel.tsx` 如何回放与试运行。回放和实验复用记录状态，不重新请求 Agent；实验预览不写回真实对话。

官方资料：

- 生命周期：<https://docs.ag-ui.com/spec/1.0/events/lifecycle>
- HTTP + SSE：<https://docs.ag-ui.com/spec/1.0/basic/transports/http-sse>
- Core 源码与 schema：<https://github.com/ag-ui-protocol/ag-ui>
