# Configuration reference / 配置参考

[English](#english) | [简体中文](#简体中文) | [Default JSON / 默认 JSON](#default-json)

## English

For installation and feature examples, see the [README](../README.md). This reference covers all settings accepted by `open-tui.json`. The sources are [config.ts](../extensions/open-tui/config.ts), [settings-command.ts](../extensions/open-tui/settings-command.ts), and [icons.ts](../extensions/open-tui/icons.ts).

### Storage and loading

The file is stored in Pi's agent directory: `~/.pi/agent/open-tui.json` by default, or `<PI_CODING_AGENT_DIR>/open-tui.json` when that environment variable is set. The extension creates the file with defaults if it is missing and the directory is writable.

You only need to specify values you want to change; missing fields inherit [the defaults](#default-json). Flags must be JSON booleans, not strings such as `"false"`. Invalid known values fall back to their defaults, and unreadable or malformed JSON falls back to the default configuration with a warning. Direct file edits are loaded on `/reload` or a new session. If saving from `/open-tui` fails, the new values still apply to the current session and a warning asks you to check directory permissions and free space.

### Settings dialog

| Tab | Sections |
| --- | --- |
| General | Extension, Interface, Messages & tools, Footer |
| Appearance | Icons, Editor |
| Footer | Location, Git, Runtime, Usage, Other |
| Telemetry | Enabled (standalone master switch), Measurements |

Tab/Shift+Tab or ←/→ switches tabs; ↑/↓ or Page Up/Page Down moves between settings; Enter/Space changes a value; Esc/q closes the dialog. Dim section headings occupy rows but cannot be selected or changed. The scroll position counts both headings and settings.

**Compact extension tools** appears only while **Tool view** is Compact. Switching to Native hides it while retaining its value. Installing or removing the UI through the **Enabled** switch is deferred until the dialog closes. Existing configuration files need no migration.

### General options

| Key | Default | Values and behavior |
| --- | --- | --- |
| `enabled` | `true` | Master switch for open-tui |
| `header` | `true` | Replaces the header; disable to leave that slot to Pi or another extension |
| `inlineFooter` | `false` | Moves the two main footer rows into a compatible editor's borders; extension status rows remain separate |
| `copyButtons` | `true` | Copy labels for code blocks, user messages, and nonempty input drafts in fullscreen mode |
| `settingsLanguage` | `"en"` | `"en"` or `"zh"`; changes the settings interface language |
| `cursorStyle` | `"block"` | `"block"`, `"bar"`, or `"underline"`; the latter two need terminal cursor-shape support |
| `icons.mode` | `"auto"` | `"auto"`, `"nerd"`, `"unicode"`, or `"ascii"`; see [Icons](#icons) |
| `thinkingPeek.lines` | `1` | `0` (off), `1`, or `2`; visible while Pi's Hide thinking setting is on and reasoning is streamed |
| `thinkingPeek.showCounts` | `true` | Append `12.3s · 1.2k tok` to the thinking header; `false` restores the 0.4.6 label |
| `toolView.mode` | `"native"` | `"native"` or `"compact"`; selected when Pi creates each tool row |
| `toolView.extensionTools` | `false` | In compact mode, includes extension, MCP, and replacement tools |
| `toolView.exclude` | `[]` | Exact tool names that keep native rendering, including built-ins; edited in the JSON file only |

For example, `"toolView": { "mode": "compact", "extensionTools": true, "exclude": ["edit", "subagent_wait"] }` enables compact rendering while preserving those two tools' native cards. Use `/reload` or a new session to rebuild existing rows with the new tool-view settings.

### Footer options

All keys below are booleans inside `footerSegments`.

| Key | Default | Content or effect |
| --- | --- | --- |
| `cwd` | `true` | Current working directory, shortened when needed |
| `hostname` | `false` | Short host name (before the first dot) with a server icon |
| `sessionName` | `false` | Session name, when one is set |
| `gitBranch` | `true` | Branch name, or `HEAD` and a short commit hash in detached HEAD state |
| `gitStatus` | `true` | Conflicted, deleted, modified, renamed, staged, untracked, stashed, and ahead/behind counts |
| `gitCommit` | `false` | Tag pointing at the detached HEAD commit; only used when `gitBranch` is on |
| `runtime` | `true` | Detected project runtime and its version when available |
| `context` | `true` | Context bar, percentage, and token usage |
| `contextBar` | `true` | Progress bar and its icon; `false` keeps only the percentage and token usage |
| `tokens` | `true` | Cumulative input/output tokens and the latest assistant cache-hit percentage |
| `cost` | `true` | Cumulative session cost reported by Pi |
| `liveTps` | `true` | Estimated streaming speed beside the working timer |
| `extensionStatuses` | `true` | Separate `ctx.ui.setStatus()` rows, including MCP status |
| `extensionSegments` | `true` | Contributions embedded in the main rows through the [footer event API](./footer-segments.md) |
| `capitalizeProviderName` | `true` | Capitalizes the provider's first character; disable to retain original casing |
| `nerdIconSpacing` | `false` | Adds one blank cell after Nerd Font icons, including runtime icons |

The provider/model and working/done timer do not have separate visibility switches; `liveTps` controls only the speed estimate. `extensionSegments` controls visibility, so hidden contributions still receive updates and their lifecycle stays available. It is independent of `extensionStatuses`.

### Telemetry options

All keys below are booleans inside `telemetry` and default to `true`.

| Key | Effect |
| --- | --- |
| `enabled` | Master switch for the end-of-run notification |
| `tps` | Provider-based output tokens per second |
| `ttft` | Time to first output |
| `duration` | Full agent-run duration |
| `tokens` | Assistant input/output counts for measured turns |
| `stalls` | Stream pauses, shown only when detected |
| `cost` | Effective rate per million reported tokens, in `cost.currency` |

The footer's live-speed estimate has its own `footerSegments.liveTps` switch. See [usage and telemetry](./implementation.md#usage-and-telemetry) for measurement definitions and limitations.

### Cost options

Both the footer total and the telemetry rate are formatted by a single formatter, so exactly one currency symbol is printed.

| Key | Default | Effect |
| --- | --- | --- |
| `cost.currency` | `"usd"` | Display currency. `usd` prints `$`, `cny` prints `¥` |
| `cost.usdToCny` | `7.15` | Manual USD→CNY rate used when `currency` is `cny`. Values outside `0.01`–`1000` fall back to the default |
| `cost.switchable` | `true` | Allow `ctrl+shift+m` and the settings dialog to toggle the currency. Set to `false` to lock it |

The rate is a fixed, manually entered number — pi-open-tui does not fetch exchange rates. Amounts at or above 0.1 in the display currency use two decimals, smaller amounts use three. A session whose cost rounds below `0.001` shows `$0.000`; negative provider figures are clamped to zero. See [usage and telemetry](./implementation.md#usage-and-telemetry).

### Theme options
Pi themes restyle Pi; these options restyle open-tui's own surfaces. `preset` selects a palette, `slots` overrides individual colours, and the rest are structural toggles built on those colours.

| Key | Default | Effect |
| --- | --- | --- |
| `theme.preset` | `"tokyo-night"` | `tokyo-night`, `catppuccin-mocha`, `gruvbox-dark`, `rose-pine-moon`, or `pi` to paint Pi's own tokens |
| `theme.slots` | `{}` | Per-slot overrides. The thirteen slots, their target, and the Pi token each falls back to are in the [README slot table](../README.md#open-tui-colours) |
| `theme.dividers` | `"line"` | `line`, `dashed`, or `none`. Rules between turns; the same slot colours footer separators |
| `theme.gutter` | `true` | Vertical rail beside command output. Drawn only in the compact tool view (`toolView.mode: "compact"`) |
| `theme.banding` | `false` | Faint background on alternating tool rows |
| `theme.userBar` | `true` | Coloured rail beside user messages |
| `theme.bubble` | `"rounded"` | Rounded frame around assistant replies, sized to the terminal width. `off` restores the unpatched output |
| `theme.timestamps` | `"all"` | `HH:MM` stamp per message: `all`, `assistant`, or `off`. Never adds a row |
| `theme.expandHint` | `"plain"` | `key` underlines the `ctrl+o` keycap in expand hints; `plain` keeps the 0.4.x rendering |

`preset: "pi"` renders the colour layer through Pi's tokens. It does **not** by itself restore the 0.4.6 output: `dividers`, `gutter`, `userBar`, and `thinkingPeek.showCounts` also ship on. Set them off to get the old rendering, and note that a failed tool row's title resolves to `error` regardless. Slot values accept `#RRGGBB`, `oklch(...)`, `okhsl(...)`, or a Pi token name. An **unparseable colour** falls back to the slot's preset colour; an **unknown slot name** is dropped silently, so copy the names exactly.

### Context blocks
Read-only linkage to `billion-context-pi`. See [context blocks](../README.md#context-blocks).

| Key | Default | Effect |
| --- | --- | --- |
| `contextBlocks.enabled` | `true` | Read the sidecar and show it in the footer and the overlay |
| `contextBlocks.footerSegment` | `true` | Footer segment on/off; the overlay stays reachable either way |
| `contextBlocks.pollMs` | `1500` | `fs.watchFile` poll interval in milliseconds |

### Icons

| `icons.mode` | Selection |
| --- | --- |
| `auto` | ASCII when stdout is not a TTY, `TERM=dumb`, or the first configured locale (`LC_ALL`, `LC_CTYPE`, `LANG`) is not UTF-8. Otherwise Unicode when `SSH_TTY` or `SSH_CONNECTION` is set, and Nerd Font locally. An unset locale passes the UTF-8 check |
| `nerd` | Always use Nerd Font glyphs |
| `unicode` | Portable Unicode symbols; emoji use the terminal's own fallback font |
| `ascii` | Plain-text symbols |

Auto detection does not inspect installed fonts. Configure a Nerd Font in the terminal profile or choose `unicode`/`ascii` if symbols are missing. If the SSH client terminal has a Nerd Font, select `nerd` explicitly.

For wide Nerd glyphs that consume the gap before a label, enable **Footer → Other → Extra space after Nerd icons** (`footerSegments.nerdIconSpacing`). This affects regular and inline footers; Unicode/ASCII icons and compact Git flags are unchanged. In Kitty, `narrow_symbols U+E000-U+F8FF 1` in `kitty.conf` is an alternative.

## 简体中文

安装和功能示例见 [README](../README.zh-CN.md)。本参考列出 `open-tui.json` 接受的全部设置，依据为 [config.ts](../extensions/open-tui/config.ts)、[settings-command.ts](../extensions/open-tui/settings-command.ts) 和 [icons.ts](../extensions/open-tui/icons.ts)。

### 存储与加载

配置位于 Pi 的 agent 目录，默认路径为 `~/.pi/agent/open-tui.json`；设置 `PI_CODING_AGENT_DIR` 后则使用 `<PI_CODING_AGENT_DIR>/open-tui.json`。文件不存在且目录可写时，扩展会创建默认配置。

只需填写要修改的值，缺失字段会补入[默认值](#default-json)。布尔开关应使用 JSON 布尔值，不能写成 `"false"` 这样的字符串。已知字段的无效值会回退到默认值；无法读取或解析 JSON 时，会提示警告并使用默认配置。直接编辑文件后，执行 `/reload` 或新开会话加载。如果从 `/open-tui` 保存失败，新值仍在当前会话生效，并提示检查目录权限和可用空间。

### 设置窗口

| 页面 | 分组 |
| --- | --- |
| 常规 | 扩展、界面、消息与工具、底栏 |
| 外观 | 图标、输入框 |
| 底栏 | 位置、Git、运行环境、用量、其他 |
| 遥测 | 启用（独立总开关）、测量指标 |

Tab/Shift+Tab 或 ←/→ 切页，↑/↓ 或 Page Up/Page Down 移动，Enter/Space 修改值，Esc/q 关闭。暗色分组标题占一行，但不能选中或修改；滚动位置同时统计标题行和设置行。

**紧凑显示扩展工具**仅在**工具视图**为紧凑时显示；切回原生后隐藏，但保留开关值。通过**启用**开关安装或移除界面会延迟到窗口关闭后执行。现有配置文件无需迁移。

### 常规选项

| 键 | 默认值 | 可选值与行为 |
| --- | --- | --- |
| `enabled` | `true` | open-tui 总开关 |
| `header` | `true` | 替换顶栏；关闭后把位置留给 Pi 或其他扩展 |
| `inlineFooter` | `false` | 将两条主底栏行移入兼容编辑器的边框，扩展状态行保持独立 |
| `copyButtons` | `true` | 全屏模式中代码块、用户消息和非空输入草稿的复制标签 |
| `settingsLanguage` | `"en"` | `"en"` 或 `"zh"`，控制设置界面的语言 |
| `cursorStyle` | `"block"` | `"block"`、`"bar"` 或 `"underline"`，后两种需要终端支持光标形状控制 |
| `icons.mode` | `"auto"` | `"auto"`、`"nerd"`、`"unicode"` 或 `"ascii"`，见[图标](#图标) |
| `thinkingPeek.lines` | `1` | `0`（关闭）、`1` 或 `2`；Pi 开启 Hide thinking 且模型输出推理时可见 |
| `thinkingPeek.showCounts` | `true` | 在思考标题后追加 `12.3s · 1.2k tok`；设为 `false` 恢复 0.4.6 的标题 |
| `toolView.mode` | `"native"` | `"native"` 或 `"compact"`，每条工具行创建时确定 |
| `toolView.extensionTools` | `false` | 紧凑模式下包含扩展、MCP 和替换内置工具的扩展 |
| `toolView.exclude` | `[]` | 保持原生渲染的完整工具名，可包含内置工具；仅在 JSON 文件中编辑 |

例如 `"toolView": { "mode": "compact", "extensionTools": true, "exclude": ["edit", "subagent_wait"] }` 会启用紧凑模式，并让这两个工具保留原生卡片。执行 `/reload` 或新开会话，可让已有工具行按新设置重建。

### 底栏选项

下面各键均为 `footerSegments` 内的布尔值。

| 键 | 默认值 | 内容或作用 |
| --- | --- | --- |
| `cwd` | `true` | 当前工作目录，必要时缩短 |
| `hostname` | `false` | 主机短名称，即第一个点之前的部分，配合服务器图标 |
| `sessionName` | `false` | 会话名称，仅在已设置名称时显示 |
| `gitBranch` | `true` | 分支名称；分离 HEAD 时显示 `HEAD` 和短提交哈希 |
| `gitStatus` | `true` | 冲突、删除、修改、重命名、已暂存、未跟踪、stash 和 ahead/behind 数量 |
| `gitCommit` | `false` | 指向分离 HEAD 提交的标签，仅在 `gitBranch` 开启时使用 |
| `runtime` | `true` | 检测到的项目运行环境，以及可获取时的版本号 |
| `context` | `true` | 上下文进度条、百分比和 Token 用量 |
| `contextBar` | `true` | 进度条及其图标；关闭后仅保留百分比和 Token 用量 |
| `tokens` | `true` | 累计输入/输出 Token，以及最新助手回复的缓存命中率 |
| `cost` | `true` | Pi 报告的会话累计费用 |
| `liveTps` | `true` | 工作计时器旁的流式速度估算 |
| `extensionStatuses` | `true` | 独立的 `ctx.ui.setStatus()` 状态行，包括 MCP 状态 |
| `extensionSegments` | `true` | 扩展通过[底栏事件接口](./footer-segments.md)嵌入主信息行的内容 |
| `capitalizeProviderName` | `true` | 将服务商名称首字母大写；关闭后保留原始大小写 |
| `nerdIconSpacing` | `false` | Nerd Font 图标后额外留一格，包括运行环境图标 |

服务商/模型和工作/完成计时器没有独立显示开关，`liveTps` 仅控制速度估算。`extensionSegments` 只控制可见性，隐藏内容仍接收更新，生命周期仍保持可用；它与 `extensionStatuses` 相互独立。

### 遥测选项

下面各键均为 `telemetry` 内的布尔值，默认全部为 `true`。

| 键 | 作用 |
| --- | --- |
| `enabled` | 运行结束通知的总开关 |
| `tps` | 基于服务商用量的每秒输出 Token |
| `ttft` | 首次输出延迟 |
| `duration` | Agent 完整运行耗时 |
| `tokens` | 被统计轮次的助手输入/输出数量 |
| `stalls` | 流式输出停顿，仅检测到时显示 |
| `cost` | 每百万报告 Token 的综合费率，货币由 `cost.currency` 决定 |

底栏实时速度使用独立的 `footerSegments.liveTps` 开关。指标定义和限制见[用量与遥测](./implementation.md#用量与遥测)。

### 费用选项

底栏累计费用与遥测费率由同一个格式化器输出，因此货币符号只会出现一次。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `cost.currency` | `"usd"` | 显示货币。`usd` 显示 `$`，`cny` 显示 `¥` |
| `cost.usdToCny` | `7.15` | `currency` 为 `cny` 时使用的**手动**美元兑人民币汇率。超出 `0.01`–`1000` 的值回退为默认值 |
| `cost.switchable` | `true` | 允许用 `ctrl+shift+m` 或设置窗口切换货币。设为 `false` 可锁定 |

汇率是不自动更新的固定值，pi-open-tui 不会联网抓取行情。显示货币下不低于 0.1 的金额保留两位小数，更小的金额保留三位；四舍五入后低于 `0.001` 的会话显示 `$0.000`，服务商报告的负数计为 0。详见[用量与遥测](./implementation.md#用量与遥测)。

### 主题选项

Pi 主题负责 Pi 本身；下列选项负责 open-tui 自己的区域。`preset` 选调色板，`slots` 覆盖单个颜色，其余是基于这些颜色构建的结构开关。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `theme.preset` | `"tokyo-night"` | `tokyo-night`、`catppuccin-mocha`、`gruvbox-dark`、`rose-pine-moon`，或 `pi` 表示使用 Pi 自己的 token |
| `theme.slots` | `{}` | 按槽位覆盖颜色。十三个槽位、各自绘制对象及回退的 Pi token 见 [README 槽位表](../README.zh-CN.md#open-tui-自有配色) |
| `theme.dividers` | `"line"` | `line`、`dashed` 或 `none`。轮次之间的分隔线；同一槽位也用于底栏分隔符 |
| `theme.gutter` | `true` | 命令输出左侧的竖线。只在紧凑工具视图（`toolView.mode: "compact"`）下才画出 |
| `theme.banding` | `false` | 交替的工具行使用淡背景 |
| `theme.userBar` | `true` | 用户消息左侧的彩色竖条 |
| `theme.bubble` | `"rounded"` | 助手回复外层的圆角边框，宽度随终端收放。`off` 回到未打补丁的输出 |
| `theme.timestamps` | `"all"` | 每条消息的 `HH:MM` 时间戳：`all`、`assistant` 或 `off`。不会新增行 |
| `theme.expandHint` | `"plain"` | 设为 `key` 会给展开提示里的 `ctrl+o` 键幅加下划线；`plain` 保持 0.4.x 的渲染 |

`preset: "pi"` 让颜色层走 Pi 的 token，但**单靠它并不能**恢复 0.4.6 的渲染：`dividers`、`gutter`、`userBar` 和 `thinkingPeek.showCounts` 也都默认开启。把这几项关掉才能回到旧渲染，并注意失败工具行的标题无论如何都会落到 `error`。槽位颜色接受 `#RRGGBB`、`oklch(...)`、`okhsl(...)` 或一个 Pi token 名。**无法解析的颜色**会回退到该预设的颜色；**未知槽位名会被静默丢弃**，请照抄名称。

### 上下文块

对 `billion-context-pi` 的只读联动。参见[上下文块](../README.zh-CN.md#上下文块)。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `contextBlocks.enabled` | `true` | 读取旁路文件并同时用于底栏和浮层 |
| `contextBlocks.footerSegment` | `true` | 底栏段开关；无论开关如何，浮层都可打开 |
| `contextBlocks.pollMs` | `1500` | `fs.watchFile` 的轮询间隔（毫秒） |

### 图标

| `icons.mode` | 选择规则 |
| --- | --- |
| `auto` | stdout 不是 TTY、`TERM=dumb`，或首个已设置的 locale（依次为 `LC_ALL`、`LC_CTYPE`、`LANG`）不是 UTF-8 时使用 ASCII。否则，存在 `SSH_TTY` 或 `SSH_CONNECTION` 时使用 Unicode，本地使用 Nerd Font。未设置 locale 时通过 UTF-8 检查 |
| `nerd` | 始终使用 Nerd Font 字形 |
| `unicode` | 可移植 Unicode 图标，emoji 使用终端自身的回退字体 |
| `ascii` | 纯文本图标 |

自动检测不会检查已安装字体。图标缺失时，请在终端配置中选中 Nerd Font，或切换到 `unicode`/`ascii`。SSH 客户端终端已配置 Nerd Font 时，可显式选择 `nerd`。

如果较宽的 Nerd Font 图标占用了标签前的间隔，可开启**底栏 → 其他 → Nerd 图标后额外留空**（`footerSegments.nerdIconSpacing`）。普通和内嵌底栏都适用，Unicode/ASCII 图标和紧凑 Git 状态标记不受影响。Kitty 用户也可在 `kitty.conf` 中设置 `narrow_symbols U+E000-U+F8FF 1`。

## Default JSON

The complete default configuration is shared by both language references. Set `settingsLanguage` to `"zh"` for the Chinese settings interface.

以下为两种语言共用的完整默认配置。将 `settingsLanguage` 改为 `"zh"` 即可使用中文设置界面。

```json
{
  "enabled": true,
  "header": true,
  "inlineFooter": false,
  "copyButtons": true,
  "settingsLanguage": "en",
  "cursorStyle": "block",
  "icons": {
    "mode": "auto"
  },
  "footerSegments": {
    "cwd": true,
    "hostname": false,
    "sessionName": false,
    "gitBranch": true,
    "gitStatus": true,
    "gitCommit": false,
    "runtime": true,
    "context": true,
    "contextBar": true,
    "contextBlocks": true,
    "tokens": true,
    "cost": true,
    "liveTps": true,
    "extensionSegments": true,
    "extensionStatuses": true,
    "capitalizeProviderName": true,
    "nerdIconSpacing": false
  },
  "telemetry": {
    "enabled": true,
    "tps": true,
    "ttft": true,
    "duration": true,
    "tokens": true,
    "stalls": true,
    "cost": true
  },
  "cost": {
    "currency": "usd",
    "usdToCny": 7.15,
    "switchable": true
  },
  "contextBlocks": {
    "enabled": true,
    "footerSegment": true,
    "pollMs": 1500
  },
  "theme": {
    "preset": "tokyo-night",
    "slots": {},
    "dividers": "line",
    "gutter": true,
    "banding": false,
    "userBar": true,
    "expandHint": "plain"
  },
  "thinkingPeek": {
    "lines": 1,
    "showCounts": true
  },
  "toolView": {
    "mode": "native",
    "extensionTools": false,
    "exclude": []
  }
}
```
