---
name: di-code-pre-push-checks
description: Use before pushing, opening a pull request, or claiming a di-code change is verified; select the smallest checks that cover the changed npm workspace packages, CLI/TUI behavior, Provider, Agent, plugin, Session, RPC, build, or release surfaces.
---

# di-code Pre-Push Checks

Use this skill to map an outgoing diff to focused evidence. Do not run the full suite by habit: choose checks based on the files and behavior affected, then report exactly what ran and what was skipped.

## Inspect the change

Start with:

```powershell
git status --short --branch
git diff --stat
git diff --name-only
```

Include staged, unstaged, and untracked files in the scope. Read the owning package README, package.json, tests, and public entry point before selecting checks. Do not reset or discard unrelated user changes.

## Check selection

- **Markdown, `AGENTS.md`, README, JSDoc, or comments:** run `npm run check` and `git diff --check`. If a public behavior or API description changed, inspect the corresponding package tests and README manually.
- **One package source or test:** run `npm test --workspace @di-code/<package>` and `npm run check`.
- **`ai` Provider, request adapter, stream parser, model types, or tool schema:** run the focused `packages/ai` test file or test name, then `npm test --workspace @di-code/ai`; run configured smoke tests only when credentials are available.
- **`agent` loop, turn state, cancellation, compaction, or message events:** run the focused `packages/agent` tests and `npm test --workspace @di-code/agent`; add `coding-agent` tests when the assembled runtime is affected.
- **`coding-agent` CLI, tools, plugins, Session, modes, or RPC:** run the owning focused tests and `npm test --workspace @di-code/coding-agent`; use a real subprocess test when the change crosses a process or JSONL boundary.
- **`tui` components, keyboard handling, terminal rendering, or layout:** run the focused TUI tests and `npm test --workspace @di-code/tui`; use a real terminal only when virtual-terminal tests cannot observe the behavior.
- **`orchestrator`, RPC client/server, process lifecycle, cancellation, or stderr handling:** run focused orchestrator and coding-agent RPC tests, then both affected workspace test commands.
- **Package manifests, exports, TypeScript config, build entries, or generated runtime paths:** run `npm run check` and `npm run build`; exercise the built entry point when the published path changed.
- **Release scripts, versions, or publish metadata:** run `npm run build` and `npm run release:dry-run`; never publish merely to validate a change.

## Broaden deliberately

Run `npm test` when the change crosses several packages, changes a shared public contract, modifies workspace configuration, or the user explicitly requests the full suite. Real Provider tests are optional evidence and must use environment configuration without printing secrets. Prefer `DI_CODE_PROVIDER=faux` for keyless CLI verification.

Do not repeat a check that already passed unless the source, lockfile, configuration, or relevant environment changed. A green check does not replace review of model-visible output, durable Session data, path security, cancellation, or subprocess behavior.

## Report

State the changed surfaces, commands actually run, skipped checks and why, and any remaining risk. Before pushing, also run `git diff --check` and inspect `git status --short`; confirm `.env`, `.di-code/`, `node_modules/`, and `dist/` are not being added.
