# pi-open-tui DIY 设计文档

- 日期：2026-11-15
- 基线：pi-open-tui v0.4.6（fork: DaybreakDear/pi-open-tui）
- 目标 Pi 版本：>= 1.5.0 / Node >= 22.19.0（沿用 AGENTS.md 约束）
- 版本目标：0.5.0

## 1. 目标与范围

四项需求，经确认后的范围：

| # | 需求 | 采纳方案 | 不做 |
|---|---|---|---|
| 1 | 费用图标重复 `$$`、增加人民币 | 修复重复符号；`cost.currency: usd\|cny` + 手动固定汇率 + 可切换 | 联网取汇率、双币并显 |
| 2 | theme 配置，提升 AI 思考/工具调用/命令/输出的可读性 | ① open-tui 槽位配色 + 结构选项（分割线/gutter/banding）② 附带 4 套 Pi 主题 JSON | — |
| 3 | 向 deepseek harness / ChatGPT desktop 一类的 GUI 观感靠拢 | 轮次分割线 + 用户消息卡；思考块专属样式 + 折叠头 | 工具调用卡片化、命令面板/快捷键帮助 |
| 4 | billion-context 联动 + 快捷键查询上下文压缩 | 只读：底栏压缩段 + `ctrl+shift+c` 浮层 | 从浮层派发 `/compress` 等命令、常驻 widget |

## 2. 现状（关键代码位置）

### 2.1 `$$` 重复的根因

- `extensions/open-tui/footer.ts:194`
  ```ts
  cost: segments.cost ? theme.fg("warning", `${glyphs.cost} $${totals.cost.toFixed(3)}`) : "",
  ```
- `extensions/open-tui/telemetry.ts:352`
  ```ts
  parts.push(theme.fg("warning", `${glyphs.cost} $${telemetry.rateUsdPerMTokens.toFixed(2)}/M`));
  ```
- `extensions/open-tui/icons.ts`：`NERD_GLYPHS.cost = "\uF155"`（私有区字体美元符，不可见即字形）、`UNICODE_GLYPHS.cost = "$"`（:124）、`ASCII_GLYPHS.cost = "$"`（:85）。
  → 当图标集为 unicode/ascii 时，`glyph + " $"` 渲染成 `$ $0.006`，与用户截图一致。

结论：货币符号不应由图标集提供。图标集只负责「钱」这个语义的可视锚点；符号与精度归 `currency.ts`。

### 2.2 主题相关的三层渲染面

| 层 | 归属 | 现有控制点 |
|---|---|---|
| Pi 原生渲染（markdown 正文、代码高亮、原生工具卡、用户消息底色） | Pi 主题 `themes/*.json`，56 个 token | `~/.pi/agent/themes/<name>.json`，`settings.json.theme` |
| open-tui 自绘（header / footer / compact 工具视图 / peek 标签 / 设置界面） | 本扩展 | `theme.fg("语义名", …)` 硬编码，散落 footer.ts / tool-view.ts / header.ts / peek.ts / telemetry.ts |
| Markdown 渲染细节（代码框、每 token 样式） | 本扩展已接管 | `copy-buttons.ts` 通过 `PATCH_KEY = Symbol.for("pi-open-tui.copy-buttons")` 包裹 `Markdown.prototype.renderToken` / `render` / `handleMouse`（copy-buttons.ts:253-473）, `UserMessageComponent.prototype.render`（:433） |

Pi 主题 token 全集（来自内置 `dark.json`，56 项）：
`accent border borderAccent borderMuted success error warning muted dim text thinkingText selectedBg scrollbarTrack scrollbarThumb searchMatchBg searchMatchText userMessageBg userMessageText customMessageBg customMessageText customMessageLabel toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff…thinkingMax bashMode`

关键：`thinkingText`、`toolPendingBg/toolSuccessBg/toolErrorBg/toolTitle/toolOutput`、`bashMode`、`mdHr`、`userMessageBg/userMessageText`、`md*`、`syntax*` 全部可由主题 JSON 控制。这是需求 2 的「免改代码就生效」路径。

### 2.3 可用的扩展 API（已验证存在）

- `pi.registerShortcut(shortcut: KeyId, { description, handler })` — types.d.ts:1275
- `pi.registerMarkdownTransformer(transformer, { messageTypes })` — types.d.ts:1297；`MarkdownMessageType = "user" | "assistant" | "assistant-thinking" | "custom" | "summary" | "changelog"`；回调收到 `{ messageType, isStreaming, availableWidth, messageId?, timestamp? }`
- `pi.registerToolRenderer(resolver)` — tool-view.ts:698 已在用
- `pi.registerEntryRenderer` / `registerMessageRenderer`（仅自定义类型）
- `ctx.ui.custom((tui, theme, kb, done) => Component, { overlay: true })` — settings-command.ts:660 已在用的浮层模式
- `ctx.ui.setStatus(key, text)` / `setWidget` / `notify`
- `ctx.sessionManager.getSessionFile(): string | undefined`

### 2.4 billion-context-pi 契约（需求 4 的数据源）

- 已装：`~/.pi/agent/npm/node_modules/billion-context-pi` v0.1.83（旧名 `il-context-pi`，同一包）
- 导出子路径：`.`、`./contract`、`./contract/schema`
- 侧文件：`<sessionFile>.acp.json`，原子写（tmp+rename），`schemaVersion: 1`，`producer: "billion-context-pi@x.y.z"`
- 稳定契约（`dist/contract.d.ts`）：
  ```ts
  SIDECAR_SCHEMA_VERSION = 1
  interface BcpBlockV1 {
    blockId: string; runId: string; tier: 1|2|3; topic?: string; summary: string;
    directMessageIds: string[]; effectiveMessageIds: string[]; directBlockIds: string[];
    compressedTokens: number; createdAt: number; survivedCount: number;
    generation: "young"|"old"; active: boolean;
    expanded?: boolean; durationMs?: number; compressCallId?: string;
    startRef?: string; endRef?: string;
  }
  interface BcpSidecarV1 { schemaVersion: number; producer: string; blocks: BcpBlockV1[]; [extra: string]: unknown }
  ```
- 侧文件实际还含（非契约，读时不得依赖）：`messageRefs`、`tokenSnapshot`、`stats{tokensCompressed,compressionCount,…}`、`nudge`、`activePack`
- 官方声明「下游工具直接 glob sidecar」→ open-tui 只读文件系统，**零 import 耦合**
- 该扩展当前仅通过 `ctx.ui.setStatus("il-context-pi", …)` 暴露一行状态，已由 open-tui 的 `extensionStatuses` 行渲染

## 3. 设计

### 3.1 任务 1 — 货币切换

**新模块 `extensions/open-tui/currency.ts`**

```ts
export type CurrencyCode = "usd" | "cny";
export interface CostConfig {
  currency: CurrencyCode;
  /** 手动固定汇率：1 USD = usdToCny CNY。仅 currency 为 cny 时使用。 */
  usdToCny: number;
  /** true 时允许 ctrl+shift+m 临时切换，切换结果写回配置。 */
  switchable: boolean;
}
export const DEFAULT_COST: CostConfig = { currency: "usd", usdToCny: 7.15, switchable: true };

export function currencySymbol(code: CurrencyCode): string;            // "$" | "¥"
export function convertUsd(usd: number, cfg: CostConfig): number;      // 仅 cny 时乘汇率
export function formatCost(usd: number, cfg: CostConfig): string;      // "$0.006" | "¥0.0429"
export function formatRate(usdPerMTokens: number | null, cfg: CostConfig): string | null; // "$0.15/M" | "¥1.07/M"
```

精度规则：绝对值 < 0.1 用 3 位小数，否则 2 位（`$0.006`、`$1.23`、`¥0.043`、`¥8.84`）。CNY 换算后再套同一规则。

**修改点**

| 文件 | 改动 |
|---|---|
| `icons.ts` | 从 `IconGlyphs` 删除 `cost` 字段及三套图标集里的定义（货币符号不再由图标集提供） |
| `footer.ts:194` | `cost: segments.cost ? formatCost(totals.cost, cfg.cost) : ""`，颜色仍走 `slots.cost`（默认 `warning`） |
| `telemetry.ts:352` | `formatRate(...)` 同上 |
| `config.ts` | 新增顶层 `cost: CostConfig`、`DEFAULT_COST`、`normalizeCost()`（currency 白名单、`usdToCny` 必须 >0 有限、switchable 布尔） |
| `settings-command.ts` | 「外观」页新增两项：`货币 / Currency`（USD/CNY 循环）与 `汇率 / USD→CNY`（数值输入） |
| `index.ts` | 注册 `ctrl+shift+m` 快键：切换 `cost.currency` → `saveConfig` → 触发 footer 重绘 + `ctx.ui.notify` 一行提示 |

**兼容性**：`footerSegments.cost` / `telemetry.cost` 两个布尔开关语义不变（管显示与否），新配置管显示什么。

### 3.2 任务 2 — 主题

分两件独立交付物，可分别验收。

#### 2a) `themes/*.json`（不动代码，覆盖 Pi 原生渲染面）

新增目录 `themes/`，4 套，均以 Pi 内置 `dark.json` 为骨架（`$schema / name / appearance / vars / colors / export`）：

| 文件 | name | 定位 |
|---|---|---|
| `themes/tokyo-night.json` | `tokyo-night` | 蓝紫冷调，工具/思考分色明显（推荐默认） |
| `themes/catppuccin-mocha.json` | `catppuccin-mocha` | 柔和低饱和，长时间阅读友好 |
| `themes/gruvbox-dark.json` | `gruvbox-dark` | 暖黄复古，对比强 |
| `themes/rose-pine-moon.json` | `rose-pine-moon` | 玫瑰紫，暗背景柔光 |

- 每套填满 56 个 token；用 `vars` 抽取共用色
- 校验：对 `D:/env/npm-global/node_modules/@earendil-works/pi-coding-agent/schemas/theme.schema.json` 做 JSON Schema 校验（加一个 `tests/themes.test.ts` 用 `node:test` 跑）
- 对比度门禁：`text`/`dim`/`muted` vs 背景、`toolOutput` vs `toolSuccessBg` 等关键配对必须 ≥ 3:1（脚本断言，避免出「看不清」的主题）
- 安装方式写进两份 README：`cp themes/*.json ~/.pi/agent/themes/ && /theme tokyo-night`
- `package.json` 的 `files` 增加 `"themes/"`

#### 2b) open-tui 槽位 + 结构选项（改代码）

**新模块 `extensions/open-tui/theme.ts`**

```ts
export type SlotName =
  | "thinking" | "toolCall" | "toolTitle" | "toolOutput" | "command"
  | "divider" | "gutter" | "userBar"
  | "hint" | "hintKey"
  | "cost" | "stats" | "success" | "error" | "warning";

export type SlotValue = string;   // "#7aa2f7" / "oklch(62% 0.1 200)" / 或 Pi 语义 token 名 "warning"

export interface ThemeConfig {
  /** "pi" = 完全跟随当前 Pi 主题（默认，等价于 v0.4.6 行为）；其余为内置槽位预设 */
  preset: "pi" | "tokyo-night" | "catppuccin-mocha" | "gruvbox-dark" | "rose-pine-moon";
  /** 逐槽覆盖 preset 与 Pi 主题 */
  slots: Partial<Record<SlotName, SlotValue>>;
  /** 消息之间的分割线 */
  dividers: "none" | "line" | "dashed";
  /** 工具输出/命令输出左侧竖线 */
  gutter: boolean;
  /** 工具结果行交替底色 */
  banding: boolean;
  /** `ctrl+o to expand` 提示的强调方式：key = 键帽提亮+下划线（默认）；plain = 整句一色；off = 隐藏 */
  expandHint: "key" | "plain" | "off";
}

export interface Painter {
  paint(slot: SlotName, text: string): string;
  /** 无覆盖时返回 Pi 语义 token 的原生函数，保持 0 成本 */
  raw(slot: SlotName): (text: string) => string;
}
export function createPainter(theme: Theme, cfg: ThemeConfig): Painter;
export function resolveSlotColor(cfg: ThemeConfig, slot: SlotName): SlotValue | undefined;
export function createMarkdownTheme(theme: Theme, cfg: ThemeConfig): MarkdownTheme; // 覆写 hr / quoteBorder
```

解析顺序：`cfg.slots[slot]` → 预设表 `PRESET_SLOTS[cfg.preset][slot]` → 硬编码的 Pi 语义 token（即 0.4.6 现值）。给了 hex/`oklch(` 就用 `theme.style(text, { fg })`（`Theme.style` 接受 `ThemeStyle { fg?: ThemeColor | Color }`，pi-tui 的 `Color` 支持 RGB/OKLCH）；否则走 `theme.fg(token, text)`。

**槽位 → 现有硬编码调用点迁移表**

| 槽位 | 现值（token） | 调用点 |
|---|---|---|
| `thinking` | `thinkingText` | peek.ts `buildPeekLabel`、tool-view.ts:600/601/664/666 |
| `toolCall` | `toolTitle` / 状态色 | tool-view.ts:307、:594（`icons.toolCall`） |
| `toolTitle` | `toolTitle` | tool-view.ts:508 |
| `toolOutput` | `toolOutput` | tool-view.ts:517、:660、:666、:673 |
| `command` | `toolTitle`（bash 工具） | tool-view.ts 的 bash 分支 |
| `divider` | `dim` | footer.ts:193、:521、:204 的 `|` 与 `·` |
| `gutter` | `dim` | tool-view.ts:600、:649（`icons.toolResult` 栏位） |
| `userBar` | `accent` | 新增（用户消息卡左侧竖条） |
| `cost` | `warning` | footer.ts:194、telemetry.ts:352 |
| `hint` | `dim`（提示正文，保持最暗） | tool-view.ts:309、:673、tool-preview.ts:170 |
| `hintKey` | `muted` + underline（键帽 `ctrl+o` 升一档亮度） | 同上三处 |
| `stats` / `success` / `error` / `warning` | `accent` / `success` / `error` / `warning` | footer.ts:184-196 |

**`ctrl+o to expand` 提示的强调（`expandHint`）**

三处提示当前都是整句 `theme.fg("dim", …)`，是最暗色，扫视时等于不存在。改为键帽单独强调，正文仍 dim：

```
├  … 5 earlier calls (ctrl+o to expand)
                      ^^^^^^  hintKey = muted + underline
                      ^^^^^^^^^^^^^^^^^^^^^  hint = dim
```

新模块 `extensions/open-tui/hint.ts`：

```ts
export interface ExpandHint { key?: string; tail: string }   // { key: "ctrl+o", tail: "to expand" }
export function formatExpandHint(painter: Painter, key: string | undefined, tail: string, expandHint: ThemeConfig["expandHint"]): string;
export const HINT_CTRL_O = { key: "ctrl+o", tail: "to expand" } as const;
```

- `"key"` → `painter.paintRaw("hint", "(") + painter.paintKey("hintKey", "ctrl+o") + painter.paintRaw("hint", " to expand)")`
- `"plain"` → 整句 `painter.paint("hint", "(ctrl+o to expand)")`
- `"off"` → 返回空串，调用方负责省略尾随空格（不能留下 `… 5 earlier calls ` 的悬挂空格）
- **不改变可见宽度**：下划线只加 ANSI 字节（`\x1b[4m`/`\x1b[24m`），`visibleWidth` 与 `truncateToWidth` 均按可见列计算，三个调用点的宽度预算无需调整

`Painter` 增加两个方法：

```ts
export interface Painter {
  paint(slot: SlotName, text: string): string;
  /** 追加文字属性（下划线等），与 paint 叠加 */
  paintStyled(slot: SlotName, text: string, attrs: TextAttributes): string;
  raw(slot: SlotName): (text: string) => string;
}
```

`hintKey` 的默认属性固定为 `{ underline: true }`，颜色取 `SLOT_TOKEN.hintKey = "muted"`；用户可在 `slots.hintKey` 里覆盖颜色（属性不开放配置，避免 `open-tui.json` 变成 CSS）。

**结构选项实现**

- `dividers`：在 `user` 面注册 markdown transformer，为每条用户消息前置一行分割线。`line` = `---`（走 `MarkdownTheme.hr`，颜色取 `slots.divider`）；`dashed` = 覆写 `hr` 渲染成 `╌╌╌`。首个用户消息不插线（模块级 flag，`session_start` 重置）。
- `gutter`：compact 工具视图的每个输出行前置 `│`（`slots.gutter` 上色），与调用行的 `⎿` 栏位对齐。
- `banding`：`nestedCallRows` / 结果行按奇偶交替 `theme.bg("toolSuccessBg")`。

**`markdown-skin.ts`（新增）**

`copy-buttons.ts` 已经证明 `Markdown.prototype.renderToken` / `UserMessageComponent.prototype.render` 的包裹是可行且可卸载的（`PATCH_KEY` + `restores[]`）。皮肤模块复用同一手法，但用独立 key `Symbol.for("pi-open-tui.markdown-skin")`：

- 包裹 `Markdown.prototype.renderToken`：当 `renderScope.messageType === "assistant-thinking"` 时把输出 token 重染为 `slots.thinking`；当 token 类型为 `hr` 时按 `dividers` 渲染
- 包裹 `UserMessageComponent.prototype.render`：每行前置 `slots.userBar` 上色的 `▌`，不改文本（避免污染「复制」内容）

**安装顺序（关键）**：`markdown-skin` 必须先于 `copy-buttons` 安装，清理时按相反顺序。这样 `copy-buttons` 保存的 `originalRenderToken` 是皮肤版本，其 cleanup 恢复成皮肤版本，皮肤 cleanup 再恢复真原始版本。

**缓存失效**：tool-view.ts:466 的渲染缓存以 `{ width, colors, toolCall, toolResult }` 为键，`colors` 是 `theme.colors` 引用。Painter 变化必须让缓存 miss → 在 `onConfigChanged` 里 bump 一个 `skinEpoch` 并加入缓存键。

### 3.3 任务 3 — GUI 观感（仅选定两项）

#### 3a) 轮次分割线 + 用户消息卡

- 分割线：见 3.2 的 `dividers`（同一实现，需求 2 与 3 共用）
- 用户消息卡：`UserMessageComponent.prototype.render` 包裹，左侧 `▌` 竖条，底色沿用 Pi 主题的 `userMessageBg`（由 2a 的 JSON 提供）。不改文本内容与宽度预算：竖条占用 2 列（`▌ `），超出时按现有 `availableWidth` 截断逻辑处理，避免横向溢出。

#### 3b) 思考块专属样式 + 折叠头

- 折叠头：增强 `peek.ts` 的 `buildPeekLabel`，从当前的纯 spinner 标签升级为
  `✻ Thinking · 12s · 1.2k tok`（三段在窄宽下降级为 `✻ 12s`），颜色取 `slots.thinking`。沿用现有 `editor.setLatestHiddenThinkingLabel` + `ctx.ui.setHiddenThinkingLabel()` 生命周期，不新增挂载点。
- 正文样式：`assistant-thinking` 面走 `markdown-skin` 重染为 `slots.thinking` 的 dim/italic 变体；Pi 主题的 `thinkingText` 作为兜底。
- 新增配置 `thinkingPeek.showCounts: boolean`（默认 true）——关掉即回到 0.4.6 的纯标签。

### 3.4 任务 4 — billion-context 只读联动

**新模块 `extensions/open-tui/context-blocks.ts`**

```ts
export interface ContextBlocksSnapshot {
  producer: string;
  blocks: readonly BcpBlockLike[];      // 本地镜像契约，不 import 该包
  compressedTokens: number;             // Σ blocks[].compressedTokens
  blockCount: number;
  tiers: Record<1 | 2 | 3, number>;
}
export function readContextBlocks(sessionFile: string | undefined): ContextBlocksSnapshot | undefined;
export function watchContextBlocks(sessionFile: () => string | undefined, onChange: (s?: ContextBlocksSnapshot) => void): () => void;
```

- 读取 `<sessionFile>.acp.json`；`schemaVersion !== 1` → 返回 `undefined` 并只记一行 warn（未来版本降级静默）
- 以 `mtimeMs` 做缓存键，避免每次重绘都 parse 大文件（侧文件可达数百 KB）
- 触发时机：`fs.watchFile(…, { interval: 1500 })` + 在 `agent_settled` / `session_compact` 事件后主动读一次；watch 失败不影响其他功能

**底栏段**：`footerSegments.contextBlocks`（默认 true），渲染 `⧉ 3 · 51k`（块数 · 已压缩 token）。无侧文件时整段消失。新图标集字段 `blocks`（nerd `\uF0C5`、unicode `⧉`、ascii `#`）。优先级 1，与 `cost` 同级，空间紧张时一起让位。

**浮层 `context-blocks-overlay.ts`**（复刻 `settings-command.ts` 的 `ctx.ui.custom(..., { overlay: true })` 结构）

```
┌ Context Compression ──────────────────────────────┐
│ 3 blocks · 51.4k compressed · t1×2 t2×1           │
│ ───────────────────────────────────────────────── │
│ ▸ b1  t1  pi-open-tui repo recon                  │
│       51.4k tok · 50.4x · survived 6              │
│ ▸ b2  t1  theme exploration                       │
│       8.2k tok  · 12.1x · survived 2              │
│ ───────────────────────────────────────────────── │
│ ctrl+d 展开摘要   esc 关闭   r 刷新               │
└───────────────────────────────────────────────────┘
```

- `↑/↓` 或 `j/k` 选行，`ctrl+d`/`Enter` 展开该块 `summary`（`wrapTextWithAnsi` 折行，滚动视口）
- `esc`/`q` 关闭；尺寸随终端自适应，与设置浮层同款 container 布局
- 快键：`ctrl+shift+c`；同时注册 `/open-tui:context` 命令作为终端吞掉该组合键时的退路
- 只读：不派发任何命令，不写侧文件

## 4. 配置 schema 变更（`~/.pi/agent/open-tui.json`）

新增四个顶层块，全部可选、全部有默认值，旧配置零改动可用：

```jsonc
{
  "cost": {
    "currency": "usd",        // "usd" | "cny"
    "usdToCny": 7.15,         // 必须 > 0
    "switchable": true
  },
  "theme": {
    "preset": "tokyo-night",  // "pi" | "tokyo-night" | "catppuccin-mocha" | "gruvbox-dark" | "rose-pine-moon"
    "slots": {},              // 逐槽覆盖，值可为 hex / oklch() / Pi 语义 token 名
    "dividers": "line",       // "none" | "line" | "dashed"
    "gutter": true,
    "banding": false,
    "expandHint": "key"       // "key"（键幅提亮+下划线）| "plain" | "off"
  },
  "thinkingPeek": { "lines": 1, "showCounts": true },
  "contextBlocks": { "enabled": true, "footerSegment": true, "pollMs": 1500 },
  "footerSegments": { "contextBlocks": true }
}
```

**默认值以用户已确认的观感为准**（`theme.preset: "tokyo-night"`、`dividers: "line"`、`gutter: true`、`banding: false`、`thinkingPeek.showCounts: true`、`contextBlocks.enabled: true`）。把 `preset` 改为 `"pi"` 且 `dividers: "none"`、`gutter: false` 时，输出必须与 v0.4.6 逐字节一致。

`config.ts` 需同步：`OpenTuiConfig` 接口、`DEFAULT_CONFIG`、`normalizeCost()`、`normalizeTheme()`、`normalizeContextBlocks()`，并在 `loadConfig()` 里调用。所有新字段走「非法值回落默认」策略，与现有 `normalizeFlags` / `normalizeToolView` 一致。

## 5. 风险与取舍

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 包裹 `Markdown` / `UserMessageComponent` 私有原型方法，Pi 升级可能改签名 | 沿用 copy-buttons.ts:265-269 的运行时能力探测，缺方法则 no-op 静默降级；`tests/markdown-skin.test.ts` 断言探测路径 |
| R2 | markdown transformer 注入 `---` 可能污染「复制」文本 | 复制走 `UserMessageComponent.text`（源文本）而非转换后文本；加测试固定该行为 |
| R3 | 4 套主题 JSON × 56 token，容易出现低对比度 | JSON Schema 校验 + 对比度断言脚本（关键配对 ≥ 3:1） |
| R4 | 皮肤与 copy-buttons 安装顺序错乱导致卸载不干净 | 单一 `installUi` 顺序常量化，测试断言 cleanup 后原型方法引用等于原始引用 |
| R5 | `ctrl+shift+c` / `ctrl+shift+m` 与 Pi 默认键位或用户自定义键位冲突 | 查 `docs/keybindings.md` 默认表；冲突时改用 `ctrl+shift+k` / 提供 `/open-tui:` 命令退路；把两个快键做成可配置 |
| R6 | 侧文件在别的终端窗口被重写（多会话） | 以 `mtimeMs` 为键缓存；parse 失败保留上一份快照，不清空底栏 |
| R7 | `dividers` 在长会话中影响 markdown 缓存命中（Pi 有 native block cache） | 分割线只加在 `user` 面，且 `user` 面本就每轮重渲；assistant 面不动 |

## 6. 测试策略

`node:test`，与现有 `npm test` 一套跑：

| 文件 | 覆盖 |
|---|---|
| `tests/currency.test.ts` | 换算、精度边界（0.0004 / 0.1 / 1.0）、`$$` 回归（断言 `formatCost` 输出只含一个符号）、汇率非法值 |
| `tests/config.test.ts`（并入现有） | 新块默认值、非法值回落、旧配置兼容（缺字段不炸） |
| `tests/theme.test.ts` | 解析优先级 slots > preset > token、hex/oklch/token 三种值形态、`Painter` 无覆盖时零成本 |
| `tests/themes.test.ts` | 4 套 JSON 通过 `theme.schema.json`；关键配对对比度 ≥ 3:1 |
| `tests/hint.test.ts` | `expandHint` 三档输出；`"key"` 下键帽带下划线且正文仍 dim；`"off"` 不留悬挂空格；ANSI 不改变 `visibleWidth` |
| `tests/markdown-skin.test.ts` | 能力探测、安装/卸载幂等、与 copy-buttons 共存、`dividers` 注入不影响复制文本 |
| `tests/context-blocks.test.ts` | 侧文件解析、`schemaVersion` 不符降级、mtime 缓存、损坏文件保留旧值、token 汇总 |
| `tests/footer.test.ts`（扩充） | `$$` 修复、CNY 态渲染、`contextBlocks` 段显隐 |

`npm test && npm run typecheck` 为完成门槛（AGENTS.md 要求）。新增用户可见行为需同步更新 `README.md` 与 `README.zh-CN.md`，并在 `CHANGELOG.md` 写 `## [0.5.0] - 2026-11-15`。

## 7. 交付顺序

每项独立可验收，各自提交：

1. **T1 货币**（最小、价值最高）：`currency.ts` + 修 `$$` + 配置 + 设置项 + 快键 + 测试
2. **T2a 主题 JSON**：4 套 + schema/对比度测试 + README 安装说明
3. **T2b 槽位与结构选项**：`theme.ts` + `markdown-skin.ts` + 调用点迁移 + 分割线/gutter/banding + 测试
4. **T3 GUI 观感**：用户消息卡 + 思考块折叠头 + `showCounts` + 测试
5. **T4 上下文联动**：`context-blocks.ts` + 底栏段 + 浮层 + 快键/命令 + 测试
6. **收尾**：README ×2 + CHANGELOG + 版本 0.5.0 + 全量 `npm test && npm run typecheck` + `pi -e .` 实机验证

## 8. 待确认

- 无（本轮四个决策点已确认）。以下为实现期自决项，如无异议按文档默认执行：
  - 汇率精度：< 0.1 三位小数，否则两位
  - `theme.preset` 默认 `"pi"`（完全不改变现有观感，用户自行 opt-in）
  - `dividers` 默认 `"none"`，`gutter`/`banding` 默认 `false`
  - 两份 README 同步更新，中文版补「DIY 分支说明」段
