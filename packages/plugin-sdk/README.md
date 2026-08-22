# @di-code/plugin-sdk

The public plugin entry point. It re-exports only the root exports of `@di-code/plugin-runtime` and `@di-code/plugin-loader`; consumers must not import private `src` or `dist` paths. Stage 1 exposes contracts and namespace validation while composition and runtime services remain future work.
