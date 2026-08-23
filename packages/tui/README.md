# @di-code/tui

为 [di-code](https://github.com/qddidi/di-code) 提供可复用的 ANSI 终端 UI 组件，包括差量渲染、中文和宽字符布局、键盘输入、焦点管理、Overlay、文本、编辑器、Markdown 和选择器组件。

这是一个库，不调用 AI Provider，也不提供 CLI 命令。

在可组合产品中，TUI 由独立的 `tui-renderer`、`theme`、`interactive-context` 和 mode entries 接入；本包继续只接受 presentation props 和事件，不依赖 runtime、Provider 或 coding-agent 逻辑。

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

主要导出 `TUI`、`Container`、`ProcessTerminal`、`Text`、`Input`、`Editor`、`Markdown`、`SelectionPanel`、选择器和设置组件、自动补全、快捷键、Overlay，以及安全处理显示宽度的文本工具。`SelectionPanel` 是所有键盘选择界面的共享展示层：统一渲染 `›` 焦点行、全宽高亮、位置计数和可选提示；调用方仍负责筛选、导航和业务回调。Overlay 可设置 `preserveLastLine: true`，在 `maxHeight` 截断时保留末行，适用于带底边或固定页脚的面板。

`TUI_THEMES` 和 `TuiTheme` 只描述 ANSI presentation colors；主题选择、Session、取消、重试和命令执行由产品层 Context/Registry 提供，TUI 不依赖 Provider 或 coding-agent。

源码、示例和问题反馈：<https://github.com/qddidi/di-code>
