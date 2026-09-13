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
 *  freshly opened Session can show the strip for a frame before it collapses. */
const HEADER_TABS_CSS = [
  'header:has(.dsh-claude-header-diff)>[role="tablist"]{display:none}',
  'header:has(.dsh-claude-header-diff){padding-bottom:10px}',
].join('')

/** The agent-preset seat draws `IconAgentPresetOutline16` at its default 16px.
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

/** The Host's meter, in two selectors — either is enough to remove it.
 *
 *  The Host renders that meter from the composer itself rather than through
 *  `conversation.input.right`, so there is no slot entry to shadow and no
 *  stable class to match: only the build-hash prefix of its CSS Module moves
 *  between Host releases (`JdJrwG_root` in Host 2.0.9). The second selector
 *  names the shape instead — a 14px ring inside its own dialog trigger, which
 *  is the one thing a Composer button would have to reproduce to be caught by
 *  mistake. Should a future Host change both, this misses and the Host's own
 *  meter comes back, rather than the row losing a control. */
const HOST_METER_SELECTORS = [
  '[class*="JdJrwG_root"]',
  'span:not([data-dsh-claude-context-meter]):has(button[aria-haspopup="dialog"]>svg[width="14"][height="14"]>circle[cx="7"])',
]

/** The Host's composer context meter is built from the request DSH assembled:
 *  its ring and headline are right, but the composition it lists is DSH's own
 *  system prompt, DSH's tool mirrors and the messages DSH can see — which for a
 *  Claude Session is none of the context Claude Code actually holds. It reads
 *  a couple of percent where the CLI reports the real figure.
 *
 *  `ClaudeContextMeter` draws the same ring from the CLI's own report and marks
 *  the body for exactly as long as a Claude Session is on screen; without that
 *  mark nothing here matches and the Host's meter stands for every other
 *  preset. Within that mark: the Host's ring goes, and this one takes the seat
 *  it had — after the model seat, immediately before the submit buttons.
 *
 *  That seat needs no DOM move. The slot anchor wrapping this plugin's meter is
 *  `display:contents`, so the ring is already a flex item of the row and `order`
 *  places it where the Host's meter sat; the Host's own meter is a direct child
 *  of the same row. */
const CONTEXT_METER_CSS = [
  ...HOST_METER_SELECTORS.map(selector => `body[data-dsh-claude-context-meter] ${COMPOSER_TRAILING}>${selector}{display:none}`),
  `body[data-dsh-claude-context-meter] ${COMPOSER_TRAILING} [data-dsh-claude-context-meter]{order:1}`,
  `body[data-dsh-claude-context-meter] ${COMPOSER_TRAILING}>[class$="_primary"]{order:2}`,
].join('')

export const HOST_CHROME_CSS = `${SESSION_LOG_CSS}${HEADER_TABS_CSS}${PRESET_SEAT_CSS}${CONTEXT_METER_CSS}`

/** Install the stylesheet and the one DOM flag it depends on.
 *  @returns a disposer that removes both again. */
export function restyleHostChrome(): () => void {
  if (typeof document === 'undefined') return () => {}
  const element = document.createElement('style')
  element.dataset.dshClaudeHostChrome = ''
  element.textContent = HOST_CHROME_CSS
  document.head.appendChild(element)
  const untrack = trackClaudePresetSeats()
  return () => {
    untrack()
    element.remove()
  }
}
