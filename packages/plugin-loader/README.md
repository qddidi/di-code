# @di-code/plugin-loader

Loader boundary for plugin namespace exports, package manifests and declarative composition. Namespace modules must expose a non-empty `name`, `version` and callable `apply`; `apiVersion` must match the loader and `default` exports are rejected. Published package entries must be declared by the package `exports` map and resolve inside the package root.

Stage 5 provides `parseComposition()`/`readCompositionFile()` for JSON/YAML composition, restricted `$VAR`/`${VAR}` configuration values, deterministic `mergeCompositionLayers()` and id-targeted insert/append/remove/replace/enable/disable/move patches. `topologicallySortEntries()` rejects missing required dependencies and cycles. `CompositionLoader` imports only enabled entries, activates them through a runtime `Context`, records an immutable `EntryTree` inventory, isolates optional failures, and rolls back already-active required entries when a required entry fails.

Composition values are data only. The loader never evaluates JavaScript, executes commands, performs shell substitution, or imports disabled entries. Plugins remain in-process code; trust and capability policy are supplied by the runtime context rather than treated as a sandbox.

Stage 6 also provides `ProjectTrustStore` and `PluginInstallManager`. Trust decisions and plugin registries are versioned JSON written with temporary-file replacement. Project-local entries are skipped when trust is false. Local, `npm:` and `git:` sources are copied through staging; npm always uses `--ignore-scripts`, managed destinations are checked with `resolve` plus `relative`, and failed replacement restores the previous install. Manifest capabilities are validated declarations for audit and import policy, not an in-process Node sandbox.
