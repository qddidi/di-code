# MCP 外部 Server 集成实施方案

## 1. 文档状态

本文是 di-code 集成外部 MCP Server 的设计和实施方案。当前仓库尚未支持 MCP；本文中的配置、命令和 API 都是目标设计，不代表当前版本已经可用。

实现目标是让 di-code 作为 MCP Host，在启动时连接一个或多个外部 MCP Server，把 Server 暴露的工具接入现有 `@di-code/agent` 工具循环。MCP 协议客户端独立于 `coding-agent`，但第一阶段可以只作为仓库内部 workspace 包使用。

## 2. 设计结论

MCP 不实现为现有插件的一个特殊分支，而是拆成独立的 `@di-code/mcp` 包，再由 `@di-code/coding-agent` 负责产品集成。

```text
@modelcontextprotocol/sdk
          |
@di-code/mcp
  MCP Client、transport、连接生命周期、协议错误
          |
@di-code/coding-agent
  配置、trust、启动/关闭、诊断、MCP Tool 适配
          |
@di-code/agent
  唯一的模型-工具循环、取消和事件顺序
```

依赖方向必须保持：

- `@di-code/mcp` 不依赖 `@di-code/coding-agent`、`@di-code/agent` 或 `@di-code/tui`。
- `@di-code/mcp` 只拥有 MCP 协议连接能力，不实现 Agent Loop、不决定工具是否允许执行。
- `@di-code/coding-agent` 负责把 MCP 工具转换成当前 `AgentTool`，并拥有 CLI、Session、信任和用户确认策略。
- `@di-code/orchestrator` 不直接访问 MCP 包或 coding-agent 内部模块；它仍然只通过公开 RPC 监督 coding-agent 子进程。

## 3. MCP 规范范围

MCP 使用 JSON-RPC 2.0 定义 Host、Client 和 Server 之间的通信。实现应以官方规范和官方 TypeScript SDK 为准，不手写一套平行协议。

第一阶段锁定一个明确的规范/SDK 版本，并在包 README 中记录版本。SDK 当前提供的标准传输包括：

- `stdio`：由 Host 启动本地 Server 子进程，适合本地工具和开发工具。
- Streamable HTTP：连接远程 Server，作为第二阶段能力。
- HTTP + SSE：不支持。仅在未来出现明确的存量 Server 兼容需求时单独评估。

MCP Server 可以提供 `tools`、`resources` 和 `prompts`；Client 可以提供 `sampling`、`roots` 和 `elicitation`。第一阶段只实现 Server tools，不宣称完整 MCP capability 支持。

官方参考：

- [MCP Specification](https://modelcontextprotocol.io/specification/2025-06-18)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## 4. 分阶段范围

### 4.1 第一阶段：stdio tools MVP

第一阶段必须能够连接本地 MCP Server，并让模型调用 Server tool。

包含：

- 一个或多个 `stdio` Server 配置。
- `initialize`、能力协商和初始化完成流程。
- `tools/list`，把工具名称、说明和 `inputSchema` 暴露给 Agent。
- `tools/call`，把模型参数转发到对应 Server。
- Server 级命名空间：`mcp__<server-id>__<tool-name>`。
- `AbortSignal` 取消传播、请求超时、Server 退出检测。
- 启动失败、协议错误、工具错误和子进程 stderr 的脱敏诊断。
- Session 关闭时关闭所有 MCP Client 和子进程。
- 单元测试和一个本地 fixture MCP Server。

不包含：

- resources 自动注入模型上下文。
- prompts 自动转换为 slash command。
- sampling、elicitation 和 roots。
- OAuth、动态注册和复杂的自动重连。
- MCP Server 市场、自动安装或真正的权限沙箱。

### 4.2 第二阶段：Streamable HTTP 和配置体验

- 支持远程 Streamable HTTP Server。
- Server 级 HTTP headers 和环境变量引用。
- 明确的 HTTP 超时、连接失败和认证错误分类。
- Claude Code 风格的 `di-code mcp add`、`list`、`get`、`remove` 管理命令和配置范围。
- 项目级、用户级和本地配置的范围和覆盖规则。
- interactive 模式中的 Server 状态和授权提示。

### 4.3 第三阶段：resources/prompts 和高级能力

只有在工具集成稳定后再评估：

- `resources/list`、`resources/read` 的显式用户/模型访问方式。
- `prompts/list`、`prompts/get` 的 slash command 或显式调用方式。
- OAuth 和 URL elicitation。
- progress、分页、通知和可恢复任务。
- Server 级重连策略和连接池。

每项能力都必须先定义在 di-code 中的用户可见语义，不能因为 SDK 有 API 就自动暴露。

## 5. 目标包结构

```text
packages/mcp/
  src/
    index.ts              # 包根公共导出
    types.ts              # Server 配置、MCP 工具和结果类型
    client.ts             # 单个 MCP Client 生命周期
    manager.ts            # 多 Server 并发连接和关闭
    transport.ts          # stdio / Streamable HTTP 构造
    errors.ts             # 可分类的连接、协议、超时和调用错误
    schema.ts             # 外部 JSON Schema 边界处理
  test/
    client.test.ts
    manager.test.ts
    stdio.test.ts
    errors.test.ts
  README.md
  package.json
  tsconfig.build.json
```

`coding-agent` 的适配代码放在：

```text
packages/coding-agent/src/mcp/
  config.ts              # .mcp.json 解析和标准化
  loader.ts              # Server trust、连接和诊断
  tool-adapter.ts        # MCP tool -> AgentTool
  lifecycle.ts           # Session/CLI 的启动和关闭
```

第一阶段不把 MCP 适配逻辑放进 `extensions/runtime.ts`。现有插件仍保持原有契约；插件可以自行包装 MCP，但这不是 Host 的标准集成路径。

## 6. `@di-code/mcp` 公共契约

公共契约应先于实现确定。下面是 `@di-code/mcp` 的运行时标准化形状，最终字段以 SDK 和测试为准；它不是 `.mcp.json` 的用户配置格式。

```ts
export type McpTransportConfig =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "streamable-http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface McpServerConfig {
  readonly id: string;
  readonly name?: string;
  readonly transport: McpTransportConfig;
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly serverId: string;
}

export interface McpClient {
  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<readonly McpTool[]>;
  callTool(name: string, argumentsValue: unknown, signal?: AbortSignal): Promise<McpToolResult>;
  close(): Promise<void>;
}
```

契约必须明确：

- `connect()` 成功后才允许 `listTools()` 和 `callTool()`。
- `close()` 幂等；成功、失败、取消和重复关闭都必须释放子进程、监听器和临时资源。
- 一个 Client 的并发 `callTool()` 是否允许由 transport/SDK 决定，但必须在测试中固定行为；不要静默改变请求顺序。
- 取消通过 `AbortSignal` 传播到 SDK、HTTP 请求或子进程；取消不应被转换成普通的 Server 错误。
- 工具调用错误区分参数错误、连接错误、超时、取消、Server 返回的 tool error 和 Server 崩溃。
- 所有从 Server 返回的文本、资源和错误都视为不可信内容；日志和诊断必须脱敏并限制大小。

## 7. 配置设计

项目配置文件使用工作根目录下的 `.mcp.json`，顶层字段为 `mcpServers`。该路径和核心字段与 Claude Code 的项目 MCP 配置保持一致，便于同一项目复用 Server 定义；它不是 MCP 协议本身规定的配置标准。MCP Server 不混入 Provider 的 `settings.json`，两者的生命周期、凭据和错误语义不同。

目标配置示例：

```json
{
  "mcpServers": {
    "project-tools": {
      "command": "npx",
      "args": ["-y", "@example/project-mcp"],
      "env": {
        "EXAMPLE_TOKEN": "${EXAMPLE_TOKEN}"
      }
    }
  }
}
```

第二阶段的远程 Server 使用 Claude Code 风格的 HTTP 条目：

```json
{
  "mcpServers": {
    "company-api": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${COMPANY_MCP_TOKEN}"
      }
    }
  }
}
```

配置规则：

- `mcpServers` 的 key 是 Server ID，必须非空、稳定且适合工具命名空间；最终工具名不能包含会破坏 Provider 工具名约束的字符。
- 未声明 `type` 的条目按 stdio Server 解析，使用 `command`、可选 `args` 和可选 `env`。启动时使用结构化参数，禁止拼接未经校验的 shell 字符串。
- Streamable HTTP 条目使用 `type: "http"` 和绝对 `http`/`https` `url`；它在第二阶段实现。
- `env` 和 `headers` 中的 `${ENV_VAR}` 是环境变量引用；缺失时错误只显示变量名，不显示值。
- 项目配置默认不自动获得高权限。是否加载项目 MCP 配置应与项目 trust 决策关联，但 trust 不能被解释为工具调用授权。
- MVP 不增加 `enabled`、超时、`cwd` 或其他 di-code 私有配置字段；存在于 `mcpServers` 的 Server 即为启用状态。连接和调用超时使用实现中固定且有测试的默认值，只有在确有需要时才通过兼容性设计扩展配置。
- Server 配置不是 Session JSONL 内容，不写入 API key、Authorization header 或完整请求体。

### 7.1 MCP 管理命令（第二阶段）

第一阶段只读取手动维护的项目 `.mcp.json`。第二阶段增加与 Claude Code 同类的配置管理命令：

```text
di-code mcp add
di-code mcp list
di-code mcp get <server-id>
di-code mcp remove <server-id>
```

`add` 注册 Server 配置，**不是**下载、安装或信任任意 MCP Server 软件。对于 stdio Server，用户传入明确的命令和结构化参数；例如 `npx` 何时下载包、`uvx` 如何解析环境或 `docker` 如何拉取镜像，仍由这些用户指定的命令在连接时负责。di-code 不提供 MCP Server 市场、包安装器或自动执行下载文件的机制。

目标调用形状：

```powershell
# stdio：`--` 后的值原样保存为 command 和 args，不经 shell 拼接。
di-code mcp add --scope project --transport stdio project-tools -- npx -y @example/project-mcp

# Streamable HTTP（第二阶段）。
di-code mcp add --scope project --transport http company-api https://mcp.example.com/mcp

di-code mcp list --scope project
di-code mcp get project-tools --scope project
di-code mcp remove project-tools --scope project
```

范围语义对齐 Claude Code 的 `local`、`project`、`user` 概念，同时使用 di-code 自己的受管目录：

| Scope | 存储位置 | 用途 | 默认是否提交 |
| --- | --- | --- | --- |
| `local`（默认） | `<work-root>/.di-code/mcp.local.json` | 当前项目的个人配置或本地凭据引用 | 否 |
| `project` | `<work-root>/.mcp.json` | 团队共享、可移植的 Server 定义 | 是，由项目自行决定 |
| `user` | `~/.di-code/mcp.json` | 当前用户所有项目可用的 Server 定义 | 否 |

写入规则：

- `add` 拒绝无效 Server ID、未知 transport、非法 URL、重复 Server ID 和未通过解析的环境变量引用；不覆盖已有定义。
- `remove` 只删除指定 scope 中的同名条目；不存在时返回明确错误，不跨 scope 删除。
- `get` 默认按生效优先级显示最终条目，并标出其来源；`--scope` 时只读取指定文件。
- `list` 不显示环境变量的实际值、HTTP authorization 值或任何其他凭据。
- 同一 Server ID 的生效优先级为 `local` > `project` > `user`。各 scope 的条目整体覆盖，不做字段级合并，避免把 command、URL 或 headers 拼成不可解释的混合配置。
- `add` 和 `remove` 必须以原子写入方式更新 JSON，保留无关的 `mcpServers` 条目；写入失败不得留下截断文件。
- 对项目范围的写入必须遵从项目 trust；非交互模式是否允许写项目配置需要明确 CLI 策略和测试，不能静默修改工作树。

`env` 和 `headers` 的复杂编辑不作为首版 `add` 参数。用户可先维护 `.mcp.json`，后续只有在明确设计了可脱敏、可验证的 `--env` / `--header` 语法后才添加命令支持。

## 8. Agent 适配

`coding-agent` 启动 MCP Manager，取得每个 Server 的 tools，然后在创建 `AgentSession` 时将它们转换为当前 Agent 使用的工具。

```text
MCP inputSchema (JSON Schema)
             |
             v
coding-agent tool adapter
  名称、说明、参数校验、callTool、结果限制
             |
             v
@di-code/agent AgentTool
             |
Provider -> tool call -> Agent 校验 -> MCP callTool -> tool result
```

工具名称统一为：

```text
mcp__<server-id>__<tool-name>
```

适配器必须：

- 保留 Server 原始名称用于 `callTool`，不要把命名空间名称传给 MCP Server。
- 检查最终名称与内置工具、插件工具和其他 MCP Server 不冲突。
- 对 MCP 返回的普通 JSON Schema 做边界验证。不能只依赖 TypeScript 类型断言，也不能因为模型参数通过 Provider schema 就跳过运行时校验。
- 将 MCP 结果转换为现有 `ToolResultContent[]`，并限制文本、结构化数据和图片结果大小。
- 保持现有 Agent 的 `tool_execution_start`、`tool_execution_end`、Session 持久化和取消语义，不增加第二套 MCP 专用对话循环。
- 对需要用户确认的工具在实际执行前询问；事件监听器不能作为事后权限拦截器。

JSON Schema 适配是第一阶段的风险点。当前 `@di-code/ai` 的 Provider 工具描述使用 TypeBox schema，而 MCP 的 `inputSchema` 是外部 JSON Schema。实现应选择一种明确方案并测试：

1. 使用 JSON Schema 验证器在 MCP adapter 内完成参数校验，向 Provider 传递一个兼容的工具描述；或
2. 将受支持的 JSON Schema 子集转换为 TypeBox，并对不支持的 schema 明确拒绝。

不能把任意外部 schema 直接强制转换成 `TSchema` 后宣称已完成验证。

## 9. 生命周期和错误处理

推荐生命周期：

```text
CLI 解析配置
  -> 验证配置和 trust
  -> 创建 MCP Manager
  -> 并发连接配置的 Server
  -> initialize / capability negotiation
  -> listTools
  -> 创建 AgentSession
  -> prompt 期间 callTool
  -> Session/CLI 结束
  -> 停止接受新调用
  -> 关闭 MCP Clients
  -> 等待子进程和监听器释放
```

失败语义：

- 一个 Server 连接失败不应默认阻止其他 Server 和内置工具启动；记录带 Server ID 的 `mcp_diagnostic`。首个版本不定义“必需 Server”配置。
- `tools/list` 失败时不注册该 Server 的工具，避免模型看到不可用工具。
- `callTool` 超时返回明确的工具错误，并保留可诊断的 Server ID；不能吞掉超时或无限等待。
- Server 子进程异常退出后，已注册工具仍必须以可观察的不可用错误结束；不能继续向已关闭 transport 发送请求。
- 取消只取消当前请求，除非 transport 已经不可恢复；不要因为一次用户取消就无条件关闭所有 Server。
- 进程 stdout 只承载 MCP transport 数据；Server 的诊断输出必须走 stderr，并使用上限截断。
- 关闭阶段即使某个 Server 关闭失败，也必须继续关闭其他 Server，并汇总诊断。

## 10. 安全边界

MCP Server 是不可信的外部代码或远程服务，连接 MCP Server 不等于授予它 di-code 的所有权限。

必须保留以下边界：

- `stdio` Server 是本机子进程，执行前检查 command、args、cwd、环境变量和项目 trust。
- 不把真实 API key、Authorization header、完整请求体或 Server 返回的敏感诊断写入 Session、日志或测试 fixture。
- HTTP URL 必须是绝对 `http`/`https` URL；认证信息不出现在错误消息和工具结果中。
- MCP tool 的描述和 annotations 是不可信模型输入；描述不能自动授予文件、网络、进程或用户数据权限。
- tools 是潜在副作用操作。interactive 模式需要可见的调用和授权语义；print/json 模式必须有明确的非交互策略，不能因为没有 TTY 就静默放行高风险操作。
- MCP Server 返回的资源、文本和错误可能包含提示注入，不应改变宿主的系统提示、权限或工具边界。
- 配置、schema、结果和 stderr 都应有大小上限，避免内存和上下文无限增长。

现有插件的 `permissions` 仍只是声明和审计信息，不会成为 MCP 的运行时沙箱。MCP 必须拥有独立的配置和授权模型。

## 11. 测试和验收

### `@di-code/mcp` 测试

- initialize 成功、协议版本不兼容和能力缺失。
- stdio Server 启动、参数传递、stderr 分离和正常关闭。
- `tools/list` 的分页/空列表/非法响应处理。
- `tools/call` 成功、Server tool error、JSON-RPC error、超时和取消。
- Server 异常退出、重复关闭和并发调用行为。
- Streamable HTTP 的 URL、headers、HTTP 错误和响应大小限制（第二阶段）。
- 所有诊断中的 `token`、`secret`、`authorization`、`api_key` 模式脱敏。

### `coding-agent` 集成测试

- `.mcp.json` 的合法配置、非法配置、环境变量缺失和 Server ID 冲突。
- `mcp add/list/get/remove` 的 stdio/HTTP 参数解析、scope、重复 ID、原子写入和凭据脱敏。
- 同一 Server ID 在 `local`、`project`、`user` 三个 scope 中的整体覆盖优先级。
- MCP 工具名称与内置工具、插件工具冲突时拒绝注册。
- 模型调用 `mcp__server__tool` 后参数校验、MCP 转发和 ToolResult 回传。
- MCP 工具调用事件进入现有 Agent/Session 事件和 JSONL 持久化。
- prompt 取消、Session 关闭和 Server 崩溃都释放资源。
- 没有 MCP 配置时现有 Faux Provider、插件、CLI 和 Session 行为不变。

### 验收命令

实现阶段按改动范围执行：

```powershell
npm test --workspace @di-code/mcp
npm test --workspace @di-code/coding-agent
npm run check
npm run build
git diff --check
```

使用 fixture MCP Server 做离线验证，不依赖真实网络或 API key。真实远程 MCP Server 测试必须显式配置环境变量，并在缺少凭据时跳过。

## 12. 实施顺序

1. 创建 `packages/mcp` workspace、包入口、严格 TypeScript 配置和官方 SDK 依赖。
2. 实现单个 stdio Client，覆盖 initialize、close、listTools、callTool 和错误分类。
3. 添加 fixture MCP Server 和 `@di-code/mcp` 单元测试。
4. 在 `coding-agent` 增加 Claude Code 兼容的 `.mcp.json` 解析、环境变量解析和诊断类型。
5. 实现 MCP Tool adapter，完成 JSON Schema 验证和 `mcp__...` 命名空间。
6. 接入 `AgentSession`，保证 Agent Loop、事件和 Session 仍是唯一主链路。
7. 增加 CLI/interactive/json 的启动、确认、诊断和关闭测试。
8. 第二阶段实现 Streamable HTTP、`mcp add/list/get/remove`、三个配置 scope 和对应写入/覆盖测试。
9. 更新 `packages/mcp/README.md`、`packages/coding-agent/README.md` 和根 README 的已支持范围；在实现完成前不要提前写“已支持 MCP”。
10. 完成 focused tests、`npm run check`、`npm run build` 和 `git diff --check` 后再评估 resources、prompts 与 OAuth。

## 13. 明确不采用的方案

### 把 MCP 协议直接写进现有插件 API

不采用。插件 API 是同进程注册工具、命令和事件的扩展契约，没有合适的 transport、连接关闭、Server 崩溃、OAuth、资源/提示词和独立授权模型。这样会把任意插件代码和 MCP Server 生命周期混在一起。

### 让 `@di-code/agent` 直接依赖 MCP

不采用。Agent 只应接收已经声明好的工具并运行唯一的模型-工具循环。MCP 配置、进程、网络和用户授权属于产品层，不属于 Provider 无关的 Agent 核心。

### 自己实现完整 MCP JSON-RPC 协议

不采用。官方 SDK 已经维护协议版本、transport、认证和能力 API。di-code 只实现自己的配置、信任、结果限制和 Agent 适配逻辑。

## 14. 完成标准

第一阶段完成必须同时满足：

- 一个本地 stdio MCP Server 可以通过 Claude Code 兼容的 `.mcp.json` 配置并连接。
- 模型能够看到并调用命名空间化 MCP tool。
- 参数经过运行时 JSON Schema 校验，结果和错误进入现有 Agent/Session 链路。
- 取消、超时、Server 崩溃和 CLI 退出不会遗留子进程、监听器或未关闭 transport。
- 配置和诊断不会泄露凭据，所有新增测试离线可重复运行。
- 文档明确区分已支持能力、暂不支持能力和后续扩展，不把插件描述成 MCP Server。
