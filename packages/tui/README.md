# @di-code/tui

为 [di-code](https://github.com/qddidi/di-code) 提供可复用的 ANSI 终端 UI 组件，包括差量渲染、中文和宽字符布局、键盘输入、焦点管理、Overlay、文本、编辑器、Markdown 和选择器组件。

这是一个库，不调用 AI Provider，也不提供 CLI 命令。

## 安装

```powershell
npm install @di-code/tui
```

要求 Node.js `>= 22.19.0`，并应在支持 TTY 的进程中使用。

## 快速开始

```ts
import { ProcessTerminal, Text, TUI } from "@di-code/tui";
const tui = new TUI(new ProcessTerminal());
tui.addChild(new Text("Hello from di-code TUI."));
tui.start();
process.once("SIGINT", () => tui.stop());
```

每个 `Component` 实现 `render(width): string[]` 和 `invalidate()`。把组件添加到 `TUI` 或 `Container`，外部状态变化后调用 `requestRender()`。`TUI` 负责终端生命周期，`stop()` 会恢复终端状态。

## 配置

没有配置文件或凭据配置。`ProcessTerminal` 默认使用 `process.stdin` 和 `process.stdout`。测试或嵌入其他程序时，可以通过 `new ProcessTerminal({ input, output, env })` 传入替代流；当输出流没有尺寸信息时，可使用 `COLUMNS` 和 `LINES` 环境变量。

不要把不可信文本直接当作 ANSI 控制序列输出。组件负责渲染显示内容，终端控制由 `Terminal` 抽象统一处理。

## 公共 API

主要导出 `TUI`、`Container`、`ProcessTerminal`、`Text`、`Input`、`Editor`、`Markdown`、选择器和设置组件、自动补全、快捷键、Overlay，以及安全处理显示宽度的文本工具。

源码、示例和问题反馈：<https://github.com/qddidi/di-code>
