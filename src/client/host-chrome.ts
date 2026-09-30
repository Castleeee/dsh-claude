/** Host chrome this plugin restyles from the browser side.
 *
 *  Every rule here reaches across into markup this package does not own, so
 *  every one is written to fail open: a Host rename makes the selector miss and
 *  the stock chrome comes back, rather than leaving the header broken.
 *
 *  Chrome this plugin wants to *change* rather than remove goes through slot
 *  shadowing where the slot's occupant is replaceable — see
 *  `ClaudeAgentPresetLabel`.
 */
import { claudeMarkUrl } from './claude-mark.ts'
import { CLAUDE_SEAT_ATTRIBUTE, trackClaudePresetSeats } from './preset-seat-mark.ts'
import { CLAUDE_SESSION_ATTRIBUTE } from './session-mark.ts'
import { permissionSelectClass as PERMISSION_SELECT_CLASS } from './styles.ts'

/** The `Session log` capsule is contributed by
 *  `@deepseek-ai/dsh-session-log-export` into
 *  `conversation.session.header.utilities`. Shadowing that slot entry would
 *  also take its download-progress dialog down with it, so the capsule is
 *  hidden with CSS instead (Host 0.1.5 turned the capsule into an ellipsis
 *  more-actions menu whose only item is the download): the controller, its dialog, and the
 *  `/export` slash command all keep working.
 *
 *  The selector matches the CSS Module local name rather than the emitted
 *  class, because only the build-hash prefix changes across Host releases. */
const SESSION_LOG_CSS = 'button[class*="sessionLogButton"],button[class*="moreButton"][aria-haspopup="menu"]{display:none}'

/** A Claude Session has exactly one view, so its header tab strip is a row of
 *  chrome with nothing to choose between. Hiding it shortens the header, and
 *  the Host's divider — an absolutely positioned `header:after` pinned to
 *  `bottom:1px` — rides up with it on its own; only the slack the tab row used
 *  to provide has to be restored as padding.
 *
 *  Scoped through `:has()` to headers carrying this plugin's diff action, so
 *  Sessions driven by other agent presets keep their tabs. The action only
 *  mounts once the projection reports the Session as plugin-owned, so a
 *  freshly opened Session can show the strip for a frame before it collapses.
 *  Host 0.1.7 nests the strip inside the header's Slot outlet, so it is
 *  matched as a descendant rather than a direct child. */
const HEADER_TABS_CSS = [
  'header:has(.dsh-claude-header-diff) [role="tablist"]{display:none}',
  'header:has(.dsh-claude-header-diff){padding-bottom:10px}',
].join('')

/** The agent-preset seat draws `IconAgentPresetOutlineRegular` at its default 16px.
 *  Swapping it needs one fact CSS cannot read — whether the seat currently
 *  names the Claude preset — which `preset-seat-mark` supplies as an
 *  attribute. Without that flag set, nothing here matches and the Host's own
 *  glyph renders. */
const PRESET_SEAT_CSS = [
  `button[${CLAUDE_SEAT_ATTRIBUTE}]>[class*="seatIcon"]{display:none}`,
  `button[${CLAUDE_SEAT_ATTRIBUTE}]::before{content:"";flex:none;width:16px;height:16px;`,
    `background:${claudeMarkUrl()} center/contain no-repeat}`,
].join('')

/** The composer's trailing row: the flex row that carries the model seat, the
 *  meter and the submit buttons. The `:has()` guard keeps the rules below off
 *  any other block in the shell that happens to use the same local name. */
const COMPOSER_TRAILING = '[class*="_trailing"]:has(>[class$="_primary"])'

/** The composer's dock row: the strip below the card that carries
 *  `conversation.composer.dock` and, from Host 0.2.0 on, the Host's meter.
 *
 *  That row is why this constant exists. Through 2.0.9 the Host's meter sat in
 *  the trailing row, a sibling of the model seat, and `COMPOSER_TRAILING` was
 *  enough to reach it. 0.2.0 renders it one row down instead:
 *
 *    <div class="..._dock">
 *      {renderSlot('conversation.composer.dock')}
 *      {activity ? null : <ContextMeter/>}
 *    </div>
 *
 *  The plugin's own meter still registers on `conversation.input.right`, which
 *  is inside the card, so without this the two meters coexist and only the
 *  Host's is where the eye expects it. The `:has()` guard names the meter's own
 *  class suffix, so a `_dock` block that carries something else is left alone. */
const COMPOSER_DOCK = '[class*="_dock"]:has(>[class*="_root"])'

/** The Host's meter, in three selectors — any one is enough to remove it.
 *
 *  The Host renders that meter from the composer itself rather than through
 *  `conversation.input.right`, so there is no slot entry to shadow and no
 *  stable class to match: only the build-hash prefix of its CSS Module moves
 *  between Host releases (`JdJrwG_root` in Host 2.0.9, `y0jqnG_root` in the
 *  official 0.2.0). The last selector names the shape instead — a 14px ring
 *  inside its own dialog trigger, which is the one thing a Composer button
 *  would have to reproduce to be caught by mistake. The hash prefixes are the
 *  part that rots; the shape is what survives a rebuild, and it is verified
 *  against 0.2.0's markup (`<span class="y0jqnG_root">` wrapping a
 *  `button[aria-haspopup="dialog"]` holding a 14px `circle[cx="7"]`). Should a
 *  future Host change both the shape and the row, this misses and the Host's
 *  own meter comes back, rather than the row losing a control. */
const HOST_METER_SELECTORS = [
  '[class*="JdJrwG_root"]',
  '[class*="y0jqnG_root"]',
  'span:not([data-dsh-claude-context-meter]):has(button[aria-haspopup="dialog"]>svg[width="14"][height="14"]>circle[cx="7"])',
]

/** Everything below stands the Host's own context chrome down for this preset,
 *  and it is all gated on one attribute: `session-mark.ts` sets it for exactly
 *  as long as a Claude Session is on screen, so every other preset keeps the
 *  Host's meter and statistics untouched. */
const CLAUDE_SESSION = `body[${CLAUDE_SESSION_ATTRIBUTE}]`

/** The Host's composer context meter is built from the request DSH assembled:
 *  its ring and headline are right, but the composition it lists is DSH's own
 *  system prompt, DSH's tool mirrors and the messages DSH can see — which for a
 *  Claude Session is none of the context Claude Code actually holds.
 *
 *  `ClaudeContextMeter` draws the same ring from the CLI's own report, from the
 *  same seat — `conversation.composer.dock` — and needs no DOM move: the dock
 *  row is a centred flex row and the entry's `order` seats the ring after the
 *  session statistics, which is where the Host's own meter sits. The Host's ring
 *  goes; this one is already there.
 *
 *  Both rows are swept, because the Host moved the meter between them: the
 *  trailing row through 2.0.9, the dock row from 0.2.0 (where it is a sibling of
 *  the `conversation.composer.dock` render rather than of the model seat). Only
 *  the stand-down is row-dependent — nothing here reorders a row, so a Host that
 *  moves the meter again takes the ring back rather than losing a control. */
const CONTEXT_METER_CSS = [
  ...[COMPOSER_TRAILING, COMPOSER_DOCK].flatMap(row =>
    HOST_METER_SELECTORS.map(selector => `${CLAUDE_SESSION} ${row}>${selector}{display:none}`)),
].join('')

/** The Host's own statistics row — the turn/step and token pills above the
 *  composer. Both of its figures are built from what DSH assembled and what it
 *  can see of the request, which for this preset is a pointer to a conversation
 *  that lives in Claude Code; its own report is what the plugin draws instead,
 *  in the same dock (`ClaudeStatsPills`).
 *
 *  A stable data attribute, unlike the meter: the row marks itself
 *  `data-composer-stats` in the Host's own markup, so this needs no build-hash
 *  guess and no shape match. */
const COMPOSER_STATS_CSS = `${CLAUDE_SESSION} [data-composer-stats]{display:none}`

/** The Host's access selector (PermissionSelect, in the composer's `modes`
 *  group) offers DSH's three sandbox modes; a Claude session runs Claude
 *  Code's own modes from this plugin's selector instead, which sits in the
 *  same tool row (`conversation.input.left`). It is hidden rather than
 *  shadowed, and only in a row where the plugin's own selector has mounted --
 *  which it does for Claude sessions alone. Host 0.1.7 renders it through the
 *  `conversation.input.permission` Slot, whose outlet carries an inline
 *  `display:contents`, so the rule needs `!important`; the `triggerLabel`
 *  local-name match stays for a Host without that outlet. */
const PERMISSION_SELECT_CSS = [
  `[class*="_tools"]:has(.${PERMISSION_SELECT_CLASS}) [data-slot="conversation.input.permission"]{display:none!important}`,
  `[class*="_tools"]:has(.${PERMISSION_SELECT_CLASS}) [class*="_modes"]>*:has(span[class*="_triggerLabel"]){display:none!important}`,
].join('')

/** The Host's experimental Agent Team roster (`[data-team-action]`, in the
 *  header action row) only ever shows the Lead for a Claude session: its
 *  teammates live inside Claude Code, not in Host child Sessions. The plugin's
 *  roster takes the same seat, so the Host's is hidden wherever ours mounted,
 *  which is Claude sessions alone; other presets keep the native one. */
const AGENT_TEAM_CSS = 'header:has(.dsh-claude-team-root) [data-team-action]{display:none}'

export const HOST_CHROME_CSS = `${SESSION_LOG_CSS}${HEADER_TABS_CSS}${PRESET_SEAT_CSS}${CONTEXT_METER_CSS}${COMPOSER_STATS_CSS}${PERMISSION_SELECT_CSS}${AGENT_TEAM_CSS}`

/** Install the stylesheet and the one DOM flag it depends on.
 *  @returns a disposer that removes both again. */
export function restyleHostChrome(presetDescription?: () => string): () => void {
  if (typeof document === 'undefined') return () => {}
  const element = document.createElement('style')
  element.dataset.dshClaudeHostChrome = ''
  element.textContent = HOST_CHROME_CSS
  document.head.appendChild(element)
  const untrack = trackClaudePresetSeats(presetDescription)
  return () => {
    untrack()
    element.remove()
  }
}
