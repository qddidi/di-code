# @di-code/plugin-runtime

`@di-code/plugin-runtime` is the future public plugin runtime boundary for di-code hosts and plugin authors. It will own the plugin manifest contract, scopes, contribution registry, lifecycle diagnostics, and host-neutral plugin APIs.

Phase 0 creates the publishable package and its root entry only. It currently exports no runtime contract and has no production consumer. Existing plugin loading remains in `@di-code/coding-agent` until the runtime and host adapter are implemented in later phases.

The package will depend only on public `@di-code/ai` and `@di-code/agent` APIs. It must not import `@di-code/coding-agent`, `@di-code/tui`, Session storage, or another package's `src` or `dist` paths.

Source and issue tracking: <https://github.com/qddidi/di-code>.
