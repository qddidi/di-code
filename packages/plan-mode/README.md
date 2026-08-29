# @di-code/plan-mode

Reference plan-mode plugin for `di-code`. It keeps mode changes in the versioned Session event `plan/mode`, derives `{ active, pending }`, contributes the dynamic `plan:policy` prompt section, and exposes a stable `exit_plan_mode` tool.

The host supplies persistence, busy-state detection, and `UserInteraction` through `PlanModeAdapter`. The plugin never writes Session JSONL directly. `createPlanToolPolicy()` composes the host `SessionToolPolicy` and rejects `write`, `edit`, and `bash` at execution time while plan mode is active.

`/plan [message]` and `/plan off` are command inputs to `PlanModeController.command`; they are not ordinary user messages. A pending selection is committed by `preStep()` and remains pending when the append fails or is cancelled. The complete Markdown plan must begin with a `#` heading. Approve exits mode, Keep planning returns feedback, and cancellation leaves mode active.

The package is MIT licensed and contains no code copied from other projects.
