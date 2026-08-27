# WebUI 自定义 UI

## 扩展模型

Web 扩展是插件 manifest 中的声明式 `web` contribution。浏览器只接收经过 ProductHost 聚合的版本化数据；它不会 import 插件 Node.js entry，不会获得 command registry、完整 RPC dispatcher、Provider key 或 transport token。

当前 slot 白名单：

| slot | 位置 | 常见用途 |
| --- | --- | --- |
| `app.sidebar` | 工作区/会话侧栏 | 状态徽章、导航附加信息 |
| `session.tree` | Session 树区域 | 分支或 Session 元数据 |
| `conversation.node` | 消息节点 | 消息标注、审计信息 |
| `conversation.tool` | 工具轨迹 | 工具状态或结果摘要 |
| `settings.panel` | Settings overlay | 插件设置展示 |

宿主通过 `list_web_contributions` 返回 manifest，并按 slot、组件 key 和版本白名单渲染。未知 slot 或非法 schema 会被拒绝；同一 namespace 的冲突由 contribution registry 报错。

## Manifest 声明

```json
{
  "diCode": {
    "apiVersion": 1,
    "plugins": ["./plugin"],
    "web": {
      "protocolVersion": 1,
      "contributions": [
        {
          "id": "acme.status",
          "slot": "app.sidebar",
          "version": 1,
          "componentKey": "builtin.workspace-status",
          "data": { "label": "Build status" }
        }
      ]
    }
  }
}
```

声明字段以 `@di-code/plugin-runtime` 的 `WebManifest`/`WebContribution` 类型为准。不要在 contribution 中放密钥、绝对路径、任意 HTML、脚本 URL 或用户输入原文；需要动态数据时通过宿主提供的 action 和窄 RPC 获取。

## Managed bundle

若使用 `web.bundle`，必须声明 `source: "managed"`、包内相对 `path`、文件 `sha256` 和 CSP。Loader 在安装前确认路径不越界、SHA-256 摘要匹配，且 CSP 包含 `default-src 'self'`。bundle 不得通过 symlink 逃逸插件根目录。

## 开发与验证

1. 在插件包中实现 namespace entry 和 manifest 声明。
2. 使用 `di-code plugin install` 安装，确认 `di-code plugin list` 显示 enabled。
3. 用 `--trace-plugins` 检查 contribution 是否在正确 Fiber 和 phase 注册。
4. 启动 `di-code web`，验证窄屏、键盘、错误和 plugin disable 后的清理。

宿主卸载插件或关闭 WebUI 时会 dispose owner Fiber；前端 slot 应响应 AbortSignal，不应持有已失效的 action。插件在进程内执行，manifest permissions 只用于声明和审计，不提供沙箱。
