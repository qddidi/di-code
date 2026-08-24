# 真实 Provider 插件系统测试报告

测试日期：2026-08-24（运行环境 Node.js 24.15.0，Windows）  
Provider：`zhipu`  ；模型：`glm-5.3`  
凭据来源：现有用户级 `C:\Users\Administrator\.di-code\settings.json`。报告、插件和测试输出均未记录 API key、Authorization header 或完整 Provider 请求体。

## 结论

插件系统通过了本次 27 项可重复检查，27 项通过，0 项失败。真实 Provider 已实际完成两次工具循环：一次 `--print`，一次 `--mode json`；模型均发现并调用了项目插件提供的 `plugin_probe` 工具。

插件测试包保留在 `.di-code/live-plugin/`，项目 composition 保留在 `.di-code/composition.yml`，可继续作为手工回归 fixture 使用。managed plugin 测试的独立安装目录保留在 `.di-code/live-test-agent/`。

## 测试插件

测试插件为 `fixture.live-plugin`，仅依赖公开入口 `@di-code/plugin-sdk` 和宿主公开 registry API。它声明 `filesystem`、`ui` capability，并注册：

| 能力 | 验证内容 | 结果 |
| --- | --- | --- |
| Namespace module | `apiVersion`、`name`、`version`、`apply`，无 default export | 通过 |
| 服务 | `Context.set()` 发布 typed service，读取 Fiber capability | 通过 |
| Agent tool | `plugin_probe` schema、参数处理、AbortSignal、结果格式 | 通过 |
| Command | `plugin-live-command` 加入 command registry | 通过 |
| Host command | `plugin-live-host` 注册、执行并返回 0 | 通过 |
| Prompt | `plugin-live-prompt` 返回固定 prompt | 通过 |
| Compaction | `plugin-live-compaction` 修改输入并加入 marker | 通过 |
| Resource | `plugin-live-resource` URI 和读取回调 | 通过 |
| Session store | `plugin-live-store` 创建、append、records | 通过 |
| Renderer | `plugin-live-renderer` 注册与渲染 | 通过 |
| Theme | `plugin-live-theme` 注册与读取 | 通过 |
| Keybinding | `ctrl-alt-l` 绑定到插件命令 | 通过 |
| RPC method declaration | namespace `fixture.live`、method `plugin_live` 注册 | 通过 |
| Runtime events | 观察 plugin status lifecycle events | 通过 |
| Lifecycle cleanup | Loader dispose 后插件服务和 tool contribution 移除，disposer 执行 | 通过 |

## 真实 Provider 端到端

### Print mode

执行：

```powershell
$env:DI_CODE_TRACE_PLUGINS = "1"
npm run dev -- --print --trust-project "请调用 plugin_probe 工具，参数 value 使用 LIVE_REAL_PROVIDER，然后只返回工具结果。"
```

结果：

- `fixture.live-plugin` 从 `loading` 进入 `active`。
- `glm-5.3` 发起真实请求并调用 `plugin_probe`。
- 工具返回 `PLUGIN_PROBE:LIVE_REAL_PROVIDER`，CLI 输出该结果。
- 退出时插件从 `active` 进入 `unloading`、`disposed`，随后整个 composition 逆序释放。
- trace 中没有输出密钥或完整请求体。

### JSON mode

执行：

```powershell
npm run dev -- --mode json --trust-project "调用 plugin_probe，value=LIVE_JSON_PROVIDER，并返回工具结果。"
```

结果：JSONL 事件包含 `tool_call`、`tool_result`、`message_end`、`turn_end` 和 `agent_end`。真实 Provider 返回的最终文本包含 `PLUGIN_PROBE:LIVE_JSON_PROVIDER`；该轮记录了 `glm-5.3` 的 input/output/total token 用量，事件版本为 2。

## Loader、Composition、Trust 和 managed plugin

由 `.di-code/live-plugin-test.mjs` 执行：

- 本地 package manifest、`exports` 和 package-root entry 解析：通过。
- project composition 插入、依赖拓扑和 required entry：通过，插件 inventory 为 `active`。
- untrusted project：插件 inventory 为 `skipped`，未加载 project-local plugin。
- capability audit：`filesystem=true`、`ui=true`、未声明的 `network=false`。
- managed `install-local`、`list`、`disable`、`enable`、`update`、`remove`、重新安装：全部通过。
- disabled managed plugin 不进入 resolved managed composition；enabled plugin 进入 `managed.di-code-live-plugin`。
- Loader dispose 后 tool registry 数量为 0，插件 disposer 标记为已执行。
- RPC composition 中插件成功注册 `fixture.live:plugin_live` method declaration。

负向配置校验也实际执行过一次：初始 composition 故意使用 tab 缩进，Loader 明确拒绝并报告 `Tabs are not allowed as indentation`，没有启动 Provider 请求；改为标准空格 YAML 后才继续测试。

另外，真实 CLI 观测命令均通过：

```powershell
npm run dev -- --dump-composition
npm run dev -- --trace-plugins
npm run dev -- plugin list
```

`--dump-composition` 和 `--trace-plugins` 正常输出 resolved tree；在没有显式 Provider 请求的 plugin/observe 命令中，`plugin list` 正常退出且不需要网络请求。

## 仓库自动化测试

实际运行结果：

| 检查 | 结果 |
| --- | --- |
| `npm test --workspace @di-code/plugin-runtime` | 4 files / 20 tests passed |
| `npm test --workspace @di-code/plugin-loader` | 1 file / 18 tests passed |
| `npm test --workspace @di-code/plugin-sdk` | 1 file / 1 test passed |
| `npm test --workspace @di-code/coding-agent` | 36 files / 371 tests passed |
| `npm run check` | Biome 和 TypeScript 均通过 |

coding-agent 全量测试从 workspace 目录运行。一次额外从仓库根目录直接指定测试文件的尝试产生了 4 个路径相关失败（测试使用 `process.cwd()` 定位 package 内源码，且子进程相对路径依赖 workspace cwd）；以正确 workspace 命令重跑后全部通过。这是测试启动目录问题，不是插件实现失败。

## 未覆盖或边界说明

- 本次真实 Provider 只使用当前可用的 `zhipu/glm-5.3`；没有擅自切换到其他需要独立 API key 的 Provider。
- RPC 插件 API 当前是 method declaration registry；本次验证了声明进入协议目录，但没有改造协议去执行插件自定义 RPC handler。
- `npm:` 和 `git:` managed source 的网络安装没有执行，以避免把测试变成不可控的第三方网络安装；local staging、registry replacement、enable/disable/remove 路径已通过真实 `PluginInstallManager` 验证，仓库已有 loader 测试覆盖 npm/git 校验与锁行为。
- 真实 Provider 请求由模型自主决定工具调用次数；一次 harness 记录了 2 次 tool call，但最终响应和工具 marker 正确，说明 Agent loop 能处理重复请求并继续完成。

## 复现入口

```powershell
node --experimental-strip-types .di-code/live-plugin-test.mjs
npm run dev -- --print --trust-project "请调用 plugin_probe 工具，参数 value 使用 LIVE_REAL_PROVIDER，然后只返回工具结果。"
npm run dev -- --mode json --trust-project "调用 plugin_probe，value=LIVE_JSON_PROVIDER，并返回工具结果。"
```

机器可读结果保存在 `.di-code/live-plugin-test-results.json`；其中仅包含能力、状态、marker 和 token 统计，不包含凭据。
