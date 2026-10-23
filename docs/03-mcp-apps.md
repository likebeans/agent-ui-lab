# MCP Apps：从工具结果到可交互应用

本章对应 `/#mcp`。实验使用 MCP TypeScript SDK v2 与 `@modelcontextprotocol/ext-apps@2.0.3`，完成一条真实链路：浏览器 MCP Client 经 Streamable HTTP 连接本地 MCP Server，发现工具、读取 `ui://` HTML 资源、调用工具，再由 Host 通过 AppBridge 与沙箱 iframe 中的 App 建立双向 JSON-RPC 通道。

GitHub Pages 静态学习版使用官方 `InMemoryTransport`，让 MCP Client 与 `shared/mcp-server.ts` 创建的 Server 在浏览器内交换相同 JSON-RPC，没有 `/mcp` HTTP 请求。App HTML 在构建时生成；iframe 中的 App / Host 握手和工具代理仍真实执行。本章 Streamable HTTP 描述对应本地模式，见 [运行与部署](04-real-development.md#5-准备部署)。

所有城市活动均来自项目内只读 fixture。页面中的“确定性 Agent”只是固定代码路径：没有 LLM、没有外部数据请求，也不产生预订或持久化副作用。

聊天入口复用同一个 Host，并增加工具数据更新与 UI 资源切换的对照实验，见 [从观察到独立开发](07-learning-method.md)。本章按钮与手动打开行为对应独立实验；聊天中的新回复会自动打开 App。

## 先看完整路径

点击“打开 MCP App”后，浏览器按顺序执行：

1. `Client.connect(StreamableHTTPClientTransport)` 请求 `/mcp`，完成 MCP 初始化。
2. `tools/list` 找到 `get_trip_activities`，从工具 `_meta.ui.resourceUri` 取得 `ui://intelligent-ui/trip-picker`。
3. `resources/list` 确认两个受控布局资源已经注册，随后 `resources/read` 读取默认资源，MIME 为 `text/html;profile=mcp-app`。
4. `tools/call` 用 `{ "city": "shanghai" }` 取得首次工具结果。
5. Host 挂载带有 `srcDoc` 的 iframe，在同次 React 提交的 `useLayoutEffect` 中连接 `AppBridge + PostMessageTransport`，先于异步 postMessage 事件投递安装监听器。
6. iframe 中的 `App` 发送 `ui/initialize`，Host 返回初始化结果，App 再发送 `ui/notifications/initialized`。
7. Host 收到 initialized 后，严格先 `sendToolInput`，再 `sendToolResult`。
8. 用户在 iframe 中切换城市。App 调用 `callServerTool`，请求经 postMessage 到 Host；Host 检查工具 allowlist 后，才经 Streamable HTTP 转发到 MCP Server。

右侧检查器显示两条不同的传输边界：

- `client→server` / `server→client`：浏览器 Host 与 `/mcp` 之间的原始 JSON-RPC。
- `app→host` / `host→app`：iframe App 与 AppBridge 之间的原始 JSON-RPC。
- `local`：allowlist 判定、会话就绪、清理与错误等 Host 本地事件，不是假装成协议消息。

检查器保留实际 JSON-RPC 信封和关联请求；`resources/read` 中的 HTML 文本会缩略为文档标记、根节点及长度，避免展开整份 SDK bundle。完整资源仍由 Host 实际读取并挂载。

## 工具怎样关联 UI 资源

服务端注册的工具声明包含：

```json
{
  "name": "get_trip_activities",
  "annotations": {
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "_meta": {
    "ui": {
      "resourceUri": "ui://intelligent-ui/trip-picker",
      "visibility": ["model", "app"]
    }
  }
}
```

`tools/list` 只负责发现工具及其关联 URI；HTML 本身不塞进工具定义。Host 随后用 `resources/read` 读取资源。这个分离允许 Host 在决定展示 UI 前检查 MIME、CSP 元数据、权限和来源策略。

资源 URI 必须使用 `ui://`，本实验的 MIME 必须是：

```text
text/html;profile=mcp-app
```

服务端用 esbuild 在内存中把 `src/mcp-app.ts` 和官方 App SDK 打成 IIFE，再内联进 HTML。资源没有外部脚本、样式表、字体或网络依赖；首次构建后缓存结果。

## `content`、`structuredContent` 与 `_meta`

本实验的工具结果包含前两项；UI 资源关联放在工具定义的 `_meta` 中：

- `content`：面向普通 MCP Host 和模型上下文的文本降级结果。即使 Host 不支持 Apps，仍能显示“已从本地 fixture 读取杭州的 3 项活动”。
- `structuredContent`：给程序和 UI 使用的机器可读结果，包括 `city`、`cityLabel`、`theme`、`activities`、`source` 与 `deterministic`。
- `_meta.ui.resourceUri`：在 `tools/list` 返回的工具定义中关联 UI 资源。本实验没有给 `CallToolResult` 额外添加 `_meta`；其他应用可以通过结果的 `_meta` 提供仅供 Host/UI 使用的辅助数据。

本实验的 App 会验证 `structuredContent.source === "local-fixture"` 和 `deterministic === true`，再渲染活动卡片。不要让 UI 依赖解析自然语言文本；也不要把只有 UI 能看懂的重要结果全部藏进 `_meta`。

## 两次握手，不是一件事

### 核心 MCP 握手

Host 的 Client 与 MCP Server 通过 `/mcp` 通信：

```text
Client                         MCP Server
  | ---- initialize ------------> |
  | <--- initialize result ------- |
  | ---- notifications/initialized>|
```

完成后 Client 才调用 `tools/list`、`resources/read` 和 `tools/call`。传输是 Streamable HTTP：请求由 HTTP POST 承载，SDK 可以用 SSE 响应流接收消息。实验使用无状态端点，每个 POST 创建新的 server/transport 处理该 JSON-RPC 请求；集成测试实际走网络端口，而不是 mock SDK。

### MCP Apps 握手

iframe 中的 App 与 Host 的 AppBridge 通过 postMessage 通信：

```text
App                            AppBridge
  | ---- ui/initialize ----------> |
  | <--- initialize result ------- |
  | ---- ui/notifications/initialized >|
  | <--- ui/notifications/tool-input ---|
  | <--- ui/notifications/tool-result --|
```

Host 必须等待 App 的 initialized 通知，才能发送完整工具输入和结果；完整输入必须先于结果。核心 MCP 已连接，不代表 iframe App 已就绪。

### 为什么在 layout effect 中连接桥

iframe 脚本可以在 `load` 事件前发送 `ui/initialize`。如果等到 `onLoad` 或普通 effect 才连接，初始化消息可能早于 Host 的监听器到达。本实验在 React 提交 iframe 的同一次任务中使用 `useLayoutEffect`，取得 `contentWindow`，调用 `bridge.connect(transport)`；官方 PostMessageTransport 的 `start()` 同步安装 message 监听器，随后才处理异步消息。

iframe 直接加载最终 `srcDoc`，不需要先加载空文档再导航一次。`hostStarting` 保证每个会话只连接一次，完成 UI 握手后才发送工具输入与结果。

## App 调用工具时，Host 为什么不能消失

用户点击 iframe 内的城市按钮时，真实路径是：

```text
App.callServerTool
  → PostMessageTransport
  → AppBridge
  → Host allowlist
  → Client.callTool
  → Streamable HTTP /mcp
  → MCP Server tool handler
  → 原路返回 CallToolResult
```

App 没有直接访问 `/mcp`。Host 是能力中介：它决定哪个 App 可以调用哪个工具、是否需要用户确认、如何限流和记录审计。本实验创建 `AppBridge(null, ...)` 并手动实现 `oncalltool`，只允许精确名称 `get_trip_activities`；其他工具名会在 Host 中被拒绝。若把已连接 Client 直接交给 AppBridge 自动转发，App 可能获得超出教学需求的 server tool 能力。

工具还声明 `openWorldHint: false`，服务端只读取三个固定城市的数据。它不接受 URL，不提供任意网络抓取工具，也不使用 LLM。

## 本地安全边界

实验 iframe 使用：

```html
<iframe sandbox="allow-scripts" srcdoc="…"></iframe>
```

刻意没有 `allow-same-origin`。因此 `srcDoc` 文档具有 opaque origin，不能读取父页面 DOM 或存储。PostMessageTransport 还检查 `event.source` 必须是目标 WindowProxy。

HTML 只来自本项目服务端生成的资源，并声明空网络域列表：

```json
{
  "connectDomains": [],
  "resourceDomains": [],
  "frameDomains": [],
  "baseUriDomains": []
}
```

文档内也有严格 CSP：默认拒绝所有资源，只允许内联脚本和样式；`connect-src`、`frame-src`、`object-src`、`base-uri` 与 `form-action` 均为 `none`。这能直观展示能力边界，但它仍是**可信本地教学 Host 的简化实现**，不是完整的第三方 MCP App 托管方案。

## 生产 Host 还需要什么

生产环境不要直接把不受信任的第三方 HTML 当作同页 `srcDoc` 即可完成隔离。更完整的设计通常包括：

1. 在独立 origin 上部署沙箱代理，外层 Host 与内层不受信任 App 使用双 iframe。
2. 由 HTTP 响应头强制 CSP，而不是只依赖 HTML 中可被内容控制的 meta CSP。
3. 验证消息来源、目标 WindowProxy、协议版本、资源归属和允许的 origin。
4. 对工具、外链、下载、剪贴板、摄像头等能力逐项授权；敏感操作增加用户确认、限流和审计。
5. 限制 HTML/消息/资源大小，设置超时，并处理恶意循环、导航和拒绝服务。
6. 不把凭证、会话内容或其他工具结果暴露给 App；只转发它被授权获得的数据。

本实验重点是可观察的协议闭环，不声称覆盖上述生产安全工程。

## 错误、重试与生命周期

实验不会在组件挂载时自动运行，必须由用户主动点击。连接过程有明确的加载、错误与“重试打开”状态；连接成功后可以“重新打开”。每次打开都创建新的 Client、HTTP transport、AppBridge、postMessage transport 和 iframe 文档。

关闭、重试、导航或组件卸载时，Host 会：

1. 递增 generation 并移除当前会话引用，令旧异步任务失效。
2. 用户点击关闭或重新打开时，若 App 已 initialized，先发送 `ui/resource-teardown`，并给优雅关闭设置短超时；直接离开页面时关闭连接，不等待这次握手。
3. 关闭 AppBridge、MCP Client，以及仍在建立连接的 Client。
4. 移除 iframe。
5. 用 mounted、generation 与当前会话检查阻止旧任务更新 React 状态和 trace。

iframe App 自己也处理 `onteardown` 与 `pagehide`，不在关闭后继续更新 DOM。

界面变化也走协议：App SDK 通过 `ui/notifications/size-changed` 报告内容尺寸，Host 据此调整 iframe 高度；宿主主题改变时发送 `ui/notifications/host-context-changed`，App 使用官方 `applyDocumentTheme` 同步深浅色。可以在检查器中直接观察这两种通知。

## 沿源码阅读

建议按这条顺序建立完整心智模型：

1. `shared/mcp-server.ts`：fixture、Zod 输入输出与 App tool/resource 注册；`server/mcp-resource.ts` 负责 HTML 内联打包，`server/mcp.ts` 提供无状态 `/mcp`。
2. `src/mcp-app.ts`：iframe 内的官方 App、首次结果处理、App 发起工具调用与 teardown。
3. `src/labs/McpLab.tsx`：浏览器 Client、传输 trace、工具/资源发现、AppBridge allowlist、iframe 生命周期。
4. `tests/mcp.test.ts`：真实临时 HTTP 服务、官方 SDK Client 与内存传输的集成测试；`src/static-mcp.ts` 提供静态版连接。

## 权威资料

- MCP Apps 稳定规范（2026-01-26）：<https://modelcontextprotocol.io/specification/2026-01-26/extensions/apps>
- MCP Apps 文档：<https://modelcontextprotocol.io/docs/extensions/apps>
- MCP Apps TypeScript SDK：<https://github.com/modelcontextprotocol/ext-apps>
- MCP TypeScript SDK：<https://github.com/modelcontextprotocol/typescript-sdk>

本项目以安装的 `@modelcontextprotocol/ext-apps@2.0.3` 与 MCP v2 拆分包类型声明为实现依据。SDK 后续可能加入新协议版本；本章讨论的是 MCP Apps 2026-01-26 的稳定握手与资源模型。

## 动手练习

1. 在 `cityFixtures` 增加第四个本地城市，并同步 Zod enum 与 App 按钮。
2. 增加第二个只读工具，然后只把它加入 Host allowlist；观察 App 调用路径。
3. 临时让 App 请求一个未列入 allowlist 的工具，确认 trace 出现 `Host blocked tool`，且请求没有抵达 `/mcp`。
4. 保持资源 CSP 的 `connectDomains: []`，解释为什么 App 仍能经由 Host 调用工具。
5. 在 trace 中找出两次 initialized，说明哪一个属于核心 MCP，哪一个属于 MCP Apps。
6. 故意交换 `sendToolInput` 与 `sendToolResult` 的顺序，观察 strict App 为什么拒绝。

完成后，你应该能解释：工具如何关联 UI 资源、为什么文本与结构化结果要同时存在、Host 为什么必须做能力中介、两套握手分别解决什么问题，以及本地 iframe 教学边界与生产第三方沙箱之间还差哪些安全层。
