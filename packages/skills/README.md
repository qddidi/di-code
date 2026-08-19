# @di-code/skills

`@di-code/skills` provides the provider-neutral SKILL.md document format, bounded reading, recursive discovery, collision-aware catalogs, and `/skill:<name>` invocation expansion. It does not execute Markdown, grant permissions, or depend on an Agent, Provider, TUI, or coding-agent host.

Skill metadata uses YAML frontmatter with required `name` and `description` fields. Names are lowercase kebab-case up to 64 characters; documents are limited to 256 KiB. Invalid documents return diagnostics instead of becoming partially valid skills. `disable-model-invocation` and `user-invocable` default to `false` and `true` respectively.

The package root is the only public import:

```ts
import { createSkillCatalog, discoverSkills, loadSkill, readSkillContent, resolveSkillInvocation } from "@di-code/skills";
```

Skill content is untrusted prompt text. Hosts remain responsible for trust, filesystem roots, tools, and command or network policy.

Source and issue tracker: <https://github.com/qddidi/di-code>.
