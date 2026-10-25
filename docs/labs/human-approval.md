# W2：人工确认与业务事实

在[人工确认实验](#labs/human-approval)中，为一场本地工作坊创建报名提议，修改内容后再确认或拒绝。通过旧版本、重复命令和响应中断实验，观察用户决策如何变成一条可查询的业务记录。

## 先分清三件事

- **提议**是待核对的拟执行内容，包含内容版本、教学会话和有效期。
- **命令**是针对某份提议的明确操作，携带 `commandId` 和 `expectedVersion`。
- **报名记录**是提交后的业务事实。浏览器按钮、加载结束或成功动画都不能单独证明它存在。

本实验的审批属于应用语义，没有给 AG-UI、A2UI 或 MCP 增添“审批协议字段”。检查器中的请求、结果和关联身份是项目自己的应用记录。

## 操作路径

1. 生成报名提议，核对姓名、工作坊与报名人数。
2. 修改内容并保存，观察提议内容版本和任务版本的变化。
3. 确认最新提议，或者明确拒绝。
4. 查询报名事实，对照记录中的提议 ID、内容版本和实际参数。
5. 重放同一个确认命令，观察报名记录仍只有一条。

修改会使旧版本的确认失效。服务端只执行已经保存并被确认的那份内容；没有保存的表单草稿不能被悄悄当作确认对象。

## 确认与版本绑定

确认至少要限定提议 ID、内容版本、教学会话、有效期和操作内容。`expectedVersion` 用于防止另一页面或另一请求已经改变任务状态时继续执行旧命令；内容版本用于说明用户究竟看过哪份报名参数。

过期提议、旧版本、错误教学会话、已经拒绝的提议都必须有可读的结果。客户端可提前阻止无效操作，服务端仍要独立检查。

教学会话只是本地实验的隔离标识，不代表已经接入生产用户认证、租户隔离或权限系统。不要在实验中填入真实个人资料。

## 幂等与同一事务

同一 `commandId`、同一完整请求代表重试同一个意图，应返回之前的结果。即使当前任务版本已经改变或有效期已经过去，已经提交成功的命令也不应因此被误报为失败。

同一 `commandId` 携带不同操作或参数应返回冲突，不能把第一次的成功结果当作另一份参数的授权。

服务端必须在同一 SQLite 事务中完成：读取和验证当前提议 → 检查幂等命令 → 写入决策与报名记录 → 保存命令结果。数据库提交失败时整组变更回滚。唯一约束为同一提议的业务记录提供第二层保护。

`server/storage/sqlite.ts` 由 W1 提供，W2 复用它的 `LabDatabase` 同步事务、迁移校验和与独立数据目录。事务回调必须同步完成，不得在回调中安排异步任务后继续使用事务连接；原生 `async` 回调在调用前拒绝。审批状态、幂等表、报名表和迁移均属于 `human-approval` 模块。

## “结果未知”怎么恢复

确认请求已发出但连接中断时，客户端不知道服务端是否提交成功。请求与响应正文共用 10 秒等待上限；超时也只表示结果未知。此时保留原命令并开放**查询事实**，迟到响应不会覆盖恢复后的状态。

- 查询到报名记录：显示查得的参数和记录身份；不创建第二条记录。
- 查询到命令的明确拒绝：显示原因，引导核对提议或重新生成。
- 暂时查不到命令：仍不能仅凭一次空查询断言旧请求永远不会提交。需要重试时使用原 `commandId` 和原参数，让服务端幂等处理。
- 查询本身失败：保持结果未知，继续提供查询入口。

“明确失败”意味着收到了可解释的拒绝或冲突，恢复入口是修正输入、查询最新版本或重新生成提议。不要把所有请求异常都渲染为“报名失败”。

## 本地与 Pages 的证据边界

| 模式      | 可以观察的证据                                      | 保存范围                                     |
| --------- | --------------------------------------------------- | -------------------------------------------- |
| 本地 HTTP | 服务端独立验证、SQLite 事务、命令结果与报名事实查询 | 当前 worktree 的数据目录；进程重启后仍可查询 |
| Pages     | 同一业务状态机、旧版本拒绝、幂等算法和交互恢复      | 浏览器内存；刷新后模拟状态重置               |

Pages 页面明确标为审批模拟，不会向真实报名、支付或其他外部业务服务发送请求。浏览器内存状态不能证明可信授权或真实服务端写入。切换实验后返回时，先查询内存中是否仍有原任务；只有查询确认不存在时才要求重置模拟。页面刷新会清空模拟 store，保留的会话线索不能替代业务事实。

重放命令返回的是该命令的历史回执。若已经查询到更新的任务版本，界面保留最新事实，并明确标注旧回执的版本，避免用“尚未写入”等历史提示覆盖当前成功状态。

## 源码入口

- `src/labs/human-approval/manifest.ts`：实验发现、学习主题和运行模式。
- `src/labs/human-approval/Lab.tsx`：草稿、提交状态、结果未知和事实查询界面。
- `shared/labs/human-approval/engine.ts`：浏览器和服务端共用的审批校验与状态机。
- `shared/labs/human-approval/ports.ts`：审批存储与事务边界。
- `server/labs/human-approval/store.ts`：SQLite 适配与本包表。
- `server/labs/human-approval/routes.ts`：本地 HTTP adapter。

新实验的公共接入方式见 [W0 实验基础](foundation.md)。任务存储与审批语义彼此独立：任务状态描述当前进度，业务记录证明副作用是否已经发生。

## HTTP 接口与整合

`POST /api/labs/human-approval/commands` 接受 `ApprovalCommand`，`GET /api/labs/human-approval/facts?taskId=...&commandId=...` 查询一致快照。两者通过 `X-Teaching-Session` 请求头传入教学会话；正文不能替换它。命令返回 `accepted`、`conflict` 或 `rejected`，查询返回 `found` 或明确拒绝。事实查询响应禁止缓存。

`X-Approval-Drop-Response: 1` 是实验专用故障开关：命令事务完成后主动丢失响应，用来观察结果未知后的恢复。它只影响传输，不改变命令指纹。Pages 也执行同样的逻辑模拟。

公共接线位于三处：`server/index.ts` 向 `installLabRoutes` 传入运行配置与可选数据库；`server/labs/index.ts` 创建审批存储并向 `installHumanApprovalRoutes` 注入，与 W1 共用宿主管理的 SQLite 连接；`shared/labs/static-handlers.ts` 登记 `humanApprovalStaticHandler`。应用清理函数先关闭各模块，再关闭自有数据库。实验导航和教程由 manifest 与 Markdown 自动发现。

Node 内置 `node:sqlite` 需要 22.13 或更新版本才能无额外开关使用；package 与 lockfile 已声明最低版本。实验没有增加 npm 依赖。默认运行后打开 `http://127.0.0.1:5173/#labs/human-approval`。需要在另一个 worktree 隔离实例时，可配置 `.env.local`：

```dotenv
LAB_WEB_PORT=5182
LAB_API_PORT=3112
LAB_PREVIEW_PORT=4182
LAB_INSTANCE_ID=approval
LAB_DATA_DIR=.lab-data/approval
```

上述配置下运行 `npm run dev`，打开 `http://127.0.0.1:5182/#labs/human-approval`。当前实例的 W1/W2 分别写入 `.lab-data/approval/lab.sqlite` 中独立的业务表；其他 worktree 使用自己的数据目录。

验证命令：

```bash
npx vitest run tests/labs/human-approval
npx playwright test e2e/labs/human-approval.spec.ts e2e/labs/human-approval-recovery.spec.ts
npx playwright test --config playwright.pages.config.ts e2e/labs/human-approval/pages.spec.ts
npm run check
```

本包测试覆盖版本与会话拒绝、幂等重试、同键异参、事务回滚、独立进程竞争、服务进程重启，以及提交后丢失 HTTP 响应。Pages 验证子路径、无真实 API 网络请求和刷新后的模拟重置。普通构建和 Pages 构建共用 `dist`，请顺序执行。

## 迁移练习

将报名替换为“保存一份本地发布草稿”。保留内容版本、教学会话、命令幂等、有效期和事实查询，回答：编辑后哪份授权失效？请求超时后先查询什么？同一键异参为何不能返回原成功提示？

随后尝试两个页面同时确认同一提议：即使两次点击使用不同命令 ID，服务端也只允许一次业务提交。用数据库记录数量和查询结果验证，不依赖界面按钮是否被禁用。
