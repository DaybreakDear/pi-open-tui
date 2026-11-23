# pi-open-tui

**English** | [简体中文](./README.zh-CN.md)

A polished terminal interface for the [Pi](https://pi.dev) coding agent.

![pi-open-tui preview](https://raw.githubusercontent.com/OldSuns/pi-open-tui/main/assets/preview_dashboard_1.png)

## Highlights

- **Pi header** with model, thinking level, working directory, and useful slash-command hints
- **Responsive footer** with Git state, detected runtime, context usage, tokens, cost, and extension status
- **Framed editor** with block, bar, and underline cursors, preserving compatible editors from other extensions
- **Project awareness** for 50+ runtimes and detailed Git state, including ahead/behind, staged, modified, untracked, stash, and detached HEAD
- **Turn telemetry** with generation speed, time to first token, duration, stalls, tokens, and cost rate
- **Thinking peek** with a live preview of hidden reasoning while the model works
- **Compact tool view** with edit/write previews and optional support for extension and MCP tools
- **Fullscreen Copy buttons** for code blocks, user messages, and input drafts
- **Interactive settings** in English and Simplified Chinese through `/open-tui`

## Requirements

- Pi 1.5.0 or later
- Node.js 22.19.0 or later (Pi's minimum)
- A terminal with UTF-8 and color support
- A [Nerd Font](https://www.nerdfonts.com/font-downloads) for the full icon set (optional; Unicode and ASCII modes are available)

## Install

Install the extension:

```bash
pi install npm:pi-open-tui
```

Or try it for one session:

```bash
pi -e npm:pi-open-tui
```

## Font and icons

For the full icon set, install a [Nerd Font](https://www.nerdfonts.com/font-downloads), select it in your terminal profile, and restart the terminal. Installing the font in the OS alone is not enough for apps such as VS Code or Windows Terminal.

In `/open-tui`, **Appearance → Icons** offers `auto`, `nerd`, `unicode`, and `ascii`. The default `auto` mode checks the terminal environment, not the installed font. If icons appear as boxes, choose `unicode`; if your terminal has a Nerd Font, you can force `nerd`, including over SSH.

See [icon detection and spacing](./docs/configuration.md#icons) for automatic selection rules and the Kitty spacing option.

## Themes

`themes/` ships four Pi themes that restyle the whole Pi UI, not just this extension:

| Theme | Appearance | Notes |
| --- | --- | --- |
| `tokyo-night` | dark | Cool blue-violet with distinct tool and thinking colours (recommended default) |
| `catppuccin-mocha` | dark | Soft and low-saturation, comfortable for long sessions |
| `gruvbox-dark` | dark | Warm retro palette with strong contrast |
| `rose-pine-moon` | dark | Rose-violet colours on a dark background |

Copy them into Pi's theme directory and switch with `/theme`:

```bash
mkdir -p ~/.pi/agent/themes && cp themes/*.json ~/.pi/agent/themes/ && /theme tokyo-night
```

Set `PI_CODING_AGENT_DIR` to use a different agent directory. Every theme fills all 56 Pi theme tokens, and `tests/themes.test.ts` checks each one against Pi's theme schema and requires at least 3:1 contrast for text, muted and dim text and for tool output.

### open-tui colours

A Pi theme restyles Pi. open-tui additionally paints its own surfaces through thirteen slots, so tool rows, command output, dividers, the user-message rail, and footer accents stay distinguishable from each other:

```json
{
  "theme": {
    "preset": "tokyo-night",
    "slots": {},
    "dividers": "line",
    "gutter": true,
    "banding": false,
    "userBar": true,
    "expandHint": "plain",
    "timestamps": "all"
  }
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `preset` | `"tokyo-night"` | `tokyo-night`, `catppuccin-mocha`, `gruvbox-dark`, `rose-pine-moon`, or `pi` for Pi's own tokens |
| `slots` | `{}` | Per-slot colour overrides; see the slot table below |
| `dividers` | `"line"` | `line` (`━`), `dashed` (`╍`), or `none`. Full-width rules follow terminal resizing before subsequent user messages and final assistant answers (after thinking, outside Markdown and copy payloads); the same colour is used for footer separators |
| `gutter` | `true` | A vertical rail beside command output. Only drawn when `toolView.mode` is `compact`; the settings row appends `(needs compact)` while it is on without it |
| `banding` | `false` | Alternate tool rows get a faint background |
| `userBar` | `true` | A coloured rail beside user messages |
| `expandHint` | `"plain"` | `key` underlines the `ctrl+o` keycap in expand hints |
| `timestamps` | `"all"` | A right-aligned date-bearing stamp: `all` on user and assistant messages, `assistant` on replies only, `chinese` on both with Chinese wording, `off` for none. Reply stamps use Pi's native blank row; user stamps skip the standalone divider and use the message's first blank row. Stamps add no rows and are skipped below 24 columns |

The clock comes from the message itself: Pi's restored messages carry an ISO `timestamp`, live replies carry `lastMessage.timestamp` in epoch milliseconds, and a component with neither gets one snapshot of the clock at its first render, so a resize or a theme switch cannot move the stamp.

The stamp carries as much date as the reader needs, chosen from the distance to today — `all`, `assistant`, and `chinese` all use this scale:

| Distance from today | Stamp |
| --- | --- |
| today | `14:32` |
| yesterday | `昨天 14:32` |
| same year | `11月15日 14:32` |
| an earlier year | `2025年11月15日 14:32` |

Month and day are never zero padded; the clock keeps its padding. "Today" and "yesterday" compare local **calendar days**, not elapsed milliseconds, so 23:59 and the next 00:01 are a day apart and a DST day is still exactly one day. A future timestamp reads as today instead of as a future date. `all` and `chinese` render identically today: `chinese` is the single value that unambiguously includes user messages with Chinese wording.

Assistant bubbles were removed in 0.7.0 because terminal mouse selection included their border glyphs. Existing `theme.bubble` preferences are discarded on load. Extension status indicators such as a sandbox extension's `ctx.ui.setStatus("sandbox", ...)` are shown in the footer by default; set `footerSegments.extensionStatuses: false` to hide them.

Overridable slots — an unknown name is dropped silently, so copy these exactly:

| Slot | Paints | Falls back to Pi token |
| --- | --- | --- |
| `thinking` | The footer's reasoning-effort badge | `thinkingText` |
| `toolCall` | The tool-call icon | `toolTitle` |
| `toolTitle` | A tool row's title | `toolTitle` |
| `toolOutput` | A tool row's output preview | `toolOutput` |
| `command` | A command title and its output | `toolTitle` |
| `divider` | Turn rules and footer separators | `dim` |
| `gutter` | The rail beside command output | `dim` |
| `userBar` | The rail beside user messages | `accent` |
| `cost` | The cost amount and its icon | `warning` |
| `stats` | Generic footer statistics | `accent` |
| `success` | Success status text | `success` |
| `error` | Error status text, and a failed tool row's title | `error` |
| `warning` | Warning status text | `warning` |

> **Upgrading from 0.4.x changes the default look, and `preset` alone does not undo it.** Three structural options also ship on: turn rules, the command gutter, the user-message rail, and the thinking-peek counts. To reproduce 0.4.6 exactly, including its colours:
>
> ```json
> {
>   "theme": { "preset": "pi", "dividers": "none", "gutter": false, "userBar": false },
>   "thinkingPeek": { "showCounts": false }
> }
> ```
>
> One difference has no switch: a **failed** tool row now paints its title with Pi's `error` token instead of `toolTitle`, so a red failed row is visible at a glance.

## Configuration

Run `/open-tui` to open the settings dialog. Its **General**, **Appearance**, **Footer**, and **Telemetry** tabs are available in English and Simplified Chinese and adapt to the terminal size. Use Tab/Shift+Tab or ←/→ to switch tabs, ↑/↓ to move, Enter/Space to change a value, and Esc/q to close.

Settings are stored in `open-tui.json` inside Pi's agent directory (default: `~/.pi/agent`; overridden by `PI_CODING_AGENT_DIR`). If saving fails, a warning explains that the change applies only to the current session.

| Setting | Where to find it | Default |
| --- | --- | --- |
| Header and settings language | General → Interface | Header on, English |
| Thinking peek | Appearance → Theme | 1 line |
| Copy buttons | General → Messages & tools | On, fullscreen only |
| Tool view | General → Messages & tools | Native |
| Footer in editor border | General → Footer | Off |
| Icons and cursor style | Appearance | Auto icons, block cursor |
| Theme preview | Appearance → Preview themes | ←/→ previews, Enter saves, Esc cancels |
| Footer fields and telemetry measurements | Footer / Telemetry | Individually configurable |

Selecting **Tool view: Compact** reveals **Compact extension tools** as a child setting. Switching back to Native hides it and retains its value. The [configuration reference](./docs/configuration.md#english) contains the complete JSON defaults, every option, and tool exclusions.

**Appearance → Preview themes** opens a preview page for the five built-in open-tui presets. ←/→ repaint the transcript with the next preset immediately, so the colours can be judged on real messages rather than on a swatch list; the rows show each preset's thinking, tool, user-rail and divider colours. Enter saves the preset you are looking at, and Esc — like closing the dialog — restores exactly the colours and switches that were in place when the page opened. Nothing is written until Enter.

## Header, footer, and editor

The header provides model and project context with command hints. The two main footer rows keep location, Git state, runtime, a working/done timer, context usage, model details, tokens, and cost visible as space allows. Fields can be toggled individually; the layout shortens or hides lower-priority information in narrow terminals.

Git status refreshes after tool execution, including commits on the current branch. Rapid tool activity is combined into periodic refreshes, with any pending refresh expedited when the agent run ends.

Footer token and cost totals include assistant responses, tool-reported usage, compaction and branch summaries, and cache warming. The cache-hit percentage describes the latest assistant response. Other extensions can use separate status rows or [contribute text directly to the main footer](./docs/footer-segments.md).

Enable **Footer in editor border** to move the two main rows into the editor's top and bottom borders. Extension status rows remain below the editor. Compatible editors keep their input behavior, completion, and ghost text; editors that cannot be framed retain a separate footer. See [editor compatibility and layout](./docs/implementation.md#editor-and-layout) for the integration boundaries.

## Turn telemetry

After each complete agent run, pi-open-tui shows one transient result, combining its assistant turns:

```text
> TPS 42.5 tok/s | ~ TTFT 1.2s | + 29.7s | ↑ 567 | ↓ 1.2k | ! stall 1x / 4.3s | $3.60/M
```

TPS measures provider-reported output tokens over generation time, including waiting and stalls but excluding tool execution between turns. The working timer also shows an estimated live speed such as `~54 tok/s` during streaming. The cost field is the effective rate per million tokens for the run; the footer shows cumulative session cost. Both use the currency set by `cost.currency` (`$` or `¥`) and print the symbol once — press `ctrl+shift+m` to toggle when `cost.switchable` is on. See [cost options](./docs/configuration.md#cost-options).

Toggle notification fields under **Telemetry → Measurements**, or live speed under **Footer → Runtime → Live TPS**. See [measurement definitions](./docs/implementation.md#usage-and-telemetry) for formulas, timing boundaries, and cache accounting.

### Third-party cost readouts

The subagent and delegate cost lines printed by `pi-subagents` and `billion-context-pi` are formatted by those packages, which hardcode the dollar sign and read no configuration at all, so a patch of the files Pi loads is the only way to make them follow `cost.currency`. Run `npm run patch:cost` (add `--check` to verify only, `--dry-run` to preview, `--revert` to restore from the `.pi-open-tui.bak` files, `--root <dir>` when the packages live outside Pi's agent directory). It rewrites the nine `$${…toFixed(4)}` sites and keeps their four decimals, so with `currency: "cny"` at 7.15 a readout of `$1.3660` becomes `¥9.7669`. The files it edits live inside those installed packages, outside this repository, so a fresh clone or CI does not carry them; skipping the step leaves those readouts in dollars while the footer and turn telemetry follow `cost.currency`. **Re-run it after upgrading either package**: the bundles are replaced wholesale, and an upgraded chunk would otherwise quietly print dollars again (`--check` exits 1 while that is the case).

### Known limitations

The numbers belong to the rule that opens the *next* user message, not to the turn they describe: `agent_settled` leaves them with the skin, which prepends a hidden marker to the following user message's markdown, and the ruling transformer hands that payload to the rule on the same message. The handoff is scoped to the `Markdown` instance that rendered the marker, because a single shared slot leaked one instance's label into another instance's rule. The numbers are formatted when the rule is drawn, so a theme switch recolours the label together with the rest of the transcript.

- A user message that itself contains a `---` line shows the label on both rules. Pi caches rendered blocks by the raw token, so the `---` we prepend and the author's own line share one decorated block; a transformer cannot separate them.
- A marker that cannot be read — a hand-edited transcript, or a marker written by another release — renders a bare divider with no numbers rather than numbers from another turn.
- A re-rendered message keeps its own label from the render that consumed it; a turn that has finished since replaces it, so a repeated identical prompt shows the latest result.

## Thinking peek

With Pi's **Hide thinking** enabled, pi-open-tui replaces the hidden block's `Thinking...` label with the latest reasoning tail while the model works:

```text
~ think ⠋ previous thought
          latest thought
```

Choose **Off**, **1 line**, or **2 lines** under **Appearance → Theme → Thinking peek**. The ticker appears only when the model streams reasoning, settles on a check mark when the answer begins, and returns to Pi's native label after the task settles. It follows Pi's Hide thinking toggle immediately and clips text to fit the available width.

With `thinkingPeek.showCounts` on, a settled reasoning block also gains `· 12.3s · 1.2k tok` beneath it. Counters are keyed by the block's own text, so a resize or a theme switch repaints an older block with the numbers it finished with instead of the current turn's, and a block with no recorded stats shows nothing rather than borrowing someone else's. The line only exists where Pi draws visible thinking: with **Hide thinking** on, Pi never runs the transformer, so the counters are dead there and the peek header is the only readout.

## Tool view

**Native** remains the default. Select **General → Messages & tools → Tool view → Compact** to display Pi's built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`, and the opt-in `codemode` and `tool_search`) as call and summary rows:

```text
● Read(extensions/open-tui/footer.ts:1-120)
  └  120 lines
● Edit(extensions/open-tui/footer.ts)
  └  +2 −1
● Bash(npm test)
  └  Done · 131 lines · 6.4s
● Codemode(const results = await Promise.allSettled([ … (+3 lines))
  ├  ✓ Read(src/config.ts) · 12ms
  ├  ✓ Find(*test.ts) · 18ms
  ├  ✓ Bash(npm test) · 2.6s
  └  Done · 3 calls · 2.7s
     42 tests passed
● Tool Search(browser screenshot)
  └  Loaded 3 tools · 24ms
     browser_snapshot · browser_click · browser_screenshot
```

- Successful `edit` and `write` calls show syntax-highlighted previews of up to 16 rows, with a hint to expand longer output.
- Running shell calls show recent output and elapsed time; errors retain their error summary.
- `codemode` shows up to three recent nested calls with status, arguments, and duration, followed by the script status, total call counts, elapsed time, and one output or error line. Image counts and output truncation remain visible; expand to see earlier calls and full output. Its call detail skips the optional script options header.
- `tool_search` shows the number of loaded tools and up to three tool names, with an expansion hint for more. Neither tool requires **Compact extension tools**.
- Click a row to expand its native card, or use `Ctrl+O` to expand all rows. Tools, arguments, results, and model-visible content are unchanged.
- Enable **Compact extension tools** to include extension and MCP tools. Use `toolView.exclude` in the config file for tools that should keep native rendering. Recognized `@ff-labs/pi-fff` tools receive search-specific summaries.
- Changing the mode affects newly created rows. Use `/reload` or a new session to apply it to the whole transcript.

See [tool rendering details](./docs/implementation.md#tool-rendering) for preview rules, extension summaries, and renderer compatibility.

## Copy buttons

In fullscreen mode (Pi's `tuiMode: "fullscreen"`), completed code blocks show a clickable `[Copy]` label in their rounded frame when there is enough width. User messages have a Copy label too. Clicking copies the source text and Pi flashes `Copied!`.

```text
╭─ sh ─────────────── [Copy] ╮
│ pi install npm:pi-open-tui │
╰────────────────────────────╯
```

Code labels copy code without fences, preserving indentation and tabs. User-message labels copy the original message. Streaming code blocks gain their label when streaming finishes; regular mode and thinking blocks keep Pi's plain fences. Use Pi's `/copy` to copy a whole assistant reply.

A nonempty draft in a compatible input editor also gets a `[Copy]` button in a free border gap, preferring the bottom border and falling back to the top. It copies the complete draft, including expanded folded pastes, without moving the cursor or changing focus. Footer, working-status, and scroll information stay intact; the button is hidden if neither border has enough space.

Toggle **General → Messages & tools → Copy buttons** to enable or disable this feature. [Copy-button details](./docs/implementation.md#copy-button-behavior) cover width limits, cached blocks, and interaction with other renderers.

## Context blocks

When `billion-context-pi` is installed, open-tui reads its sidecar and shows how heavily the conversation has been compressed — the block count and, once at least one block exists, the compression ratio:

```
≡ 3 bl · 2.1×
```

Press `ctrl+shift+c` (or run `open-tui:context`) for a detail overlay listing every block. Click a block or press `enter` to expand it, `j`/`k` to move, `r` to reload the sidecar, and `q` or `esc` to close. The linkage is strictly read-only: open-tui never writes the sidecar, never dispatches a Pi command from the overlay, and does not import `billion-context-pi`. Without the sidecar there is simply no segment.

```json
{ "contextBlocks": { "enabled": true, "footerSegment": true, "pollMs": 1500 } }
```

`footerSegment: false` keeps the overlay reachable while hiding the footer segment. A sidecar whose `schemaVersion` is not `1` is ignored with one warning per process, and a malformed file keeps the last good snapshot instead of clearing it.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `ctrl+shift+m` | Toggle the cost currency, when `cost.switchable` is on |
| `ctrl+shift+c` | Open the context compression blocks overlay |
| `ctrl+o` | Expand a collapsed tool output or thinking block (Pi's own binding) |

## Documentation

- [Configuration reference](./docs/configuration.md#english) — complete defaults, options, and icon selection
- [Implementation and compatibility](./docs/implementation.md#english) — measurement formulas, layout, rendering, and lifecycle
- [Extension footer segments](./docs/footer-segments.md) — public events and an integration example for extension authors
- [Changelog](./CHANGELOG.md) — released and upcoming changes

## Local development

```bash
npm install
npm test
npm run typecheck
pi -e .
```

CI checks Pi 1.5.0 and the latest release on Node.js 22.19.0 and 24 across Linux, Windows, and macOS. Keep all Pi packages on the same version. Use `pi -e .` to check terminal fonts, mouse interaction, and cursor support interactively.

## Acknowledgements

This project builds on several Pi community packages:

- **[pi-haiku](https://github.com/nnocte/pi-haiku)** — two-line footer structure and working timer
- **[pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)** — Pi logo artwork and rounded editor border technique
- **[pi-zentui](https://github.com/lmilojevicc/pi-zentui)** — Starship-style footer segments, runtime detection, session lifecycle, and settings UI pattern
- **[pi-tps](https://github.com/monotykamary/pi-tps)** — turn timing, stall detection, and conservative TPS measurement
- **[pi-polish](https://github.com/Pringled/pi-extensions/blob/main/packages/pi-polish)** — compact tool-call rows and syntax-highlighted edit diffs

The logo artwork is derived from Pi's official install script (`pi.dev/install.sh`). Runtime detection and Git porcelain parsing borrow structure from `pi-zentui`.

Special thanks to the **[LINUX DO](https://linux.do)** community for its support.

## License

[MIT](./LICENSE)
