# AGENTS.md

`di-code` 是一个以终端为主要界面的 TypeScript AI Coding Agent：模型适配、Agent 工具循环、编码工具、会话、插件、RPC 和 ANSI TUI 都拆分为独立的 npm workspace 包。修改代码前先阅读 [README.md](README.md) 了解用户可见行为；修改插件、会话或 RPC 时同时阅读对应包的 README 和测试。

## Repository layout

```text
packages/
  ai/             Provider 无关的 AI 类型、消息、工具 schema、流式事件和 Provider 适配器
  agent/          Agent 状态管理、上下文和模型-工具循环
  coding-agent/   CLI、编码工具、会话、上下文压缩、交互模式、插件和 RPC
  orchestrator/   通过公开 RPC SDK 监督 coding-agent 子进程
  tui/            ANSI 终端渲染和交互组件库
scripts/          版本准备、发布 dry-run 和发布脚本
docs/             中文开发教程和插件使用指南
.di-code/         本地运行时数据；不要提交会话、插件状态或剪贴板文件
dist/             构建产物；由各 workspace 的 build 生成，不作为源码编辑
```

包的依赖方向保持单向：`ai` 不依赖产品层；`agent` 只依赖 `ai`；`coding-agent` 组装 `agent`、`ai` 和 `tui`；`orchestrator` 只通过公开 RPC 协议管理 coding-agent。跨包代码使用 workspace package name，不从另一个包的 `src` 或 `dist` 私有路径导入。

## Commands

要求 Node.js `>=22.19.0`、npm。首次安装建议跳过生命周期脚本：

```powershell
npm install --ignore-scripts
npm run dev                         # 从源码启动交互 CLI
npm run dev -- --print "检查项目"   # 使用 print 模式
npm run dev -- --mode json "检查项目" # 输出 JSON 事件
```

```powershell
npm run check                       # Biome + TypeScript 类型检查
npm test                            # 运行所有 workspace 测试
npm run build                       # 构建全部 workspace
npm run release:dry-run             # 检查发布包，不上传
npm run version:prepare             # 同步 workspace 版本
npm run release:publish             # 按发布脚本发布
```

提交前根据改动范围运行最小充分检查：

- 修改单个包的行为：`npm test --workspace @di-code/<package>`，并运行 `npm run check`。
- 修改公共类型、Provider 协议、Agent 循环或 RPC：运行相关 workspace 测试、`npm run check` 和 `npm run build`。
- 修改 CLI、交互 UI 或终端输出：补充对应测试；需要人工确认时在真实终端运行 `npm run dev`。
- 修改发布入口、package.json 或版本脚本：运行 `npm run build` 和 `npm run release:dry-run`。

没有必要时不要反复运行全套命令；最终说明中只报告实际运行过的检查。真实 Provider 测试需要对应 API key；优先使用 `DI_CODE_PROVIDER=faux` 做无网络验证，绝不把 key 写入源码、测试、日志或提交。

## Configuration and secrets

根目录 `npm run dev` 会使用 Node 的 `--env-file-if-exists=.env`。非交互模式必须明确配置 `DI_CODE_PROVIDER`；可选设置 `DI_CODE_MODEL`。支持的内建 Provider 为 `openai`、`anthropic`、`deepseek`、`zhipu` 和离线 `faux`。自定义 Provider 放在未提交的 `.di-code/settings.json`，凭据通过 `$ENV_VAR` 或 `${ENV_VAR}` 引用。

`.env`、`.di-code/`、会话 JSONL、剪贴板图片和插件运行状态属于本地数据。不要提交真实 API key、Authorization header、完整请求体或包含凭据的错误信息。新增配置字段时同步更新 `.env.example` 和 README，并为非法配置添加测试。

## Architecture invariants

- **Provider protocol first.** Provider 输出通过统一消息和流事件协议进入 `agent`；新增 Provider 应复用现有 API 适配器和验证工具，不把厂商字段泄漏到 Agent 公共类型。
- **Agent owns the loop.** 模型请求工具后由 Agent 校验参数、顺序执行工具、追加 tool result，再开始下一轮；Provider、CLI、插件和 orchestrator 不要各自实现第二套循环。
- **Public boundaries stay stable.** `@di-code/ai`、`@di-code/agent`、`@di-code/coding-agent` 的根入口是公共 API。RPC 每条记录保留 `version: 1`，请求通过 `id`、流事件通过 `requestId` 关联；协议字段变更必须同步 server、client、SDK、测试和 README。
- **Tools are untrusted-input boundaries.** JSON schema 只保证字段类型；`read`、`write`、`edit`、`bash` 仍必须校验路径边界、symlink 逃逸、命令参数、超时、输出大小和取消信号。
- **Sessions are durable data.** 会话 JSONL 的字段、追加顺序、并发保护和恢复语义属于持久化格式。改变它们时同时更新存储、恢复、压缩、RPC 和测试；不要静默丢弃未知或损坏记录。
- **Plugins are in-process code.** 插件工具、slash command 和生命周期事件运行在同一 Node 进程中。manifest 权限用于声明和审计，不是沙箱；事件 handler 用于观察和清理，不是工具授权门禁。
- **TUI remains presentation-only.** `tui` 组件负责 ANSI 渲染、输入和布局，不依赖 Provider 或 coding-agent 产品逻辑；终端状态变化通过明确的 props、事件或公共类型传递。
- **Orchestrator uses RPC only.** 不要从 orchestrator 访问 coding-agent 的内部模块；进程生命周期、取消、stderr 截断和崩溃传播都必须通过公开 RPC/SDK 行为测试覆盖。

## TypeScript and code conventions

- ESM everywhere：`package.json` 使用 `"type": "module"`，相对 TypeScript import 保留 `.ts` 扩展名；不要引入 CommonJS-only export。
- TypeScript 使用 `strict: true`、`NodeNext`、`verbatimModuleSyntax` 和 `erasableSyntaxOnly`。优先精确联合类型、类型守卫和显式返回类型；不要用 `any` 绕过边界，确需使用时写明原因。
- 遵循 Biome：tab 缩进、120 列、推荐 lint 规则。格式化或修复 lint 时不要混入无关行为改动。
- 跨包 import 使用 `@di-code/*` 根入口；同包内部可以使用相对路径。不要依赖 `dist` 中碰巧存在的文件。
- 公共导出、非显然的生命周期/错误/并发行为写简短 JSDoc；注释解释约束和原因，不复述代码。
- 事件、消息、工具和 RPC 都使用明确的 discriminant；关闭的 union 用 `assertNever`，扩展性 union 为未知值保留明确的 fallback。
- 资源由创建它的模块拥有并释放。`AbortSignal`、文件句柄、子进程、监听器和临时文件都要覆盖成功、失败、取消和重复关闭路径。

## Testing rules

测试描述用户可观察行为和边界条件，而不是复制实现细节。新增或修改以下行为时必须增加/更新测试：

- Provider 请求映射、流事件、工具参数校验和错误归一化。
- Agent turn、工具循环、取消、重试、上下文压缩和异常传播。
- 文件工具的路径边界、覆盖/追加语义、编码、输出截断和 shell 超时。
- Session JSONL 的追加、恢复、并发写入、损坏记录和版本兼容行为。
- 插件 manifest、注册冲突、trust、事件隔离和诊断脱敏。
- RPC JSONL 的版本、请求关联、并发 prompt、cancel、崩溃和 stderr 行为。
- TUI 在虚拟终端中的布局、光标、键绑定、输入和 ANSI 输出。

网络测试应显式使用环境变量并在缺少 key 时跳过；不要让单元测试依赖网络。测试 fixture 不包含真实密钥、用户目录或机器相关的绝对路径。修复 bug 时先添加能复现它的测试，再修改实现。

## Documentation and generated files

用户可见行为、CLI 选项、Provider 配置、插件 API、RPC 字段和安全限制变化时，代码与文档在同一个变更中更新。主要文档入口：

- [README.md](README.md)：安装、配置、CLI、架构和用户行为。
- [docs/开发教程.md](docs/开发教程.md)：源码开发和扩展说明。
- [docs/插件使用指南.md](docs/插件使用指南.md)：插件 manifest、能力、权限和安全边界。
- 各 workspace 的 `README.md`：包级 API 和使用方式。

`dist/`、coverage、临时会话和 `.di-code/` 是生成或运行时文件，不手工编辑或提交。`package-lock.json` 是 npm workspace 的锁文件；依赖变更必须通过 npm 更新并检查锁文件差异。模型目录等生成源码若有对应脚本，修改源数据后运行生成脚本，不直接改生成结果。

## Security and operational safety

工具接收的路径、URL、命令片段、模型返回的 JSON 和插件输入都视为不可信。禁止拼接未经校验的 shell 字符串；使用固定命令、结构化参数、明确 cwd、超时和输出上限。错误和诊断必须脱敏 `token`、`secret`、`authorization`、`api_key` 等凭据模式。

涉及文件删除、覆盖、子进程、网络请求、插件 import 或会话迁移时，先确认目标和失败恢复行为，再实现。不要为了让测试通过而放宽路径边界、关闭校验、吞掉异常或静默兼容旧格式。

## Git and change hygiene

保持工作区变更小而可审查；一个提交只做一件逻辑上的事，提交信息使用 `feat:`、`fix:`、`refactor:`、`test:`、`docs:` 或 `chore:` 前缀并说明意图。不要提交 `.env`、密钥、`node_modules/`、`dist/` 或临时输出。文档变更也应经过 `git diff --check`。

提交前检查：

```powershell
git diff --check
git status --short
npm run check
npm test
```

不要重置、覆盖或删除用户已有的未提交改动；发现与当前任务冲突时保留并基于现状工作。版本发布遵循语义化版本，先运行 `npm run release:dry-run`，再由发布脚本更新包版本和 changelog。

## Editing this file

根目录 `AGENTS.md` 是所有包的默认开发约束。新增更细的目录级 `AGENTS.md` 时，只补充该目录特有规则，不重复整份根文档；规则与代码或 README 冲突时，先确认实际行为并在同一变更中修正文档。保持本文件短、可执行、与仓库现状一致。
