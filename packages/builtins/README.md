# @di-code/builtins

Reference namespace plugins used by the composable profiles. The package exposes only public workspace dependencies and contains no CLI-specific legacy loader path.

Provider composition is split into `provider-openai`, `provider-anthropic`, `provider-deepseek`, `provider-kimi`, `provider-zhipu`, and `provider-faux`; `model-catalog`, `credential-env`, `runtime-selection`, and `provider-onboarding` provide neutral selection/configuration services. Each adapter only contributes the `@di-code/ai` `Provider` and `Model` contracts to `ProviderRegistry`.

The default print profile mounts the registry, catalog, credential and selection entries before `agent-loop`. Provider entries with unavailable credentials are optional and leave a diagnostic inventory entry; selecting one still reports the normalized missing-key error. Environment variables take precedence over global then project settings for provider/model selection. `provider-faux` is deterministic and offline. `session-memory` and the Agent subscription are owned by their plugin Fibers and are released during reverse-order composition disposal.
