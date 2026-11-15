# pi-open-tui DIY 实现计划（v0.5.0）

> 设计文档：`docs/plans/2026-11-15-open-tui-diy-design.md`
> 仓库：`E:/Document/Pi_PJ/Pi_日常/pi-open-tui`
> 完成门槛：`npm test && npm run typecheck` 全绿

## 全局约定

- 每个任务 = 红 → 绿 → 提交。**先写测试，看它失败**，再写实现。
- 测试用 `node:test` + `node:assert/strict`。主题桩：`{ fg: (_c: string, t: string) => t } as Theme`
- 临时目录用 `tests/fixtures/test-helpers.ts` 的 `temporaryDirectory(t, prefix)`
- 提交信息：`feat(cost): …` / `feat(theme): …` / `feat(gui): …` / `feat(context): …` / `docs: …`
- 默认观感（已确认）：`theme.preset: "tokyo-night"`, `dividers: "line"`, `gutter: true`, `banding: false`, `expandHint: "key"`, `thinkingPeek.showCounts: true`, `contextBlocks.enabled: true`

---

## T1 — 货币（currency）

### T1.1 红：`tests/currency.test.ts`

新建，覆盖：

```ts
import { formatCost, formatRate, convertUsd, currencySymbol, DEFAULT_COST } from "../extensions/open-tui/currency.ts";

const usd = DEFAULT_COST;                                    // { currency:"usd", usdToCny:7.15, switchable:true }
const cny = { ...DEFAULT_COST, currency: "cny" as const };

test("usd renders single $ and no duplicate glyph", () => {
  assert.equal(formatCost(0.0063, usd), "$0.006");
  assert.equal(formatCost(0.0063, usd).match(/\$/g)?.length, 1);   // 回归：$$ 只能有一个
});
test("cny converts with configured rate", () => {
  assert.equal(formatCost(0.0063, cny), "¥0.045");
  assert.equal(currencySymbol("cny"), "¥");
});
test("precision switches at 0.1", () => {
  assert.equal(formatCost(0.0999, usd), "$0.100");
  assert.equal(formatCost(0.1, usd), "$0.10");
  assert.equal(formatCost(1.234, usd), "$1.23");
  assert.equal(formatCost(0, usd), "$0.000");
});
test("rate formatting", () => {
  assert.equal(formatRate(0.15, usd), "$0.15/M");
  assert.equal(formatRate(0.15, cny), "¥1.07/M");
  assert.equal(formatRate(null, usd), null);
});
test("convertUsd is identity for usd, guarded for bad rates", () => {
  assert.equal(convertUsd(1, usd), 1);
  assert.equal(convertUsd(1, { ...cny, usdToCny: Number.NaN }), 1);   // 非法汇率回落 1
  assert.equal(convertUsd(1, { ...cny, usdToCny: -2 }), 1);
});
```

`npx tsx --test tests/currency.test.ts` → 失败（模块不存在）。

### T1.2 绿：`extensions/open-tui/currency.ts`

```ts
export type CurrencyCode = "usd" | "cny";
export interface CostConfig { currency: CurrencyCode; usdToCny: number; switchable: boolean }
export const DEFAULT_COST: CostConfig = { currency: "usd", usdToCny: 7.15, switchable: true };
export function currencySymbol(code: CurrencyCode): string;
export function convertUsd(usd: number, cfg: CostConfig): number;
export function formatCost(usd: number, cfg: CostConfig): string;
export function formatRate(usdPerMTokens: number | null, cfg: CostConfig): string | null;
```

实现要点：`convertUsd` 对非有限/≤0 的 `usdToCny` 返回原值；`formatCost` 用 `value < 0.1 ? 3 : 2` 位小数（注意 `0.0999` 经 `toFixed(3)` = `"0.100"`，按**转换后的值**判断精度）。

提交：`feat(cost): add currency conversion module`

### T1.3 红→绿：图标集不再提供货币符号

1. `tests/icons.test.ts` 加断言：`resolveGlyphs(...)` 结果不含 `cost` 键（`"cost" in glyphs === false`）
2. 删 `extensions/open-tui/icons.ts` 的 `IconGlyphs.cost` 字段 + `NERD_GLYPHS.cost`（原 :79）+ `UNICODE_GLYPHS.cost`（原 :124）+ `ASCII_GLYPHS.cost`（原 :85）
3. `npx tsc --noEmit` 列出所有引用点（预期：`footer.ts:194`、`telemetry.ts:352`）

提交：`refactor(icons): drop cost glyph, currency owns the symbol`

### T1.4 绿：修 `$$` 与 `$/M`

- `extensions/open-tui/footer.ts:194`
  ```ts
  cost: segments.cost ? painter.paint("cost", formatCost(totals.cost, config.cost)) : "",
  ```
  此时 painter 尚未存在 → 本任务先用 `theme.fg("warning", formatCost(totals.cost, config.cost))`，T2.8 再换成 painter。
- `extensions/open-tui/telemetry.ts:352`
  ```ts
  const rate = formatRate(telemetry.rateUsdPerMTokens, config.cost);
  if (rate) parts.push(theme.fg("warning", rate));
  ```
  注意 `formatRate(null) === null` 要跳过而不是渲染 `"null"`。
- `footer.ts` / `telemetry.ts` 需要拿到 `config`：检查现有签名是否已传入（footer 已接受 config，telemetry 若未传则加参数）。
- 更新 `tests/footer.test.ts` 中任何断言 `"$ $"` / `"$0.00"` 的期望。

提交：`fix(cost): render a single currency symbol in footer and telemetry`

### T1.5 红→绿：配置块 `cost`

1. `tests/config.test.ts` 加：缺 `cost` → `DEFAULT_COST`；`currency: "eur"` → 回落 `"usd"`；`usdToCny: 0` → 回落 `7.15`；`switchable: "yes"` → `true`
2. `extensions/open-tui/config.ts`：`OpenTuiConfig` 加 `cost: CostConfig`，`DEFAULT_CONFIG.cost = DEFAULT_COST`，新增 `normalizeCost(raw): CostConfig` 并在 `loadConfig()` 调用

提交：`feat(config): add cost block with currency and manual rate`

### T1.6 绿：设置项 + 快键

- `extensions/open-tui/settings-command.ts`
  - `COPY.en.labels` 加 `currency: "Currency"`, `usdToCny: "USD→CNY rate"`；`COPY.zh.labels` 加 `货币`, `汇率（USD→CNY）`
  - `COPY.*.values` 加 `currencies: { usd: "USD $" , cny: "CNY ¥" }`
  - `buildIconsItems`（外观页）末尾加两行：
    ```ts
    { id: "currency", label: copy.labels.currency, currentValue: copy.values.currencies[config.cost.currency] },
    { id: "usdToCny", label: copy.labels.usdToCny, currentValue: String(config.cost.usdToCny) },
    ```
  - `handleSettingChange` 的 `tab === "icons"` 分支加：
    ```ts
    if (itemId === "currency") return { ...config, cost: { ...config.cost, currency: config.cost.currency === "usd" ? "cny" : "usd" } };
    if (itemId === "usdToCny") return { ...config, cost: { ...config.cost, usdToCny: nextRateStep(config.cost.usdToCny) } };
    ```
    `nextRateStep`：`7.15 → 7.00 → 7.30` 阶梯循环（避免引入数值输入框，SettingsRow 只有 item 无 input）。循环序列 `[6.80, 7.00, 7.15, 7.30, 7.50]`。
- `extensions/open-tui/index.ts` 注册快键（**已查 `docs/keybindings.md`：`ctrl+shift+m`、`ctrl+shift+c` 无冲突**，已占用的是 `+n/+t/+f/+g/+up/+down`）：
  ```ts
  pi.registerShortcut("ctrl+shift+m", {
    description: "Toggle currency (USD/CNY)",
    handler: (ctx) => { /* config.cost.switchable 为 false 时 notify 并返回 */ },
  });
  ```
- `tests/settings-command.test.ts` 加：currency 项循环、`usdToCny` 阶梯、`switchable: false` 时不切换

提交：`feat(settings): currency toggle in settings and ctrl+shift+m`

---


## T1 修复轮 1（review 结论，`bfd48ba..bc016c6`）

reviewer 已确认 **`$$` 重复彻底根除**：`currency.ts` 是唯一符号发送者，`footer.ts:196` 与 `telemetry.ts:353` 都只调格式化器，`icons.ts` 再无 `cost` 键。以下为待修项。

### BLOCKER

**B1 — 切换成功时无任何提示，且测试把缺失钉死了。**
`index.ts:455-470` 只在 locked 分支 `ctx.ui.notify`，成功分支只有 `persistConfig` + `requestFooterRender`。当 `footerSegments.cost` 与 `telemetry.cost` 都关闭时，`ctrl+shift+m` 完全无可见反馈。而 `tests/settings-command.test.ts:606` 用 `assert.equal(host.notifications.length, 0)` 把"无提示"固化成了预期。
修法：`persistConfig` 之后 `ctx.ui.notify(copy.notices.currencySwitched(...), "info")`，`COPY.en.zh.notices` 各加一条；`:606` 改为断言 1 条且含新货币。

**B2 — locked 提示指向一个不存在的设置项。**
`COPY.notices.currencyLocked` 说"可在 open-tui 设置中开启"，但 `switchable` 在 `settings-command.ts` 里**没有行、没有 handler**（全仓 grep 只在 `index.ts:459`、`config.ts:155` 出现）。
修法：Settings 页加一行 `{ id: "switchable", label: copy.labels.currencySwitch, currentValue: flag(config.cost.switchable) }`，`handleSettingChange` 加 `if (itemId === "switchable") return { ...config, cost: { ...config.cost, switchable: !config.cost.switchable } }`，双语 labels + 测试。

### SHOULD FIX

- **S3（已完成，`bb0e2e1`）** — `docs/configuration.md` 增补 `cost` 块；两个 README 的样例从 `$ $3.60/M` 改为 `$3.60/M`，`$ / M` 措辞改为货币中立并列出 `ctrl+shift+m`。
- **S4** — `config.ts:148-159` `normalizeCost` 返回全新字面量，**丢弃未知同级键**；`normalizeFlags`(`:161-170`) 与 `deepMerge` 都保留。`loadConfig` 在 `:247` 采用该对象且 `saveConfig` 写内存态，故首次保存设置就会删掉用户/新版写入的键。修法：`return { ...(source as Record<string, unknown>), currency, usdToCny, switchable };` + 往返测试。
- **S5** — `currency.ts:36-40` 负数渲染成 `$-0.50`（符号在负号前）。负数可达：`state.ts:60`、`telemetry.ts:256` 只用 finite 守卫。修法：`Math.max(0, convertUsd(...))` 或显式处理符号 + 负值测试（现无）。
- **S6** — 汇率无上限：`usdToCny: 1e300` 可通过，乘积仍 finite，而 `toFixed` 在 ≥1e21 返回指数形式 → 底栏出现 `¥6.3e+297`。修法：`currency.ts` 与 `normalizeCost` 双双 clamp 到 `[0.01, 1000]`，越界回退 `DEFAULT_COST.usdToCny`，补 `1e300` 测试。
- **S7** — `tests/telemetry.test.ts:136,207` 只用 USD 调用（4 参，走默认 `DEFAULT_COST`），CNY 一半的 bug 从未被测试。补一例传 `{ ...DEFAULT_COST, currency: "cny" }`，断言 `¥1.07/M` 且 `output.includes("$") === false`。
- **S8（已在 S3 文档中说明）** — `formatCost(0.0004) === "$0.000"`：计划规定的规则，不改行为，已写进 `docs/configuration.md`。

### NIT（顺手修）

- `telemetry.ts:353` 参数命名冲突：`config.cost`（boolean 开关）与 `cost`（`CostConfig`）同表达式中出现 → 参数改名 `currency`。
- `currency.ts:19-21` `SYMBOLS[code] ?? SYMBOLS.usd` 的右支不可达（`Record<CurrencyCode, string>`）→ 去掉 `??`。
- `settings-command.ts:264-270` `nextRateStep`：`RATE_STEPS.findIndex(step === current)` 用浮点严格相等，手改的 `7.4` 匹配不到 → `-1` → 跳到 `6.8`。改为取"最近/次高"梯级；并把梯级表移进 `currency.ts`（避免第二处汇率真源）。`:269` 的 `?? DEFAULT_COST.usdToCny` 不可达。
- `settings-command.ts:100,166` `"USD $"` / `"CNY ¥"` 标签硬编码符号 → 用 `currencySymbol()` 拼（不是 `$$` 回归，只是保持单一所有者）。
- `index.ts:455` 加一行注释：快捷键注册于扩展生命周期、非每会话。
- `index.ts:455-470` 两个行为边界：(a) 无 `config.enabled` 守卫——功能关闭时仍会改写 `open-tui.json`；(b) 设置悬浮窗打开时切换会与悬浮窗快照冲突，下次改行会把旧货币写回。修法：悬浮窗开启时短路该快捷键（若有现成标志），或统一走 `applyConfig`。
- `tests/footer.test.ts:1008` 的 `output.includes("$0.010")` 是**空断言**（`"$ $0.010"` 也包含它）→ 删除或加强（真正的守门是 `:1041` 的 `$` 计数与 `:1044-1058` 的 CNY 无 `$` 断言）。
- `tests/config.test.ts:29-32` `switchable: "yes"` 断言通过的理由是错运气（`DEFAULT_COST.switchable` 恰为 `true`）→ 改断言常量本身，并补 `"false"` 用例。

### 明确不做

- `settingsCopy` 暴露整棵 COPY 树（原 NIT 13）：收益小、改动面大，保持现状。

## T2a — 主题 JSON 预设

**已核实的事实（direct from repo）**

- 骨架源：`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json` — 完整 56 色 + `vars` + `export` 块，直接 `cp` 后改色值即可
- Schema：`node_modules/@earendil-works/pi-coding-agent/schemas/theme.schema.json` — `required: ["name", "colors"]`；`colors.required` 只有 **51** 色（`scrollbarTrack`、`scrollbarThumb`、`searchMatchBg`、`searchMatchText`、`thinkingMax` 是可选的，但 dark.json 都给了，新主题一律补齐 56）
- 颜色值允许形态（`$defs.ColorValue`）：`#RGB` / `#RRGGBB` / `oklch(...)` / `okhsl(...)` / 变量名（不加 `$` 前缀，如 `"muted"`）/ 空字符串（终端默认）/ 0–255 整数
- `dark.json` 的写法惯例：先把基础色放进 `vars`（`text`/`muted`/`violet`/`blue`/`green`/`red`/`yellow`/`blueBg`），`colors` 里用变量名引用，可读性最好——新主题沿用这个结构，不要铺满扁平 hex
- `export` 块（`pageBg` / `cardBg` / `infoBg`）供 HTML 导出用，也要一并给出

### T2.1 红：`tests/themes.test.ts`

```ts
const SCHEMA = JSON.parse(readFileSync("D:/env/npm-global/node_modules/@earendil-works/pi-coding-agent/schemas/theme.schema.json", "utf8"));
const NAMES = ["tokyo-night", "catppuccin-mocha", "gruvbox-dark", "rose-pine-moon"];

test("each theme validates against Pi theme schema", ...);
test("each theme defines all 56 base tokens", ...);   // 与内置 dark.json 的 colors 键集对比
test("critical pairs meet 3:1 contrast", ...);        // text/dim/muted vs background；toolOutput vs toolSuccessBg
test("vars are resolvable", ...);                     // 所有 "$var" 引用能在 vars 里找到
```

对比度算法用 WCAG 相对亮度（sRGB → 线性 → `(L1+0.05)/(L2+0.05)`），hex 颜色解析本地实现，不引依赖。

`npx tsx --test tests/themes.test.ts` → 失败（目录不存在）。

提交（红测试单独提交）：`test(themes): add theme validation and contrast gates`

测试实现要点：断言键集时以 `dark.json` 的 `Object.keys(colors)` 为基准（56 个），而不是手写列表。

### T2.2 绿：`themes/tokyo-night.json`

以 `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json` 为骨架（`cp` 后改 `vars` + `colors` + `export`），按 Tokyo Night 调色板填充：

```
background #1a1b26  text #c0caf5  muted #565f89  dim #414868
accent #7aa2f7  border #2f3549  borderAccent #7dcfff  borderMuted #24283b
success #9ece6a  error #f7768e  warning #e0af68
thinkingText #565f89  userMessageBg #24283b  userMessageText #c0caf5
toolPendingBg #1f2335  toolSuccessBg #1a2b2a  toolErrorBg #2d1f27
toolTitle #7dcfff  toolOutput #a9b1d6
mdHeading #7aa2f7  mdLink #7dcfff  mdCode #e0af68  mdCodeBlock #a9b1d6
mdCodeBlockBorder #3b4261  mdQuote #565f89  mdQuoteBorder #3b4261  mdHr #3b4261  mdListBullet #bb9af7
syntaxKeyword #bb9af7  syntaxFunction #7aa2f7  syntaxVariable #c0caf5  syntaxString #9ece6a
syntaxNumber #ff9e64  syntaxType #2ac3de  syntaxOperator #89ddff  syntaxComment #565f89
bashMode #9ece6a
```
`appearance: "dark"`，`name: "tokyo-night"`。

提交：`feat(themes): add tokyo-night preset`

### T2.3 绿：另三套

- `themes/catppuccin-mocha.json`：bg `#1e1e2e` / text `#cdd6f4` / accent `#89b4fa` / keyword `#cba6f7` / string `#a6e3a1` / number `#fab387` / type `#89dceb` / error `#f38ba8` / warning `#f9e2af`
- `themes/gruvbox-dark.json`：bg `#282828` / text `#ebdbb2` / accent `#83a598` / keyword `#fb4934` / string `#b8bb26` / number `#d3869b` / type `#fabd2f`
- `themes/rose-pine-moon.json`：bg `#232136` / text `#e0def4` / accent `#c4a7e7` / keyword `#c4a7e7` / string `#f6c177` / number `#ea9a97` / type `#9ccfd8`

每套写完立刻跑 T2.1 的测试，红→绿。

提交：`feat(themes): add catppuccin-mocha, gruvbox-dark, rose-pine-moon`

### T2.4 打包与文档

- `package.json`：`files` 数组加 `"themes/"`
- `README.md` / `README.zh-CN.md` 加「主题」节：`cp themes/*.json ~/.pi/agent/themes/ && /theme tokyo-night`

提交：`docs: ship theme presets and install instructions`

---

## T2b — open-tui 槽位与结构选项

### T2.5 红：`tests/theme.test.ts`

```ts
import { createPainter, resolveSlotColor, PRESET_SLOTS } from "../extensions/open-tui/theme.ts";

test("slots beat preset", () => {
  const cfg = { preset: "tokyo-night", slots: { thinking: "#ff0000" }, dividers: "line", gutter: true, banding: false };
  assert.equal(resolveSlotColor(cfg, "thinking"), "#ff0000");
  assert.equal(resolveSlotColor(cfg, "toolCall"), PRESET_SLOTS["tokyo-night"].toolCall);
});
test("preset 'pi' yields no override -> falls through to Pi token", () => {
  assert.equal(resolveSlotColor({ ...cfg, preset: "pi", slots: {} }, "thinking"), undefined);
});
test("paint uses theme.fg for token names and theme.style for colors", () => {
  // 断言 fg 收到 token 名；style 收到 { fg: "#7aa2f7" }
});
```

提交：`test(theme): pin slot resolution precedence`

### T2.6 绿：`extensions/open-tui/theme.ts`

```ts
export type SlotName = "thinking" | "toolCall" | "toolTitle" | "toolOutput" | "command"
  | "divider" | "gutter" | "userBar" | "cost" | "stats" | "success" | "error" | "warning";
export type SlotValue = string;
export interface ThemeConfig { preset: PresetName; slots: Partial<Record<SlotName, SlotValue>>; dividers: "none"|"line"|"dashed"; gutter: boolean; banding: boolean }
export const PRESET_SLOTS: Record<Exclude<PresetName, "pi">, Partial<Record<SlotName, SlotValue>>>;
export const SLOT_TOKEN: Record<SlotName, ThemeColorName>;   // 无覆盖时的回落 token（= v0.4.6 现值）
export function resolveSlotColor(cfg: ThemeConfig, slot: SlotName): SlotValue | undefined;
export interface Painter { paint(slot: SlotName, text: string): string; raw(slot: SlotName): (t: string) => string }
export function createPainter(theme: Theme, cfg: ThemeConfig): Painter;
```

`SLOT_TOKEN` 初值（严格对齐现有硬编码，保证 `preset: "pi"` 时零视觉变化）：

| slot | token |
|---|---|
| thinking | `thinkingText` |
| toolCall / toolTitle | `toolTitle` |
| toolOutput | `toolOutput` |
| command | `toolTitle` |
| divider / gutter | `dim` |
| userBar | `accent` |
| cost / warning | `warning` |
| stats | `accent` |
| success / error | `success` / `error` |

hex / `rgb(` / `oklch(` 前缀判定 → `theme.style(text, { fg: value })`；否则 `theme.fg(value as ThemeColorName, text)`。
`PRESET_SLOTS["tokyo-night"]` = 设计文档里的 7 槽（thinking `#7aa2f7`、toolCall `#bb9af7`、toolTitle `#7dcfff`、toolOutput `#a9b1d6`、command `#e0af68`、divider `#3b4261`、gutter `#414868`）+ userBar `#7aa2f7` + cost `#e0af68`。其余三套同调色板。

提交：`feat(theme): slot painter with presets and per-slot overrides`

### T2.7 红→绿：配置块 `theme`

`tests/config.test.ts`：非法 preset → `"pi"`？**不**——按已确认默认，回落 `"tokyo-night"`；非法 `dividers` → `"line"`；`gutter` 非布尔 → 默认值。
`config.ts` 加 `theme: ThemeConfig`、`DEFAULT_CONFIG.theme = { preset: "tokyo-night", slots: {}, dividers: "line", gutter: true, banding: false }`、`normalizeTheme()`。

提交：`feat(config): add theme block`

### T2.8 绿：迁移调用点到 Painter

替换下列硬编码（逐个文件、小步提交）：

| 文件:行 | 原 | 新 |
|---|---|---|
| `footer.ts:184` 等 stats 段 | `theme.fg("accent", …)` | `painter.paint("stats", …)` |
| `footer.ts:193`、`:521` 的 `\|` | `theme.fg("dim", "│")` | `painter.paint("divider", "│")` |
| `footer.ts:194` cost | `theme.fg("warning", …)` | `painter.paint("cost", formatCost(...))` |
| `footer.ts:204` 的 `·` | `theme.fg("dim", "·")` | `painter.paint("divider", "·")` |
| `telemetry.ts:352` rate | `theme.fg("warning", …)` | `painter.paint("cost", rate)` |
| `tool-view.ts:508` 标题 | `theme.fg("toolTitle", …)` | `painter.paint("toolTitle", …)` |
| `tool-view.ts:517` 输出 | `theme.fg("toolOutput", …)` | `painter.paint("toolOutput", …)` |
| `tool-view.ts:594` 调用图标 | `theme.fg("toolTitle", …)` | `painter.paint("toolCall", …)` |
| `tool-view.ts:600/601` 结果栏位 | `theme.fg("dim"/"thinkingText", …)` | `painter.paint("gutter"/"thinking", …)` |
| `tool-view.ts:649` gutter 栏位 | `theme.fg("dim", …)` | `painter.paint("gutter", …)` |
| `tool-view.ts:660/664/666/673` | 混合 | `toolOutput` / `thinking` |
| bash 工具标题分支 | `theme.fg("toolTitle", …)` | `painter.paint("command", …)` |

Painter 从 `index.ts` 构造一次，经现有 config 传递路径下发（footer/tool-view 已收 config，加 `painter` 字段）。

**缓存**：`tool-view.ts:466` 缓存键 `{ width, colors, toolCall, toolResult }` 追加 `skinEpoch: number`（config 变更时 `index.ts` 递增），否则改主题后不重绘。

提交：`refactor(theme): route open-tui colors through the slot painter`

### T2.9 红→绿：`markdown-skin.ts`（原型包裹，含安装顺序）

1. `tests/markdown-skin.test.ts` 先写：
   - 能力探测：原型缺 `renderToken` 时 `installMarkdownSkin` 返回 `undefined` 且不抛
   - 安装/卸载幂等：cleanup 两次不报错；cleanup 后原型方法引用 `===` 原始引用
   - 与 copy-buttons 共存：先装 skin 再装 copy-buttons，按**相反顺序**清理后两者引用都恢复
2. 实现：独立 `const SKIN_KEY = Symbol.for("pi-open-tui.markdown-skin")`，`restores[]` 栈，`installMarkdownSkin(theme, cfg): (() => void) | undefined`
3. `index.ts` 安装顺序**固定**：`markdown-skin` → `copy-buttons`；清理反序

提交：`feat(theme): markdown skin with ordered prototype patching`

### T2.10 绿：`dividers` / `gutter` / `banding`

- **dividers**：在 `user` 面 transformer 输出前置一行。`line` → 走 MarkdownTheme 的 `hr`（颜色 `slots.divider`）；`dashed` → 覆写 `hr` 渲染为 `╌`×width 的 dim 串。首个用户消息不插线（模块级 `firstUserTurn` flag，`session_start` 重置）。**不得改变 `UserMessageComponent.text`**（复制走源文本）。
- **gutter**：compact 工具视图每行输出前置 `painter.paint("gutter", "│")`，宽度预算里扣 2 列。
- **banding**：`nestedCallRows` 奇数行套 `theme.bg("toolSuccessBg")`。
- `tests/footer.test.ts` / `tests/tool-view.test.ts` 加：`dividers: "none"` 时输出与 v0.4.6 逐字节相同（回归门）；`gutter: true` 时每行以 `│` 开头。

提交：`feat(theme): turn dividers, output gutter, and banding`

---

## T2c — `ctrl+o to expand` 提示强调

背景：三个提示点（`tool-view.ts:309` 折叠的早前调用、`tool-view.ts:673` 的 `+N more`、`tool-preview.ts:170` 的 `… +N lines`）当前都是整句 `theme.fg("dim", …)`——最暗色，扫视时等于不存在。改为键帽单独强调：

```
├  … 5 earlier calls (ctrl+o to expand)
                      ^^^^^^  hintKey = muted + underline（SGR 4/24）
                      ^^^^^^^^^^^^^^^^^^^^^  hint = dim
```

### T2.11 红：`tests/hint.test.ts`

```ts
import { formatExpandHint } from "../extensions/open-tui/hint.ts";

test("key mode underlines only the keycap", () => {
  const out = formatExpandHint(painter, "ctrl+o", "to expand", "key");
  assert.ok(out.includes("\x1b[4m"));      // underline on
  assert.ok(out.includes("\x1b[24m"));     // underline off
});
test("key mode paints hint / hintKey / hint in that order", () => {
  assert.deepEqual(painter.log.map(([slot]) => slot), ["hint", "hintKey", "hint"]);
});
test("off mode yields empty string", () => {
  assert.equal(formatExpandHint(painter, "ctrl+o", "to expand", "off"), "");
});
test("ANSI never changes visible width", () => {
  assert.equal(visibleWidth(formatExpandHint(painter, "ctrl+o", "to expand", "key")), visibleWidth("(ctrl+o to expand)"));
});
```

`npx tsx --test tests/hint.test.ts` → 失败（模块不存在）。

提交：`test(hint): pin expand-hint modes and width neutrality`

### T2.12 绿：`extensions/open-tui/hint.ts` + 两个槽位

- `theme.ts`：`SlotName` 加 `"hint" | "hintKey"`；`SLOT_TOKEN.hint = "dim"`、`SLOT_TOKEN.hintKey = "muted"`；`ThemeConfig.expandHint: "key" | "plain" | "off"`（默认 `"key"`）
- `Painter` 加 `paintStyled(slot, text, attrs: TextAttributes): string`：与 `paint` 同解析路径，但走 `theme.style(text, { fg, ...attrs })`；值为 token 名时先取 `theme.colors[token]` 作 `fg`
- `hint.ts`：`formatExpandHint(painter, key, tail, mode)`，`"key"` 模式硬编码 `{ underline: true }`
- `config.ts`：`normalizeTheme` 校验 `expandHint` 三值，非法回落 `"key"`

提交：`feat(theme): expand-hint slots with underlined keycap`

### T2.13 绿：迁移三处提示

| 文件:行 | 原 | 新 |
|---|---|---|
| `tool-view.ts:309` | `theme.fg("dim", `… N earlier call(s) (ctrl+o to expand)`)` | 头部与提示分开拼；`off` 时头部不带尾随空格 |
| `tool-view.ts:673` | `theme.fg("toolOutput", names + ` · +N more (ctrl+o to expand)`)` | `theme.fg("toolOutput", names + ` · +N more`) + " " + formatExpandHint(...)`；`off` 时省略整段 |
| `tool-preview.ts:170` | `theme.fg("dim", truncateToWidth(`… +N lines (ctrl+o to expand)`))` | 先拼好已着色的 `head + hint` 再 `truncateToWidth`（按可见列截断、保留 ANSI）；`off` 时只拼 `… +N lines` |

`tests/tool-view.test.ts` / `tests/tool-preview.test.ts` 加回归：`expandHint: "off"` 时逐行 `assert.ok(!line.endsWith(" "))`。

提交：`feat(gui): emphasize ctrl+o expand hints`

> 注：`painter` 尚未存在时（若 T2c 先于 T2b 执行）可先接受 `(slot, text) => theme.fg(...)` 形状的函数，T2.8 换成真 Painter。**推荐顺序：T2b → T2c**。

---

## T3 — GUI 观感

### T3.11 绿：用户消息卡左侧竖条

`markdown-skin.ts` 内包裹 `UserMessageComponent.prototype.render`：每行前置 `painter.paint("userBar", "▌") + " "`，宽度预算扣 2 列。

`tests/markdown-skin.test.ts` 加：
- 竖条只在 `slots.userBar` 有值时出现（`preset: "pi"` 且无 override 时也可能出现——用 `theme.cfg` 控制，默认开：`theme.userBar: true`，加进 ThemeConfig，默认 `true`）
- 复制内容不受影响（`component.text` 不含 `▌`）

> 注：ThemeConfig 增加 `userBar: boolean`（默认 `true`），需回填 T2.6/T2.7 的接口与 normalize。

提交：`feat(gui): user message rail`

### T3.12 绿：思考块折叠头带耗时与 token

1. `tests/peek.test.ts` 扩展（文件已存在则追加）：
   ```ts
   buildPeekLabel({ phase: "thinking", tail: "x" }, 0, glyphs, 80, 1, { elapsedMs: 12_300, tokens: 1_240, showCounts: true })
   // → "✻ think ⠋ … 12.3s · 1.2k tok"（前缀仍含 glyphs.thinking 与 spinner）
   ```
   窄宽（`width: 20`）降级为 `✻ 12s`，不出现 tok 段。
2. `peek.ts`：`buildPeekLabel` 加第 6 个可选参数 `counts?: { elapsedMs: number; tokens: number; showCounts: boolean }`；`glyphs.thinking` 之外的部分可被裁剪，但 spinner 与耗时必须保留。复用现有 `clipTail` / `truncateToWidth` 逻辑。
3. 耗时来源：`index.ts` 在 `message_update` 首次收到 thinking 时记 `thinkingStartedAt`；token 数用现有 usage 计数。
4. `config.ts` 加 `thinkingPeek: { lines: ThinkingPeekLines; showCounts: boolean }`，默认 `{ lines: 1, showCounts: true }`（现有 `thinkingPeek` 若已是数字则迁移）。
5. `settings-command.ts` 常规页加 `thinkingPeekCounts` 开关。

提交：`feat(gui): thinking peek header with elapsed and token counts`

### T3.13 绿：设置项与实机检查

- 外观页加 `theme.preset`（五档循环）、`dividers`（三档循环）、`gutter`、`banding`
- `pi -e .` 实机：分割线、竖条、思考头、工具 gutter 均生效；`preset: "pi"` + 全关时与 v0.4.6 一致

提交：`feat(settings): theme controls`

---

## T4 — billion-context 只读联动

### T4.14 红：`tests/context-blocks.test.ts`

用 `temporaryDirectory` 造 `<sessionFile>.acp.json`：

```ts
test("parses blocks and sums compressed tokens", ...);      // 2 blocks → compressedTokens 求和、tiers 计数
test("schemaVersion mismatch yields undefined", ...);        // schemaVersion: 2 → undefined
test("malformed json keeps previous snapshot", ...);         // 先读好文件，再写坏 json，watch 回调不应清空
test("mtime cache avoids re-parse", ...);                    // 同 mtime 读两次，第二次返回同一引用
test("missing session file is not an error", ...);           // undefined 输入 → undefined，不抛
```

提交：`test(context): pin sidecar contract handling`

### T4.15 绿：`extensions/open-tui/context-blocks.ts`

```ts
export interface ContextBlocksSnapshot { producer: string; blocks: readonly BcpBlockLike[]; compressedTokens: number; blockCount: number; tiers: Record<1|2|3, number> }
export function readContextBlocks(sessionFile: string | undefined): ContextBlocksSnapshot | undefined;
export function watchContextBlocks(getSessionFile: () => string | undefined, onChange: (s?: ContextBlocksSnapshot) => void): () => void;
```

- **不 import `billion-context-pi`**（本地镜像 `BcpBlockLike` 只取用到的字段：`blockId/tier/topic/summary/compressedTokens/survivedCount/active/generation`）
- `schemaVersion !== 1` → `undefined` + 一次 `warn`（模块级 flag，只提示一次）
- `fs.watchFile(…, { interval: config.contextBlocks.pollMs })`，`mtimeMs` 为缓存键
- `pi.unregister` / `session_shutdown` 时 `fs.unwatchFile`

提交：`feat(context): read billion-context sidecar blocks`

### T4.16 绿：底栏段

- `icons.ts` 三套图标集加 `blocks`：nerd `\uF0C5`、unicode `⧉`、ascii `#`
- `footer.ts` 新增段 `contextBlocks`，渲染 `${glyphs.blocks} ${blockCount} · ${shortTokens(compressedTokens)}`（`shortTokens` 复用现有 `formatTokens` 的 k/M 缩写）
- `config.ts`：`contextBlocks: { enabled: true, footerSegment: true, pollMs: 1500 }` + `footerSegments.contextBlocks: true`
- 优先级 1（与 `cost` 同级）；无侧文件时整段不出现
- `tests/footer.test.ts` 加：有快照 → 段出现；无快照 → 段消失且不留多余分隔符（回归：不能出现 `│ │`）

提交：`feat(footer): context compression segment`

### T4.17 绿：浮层 + 快键 + 命令

`extensions/open-tui/context-blocks-overlay.ts`，复刻 `settings-command.ts:660` 的 `ctx.ui.custom((tui, theme, kb, done) => Component, { overlay: true })` 结构：

- 头部：`N blocks · X compressed · t1×a t2×b t3×c`
- 列表每项两行：`▸ b1  t1  <topic>` / `      <tokens> tok · <ratio>x · survived <n>`
- `↑/↓/j/k` 移动，`ctrl+d`/`enter` 展开 `summary`（`wrapTextWithAnsi` + 滚动视口），`r` 重读，`esc/q` 关闭
- 空态：`No compression blocks yet.`
- `index.ts`：`pi.registerShortcut("ctrl+shift+c", { description: "Context compression blocks", handler })`；同时 `pi.registerCommand("open-tui:context", …)` 作退路
- 只读：不派发任何命令、不写侧文件
- `tests/context-blocks-runtime.test.ts`：用假 `ctx.ui.custom` 捕获组件，喂 mock keys，断言渲染行数与展开切换

提交：`feat(context): compression blocks overlay and ctrl+shift+c`

---

## T5 — 收尾

### T5.18 文档与版本

- `README.md` / `README.zh-CN.md`：新增 `Cost currency` / `Themes` / `Context compression overlay` 三节；中文版补「DIY 分支说明」段（本 fork 的改动清单与默认值变更）
- `CHANGELOG.md`：`## [0.5.0] - 2026-11-15`，分 `Added / Changed / Fixed`，`Fixed` 写明「footer 与 telemetry 的货币符号重复（`$$` / `$/M`）」
- `package.json`：`version` → `0.5.0`
- 配置示例更新（文档里贴完整 `open-tui.json`）

提交：`docs: 0.5.0 notes and config reference`

### T5.19 验证

```bash
npm test
npm run typecheck
```

再跑实机三组：

1. `pi -e . `（默认配置）→ 新观感全部生效
2. `open-tui.json` 里 `theme: { preset: "pi", dividers: "none", gutter: false, banding: false }` → 与 v0.4.6 逐屏一致（回归）
3. `cost: { currency: "cny", usdToCny: 7.15 }` → 底栏 `¥0.0xx`，`ctrl+shift+m` 可切回 `$`

提交：`chore: release 0.5.0`

---

## 任务依赖图

```
T1.1 → T1.2 → T1.3 → T1.4
                 └→ T1.5 → T1.6
T2.1 → T2.2 → T2.3 → T2.4
T2.5 → T2.6 → T2.7 → T2.8 → T2.9 → T2.10
                                └→ T2.11 → T2.12 → T2.13
T2.12 ──────────────────────────────→ T3.11 → T3.12 → T3.13
T4.14 → T4.15 → T4.16 → T4.17
(T2.8, T2.13, T3.13, T4.17) → T5.18 → T5.19
```

可并行：`T1.*` 与 `T2a` 与 `T4.*` 互不依赖。`T2b` 必须先于 `T3`（Painter 存在才能上色）。

## 风险复查

- `ThemeConfig.userBar` 是 T2.6 写好后才在 T3.11 用到的字段 → T3.11 回头补接口与 normalize，不要提前加。
- `painter` 传参链是本计划最容易漏的地方：footer / tool-view / telemetry / peek 四条路径都要过一遍，`npm run typecheck` 会兜住类型，但运行时漏传会静默回落 token（可接受）。
- `README` 与 `CHANGELOG` 必须双语同步，AGENTS.md 要求用户可见行为变更都有文档。

---

## T2b 修复轮 1（复审行动项）

复审范围 `01087de..dd46bc9`（T1 修复 4 提交 + T2b-PART1 4 提交）。结论 **ACCEPT**，
`preset: "pi"` 与 `c6ab680` 等价性已逐 token 核对通过；`normalizeTheme` 全部回退路径正确。
以下是发布前必须处理的行动项。

### F1（SHOULD FIX，影响默认观感 —— 优先）工具状态色被预设吞掉

`extensions/open-tui/tool-view.ts:603-604`：

```ts
painter.paint("toolCall", icons.toolCall, color)
painter.paint(isShell ? "command" : "toolTitle", …, titleColor)
```

把状态 token（`success`/`error`/`warning`/`dim`）当成 `fallback` 传入，但
`resolveSlotColor` 对任何非 `pi` 预设都会解析出 `toolCall`/`command`/`toolTitle`，
于是 fallback 永远不生效。出厂默认 `preset: "tokyo-night"`（`config.ts:126`）下：

- 失败的工具图标显示 `#bb9af7`（紫），**不再是红色**
- bash 标题在 error/partial 时不再变暗

v0.4.6 对每个没配 `theme.preset` 的用户都是正常工作的，这是无声的功能倒退。
`tests/theme.test.ts:134` 甚至把这个行为钉死了。

**做法：按状态选槽位，而不是把状态当 fallback。**

```ts
// 状态槽位仍然是 Pi token 支撑的（"success"/"error"/"warning"/"dim" 不在 PRESET_SLOTS 里）
const iconSlot = ok === "success" ? "success" : ok === "error" ? "error" : "toolCall";
painter.paint(iconSlot, icons.toolCall, color);
```

标题同理：error → `"error"`、partial/警告 → `"warning"`、其余 → `"toolTitle"`。
改完后 `tests/theme.test.ts:134` 的断言要跟着改成"状态槽位优先"，
并新增一条测试：预设生效时失败工具图标仍走 `error` token。

### F2（发布前）文档 + CHANGELOG

- 两个 README 都没写新的 `theme` 配置块（`preset` / `slots` / `dividers` / `gutter` / `banding` 及默认值）
- 没有 `0.5.0` 的 CHANGELOG 条目
- 必须显式点出升级影响：**v0.4.6 用户什么都不改，底栏/分隔线/工具标题的配色也会变**
  （`preset` 默认 `tokyo-night`）；`preset: "pi"` 是回到 v0.4.6 外观的逃生舱

归入 T5 发布提交，不要单独散提交。

### F3（低成本硬化）`colorFn` 的未知 token 保证是有条件的

`extensions/open-tui/theme.ts:156-183`：

```ts
const known = (theme as { colors?: Record<string, unknown> }).colors;
if (known === undefined || Object.hasOwn(known, value))
```

真实 `initTheme()` 下没问题（已验证 `"not-a-color"` 会回退到 `thinkingText`）。
但若 `theme.colors` 为 `undefined`（stub 主题、或 Pi 将来改形状），未知名会直落
`theme.fg(value as ThemeColor)`，Pi 的 `tokenAnsi` 抛 `Unknown theme color: …`，
**异常发生在 `render()` 内部，整个状态栏会挂掉**。这是用户可控 `slots` 值唯一
能打到渲染器的路径。

**做法**：`known === undefined` 分支改为正向白名单校验（`SLOT_TOKEN` 的取值集合
∪ Pi token 名清单），或把闭包包一层 `try { theme.fg(…) } catch { return theme.fg(token, text) }`。

### F4（NIT，可顺手）其余

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 4 | `tool-view.ts:462` / `footer.ts:577` | 未配置皮肤时每次 render 重建 painter（两个 Map + 闭包） | 按 `theme` 标识 memoize |
| 5 | `index.ts:426` | `skinEpoch += 1` 在 `persistConfig` 里，改图标模式也触发全量重绘 | 仅 `config.theme` 变化时自增 |
| 6 | `currency.ts:42-44` | `currencySymbol` 丢了 `?? SYMBOLS.usd` 兜底 | 加回 |
| 7 | `currency.ts:51-58` vs `:27-32` | 同一窗口两套兜底（`1` vs `7.15`），若暴露会差 7 倍 | 统一走 `DEFAULT_COST.usdToCny` |
| 8 | `tests/config.test.ts:37-39` | `"false"` → `true` 断言恒过（默认就是 `true`） | 用 `switchable: false` 的配置才成为门 |
| 9 | `tests/theme.test.ts:48` | 自指断言（`undefined === undefined` 也过） | 改断言具体 hex |
| 10 | — | `index.ts` 的 `getSkin` 接线无测试，epoch 只被本地构造的 provider 验证 | 补一条接线测试 |

注：**#11（测试字面量用 `currencySymbol()` 构建）不采纳** —— 复审核实该约定在仓库里
并不存在（`tests/footer.test.ts:1016/1042`、`tests/telemetry.test.ts:137/208/252`、
`tests/settings-command.test.ts:529` 都硬编码 `$`/`¥`）。新测试遵循既有约定即可；
若要引入该约定需四个文件一起改，不在本阶段范围。

### 已核实为真的实现细节（无需改动）

- `nextRateStep` 全路径正确：`7.4→7.5`、梯顶 `7.5→6.8`（绕回，符合文档）、`99→6.8`、`0→6.8`
- `switchable` 行在 editor 分组（`:286`），handler `:404`；notify 在 guard 之外，快捷键必留痕迹
- `skinEpoch` 确实在缓存键里（`tool-view.ts:478` 比较 / `:481` 写入）且 `index.ts:426` 自增
- `footer.test.ts:1016-1017` 是真门（旧的裸 `includes` 会被 `"$ $0.010"` 蒙混过关）
- `theme.test.ts:58`（`SLOT_TOKEN` deepEqual）与 `:148-185`（epoch）是真门

---

## T2c 修复轮（复审行动项）

复审 `532503b..58ac9f1` 结论 **ACCEPT**。确认事项：
- 非 `pi` 预设下，失败**和**成功两种状态都正确渲染 `error`/`success` token
- `titleToken` 在状态分支传 `undefined`，所以 `SLOT_TOKEN.error` 能生效
- `expandHint: "plain"` 输出与 v0.4.6 逐字节一致
- 宽度中性成立：下划线只增加字节，截断在着色后进行，预算不溢出

### G1（必须修）键帽不是键帽

设计约定 `expandHint: "key"` = **键帽提亮 + 下划线**。实际只有提亮，渲染结果里
根本没有下划线 SGR 序列 —— 用户要的「略微突出显示」只兑现了一半。

根因：`theme.style()` 最终走 `chalk`，`chalk` 的 `underline` 在这条路径上被丢弃
（与 `theme.underline === chalk.underline` 在 color level 0 被剥 ANSI 是同一个坑）。

**做法**：下划线用原始 SGR 发出来（把键帽包进 `\x1b[4m…\x1b[24m`），
或给 chalk 显式 level；然后加一条测试，断言 `"key"` 模式下输出里**真的存在**
下划线序列。现有 `tests/hint.test.ts` 的 `\x1b[4m` 断言今天能过恰恰是因为
它没有真正校验（见 G2）。

### G2（同批修）下划线断言不是门

`tests/hint.test.ts` 里对该序列的断言必须断言**存在**，而不是只验证 color level。
修完 G1 后这条测试必须先红再绿。

### 其余 NIT（可延后到 T5）

- `expandHint` 目前只能在配置文件里改，没有设置行；`README` 文档归 T5
- `skinEpoch` 的深/浅比较已核实不会每次都自增（不要再动）
