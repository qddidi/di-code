# @di-code/skills

`@di-code/skills` 提供 Provider 无关的 SKILL.md 文档格式、带边界的内容读取、递归发现、带冲突检测的目录，以及 `/skill:<name>` 调用展开。它不执行 Markdown、不授予权限，也不依赖 Agent、Provider、TUI 或 coding-agent 宿主。

默认 composition 通过 `@di-code/builtins/skills` 将 catalog 接入产品资源；项目 trust 决定项目本地 Skill 是否加载，Skill 内容本身始终是不可信提示词文本。

Skill 元数据使用 YAML frontmatter，`name` 和 `description` 为必填字段。名称为小写 kebab-case，最长 64 个字符；文档大小限制为 256 KiB。非法文档返回诊断信息，而不是变成部分有效的 skill。`disable-model-invocation` 和 `user-invocable` 的默认值分别为 `false` 和 `true`。

包根入口是唯一的公共导入方式：

```ts
import { createSkillCatalog, discoverSkills, loadSkill, readSkillContent, resolveSkillInvocation } from "@di-code/skills";
```

Skill 内容是不可信的提示词文本。信任判定、文件系统根目录、工具以及命令或网络策略仍由宿主负责。

源码与 issue 跟踪：<https://github.com/qddidi/di-code>。
