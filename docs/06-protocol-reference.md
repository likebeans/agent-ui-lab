# 消息对照速查

这份表用来读右侧检查器，不代替完整规范。字段形状应以本项目固定的协议版本及官方 schema 为准。

## 先看方向，再看消息名

| 方向                              | 发生在哪里                                               |
| --------------------------------- | -------------------------------------------------------- |
| `client→server` / `server→client` | 浏览器与本地 HTTP、SSE 或 MCP 服务之间                   |
| `app→host` / `host→app`           | 沙箱 iframe 内的 App 与父页面 Host 之间                  |
| `local`                           | 浏览器中的绑定写入、校验、实验或状态记录，没有跨服务边界 |

`learning/…` 是本项目的教学 trace 标签，不是协议标准事件。AG-UI 的回放面板保存实际事件与状态；编辑后试运行产生的是本地实验。A2UI Workshop 的本地应用也不等于服务端发送了 `updateComponents`。

## AG-UI：事件名不是业务状态

| 事件                   | 你应观察的字段                       | 含义                                           |
| ---------------------- | ------------------------------------ | ---------------------------------------------- |
| `RUN_STARTED`          | `threadId`, `runId`                  | 一次运行开始                                   |
| `TEXT_MESSAGE_START`   | `messageId`, `role`                  | 为文本流建立身份                               |
| `TEXT_MESSAGE_CONTENT` | `messageId`, `delta`                 | 追加一段文字，不是替换整个消息                 |
| `TEXT_MESSAGE_END`     | `messageId`                          | 这一条文本消息关闭，整个 run 仍可能继续        |
| `TOOL_CALL_START`      | `toolCallId`, `toolCallName`         | 开始描述工具调用                               |
| `TOOL_CALL_ARGS`       | `toolCallId`, `delta`                | 参数文本的片段，不能单片段解析                 |
| `TOOL_CALL_END`        | `toolCallId`                         | 工具调用描述已结束，不代表业务工具已经成功执行 |
| `TOOL_CALL_RESULT`     | `messageId`, `toolCallId`, `content` | 工具结果消息到达                               |
| `STATE_SNAPSHOT`       | `snapshot`                           | 完整替换共享状态                               |
| `STATE_DELTA`          | `delta`                              | 按 JSON Patch 顺序修改共享状态                 |
| `RUN_FINISHED`         | `threadId`, `runId`, `outcome`       | 正常终止，包括确认取消                         |
| `RUN_ERROR`            | `message`, `code`                    | 运行失败                                       |

确认取消是 `RUN_FINISHED` + `outcome: { type: "cancelled" }`。客户端 AbortController 断开连接不会凭空生成这个服务端确认。异常断流、用户停止读取、服务端取消应区别处理。

## A2UI：结构、数据、动作分离

所有消息使用 `version: "v0.9.1"`。

| 消息               | 关键字段                                                         | 本实验中的效果         |
| ------------------ | ---------------------------------------------------------------- | ---------------------- |
| `createSurface`    | `surfaceId`, `catalogId`                                         | 创建界面上下文         |
| `updateDataModel`  | `surfaceId`, `path`, `value`                                     | 初始化或更新绑定数据   |
| `updateComponents` | `surfaceId`, `components`                                        | 按 ID 替换完整组件定义 |
| `action`           | `name`, `surfaceId`, `sourceComponentId`, `timestamp`, `context` | 发送已经解析的用户操作 |
| `deleteSurface`    | `surfaceId`                                                      | 删除整棵界面与数据模型 |

`TextField.value: { path: "/form/traveler" }` 描述绑定。用户输入会先更新本地模型，按钮 action 才发送明确选择的 context。`ChoicePicker` 即便单选也绑定字符串数组。

不要混用旧版 `beginRendering`、`surfaceUpdate`、`dataModelUpdate`、`userAction` 与 v0.9.1 的消息键。

## MCP Apps：两段协议连接

| 边界              | 消息                           | 作用                       |
| ----------------- | ------------------------------ | -------------------------- |
| Host ↔ MCP Server | `initialize`                   | 协商 MCP 能力              |
| Host → MCP Server | `tools/list`                   | 发现工具与 UI 元数据       |
| Host → MCP Server | `resources/list`               | 列出本实验已注册的布局资源 |
| Host → MCP Server | `resources/read`               | 读取 `ui://` HTML 资源     |
| Host → MCP Server | `tools/call`                   | 执行业务工具               |
| App → Host        | `ui/initialize`                | 应用与宿主协商             |
| App → Host        | `ui/notifications/initialized` | 应用握手完成               |
| Host → App        | `ui/notifications/tool-input`  | 提供完整工具输入           |
| Host → App        | `ui/notifications/tool-result` | 提供工具执行结果           |
| App → Host        | `tools/call`                   | 应用请求宿主代理工具调用   |

同名 `tools/call` 可能跨两个不同边界出现，不能把它们当成两次用户操作。检查器的方向标签用来定位当前观察的是哪一段链路。

本项目的 App 使用官方桥接 SDK；Host 的单 iframe 是本地自有资源的教学简化。标准 Web Host 的 Sandbox Proxy、独立源双 iframe 和 HTTP CSP 需要在后续托管实现中补齐。

## 学习实验的证据标签

| 标签或字段                 | 对照内容                                                            |
| -------------------------- | ------------------------------------------------------------------- |
| `learning/agui-event`      | 修改后的事件，以及受影响状态的更新前后值；真实对话不变              |
| `learning/agui-append`     | `before`、`delta`、`after` 和实际计算的 `appended`                  |
| `learning/a2ui-validation` | 草稿是否通过本地校验；失败时保留上次有效 Surface                    |
| `learning/a2ui-component`  | 当前 Renderer 使用的组件声明与模型快照，包含本地修改                |
| `learning/a2ui-binding`    | 绑定路径、模型前后值、`componentsUnchanged` 和 `httpRequest: false` |
| MCP 实验的 `comparison`    | 本次新增的 `resourceReads`、`iframeMounts`、`toolCalls`             |

MCP 实验直接定位实际 `tools/call` 或 `resources/read` 响应，实验结论还需结合 App 中显示的数据。计数表示 Host 发起的操作；App 就绪另由 `ui/notifications/initialized` 确认。资源响应中的 HTML 文本在检查器中被缩略，URI、MIME、文档标记和长度仍可核对。

## 官方依据

- <https://docs.ag-ui.com/spec/1.0/events/lifecycle>
- <https://docs.ag-ui.com/spec/1.0/events/tool-calls>
- <https://docs.ag-ui.com/spec/1.0/events/state>
- <https://github.com/a2ui-project/a2ui/tree/3eb145de4fca475c0d2ada076fd91bb22b0d98ec/specification/v0_9_1>
- <https://github.com/modelcontextprotocol/ext-apps/blob/v2.0.3/specification/2026-01-26/apps.mdx>
- <https://apps.extensions.modelcontextprotocol.io/api/documents/migrate-to-v2.html>
