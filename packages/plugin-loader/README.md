# @di-code/plugin-loader

Loader boundary for plugin namespace exports and declarative composition. Namespace modules must expose a non-empty `name` and callable `apply`, and `default` exports are rejected.

Stage 5 provides `parseComposition()`/`readCompositionFile()` for JSON/YAML composition, restricted `$VAR`/`${VAR}` configuration values, deterministic `mergeCompositionLayers()` and id-targeted insert/append/remove/replace/enable/disable/move patches. `topologicallySortEntries()` rejects missing required dependencies and cycles. `CompositionLoader` imports only enabled entries, activates them through a runtime `Context`, records an immutable `EntryTree` inventory, isolates optional failures, and rolls back already-active required entries when a required entry fails.

Composition values are data only. The loader never evaluates JavaScript, executes commands, performs shell substitution, or imports disabled entries. Plugins remain in-process code; trust and capability policy are supplied by the runtime context rather than treated as a sandbox.
