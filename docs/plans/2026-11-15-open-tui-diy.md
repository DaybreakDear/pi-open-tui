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

---

## T3 修复轮（复审行动项）

复审范围 = `5f58e8f` / `9831a54` / `6b39464`（T3 三个提交）。**注意：T3 worker 在汇报里给出的
`49c4521` / `949914e` / `0a97cb3` 三个 SHA 在仓库中不存在**（`git cat-file -t` 报
`fatal: Not a valid object name`），实际提交以上面三个为准。同时核实：**所谓"`markdown-skin.ts`
四处 add/add 冲突"从未发生**——`git log --all --merges -- extensions/open-tui/markdown-skin.ts`
为空，该文件全长只有 `1cc9534`（创建）与 `5f58e8f`（加竖条）两个提交。

结论 **CHANGES REQUIRED**。以下五项进入修复轮。

### G3（应当修）两行模式下耗时/token 重复两次 —— `peek.ts:181` `:189` `:197`

`statsSuffix` 被 `lineWithMarker()` 追加到第 1 行（`:181`），又被 `:189` 和 `:197` 追加到第 2 行。
实测：

```
buildPeekLabel({phase:"thinking", tail:"prev\nlatest"}, 0, glyphs, 80, 2, counts)
"~ think ⠋ prev 12.3s · 1.2k tok\n          latest 12.3s · 1.2k tok"
```

27/30/40/60 各宽度均复现。即开启 `thinkingPeek.lines: 2` 的用户会看到同一组数字两遍——
正是本功能要消除的"信息墙"。
**做法**：只在 marker 行追加 `statsSuffix`，第 2..n 行保持 `${thoughtIndent}${tail}`；
`:173` 的宽度预留可顺带放宽。

### G4（应当修）token 段是全会话累计，计时器却是单条消息 —— `index.ts:99`

`elapsedMs` 每条 assistant 消息重置（`resetPeek()` 于 `message_start`，`index.ts:315-319` 清
`thinkingStartedAt`），但 `tokens: getUsageTotals(target).output` 是**整个会话**的 output 累计
（`state.ts:30-60`）。于是第二轮开头是 `0.4s · 4.2k tok`，两侧自相矛盾。
**做法**：在 `index.ts:332` 记录 `thinkingTokensBase`，传
`tokens: getUsageTotals(target).output - thinkingTokensBase`。

### G5（应当修）窄宽度降级会先杀掉 spinner，且被测试钉死 —— `peek.ts:170-172`

降级触发条件是 `markerWidth + statsWidth > w`，即 `w < ~26`。此时头部退化为
`fit("✻ 12s")`：spinner 没了、"think" 没了、两行思考正文也没了。实测 `w=25` → `"~ 12s"`，
`w=26` → `"~ think ⠋ 12.3s · 1.2k tok"` 但 `contentWidth = max(0, -1)`，思考列数为 0。
26 列下头部停止动画，比 T3 之前的版本更差（旧版至少保留 spinner 列）。
**做法**：两阶段降级 ——（a）先丢 token 段，保留 `✻ think ⠋ 12.3s`；（b）仍放不下才丢 ` think`
字面量至 `✻ ⠋ 12s`。**永远不要先丢 spinner 再丢文字**。

### G6（应当修）竖条宽度是魔法数 2 —— `markdown-skin.ts:19`

`USER_BAR_COLUMNS = 2` 硬编码 `visibleWidth("▌ ")`。`U+258C` 是东亚**Ambiguous**宽度字符：
`pi-tui` 的 `visibleWidth("▌") === 1`，但配置为 ambiguous-wide 的 CJK 终端会画成 2 格，
于是每条用户消息超出右边 1 列。
**做法**：`const USER_BAR_COLUMNS = visibleWidth("▌ ");`

### G7（应当修）`theme.userBar` 没有设置行 —— `config.ts:138`

T3.11 新增了这个用户可见配置键，而同一阶段 T3.13 的宗旨恰恰是"主题控制项能在设置窗口里改"。
现在 `userBar` 只能手改 `open-tui.json`；`settings-command.ts:329-332` 列了
preset/dividers/gutter/banding 就停了。
**做法**：仿 `themeGutter` 加 `{ id: "themeUserBar", ... }` 与 `!config.theme.userBar` 分支。

### G8（NIT，顺手）

| 位置 | 问题 | 处理 |
|---|---|---|
| `peek.ts:173` | `contentWidth` 可为 0 但统计仍显示，静默抹掉全部思考正文 | 用 `MIN_THOUGHT_COLS` 门槛走降级 |
| `index.ts:95-101` | `counts.elapsedMs` 是装 closure 时的快照，重绘/缩放复用冻结值 | 在 closure 内算 `Date.now() - thinkingStartedAt` |
| `markdown-skin.ts:114` | 注释声称竖条"在 OSC-133 zone marker 之外"，Pi 当前输出无法验证该断言 | 删注释或按 `\x1b]133;…` 前缀插入 |
| `markdown-skin.ts:73` | 竖条安装被 `Markdown.prototype.renderToken` 存在性把守，该 hook 缺失时竖条一起静默不装 | 接受（符合该文件的降级哲学），但需解耦 |
| `config.ts:293-300` | `showCounts` / `userBar` 的非布尔回退无测试 | 补两条 |
| `peek.ts:35-38` `:41-43` | 负值/NaN 钳制正确（实测 `-5000/-3` → `"0.0s · 0 tok"`）但无测试 | 补 |

### G9（测试补强：以下三条不是真门）

- `tests/peek.test.ts`「两行模式第二行保留计数」：**在重复 bug 存在时仍然通过**。它只断言
  `rows[1]?.endsWith("…tok")` 与 `rows[0]?.includes("previous thought")`，从不检查第 0 行**不含**计数。
  改成 `assert.equal((label.match(/tok/g) ?? []).length, 1)`。
- `tests/peek.test.ts`「窄终端降级」：`assert.equal(label, "~ 12s")` **把 spinner 丢失固化成了预期**，
  会阻止 G5 修复，必须随 G5 一起改字面量。
- `tests/peek.test.ts`「各宽度不超预算」：只验 `visibleWidth(row) <= width`，画一个 `…` 也能过。宽度安全但内容盲目。

真门（已核实会在功能损坏时变红）：`userBar: false` 逐字节测试、竖条占用宽度测试
（`assert.equal(visibleWidth(line), 40)` 及 21/12/5 宽度下的 `<= width`）、copy payload 测试、
`showCounts: false` 字面量测试、以及三个设置项改配置的测试。

### 已核实为真 / 无需改动

- `thinkingPeek` 在 `51a9d45` **本来就是对象**（`{ lines: ThinkingPeekLines }`，默认 `{ lines: 1 }`），
  worker 说的"无需迁移"属实；`showCounts` 有默认值与回退。
- 四个 T3.13 设置行都真的改配置（`themePreset:329/:456`、`dividers:330/:457`、
  `themeGutter:331/:458`、`themeBanding:332/:459`），且 `gutter`/`banding` 切的是布尔而非字符串，
  测试断言的是返回的配置值，是真门。
- 回归门干净：`git diff 51a9d45..HEAD -- tests/footer.test.ts tests/tool-view.test.ts` 为空。
- 竖条不会超预算也不会错算 CJK：预算在内部渲染**之前**就减掉（`markdown-skin.ts:106`），
  内部行再校验（`:111`），44 列预算 + 2 列竖条 = 40/40；宽度用 `visibleWidth` 而非 `.length`。
  唯一残留风险即 G6。

---

## T4 修复轮（复审行动项）

复审范围：`dc3cc55` 之后的 4 个提交（`e643afa` / `95e5bc5` / `e4dd81b` / `a6ecc93`）。
结论 **CHANGES REQUIRED**，无 BLOCKER。

**已核实的正面结论（不要动这些）**
- 只读不变式成立：两个新文件里 `writeFile|appendFile|writeSync|createWriteStream|runCommand|sendMessage|dispatchCommand|billion-context-pi` 仅命中一处注释；无 `exec`/`spawn`；块形状本地镜像 `BcpBlockLike`，未 import `billion-context-pi`
- watcher 回收正确：`tests/context-blocks-runtime.test.ts:302` 同时 spy `fs.watchFile`/`fs.unwatchFile` **并**用 `process.getActiveResourcesInfo()` 断言 `StatWatcher` 数量回落到基线
- `ctrl+shift+c` **可以触发**：`pi-tui` 的 `keys.js:996-999` 有 `MODIFIERS.shift + MODIFIERS.ctrl` 分支，走 `matchesKittySequence` / `matchesPrintableModifyOtherKeys`。实测 `matchesKey("\x1b[99;6u","ctrl+shift+c") === true`。但**传统终端把该组合发成 `^C`**（`matchesKey("\x03","ctrl+shift+c") === false`），只会被 Pi 当 interrupt。因此 `/open-tui:context` 命令不是摆设，README 必须注明该快捷键需要 Kitty 协议终端（kitty/Ghostty/foot/WezTerm）
- `tests/context-blocks.test.ts:73`（畸形 JSON 保留上一次快照）是**真门**：它驱动真实 watch 回调 + `utimesSync` 改 mtime + 断言引用同一性
- 既有断言未被削弱：`tests/footer.test.ts` 纯新增（+38/-0），`tests/tool-view.test.ts` 零改动

### H1（SHOULD FIX）浮层分隔线溢出并折行

`extensions/open-tui/context-blocks-overlay.ts:108`
`innerWidth = Math.max(20, width - 2)` 只减了 `Box(1, 1, …)` 的左右内边距，
但子元素全是 `new Text(str, 1, 0)`（`:118`、`:143` 及所有 `blockLines` 行），
每个孩子又带 2 列 paddingX。于是 `innerWidth` 宽的分隔线在 `width - 2` 的孩子区里
渲染成 `innerWidth + 2`，折行。实测渲染输出在第 4 行和第 12 行各多出一条 `"  ──   "`。

同时 `CHROME_ROWS = 7`（`:20`）低估了真实 chrome（折行后是 9 行），`budget`（`:120`）
多分配 2 行，矮终端上浮层会顶出底部。

**做法**：`Math.max(20, width - 4)`，或把孩子改成 `new Text(line, 0, 0)` 后保持 `width - 2`；
然后重算 `CHROME_ROWS`。补测试断言 `render(80)` 每行可见宽度 ≤ 80 且行数 ≤ 行预算。

### H2（SHOULD FIX）鼠标点击选中错误的块

`extensions/open-tui/context-blocks-overlay.ts:201` `const block = this.rowBlocks[event.y - 1];`
假设块行从组件顶部下一行开始，但块行实际在三个 chrome 子元素（`:110` 标题、`:117` 表头、
`:118` 分隔线）之下，还要算上 H1 的折行。`rowBlocks` 是**只含块行**的稠密索引（`:130-136`），
整体错位 3+ 行。实测：点 b1 展开 b3，点 b3 也展开 b1，点 b2 无反应。

**做法**：构建 `rowBlocks` 时对齐绝对渲染行（标题/表头/分隔线位置填 `-1` 占位），
取 `this.rowBlocks[event.y]`，只减真实的 Box padding（`contentY = event.y - paddingY`）。
补测试：点第 i 块的表头行 → 断言展开第 i 块。

### H3（SHOULD FIX）缺少设计要求的主动重读

`docs/plans/2026-11-15-open-tui-diy-design.md` §3.4 要求
「`fs.watchFile(…, { interval: 1500 })` + 在 `agent_settled` / `session_compact` 事件后主动读一次」。
但 `index.ts:422`（`agent_settled`）与 `:471`（`session_compact`）都没碰 `contextBlocks`，
唯一的数据源是 watch 回调（`:154-157`）。

后果：压缩轮次结束后底栏最多滞后 1500ms；更严重的是若 `startContextBlocksWatch` 在
`index.ts:151` 的 `if (!sessionFile()) return;` 提前返回（内存会话 / `getSessionFile()` 抛错），
**没有任何地方重新挂载**，该会话的段位永久失效。

**做法**：两个 handler 里
`if (config.contextBlocks.enabled) { if (!stopContextBlocks) startContextBlocksWatch(ctx); else { contextBlocks = readContextBlocks(currentSessionFile(ctx)); requestFooterRender?.(); } }`

### H4（SHOULD FIX）`contextBlocks.enabled: false` 时浮层仍可打开

`config.ts:55` 把 `enabled` 文档为「读取侧文件并在底栏和浮层中显示」，`index.ts:213` 对底栏做了判断，
但 `openContextBlocksOverlay`（`index.ts:163`）没检查，命令（`:560`）与快捷键（`:568`）仍会读侧文件并渲染。

**做法**：`openContextBlocksOverlay` 里 `!config.contextBlocks.enabled` 时提前返回。
注意保留 `footerSegment: false` 但浮层仍可用的既有语义（`config.ts:57` 有文档）。

### H5（NIT，顺手）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 5 | `context-blocks.ts:156` | 监听路径只在启动时求值一次 | H3 的重新挂载已覆盖；否则在回调里比对 `getSessionFile()` |
| 6 | `context-blocks.ts:161` | `Math.max(1, pollMs)` 放行 `NaN`/`Infinity` | `Number.isFinite` 校验后退回 `DEFAULT_POLL_MS` |
| 7 | `context-blocks.ts:83` | `process.emitWarning` 绕过仓库的 `notify` 通道，全屏 TUI 下会丢 | 改走 `notify`；模块级一次性开关本身是对的 |
| 8 | `context-blocks-overlay.ts:33-37` | `summaryRatio = compressedTokens / (summary.length / 4)`，2 字符摘要会打印 `2500.0x` | 截断 `Math.min(ratio, 999)` 或改为由 `survivedCount` 推导，或先去掉该列 |
| 9 | `context-blocks.ts` + `tests/context-blocks.test.ts` | 这两个文件是 LF，本次改动其余文件是 CRLF，无 `.gitattributes` | 统一为 CRLF，避免将来整文件 diff |
| 10 | `context-blocks-overlay.ts:112-115` | 空状态提示漏了 `r reload`，而它恰是最需要重读的状态 | 补上 |
| 11 | `tests/footer.test.ts:1291-1296` | 「两处分隔符」测试**区分不了 `null` 与 `""`**（消费者已 `filter(Boolean)`） | 改为断言 hook 契约：`getContextBlocks` 返回空串时的 `render(160)` 行数，或断言 `footerSegments.contextBlocks: false` 时根本不查询 |

### H6（测试补强，与 H1/H2 同批）

- `tests/context-blocks.test.ts:54`（`schemaVersion` 只警告一次）是**自证**：`readContextBlocks`
  按 mtime 缓存了 `undefined`，第二次读在缓存里就返回了，删掉 `schemaWarningEmitted` 标志也能过。
  改为改写侧文件并 bump mtime，或用两个不同路径
- `tests/footer.test.ts:1300` 硬编码分隔符数量为 3，将来插入任何段位都会以错误理由失败
- `tests/context-blocks-runtime.test.ts:278` 依赖 `await setTimeout(600)` 时序，负载高时会抖；改用 `waitFor` 轮询
- `tests/context-blocks-runtime.test.ts:250` 只断言快捷键字符串被注册，从未把字节喂给 `matchesKey`；
  补一条 `matchesKey("\x1b[99;6u", "ctrl+shift+c") === true` 的契约测试
