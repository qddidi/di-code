# @di-code/plugin-loader

Loader boundary for plugin namespace exports. Stage 1 validates that a module exposes a non-empty `name` and callable `apply`, and rejects a `default` export. It depends only on `@di-code/plugin-runtime`; dependency ordering, composition, trust, and lifecycle loading are later-stage behavior.
