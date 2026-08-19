---
name: di-code-prose-standard
description: Use when writing or reviewing di-code JSDoc, comments, README prose, Chinese tutorials, plugin descriptions, CLI help, diagnostics, prompts, or other user- and model-visible strings.
---

# di-code Prose Standard

Write prose from the repository's current-state perspective. Every sentence should state a complete, verifiable proposition or a concise instruction that helps a maintainer or user act correctly.

## Required content

- Public JSDoc covers parameters, return values, errors, side effects, ownership, timing, cancellation, and persistence when callers rely on them.
- Module and package prose states role, supported consumers, important limits, and non-obvious integration constraints.
- Comments explain why an invariant, ordering, defensive check, or cleanup path exists; delete comments that only narrate control flow or restate syntax.
- CLI help, diagnostics, prompts, and tool descriptions name the action, input, result, failure condition, and relevant limit. Treat their wording as behavior.
- Chinese documentation uses consistent technical names for packages, APIs, environment variables, and protocol fields; retain exact code identifiers in backticks.

## Avoid

Do not write review history, change narration, unresolved planning language, or arguments addressed to a reviewer. Avoid claims such as "safe" or "secure" without naming the enforced condition. Do not describe a test walkthrough as a contract. Do not invent guarantees that the current implementation does not enforce.

When a historical or architectural rationale matters, link the committed owner instead of embedding a session transcript. When wording is model-visible or CLI-visible, inspect the resulting output and add or update a focused test where practical.

## Editing workflow

Read the owning code and existing documentation first. Enumerate the propositions that must survive an edit, then keep, add, trim, or restructure only what is supported by current behavior. Update derived docs from their source, not by leaving conflicting copies. Finish with `git diff --check`, `npm run check`, and the narrow behavior test for visible strings when one exists.
