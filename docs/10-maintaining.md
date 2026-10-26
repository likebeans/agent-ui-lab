# 维护与贡献验证

本页说明运行环境、提交前检查和 CI 排错。第一次启动请先阅读 [首次学习](./00-first-session.md)；运行模式与部署边界见 [从学习实验到真实开发](./04-real-development.md)。

## Node 支持矩阵

| 环境                 | 用途                                                            | CI 检查                                                                  |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Node 22.13.0         | 最低兼容版本，与 `package.json` 和锁文件根节点的 `engines` 一致 | `npm ci`、`npm run check`，包含单元与集成测试、类型检查和普通生产构建    |
| Node 24 最新补丁版   | 推荐开发环境；`.nvmrc`、完整验证作业和 Pages 构建使用此主版本   | 格式检查、`npm run check`、本地 HTTP 浏览器套件和 Pages 子路径浏览器套件 |
| 其他 Node 版本与平台 | 未纳入上述 CI 矩阵                                              | 满足 `engines` 不代表已完成所有平台与版本的验证                          |

使用 Node 发行版随附的 npm，按锁文件执行 `npm ci`。不要因为 Vite 接受 Node 20 就降低项目的最低版本：当前运行环境还使用 Node 内置 SQLite，`concurrently` 也要求 Node 22。

锁文件中的 Vite 8、Rolldown 和 React 插件要求 `^20.19.0 || >=22.12.0`，均接受 22.13.0。Linux x64/glibc 的可选包 `@napi-rs/lzma-linux-x64-gnu@1.5.1` 要求 `^22.20 || ^24.12 || >=25`；在 22.13.0 下 npm 会跳过该包，Rollup 的平台原生包仍可安装。这一可选包不构成提高项目最低版本的理由；升级相关依赖后仍须检查最低版本 CI，不能只看 Vite 的声明。

本次环境核验在 macOS arm64 上使用 Node 22.13.0 和 npm 10.9.2 完成隔离 `npm ci` 与完整 `npm run check`，包含全部单元与集成测试、类型检查和普通生产构建。Linux 平台筛选安装也通过，但没有在 macOS 上执行 Linux 二进制；Ubuntu 上完整的最低版本检查由 CI 提供。

## 提交前检查

使用 nvm 时，在仓库根目录执行：

```sh
nvm install
nvm use
npm ci
npm run format:check
npm run check
npx playwright install chromium
LAB_DATA_DIR=.lab-data/verification PLAYWRIGHT_CHANNEL=chromium npm run test:e2e
PLAYWRIGHT_CHANNEL=chromium npm run test:pages
```

`npm run check` 会执行测试、类型检查和普通构建。`npm run test:pages` 会另行构建 Pages 模式并在 `/pages-test/` 子路径验证；它不能替代真实 HTTP 模式检查。Linux 缺少浏览器系统依赖时，使用 CI 中的 `npx playwright install --with-deps chromium`。

涉及依赖、Node API 或构建配置的改动，再用最低版本执行：

```sh
nvm install 22.13.0
nvm use 22.13.0
npm ci
npm run check
nvm use
```

CI 仅在推荐版本运行完整浏览器套件，最低版本运行安装与 `check`，避免把整套浏览器检查重复一遍。升级 `engines` 时同步修改锁文件根节点和 CI 的精确最低版本；推荐主版本变化时同步检查 `.nvmrc`、CI 和 Pages 工作流。

检查前为当前 checkout 配置 `.env.local`，三个端口必须各不相同，并与其他 worktree 的端口错开。Playwright 默认启动独立服务；只有明确要复用自己的服务时才设置 `LAB_REUSE_EXISTING_SERVER=1`，复用仍会验证实例身份。验证数据可使用上例独立目录，避免覆盖日常实验状态。

## 数据目录与环境变量

本地 HTTP 服务启动时会在 `LAB_DATA_DIR` 下打开 `lab.sqlite`。W1 保存任务与事件，W2 保存人工确认与报名事实；活动报名联合实验使用独立表保存任务、回执、事件与报名事实；SQLite 还可能创建 `lab.sqlite-wal` 和 `lab.sqlite-shm`。默认目录是当前 checkout 的 `.lab-data`，相对路径按仓库根目录解析。

每个 worktree 使用自己的数据目录。需要备份时先停止写入服务，再备份整个目录；需要重置时同样先停服务，再移走该目录，下一次启动会创建新库。不要只删除运行中的数据库主文件。SQLite 迁移带有校验和，已应用的迁移不应原地改写。

Pages 静态模式把实验状态保存在浏览器内存中，不会写入本地 SQLite。`.env`、`.env.local` 和数据库不应进入提交或失败附件；环境变量的读取优先级见仓库根目录 `.env.example`。

## CI 失败诊断

先查看失败的作业和步骤：

- `Minimum Node 22.13.0` 的安装失败：核对锁文件、必需依赖的 `engines` 和平台可选包，使用同一 Node/npm 版本重现。避免通过删除锁文件绕开失败。
- `Verify contracts, types and production build` 或 `Check formatting, contracts and production build` 失败：查看首个失败命令，再分别运行 `npm run test`、`npm run typecheck`、`npm run build` 或 `npm run format:check`。
- Chromium 安装失败：检查下载与系统依赖日志；此时浏览器尚未运行，通常没有 trace。
- 本地 HTTP 浏览器步骤失败：查看实例健康、端口占用、HTTP/SSE 与 SQLite 日志。
- Pages 浏览器步骤失败：检查资源子路径、静态模式标记和浏览器是否意外请求 API。

浏览器步骤失败后，CI 会尝试上传 `browser-failures-<run_id>-<run_attempt>`，保留 7 天。附件包含 `test-results/` 下的截图、Playwright 失败目录和 trace；本地 HTTP 与 Pages 分别使用 `test-results/local/`、`test-results/pages/`。下载后可打开 trace：

```sh
npx playwright show-trace /path/to/trace.zip
```

数据库放在 runner 临时目录，不在上传路径中；上传规则也排除 SQLite、数据库文件和 `.env`，默认忽略隐藏文件。截图与 trace 会记录页面和请求内容，因此 CI 只使用教学测试数据，不向浏览器测试注入生产凭据。全局 setup 或服务启动过早失败时可能没有截图或 trace，Actions 步骤日志仍是排错入口。

上传步骤允许自身失败，并只在浏览器步骤失败后运行；上传故障不会掩盖原来的测试失败，也不会把失败的 CI 变成成功。浏览器步骤本身保留正常的失败状态。

## 主分支保护建议

建议维护者在仓库的 branch protection 或 ruleset 中启用以下规则；本指南不会改动 GitHub 设置：

- `main` 通过 Pull Request 合并，并要求评审与讨论解决。
- 将最低 Node 作业和完整 `validate` 作业均设为必需状态检查。GitHub 显示的名称可能包含调用工作流前缀，应从实际成功运行记录中选择这两个检查。
- 要求检查针对待合并的最新提交通过；限制强制推送、删除分支和绕过规则。

Pages 工作流继续复用同一提交的完整 CI，只有全部验证成功才进入构建与部署。部署前还会确认该提交仍是 `main` 当前版本。新增最低版本作业同样属于这个门禁，诊断附件的上传结果不会放宽门禁。
