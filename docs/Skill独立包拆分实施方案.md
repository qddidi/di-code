# Skill 独立包拆分实施方案

## 1. 目标与原则

本方案将当前 `@di-code/coding-agent` 内置的 Skill 功能完整移除，再以新的 `@di-code/skills` workspace 包重新实现。拆分完成后，Skill 能力可以被 CLI、其他 Agent 宿主和第三方 npm 项目复用，但 Skill 本身不依赖 Provider、Agent Loop、TUI 或 coding-agent 产品逻辑。

本次采用有意的破坏性迁移，不保留旧实现的兼容分支。旧 Skill 入口删除完成后，先建立一个“不支持 Skill 但可正常构建和运行”的基线，再逐阶段恢复能力。任何阶段都不得把未实现的能力写成已支持的用户文档。

核心原则：

- `@di-code/skills` 只拥有 Skill 文档格式、解析、发现、目录、读取和调用展开。
- `@di-code/coding-agent` 拥有 CLI、项目 trust、资源组合、模型可见工具和交互入口。
- `@di-code/agent` 不依赖 Skill 包，也不负责 Skill 搜索或权限策略。
- Skill 内容和 metadata 都是不可信输入；metadata 不能授予文件、命令、网络或插件权限。
- 模型自动加载必须通过受控的 `load_skill` 工具，不让模型直接读取任意 Skill 文件路径。
- 每个阶段都要有可执行的验收命令和测试，不允许一次性大规模重写。

## 2. 当前实现的删除范围

第一阶段需要删除或改回无 Skill 状态的代码：

| 范围 | 当前位置 | 处理方式 |
| --- | --- | --- |
| Skill 文件解析和读取 | `packages/coding-agent/src/core/resources/skills.ts` | 删除 |
| `/skill:<name>` 展开 | `packages/coding-agent/src/core/skill-command.ts` | 删除 |
| Skill 类型和资源字段 | `packages/coding-agent/src/core/resources/types.ts` | 删除 Skill 类型、`skills` 字段和相关选项 |
| Skill 发现和冲突 | `packages/coding-agent/src/core/resources/loader.ts` | 删除 Skill 分支，只保留 `AGENTS.md` 加载 |
| system prompt Skill 列表 | `packages/coding-agent/src/core/system-prompt.ts` | 删除 Skill 相关格式化和输入字段 |
| Session Skill 依赖 | `packages/coding-agent/src/core/session.ts` | 删除 `skills` 选项、状态和调用展开 |
| CLI 入口 | `packages/coding-agent/src/cli.ts`、`main.ts` | 暂时删除 `--skill`、`--no-skills` 及其传递链路 |
| Interactive slash 补全 | `packages/coding-agent/src/modes/interactive.ts` | 删除 Skill 命令项 |
| Skill 测试 | `packages/coding-agent/test/resources.test.ts`、`interactive.test.ts`、相关 main/CLI 测试 | 删除 Skill 专用用例，保留 AGENTS、CLI 和 Session 的非 Skill 用例 |
| 用户文档 | `README.md`、`packages/coding-agent/README.md` | 删除旧 Skill 使用说明，待新包完成后重新写入 |

删除完成后必须确认：`AgentSession`、`ResourceSnapshot`、system prompt、CLI 和 interactive 模式中不再存在孤立的 Skill 字段或 import。此阶段不发布 npm 包，只作为实现 checkpoint。

## 3. 目标包结构

```text
packages/
  skills/
    src/
      index.ts              # 唯一公共入口
      types.ts              # metadata、descriptor、diagnostic、catalog 类型
      frontmatter.ts        # 标准 YAML frontmatter 解析和 schema 校验
      document.ts           # SKILL.md 加载和正文读取
      discovery.ts          # 目录递归发现
      catalog.ts            # 来源、优先级、冲突和可见性
      invocation.ts         # 显式调用和参数展开
    test/
      frontmatter.test.ts
      document.test.ts
      discovery.test.ts
      catalog.test.ts
      invocation.test.ts
    README.md
    package.json
    tsconfig.build.json
```

依赖方向：

```text
@di-code/coding-agent  --->  @di-code/skills
        ^                         # 无 workspace 依赖，只使用 Node.js 文件系统能力
        |
@di-code/orchestrator  -RPC->  coding-agent 子进程
                              # 不导入 coding-agent 内部模块
```

`@di-code/skills` 使用 ESM、`NodeNext`、严格 TypeScript 和 Node `>=22.19.0`。包根入口必须通过 `exports` 暴露，消费者不得导入另一个包的 `src` 或 `dist` 私有路径。

## 4. 第一版公共契约

第一版只实现稳定且可复用的核心能力，不实现 fork Agent、脚本执行和网络权限。

```ts
export type SkillSource =
  | "system"
  | "user"
  | "project"
  | "explicit"
  | "plugin"
  | "package";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly disableModelInvocation: boolean;
  readonly userInvocable: boolean;
  readonly argumentHint?: string;
}

export interface SkillDescriptor extends SkillMetadata {
  readonly kind: "skill";
  readonly filePath: string;
  readonly baseDir: string;
  readonly source: SkillSource;
}

export type SkillDiagnosticStage =
  | "discover"
  | "read"
  | "parse"
  | "collision"
  | "trust";

export interface SkillDiagnostic {
  readonly kind: "skill";
  readonly path: string;
  readonly stage: SkillDiagnosticStage;
  readonly severity: "warning" | "error";
  readonly message: string;
}

export interface SkillLoadResult {
  readonly skill?: SkillDescriptor;
  readonly diagnostics: readonly SkillDiagnostic[];
}

export interface SkillCatalog {
  readonly skills: readonly SkillDescriptor[];
  readonly diagnostics: readonly SkillDiagnostic[];
  resolve(name: string): SkillDescriptor | undefined;
  listForModel(): readonly SkillDescriptor[];
  listForUser(): readonly SkillDescriptor[];
}

export function createSkillCatalog(
  results: readonly SkillLoadResult[],
): SkillCatalog;

export function loadSkill(
  path: string,
  source: SkillSource,
): Promise<SkillLoadResult>;

export function discoverSkills(
  directory: string,
  source: SkillSource,
): Promise<readonly SkillLoadResult[]>;

export function readSkillContent(
  skill: SkillDescriptor,
  signal?: AbortSignal,
): Promise<string>;

export function resolveSkillInvocation(
  text: string,
  catalog: SkillCatalog,
  signal?: AbortSignal,
): Promise<string>;
```

契约语义：

- `filePath` 和 `baseDir` 始终是绝对路径；返回的 metadata 是新对象，调用者不得修改内部状态。
- `loadSkill` 对缺失、非法 frontmatter、非文件和超限文件返回诊断，不把格式错误静默转换为有效 Skill。
- `readSkillContent` 支持取消，正文上限默认 256 KiB；超过上限必须拒绝，不得部分执行。
- `resolveSkillInvocation` 对普通 prompt 原样返回；未知 Skill、非法命令和取消都以可识别错误拒绝。
- `listForModel()` 过滤 `disableModelInvocation`，`listForUser()` 过滤 `userInvocable`。
- 同名 Skill 的选择由 `SkillCatalog` 统一完成；被覆盖项必须留下 `collision` 诊断。

## 5. SKILL.md 格式

### 5.1 第一版字段

```yaml
---
name: release-check
description: Verify release prerequisites before publishing.
disable-model-invocation: false
user-invocable: true
argument-hint: "[package]"
---

Read the release checklist before taking any publishing action.
```

要求：

- frontmatter 使用标准 YAML 解析器，不继续维护手写 `key:value` 解析器。
- `name` 使用小写字母、数字和单连字符，长度不超过 64。
- `description` 必填，长度不超过 1,024。
- 文件默认不超过 256 KiB；具体上限作为包级常量和 JSDoc 记录。
- 未知 metadata 字段默认产生 warning 并保留正文，不得静默改变安全策略。
- `disable-model-invocation` 和 `user-invocable` 必须是真正的 YAML boolean。
- `disable-model-invocation` 默认 `false`，`user-invocable` 默认 `true`。

### 5.2 后续字段

以下字段先进入设计预留，不在第一版承诺行为：

- `allowed-tools`：只作为模型提示和工具过滤候选，不能替代工具边界校验。
- `model`：只在宿主支持模型路由时生效。
- `context: fork`、`agent`：只有 Agent 能创建独立上下文并正确传播取消、会话和结果时才实现。
- `hooks`：属于插件/宿主生命周期能力，不能由 Markdown metadata 直接注册进程 handler。

## 6. 宿主集成设计

### 6.1 `coding-agent` 资源层

`coding-agent` 保留 `ResourceSnapshot`，但不再实现 Skill 解析。新的资源加载流程为：

1. 加载全局目录和当前工作目录中的 `AGENTS.md`。
2. 根据 CLI 和 trust 状态生成 Skill 搜索根目录。
3. 调用 `@di-code/skills` 的 `discoverSkills()`。
4. 按明确的根目录顺序加入 catalog，产生冲突诊断。
5. 将 catalog 的只读快照传给 `AgentSession` 和 system prompt。

项目 trust 仍由 `coding-agent` 拥有。Skill metadata、`allowed-tools` 或正文不能改变 trust、`allowedRoot`、命令超时或网络权限。

### 6.2 模型自动加载

在 `coding-agent` 增加内部 `load_skill` 工具：

```json
{
  "name": "load_skill",
  "parameters": {
    "name": "release-check"
  }
}
```

工具要求：

- 参数只接受 catalog 中的 Skill 名称，不接受任意路径。
- `disable-model-invocation: true` 的 Skill 对模型不可见。
- 读取通过 `readSkillContent()` 完成，支持 `AbortSignal` 和大小限制。
- 返回结果只包含 Skill 正文及必要的来源信息。
- Skill 目录中的附属文件必须通过单独的、以 `baseDir` 为边界的只读接口访问；第一版可暂不支持附属文件。

system prompt 只列出名称、描述和 `load_skill` 的使用语义，不再要求模型用普通 `read` 工具读取工作区外路径。

### 6.3 用户显式调用

第一版保留 `/skill:<name> [request]` 作为兼容入口，并增加参数替换：

- `$ARGUMENTS` 替换为完整请求文本；
- `$1`、`$2` 等替换为按空白分隔的参数；
- 不存在的参数替换为空，并产生可诊断的 warning；
- `user-invocable: false` 的 Skill 不出现在补全和显式调用列表中。

是否增加 `/name` 或 `$name` 别名，等第一版稳定后再决定，避免和现有 slash command、shell 变量及 prompt 文本冲突。

## 7. 分阶段实施任务

### 阶段 A：删除旧实现

- [ ] 删除旧 Skill 源码、类型、loader 分支、Session 字段和 CLI 参数。
- [ ] 删除旧 Skill 专用测试，修复剩余测试 fixture 和 imports。
- [ ] 从 root README 和 `packages/coding-agent/README.md` 删除旧 Skill 使用说明。
- [ ] 确认 `rg -n "skill|Skill|SKILL.md" packages/coding-agent/src` 只剩计划中的文档或无关文本。
- [ ] 运行 `npm run check`、`npm test`、`npm run build`。

**阶段验收：**仓库在没有 Skill 功能的状态下可构建、可运行、可测试；此阶段不发布。

### 阶段 B：创建 `@di-code/skills` 包

- [ ] 新建包 metadata、exports、README 和 build 配置。
- [ ] 引入并锁定标准 YAML 解析依赖。
- [ ] 实现 frontmatter 校验、Skill 加载、正文读取和取消。
- [ ] 实现递归发现：跳过隐藏目录和 `node_modules`，排序稳定，发现根 symlink 不越界。
- [ ] 实现 catalog、来源和同名冲突诊断。
- [ ] 实现 `/skill:` 解析和参数替换。

**阶段验收：**`npm test --workspace @di-code/skills`、`npm run check` 和该包 build 通过；包根入口不依赖 coding-agent。

### 阶段 C：恢复 `coding-agent` 集成

- [ ] 将 `coding-agent` 添加为 `@di-code/skills` 消费者，更新 workspace build 顺序。
- [ ] 用 Skill catalog 替换资源 loader 中已删除的实现。
- [ ] 恢复 `--skill`、`--no-skills` 和项目 trust，但参数只负责宿主策略。
- [ ] 增加 `load_skill` 内部工具和取消、错误、输出大小测试。
- [ ] 恢复 system prompt Skill 列表和 interactive 补全。
- [ ] 输出 `skill_diagnostic`，覆盖 parse、discover、trust 和 collision。

**阶段验收：**覆盖项目、全局、explicit 三种来源；模型可通过 `load_skill` 加载工作区外 Skill；`/skill:` 显式调用和错误信息保持确定性。

### 阶段 D：兼容能力和资源目录

- [ ] 增加 `user-invocable`、`argument-hint` 和完整的用户/模型可见性矩阵。
- [ ] 增加 Skill 目录内的只读 `references/` 访问，严格限制在 `baseDir`。
- [ ] 增加插件或 npm 包内置 Skill 的注册接口，不允许动态 import Markdown。
- [ ] 评估 `allowed-tools`、`model`、`context: fork` 和 `agent`，每项单独形成接口和测试，不打包成模糊的 metadata 开关。

**阶段验收：**每个新增字段都有明确 owner、失败语义、取消行为、测试和 README 文档；没有字段只“解析但不生效”。

## 8. 测试矩阵

`@di-code/skills` 必须覆盖：

- BOM、LF/CRLF、缺少结束标记、非法 YAML、重复键、未知字段。
- name/description 长度、字符集和 boolean 类型。
- 空文件、非 UTF-8/二进制、超限、读取取消和文件替换竞态。
- 递归发现顺序、隐藏目录、`node_modules`、坏目录、文件 symlink 和目录 symlink。
- 同名 Skill 的优先级、shadowed 诊断和 model/user 可见性。
- `/skill:`、参数替换、未知 Skill、非法命令和取消。

`@di-code/coding-agent` 必须覆盖：

- 未信任项目不加载 project Skill。
- global/explicit Skill 不被 `allowedRoot` 错误阻断。
- 模型只能通过 `load_skill` 读取已注册 Skill，不能读取任意路径。
- `--no-skills` 完全关闭 catalog 和 `load_skill`。
- print、json、interactive 三种模式的诊断输出位置和格式。
- Skill 内容不会进入系统 prompt 的完整正文，只有被显式或模型工具加载后才进入对话。

## 9. 安全与失败语义

- Skill 正文始终标记为不可信指令，不能覆盖宿主安全边界。
- 所有路径在读取前都要进行绝对化、realpath 和根目录边界检查。
- 发现根内的 symlink 不得逃逸；explicit 路径是否允许外部文件必须由 CLI 文档明确声明。
- 读取使用有上限的 file handle，避免 `stat` 后文件变大导致超限读取。
- metadata 解析错误返回诊断；不能自动降级为“部分有效 Skill”。
- 工具错误、取消、超限和文件消失必须区分，不得统一吞成空正文。
- Skill 包不执行 Markdown 中的脚本，不动态 import Skill 目录文件。

## 10. 发布、文档与版本

新增包后必须同步：

- 根目录 `package.json` 的 workspace build 顺序。
- `scripts/version-packages.mjs` 和 `scripts/release-dry-run.mjs` 的 workspace 列表。
- `package-lock.json`、`packages/skills/package.json` 和 `packages/skills/README.md`。
- `docs/开发教程.md` 的包结构、资源加载和测试说明。
- root README 的架构和用户行为概览。
- `packages/coding-agent/README.md` 的 CLI、Skill 使用和安全限制。

第一阶段继续使用仓库现有的同步版本策略。`@di-code/skills` 虽然可以独立安装，但暂不引入独立版本节奏；如未来需要独立发布，再单独迁移版本工具或 Changesets。

完成阶段 C 后运行：

```powershell
npm test --workspace @di-code/skills
npm test --workspace @di-code/coding-agent
npm run check
npm run build
npm run release:dry-run
git diff --check
```

## 11. 暂不实现的内容

以下能力不进入第一版，避免把 Skill 包变成第二套插件系统：

- Skill 内执行 shell、网络请求或任意 TypeScript/JavaScript。
- Skill metadata 直接授予工具权限或改变 `allowedRoot`。
- Skill 自己启动 Agent Loop。
- Skill 直接写 Session 或 RPC 记录。
- 多版本 Skill 同时激活。
- 没有测试和文档的兼容别名。

## 12. 完成定义

拆分只有在以下条件全部满足后才算完成：

- 旧 Skill 实现已经删除，唯一实现位于 `@di-code/skills`。
- `coding-agent` 只保留宿主策略和集成，不再复制解析、读取和调用逻辑。
- 全局、项目和 explicit Skill 都能通过受控 `load_skill` 被模型加载。
- 无效 Skill、冲突、trust、取消和越界路径都有可观察诊断。
- 新包有独立 README、根入口、构建产物和 workspace 测试。
- `npm run check`、相关测试、`npm run build`、`npm run release:dry-run` 和 `git diff --check` 全部通过。
