# @di-code/plugin-runtime

Provider-neutral contracts for the pluggable runtime. This package owns `Context`, `Fiber`, service keys, lifecycle statuses, runtime events, capabilities, configuration schemas, and owner-aware Registry shapes. It has no dependency on `coding-agent` or product implementations.

The contracts are intentionally foundational in Stage 1; runtime behavior and product composition are introduced in later stages. Plugins should import these types from the package root.
