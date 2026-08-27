# 会话、Skills 与图片

## 交互命令总表

在 `interactive` 模式中输入 `/` 可打开补全菜单。命令由当前 Composition 的 `CommandRegistry` 提供，下面是内建命令；已加载的 Skill 会额外提供 `/skill:<name>`，插件也可以贡献命令。

| 命令 | 作用 | 重要行为 |
| --- | --- | --- |
| `/help` | 显示命令清单 | 清单包含当前 registry 命令和已加载 Skill |
| `/clear` | 清除屏幕可见消息 | 只清理当前 TUI 投影，不删除 Session JSONL |
| `/model` | 选择模型 | 只能选择当前 runtime 提供的模型，选择结果保存为用户偏好 |
| `/session` | 选择或切换 Session | 切换期间不能提交 prompt；切换成功后刷新 transcript 和 usage |
| `/tree` | 浏览当前 Session 历史树 | 可继续、编辑历史用户消息，或为选定分支生成摘要 |
| `/theme` | 选择 `dark`/`light` 主题 | 主题属于 TUI 偏好，不改变模型或 Session |
| `/settings` | 打开设置 | 可切换上下文压缩和内置终端语言，语言保存到用户 settings |
| `/login` | Provider 配置向导 | 选择 Provider、模型并隐藏输入 key；prompt 运行或切换 Session 时不可用 |
| `/logout` | 删除当前 Provider 的用户级 key | 不改环境变量或项目 settings；当前 Session 直到退出前仍可继续使用 |
| `/compact` | 立即压缩上下文 | prompt 或其他压缩正在运行时拒绝；没有可压缩历史时明确失败 |
| `/usage` | 查看用量 | 显示请求数、输入/输出/总 token、费用和估算上下文占用 |
| `/retry` | 重试最近失败或取消的 prompt | 只在存在失败 prompt 且当前空闲时执行 |
| `/steer <内容>` | 引导正在运行的 Agent | 内容不能为空，只能在 prompt 运行期间使用；可用 `Alt+S` 快捷键发送 |
| `/skill:<name> [请求]` | 调用已加载 Skill | Skill 文本作为不可信上下文附加，参数作为额外请求发送 |

命令名不区分大小写；未知命令会显示错误。补全菜单打开时，`Enter` 会直接运行当前选中的命令，`Tab` 只补全输入框。插件命令的参数由插件自行解析，命令冲突由 registry 拒绝。

## JSONL 会话

interactive 默认把会话保存到 `~/.di-code/sessions/<工作区哈希>/`。当前格式是 v2、append-only，每条记录可引用任意父节点，因此一个文件可以包含多个分支。`--session <path>` 可显式打开其他文件；项目内已有 `.di-code/sessions/` 不会自动迁移。

常用命令：`/session` 选择会话，`/tree` 浏览历史，`/compact` 手动压缩，`/retry` 重试失败 prompt，`/usage` 查看 token 与上下文占用。选择历史用户消息会把文本恢复到编辑器并从其父节点创建新分支；选择 assistant、tool result 或 summary 则从该节点继续。导航不会回滚已经发生的文件、命令或网络副作用。

`/session` 的列表包含当前 Session 和由产品 Host 提供的其他 Session。打开新 Session 时会重建当前工作区的 transcript、usage、文件预览和队列；旧 Session 的订阅会被取消。Session 正在打开、prompt 正在运行或 Session 已被其他 owner 占用时，操作会返回稳定错误而不会并发写入。

`/tree` 的选择器按历史节点展示当前路径（`›` 表示当前选择）。继续节点会改变模型上下文；编辑历史用户消息会恢复文本到编辑器并创建新的 sibling 分支；摘要操作先导航到节点，再生成 summary 分支。图片不会随树导航恢复，需重新附加。

`/clear` 只影响屏幕投影，因此重新打开或刷新 Session 后历史仍然存在。`/retry` 复用 host 记录的目标失败 request，而不是猜测磁盘末端的最后一条消息；关闭再打开同一 Session 后仍能定位该失败 turn。

`/steer` 不会排队为空闲 Session；prompt 运行时的新普通文本会按 FIFO 排队，steer 内容单独进入 steering 队列。`Esc` 取消当前请求但不会删除已持久化记录，之后可以用 `/retry` 或 `Ctrl+R` 重试。

锁文件保护并发追加。v1、未知版本或损坏记录不会静默迁移；打开时会报告 `UNSUPPORTED_VERSION` 或损坏诊断。取消只停止当前请求，已追加记录仍保留。

## 上下文压缩

达到上下文预算时 Agent 可自动压缩；`/compact` 使用同一 Session 的 summary 分支。压缩事件包含 `compaction_start`/`compaction_end`，手动压缩在没有可压缩早期回合时会明确失败。summary 只影响所在分支，磁盘完整历史仍保留。

## AGENTS.md 与 Skills

`AGENTS.md` 是项目说明文本，默认从工作根目录发现；`--no-context-files` 禁用发现。Skill 使用 `SKILL.md` YAML frontmatter：`name` 必须是小写 kebab-case（最多 64 字符），`description` 必填，文件最多 256 KiB。发现范围包括用户、项目和 `--skill` 显式路径；项目 Skill 只有在项目信任后加载。

Skill 内容只是提示词文本，不授予文件、命令或网络权限，也不会被自动执行。输入 `/` 可补全已加载的 `/skill:<name>`；命令的参数会附加到 Skill 内容。`disable-model-invocation` 和 `user-invocable` 默认分别为 `false`、`true`。冲突、解析失败和越界读取会生成诊断，不会产生半有效 Skill。

## 图片

非交互模式重复使用 `--image`：

```powershell
di-code --image .\before.png --image .\after.webp "比较两张图"
```

支持 PNG、JPEG、WebP、GIF；按文件签名校验，不信任扩展名。每条 prompt 最多 4 张，每张最多 5 MiB，模型必须声明 `image` 输入能力。interactive 中可输入 `@path`、拖放图片，Windows 使用 `Alt+V`，macOS/Linux 使用 `Ctrl+V`。剪贴板临时文件位于 `~/.di-code/clipboard/<工作区哈希>/<进程 ID>/`，发送、删除引用或退出后清理。

图片会作为 user message 的 image content 持久化，重开会话仍可查看；图片附件不会因 `/tree` 导航自动恢复到下一次 prompt，需要重新附加。
