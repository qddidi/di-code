# @di-code/builtins

Reference namespace plugins used by the Stage 7 minimal composition. The package exposes only public workspace dependencies and contains no CLI-specific legacy loader path.

The profile mounts `Bootstrap`, `runtime`, `diagnostics`, `process-exit`, `provider-registry`, `provider-faux`, `agent-loop`, `session-memory`, and `mode-print`. `provider-faux` is deterministic and offline. `session-memory` and the Agent subscription are owned by their plugin Fibers and are released during reverse-order composition disposal.
