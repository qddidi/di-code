# di-code 文档

本目录按使用者角色和运行形态组织文档。根目录 [README.md](../README.md) 负责安装、功能概览和最短路径；本目录记录完整操作、扩展契约和源码实现边界。

## 用户指南

- [使用指南](使用指南.md)：面向终端用户的场景总览。
- [快速开始](用户指南/快速开始.md)：安装、Faux 离线验证、Provider 选择和第一次对话。
- [CLI 与配置](用户指南/CLI与配置.md)：命令行参数、`.env`、`settings.json`、三种输出模式和安全限制。
- [会话、Skills 与图片](用户指南/会话与Skills.md)：JSONL 会话、分支、压缩、`AGENTS.md`、Skill 和图片输入。
- [MCP 使用指南](用户指南/MCP.md)：stdio/HTTP Server 配置、信任、管理命令和故障排查。

## Web

- [WebUI 使用指南](webui/使用指南.md)：`di-code web`、`di-code-webui`、开发代理、工作区和 HTTP/SSE。
- [WebUI 自定义 UI](webui/自定义UI.md)：插件声明式 Web slot、bundle 校验和前端扩展边界。

## 终端与扩展

- [TUI 使用指南](tui/使用指南.md)：`@di-code/tui` 组件、终端生命周期、键位和自定义 Host。
- [插件使用指南](插件使用指南.md)：namespace plugin、manifest、Composition、权限和生命周期。

## 开发与架构

- [开发教程](开发教程.md)：源码布局、依赖方向、实现新 Provider/工具/命令的步骤和测试策略。
- [运行时与 RPC 架构](架构/运行时与RPC.md)：Composition、Agent loop、SessionHost、RPC JSONL 和事件恢复。

## 文档约定

文档中的命令以 PowerShell 为例，路径和字段名以反引号标记。示例不会包含真实密钥。`dist/` 是构建产物，不是文档来源；行为以 `packages/*/src` 和测试为准。
