# di-code 可插拔运行时重构 Vibe Coding 实施步骤

本文件是可直接逐步复制给 AI 的执行手册。架构、公共协议、包边界、安全约束和最终验收以[可插拔运行时重构方案](./可插拔运行时重构方案.md)为唯一设计来源；本文件只负责实施顺序、提示词、完成门和提交节奏。

## 1. 使用方式

每次只执行一个阶段。下面每个阶段的代码块都是独立、完整、可直接复制的提示词，不需要再手工拼接其他内容。

每个阶段都必须读取并更新 `docs/可插拔运行时重构实施状态.md`：

1. 阶段 0 如果状态文件不存在就创建；后续阶段读取上一阶段记录。
2. AI 必须先检查 `git status --short`、最近相关 commit 和当前 diff，并报告与用户已有改动重叠的文件。
3. AI 完成后把阶段、状态、改动文件、公共 API、composition/plugin entry、测试命令、生命周期/安全证据、风险和下一阶段写入状态文件。
4. 状态只有在全部完成门和检查通过时才能写 `passed`；否则写 `blocked` 并停在当前阶段。
5. Git commit 是代码事实来源，状态文档是跨上下文恢复依据，AI 的聊天回答只保留为摘要，不需要复制到下一次上下文。
6. 每阶段形成一个逻辑 commit，但不要让 AI 自动 push 或修改无关用户文件。

建议从当前项目创建独立分支：

```text
codex/plugin-runtime-rebuild
```

如果工作区已有用户改动，所有提示词都必须要求 AI 保留这些改动，并在开始前报告重叠文件。

## 2. 全局 Vibe Coding 规则

- 先读根 `AGENTS.md`、根 `README.md`、目标包 README、相关测试和架构方案，不凭记忆猜接口。
- 先写能复现行为的失败测试，再写实现；测试描述用户可观察行为和边界条件。
- 一次只实现一个阶段；发现跨阶段必要改动时，先停在当前阶段并报告原因。
- 不编辑 `dist/`、coverage、`.di-code/`、`.env`、会话文件和凭据；不删除用户已有无关改动。
- TypeScript 保持 `strict`、`NodeNext`、`verbatimModuleSyntax`、`erasableSyntaxOnly`；不使用 `any` 绕过边界。
- 相对 TypeScript import 保留 `.ts`；跨包只使用 workspace package 根入口。
- 资源必须由创建它的插件拥有并释放，覆盖成功、失败、取消、重复关闭四条路径。
- 工具输入、路径、symlink、命令、URL、Provider 返回、插件 manifest 都是不可信输入。
- 不把 in-process plugin 描述为沙箱；不为了通过测试放宽 trust、capability、路径或命令校验。
- 每阶段结束报告：改动文件、公共 API、生命周期/安全影响、实际检查命令和未解决风险。

## 3. 每个阶段提示词的固定要求

下面的固定要求已经写入每个阶段代码块中。若某个阶段代码块缺少其中任何一项，应先补齐再复制：

```text
你正在 D:\pi\di-code 实现一个严格分阶段的 TypeScript npm workspace 变更。
先阅读根 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
遵守 ESM/NodeNext/strict/verbatimModuleSyntax/erasableSyntaxOnly、Biome tab、120 列、公共边界和安全约束。
本阶段只改当前提示词列出的文件/目录；保留用户已有的无关工作区改动；不要编辑 dist、coverage、.di-code、.env、会话或凭据。
先补行为测试再实现。不要用 any、危险类型断言、静默吞异常、任意 eval、shell 拼接或放宽路径/trust/manifest/capability 校验。
所有异步资源都覆盖成功、失败、取消、重复关闭；所有新 public API 写简短 JSDoc。
完成后运行本阶段指定检查，并更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有全部完成门和检查通过时才能写 Status: passed；否则写 Status: blocked 并停止，不进入下一阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

## 4. 阶段总览

| 阶段 | 主题 | 必须先满足 |
| --- | --- | --- |
| 0 | 行为基线和硬编码清单 | 无 |
| 1 | workspace 和公共类型骨架 | 0 |
| 2 | Context/Service/Fiber | 1 |
| 3 | EventBus/诊断/capability | 2 |
| 4 | Contribution Registry | 3 |
| 5 | Composition/Loader | 4 |
| 6 | manifest/trust/安装 | 5 |
| 7 | faux minimal profile | 6 |
| 8 | Provider/模型迁移 | 7 |
| 9 | Agent/Session/compaction | 8 |
| 10 | 工具和安全策略 | 9 |
| 11 | CLI/TUI/mode/command | 10 |
| 12 | RPC/MCP/orchestrator | 11 |
| 13 | 默认 profile/管理/观测 | 12 |
| 14 | 删除旧插件系统 | 13 |
| 15 | 可插拔专项和故障注入 | 14 |
| 16 | 文档同步和发布 | 15 |

不要跳过阶段 0、2、5、7、14、15；它们分别证明行为不退化、生命周期正确、Loader 可组合、有新垂直切片、旧系统已删除、插件真的可插拔。

## 5. 阶段 0：冻结基线和决策记录

**目标**：建立新旧实现可比较的行为基线，只审计和补测试，不实现新 Runtime。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 0：冻结基线和决策记录。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
只做审计和测试基线，不实现新 Runtime。
盘点当前 plugins/extensions、main/entry/rpc-entry、AgentSession、Provider、工具、Session、MCP、TUI、orchestrator 的直接依赖和用户可见行为。
新增 baseline 测试：faux print/json、interactive 虚拟终端、RPC prompt/cancel/get_state、Session restore/branch、工具安全边界、现有插件 trust/diagnostic。
把硬编码构造点整理成表格，逐项标出目标 Context scope、Registry 和 plugin entry；不要修改生产路径。
本阶段不要删除旧代码，不新增运行时依赖。
检查：npm run check；npm test；git diff --check。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：`test/`、`docs/` 的迁移清单、必要的测试 fixture。
**完成门**：基线稳定；清单能从源码路径指向目标 plugin/registry；fixture 没有真实 key、用户目录或机器绝对路径。

## 6. 阶段 1：workspace 和公共契约骨架

**目标**：建立三个新 workspace 和公共类型入口，不实现复杂生命周期。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 1：workspace 和公共契约骨架。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
新增 @di-code/plugin-runtime、@di-code/plugin-loader、@di-code/plugin-sdk 三个 workspace。
先定义并导出 PluginDefinition、Context、Fiber、ServiceKey、Disposer、PluginStatus、RuntimeEvent、RuntimeMode、ConfigSchema、PluginCapabilities 和 Registry 基础类型。
plugin-runtime 不依赖 coding-agent；plugin-loader 只依赖 plugin-runtime；plugin-sdk 只从公开根入口 re-export，不允许 deep import。
为公共 union 增加 discriminant/守卫测试；为 PluginDefinition 增加真实 namespace export fixture（无 default）。
更新根 workspace/build/check 脚本，但不要迁移现有产品代码。
检查：相关 workspace test、npm run check、npm run build。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：新包、根 `package.json` workspace/build 脚本、公共类型测试。
**完成门**：新包独立构建；外部 fixture 只从 `@di-code/plugin-sdk` 根入口编译；没有 `any`。

## 7. 阶段 2：Context、Service Registry 和 Fiber

**目标**：实现 owner-aware 生命周期地基。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 2：Context、Service Registry 和 Fiber。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
在 @di-code/plugin-runtime 实现 Root/Child Context、ServiceRegistry、Fiber 状态机和 disposer。
覆盖：依赖激活前不发布服务；apply 失败全部回滚；dispose 幂等、逆序、聚合错误；子 Context isolate；同一 scope duplicate service 明确报错；registry record 带 owner Fiber。
为 pending async setup、dispose 期间迟到 callback、AbortSignal、重复 dispose 编写行为测试。
禁止连接 CLI、Agent、Provider 或文件工具；只使用 fake plugin/service。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：`packages/plugin-runtime` 实现和测试。
**完成门**：Runtime unit tests 覆盖成功、失败、取消、重复关闭；Fiber phase 转换合法；无资源 owner 泄漏。

## 8. 阶段 3：EventBus、诊断和 capability

**目标**：统一事件、错误隔离、脱敏和能力边界。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 3：EventBus、诊断和 capability。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
在 @di-code/plugin-runtime 增加 typed EventBus、PluginLogger、DiagnosticSink、CapabilityView。
实现 observer handler 错误隔离、critical gate、priority/entry 稳定排序、自动 unsubscribe、handler timeout/abort，以及 token/secret/authorization/api_key 脱敏。
能力 API 只提供接口和 fake implementation；不要把 Node fs/spawn/process 直接暴露给 Context。
新增负例：未声明 capability、未 trust project、handler 抛出凭据、dispose 后 emit/注册。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：Runtime 事件/诊断/能力模块及测试。
**完成门**：observer 错误不破坏 sibling；critical 有明确策略；诊断永不输出 secret；Runtime 不直接依赖产品实现。

## 9. 阶段 4：Contribution Registry 集合

**目标**：固定 Provider、Tool、Command、Prompt、Session、RPC 等公共扩展面。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 4：Contribution Registry 集合。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
实现统一 ContributionRegistry，并定义 Provider/Tool/Command/Prompt/SessionStore/SessionFactory/Compaction/Renderer/RpcMethod/Resource 的最小公共类型。
每次 register 返回 owner disposer；list/snapshot 只读；duplicate、reserved、namespace 冲突在注册时失败；快照顺序确定。
为工具 schema、RPC method、Provider model 增加 runtime validation。
先写纯 registry 行为测试，不迁移现有实现，不修改 AgentSession。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：Runtime/SDK contract 和 registry 测试。
**完成门**：所有 Registry 使用相同 owner/dispose 语义，没有独立的隐式生命周期缓存。

## 10. 阶段 5：Composition Parser 和 Loader

**目标**：实现 dsh 风格声明式 Entry Tree、patch 和拓扑激活。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 5：Composition Parser 和 Loader。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
在 @di-code/plugin-loader 实现 composition 读取、base/mode/user/project layer 合并、Entry Tree、group/disabled、insert/remove/replace/enable/disable/move patch、依赖拓扑排序和 inventory。
配置只允许 JSON/YAML 值和明确环境变量表达式，不执行任意 JS、命令替换或 shell。
实现 required/optional failure、循环/缺失依赖、稳定排序、entry id 唯一、disabled 不 import。
用 fixture plugin package 走真实 Loader 入口测试，不在测试中直接调用 plugin.apply 代替。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：`packages/plugin-loader` 及真实 fixture package。
**完成门**：简单 composition 可 mount/unmount/reload；错误包含来源文件和 entry id；Loader 没有第二个生命周期真相。

## 11. 阶段 6：manifest、package exports、trust 和安装

**目标**：让外部 npm/local plugin 可以安全发现、加载和管理。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 6：manifest、package exports、trust 和安装。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
实现 manifest 校验、namespace export unwrap、apiVersion、package exports 边界、project trust、local/npm/git staging install 和 versioned registry。
拒绝 default export、路径逃逸、unsafe id、无效 capability、缺失 required plugin；npm install 使用 --ignore-scripts；managed path 使用 resolve+relative 验证。
加入真实 fixture：published namespace plugin、malformed manifest、missing export、import failure、disabled plugin、untrusted project、install rollback。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：`plugin-loader`、安装 fixture、trust/manifest 测试。
**完成门**：第三方 fixture 只依赖 SDK 根入口即可加载；安装/更新/删除不触及 managed root 外路径；诊断脱敏。

## 12. 阶段 7：最小 profile（runtime + faux + agent + memory + print）

**目标**：拥有一条完全不依赖旧插件系统的可运行垂直切片。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 7：最小 profile（runtime + faux + agent + memory + print）。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
新增最小 profile，只包含 Bootstrap、runtime、diagnostics、process-exit、provider-registry、provider-faux、agent-loop、session-memory、mode-print。
把 coding-agent 的 main 改成只启动 Loader 和 HostCommandRegistry；不要接入旧 loadPlugins/loadExtensions。
让 DI_CODE_PROVIDER=faux npm run dev -- --print "..." 通过新 composition 完成一次 prompt。
旧产品路径只作为 baseline 参照，不允许新 profile import 它。
加入 subprocess e2e，断言 stdout、退出码、plugin_status、Session dispose 和资源释放。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：最小 profile、Bootstrap 接线、fake/memory plugins、垂直切片测试。
**完成门**：新 profile 独立运行；删掉 print renderer 后 Loader 明确报告缺失，不 fallback 到旧 main 分支。

## 13. 阶段 8：Provider 和模型迁移

**目标**：Provider 完全由 Registry 提供，宿主不再选择/构造 adapter。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 8：Provider 和模型迁移。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
把 openai/anthropic/deepseek/kimi/zhipu/faux、model catalog、credential-env、runtime-selection、provider-onboarding 迁移为独立 plugin entries。
复用 @di-code/ai 的 provider-neutral 类型；禁止厂商字段进入 agent/runtime 公共类型。
迁移现有 settings/env precedence、unknown model、missing key、reasoning level 和 redaction 测试。
main/entry 只向 ProviderRegistry 查询，不得 import provider files。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：Provider/model/settings/onboarding plugins 及其 fixture。
**完成门**：两个 Provider 可同时加载且只有选中的 factory 发请求；faux 离线无网络。

## 14. 阶段 9：Agent、Session 和 compaction 迁移

**目标**：把 `AgentSession` 从万能构造器变成 Registry 驱动的 plugin。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 9：Agent、Session 和 compaction 迁移。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
新增/迁移 agent-loop、agent-session、session-store-jsonl、session-tree、session-query、usage-meter、context-budget、compaction-basic、system-prompt、resource-loader、skills plugins。
AgentSession 不再创建任何内建工具数组，不接收 ExtensionHost；它从 Context 获取 Provider/Tool/Session/Prompt/Compaction registry snapshot。
保持 SESSION_FORMAT_VERSION=2、追加顺序、并发锁、坏记录诊断、树导航和压缩语义；增加 plugin record namespace 与未知记录保留测试。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：Agent/Session/resource/compaction plugins、迁移测试。
**完成门**：Agent loop 仍只有一套；memory/jsonl store 可替换且 prompt 行为不变；恢复测试全绿。

## 15. 阶段 10：编码工具和策略迁移

**目标**：每个工具可独立安装、禁用和替换。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 10：编码工具和策略迁移。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
将 workspace、read、write、edit、bash、glob、grep、load-skill、approval、policy、tool-output 拆为 plugin entries。
所有工具通过 ToolRegistry 注册，Agent loop 不再知道工具名单；各工具保留 schema、reserved name、path/symlink、timeout/output/cancel 测试。
移除 AgentSession 对 core/tools 具体文件的 import；通过 capability service 访问 workspace/process/network。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：工具 plugin packages、workspace/policy capability、工具测试。
**完成门**：只加载 read 时 schema 只有 read；移除工具不会 import/初始化其资源；安全负例仍拒绝。

## 16. 阶段 11：CLI、TUI、mode 和 command 迁移

**目标**：interactive/print/json 都是组合，不是 main 中的产品 if/else。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 11：CLI、TUI、mode 和 command 迁移。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
迁移 cli-parser、command-core/session/model/settings/compact、mode-interactive/print/json、tui-renderer/theme/output-json。
所有 slash command 进入 CommandRegistry，所有 mode 进入 Mode/Renderer registry；帮助文本由 registry 生成并保留现有 locale 文案。
interactive 的 Session choices、cancel/retry/theme/keybindings 通过 Context service 访问；TUI 包继续 presentation-only。
用虚拟终端和 subprocess tests 断言布局、ANSI、cursor、输入、退出和 stdout/stderr 边界。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：CLI/TUI/mode/command plugins、入口接线、交互测试。
**完成门**：同一 SessionFactory 可用于三种 mode；删除 interactive 不影响 print；UI 产品逻辑不进入 tui core。

## 17. 阶段 12：RPC、MCP 和 orchestrator 迁移

**目标**：恢复跨进程能力，不产生第二套产品装配。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 12：RPC、MCP 和 orchestrator 迁移。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
迁移 rpc-protocol-v1、rpc-server、rpc-events、mcp-config/client/tools、orchestrator-host。
保持 RPC version=1、id/requestId、prompt/cancel/get_state 和错误 code；新 method 只能从 RpcMethodRegistry namespace 注册。
RPC server 通过 SessionFactory/AgentSession service 工作，不直接 new AgentSession；shutdown 必须 response -> flush -> dispose -> exit，覆盖 racing shutdown/flush failure/dispose。
MCP transport/manager 的 close/cancel/SSRF/path/headers 测试保留；orchestrator 只能依赖公开 RPC SDK。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：RPC/MCP/orchestrator plugins、公开协议/SDK、subprocess tests。
**完成门**：RPC real subprocess e2e 全绿；MCP 是 ToolRegistry contribution；orchestrator 无 coding-agent 内部 import。

## 18. 阶段 13：默认 profile、插件管理和可观测性

**目标**：默认体验完全由 composition 提供，插件可发现、可管理、可诊断。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 13：默认 profile、插件管理和可观测性。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
把所有 built-in entries 写入 base/interactive/print/json/rpc composition；加入 plugin-manager、plugin-inventory、plugin-trace、plugin-dump-composition。
实现 di-code plugin list/get/enable/disable/install/update/remove 命令，但命令本身也是 command plugin；disabled plugin 不 import。
输出 resolved tree、owner Fiber、phase、capability audit 和失败诊断；不输出凭据或完整请求体。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：默认 compositions、插件管理/库存/观测 plugins、CLI help。
**完成门**：默认和最小 profile 都不依赖旧 plugins/extensions；inventory 与真实 Loader phase 一致；管理操作有回滚测试。

## 19. 阶段 14：删除旧插件系统

**目标**：完成旧 `plugins`/`extensions` 的彻底移除。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 14：删除旧插件系统。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
先运行全仓库 rg，列出 plugins、extensions、ExtensionHost、loadPlugins、loadExtensions、registerExtension、extensionHost 的所有引用。
将剩余测试、README、CLI trust 文案和 package exports 迁移到 plugin-runtime/plugin-loader/Composition 术语后，删除 packages/coding-agent/src/plugins、src/extensions 及旧测试。
删除 legacy-adapter、兼容 re-export 和旧 manifest/plugin.json 解析入口；不要保留死代码。
检查依赖方向、根 README、docs/插件使用指南、packages/coding-agent/README 与 package.json exports。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：旧插件系统文件、旧测试、导出和文档引用；不要删除新 Runtime。
**完成门**：`rg` 对旧 API 只剩必要迁移记录而无源码/测试引用；check/test/build 全绿；默认启动走新 Loader。

## 20. 阶段 15：可插拔专项、故障注入和发布门禁

**目标**：证明完全可插拔，而不是只证明默认 profile 能启动。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 15：可插拔专项、故障注入和发布门禁。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
新增 plugin-composability.e2e.ts、plugin-chaos.e2e.ts、published-plugin-smoke.e2e.ts。
覆盖架构方案中的十项可插拔验收，重复 unload/reload 100 次，故意注入 import/setup/handler/dispose/flush/child-process failure。
使用 faux provider、临时目录、虚拟 terminal 和 mock server；禁止真实网络 key。
检查 listener/timer/process/file descriptor 计数或等价 inventory，不允许卸载后残留贡献。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：真实 Loader/CLI/RPC/MCP 组合 fixture、故障注入测试、诊断测试。
**完成门**：专项测试全绿；错误能定位 entry/plugin/stage；没有 flaky retry 掩盖竞态；外部 fixture plugin 只使用公开 SDK。

## 21. 阶段 16：文档、包 README 和发布

**目标**：让文档成为实现后的公共合同。

**复制提示词**：

```text
你正在 D:\pi\di-code 执行阶段 16：文档、包 README 和发布。
先阅读 AGENTS.md、README.md、目标包 README、docs/可插拔运行时重构方案.md、docs/可插拔运行时重构VibeCoding实施步骤.md，以及 docs/可插拔运行时重构实施状态.md（不存在时创建）。
先检查 git status --short、最近相关 commit 和当前 diff；保留用户已有改动，并报告重叠文件。
本阶段只修改允许范围；遵守 strict/ESM/安全约束；不要编辑 dist、coverage、.di-code、.env、会话或凭据，不使用 any、任意 eval 或 shell 拼接。
同步根 README 的架构/启动/配置/安全概览，docs/插件使用指南.md 的 manifest/loading/trust/capability/lifecycle/API，docs/开发教程.md 的 workspace/测试/Vibe Coding 流程，以及每个公开 package README。
删除旧 ExtensionFactory、plugin.json 工厂、仅能追加工具的过时示例；给出可运行的第三方 namespace plugin 和 composition 示例。
核对所有命令、环境变量、JSON/RPC 字段、版本、错误行为与源码/测试。
运行 npm run check、git diff --check、npm test、npm run build、npm run release:dry-run。
完成后必须更新 docs/可插拔运行时重构实施状态.md，记录 Stage、Status、Changed files、Public API、Composition entries、Tests/Checks、Lifecycle/Security evidence、Known risks 和 Next stage context。
只有完成门和检查全通过时才能写 Status: passed；否则写 Status: blocked 并停在本阶段。
不要自动 commit、push、reset、checkout 或删除用户文件。
```

**允许范围**：架构方案引用、根/包 README、插件指南、开发教程、CLI help、RPC 文档。
**完成门**：每个事实只有一个权威来源；示例可运行；release dry-run 不含 dist、`.di-code`、凭据或临时 fixture。

## 22. 阶段提交模板

每阶段完成后使用一个逻辑 commit，建议格式：

```text
<type>: <one logical intent>

Scope:
- package(s): ...
- public contract changed: yes/no
- docs updated: ...

Behavior evidence:
- tests: ...
- commands: ...

Lifecycle/security:
- owner/dispose paths covered: ...
- trust/capability/path/process implications: ...

Known follow-up:
- next stage: ...
```

推荐前缀：`feat:`、`fix:`、`refactor:`、`test:`、`docs:`、`chore:`。不要让一个提交同时迁移 Provider、删除旧插件和修改 RPC 协议。

## 23. 阶段状态记录模板

每次让 AI 结束阶段时，把下面结果保存到 PR/commit 描述或临时任务记录：

```text
Stage: <0-16>
Status: passed | blocked
Changed files: ...
Public API: ...
Composition entries: ...
Tests run: ...
Checks: ...
Lifecycle evidence: ...
Security evidence: ...
Known risks: ...
Next stage context: ...
```

如果状态是 `blocked`，不要直接进入下一阶段。先解决阻塞，或把设计决策记录到架构方案后重新运行当前阶段测试。

## 24. 最终复制前检查

- [ ] 当前阶段编号与前置阶段完成门匹配。
- [ ] 提示词前缀和阶段提示词一起复制。
- [ ] 已告知 AI 保留用户已有工作区改动。
- [ ] 没有把真实 API key、`.env`、Session 或用户目录带进上下文。
- [ ] AI 会先测试后实现，并限制修改目录。
- [ ] AI 会报告实际运行的命令，而不是声称“应该通过”。
- [ ] 当前阶段通过后才复制下一阶段。

最终只有在架构方案的完成门、十项可插拔验收和本文件阶段 16 全部通过后，才可以发布“插件完全可插拔”。
