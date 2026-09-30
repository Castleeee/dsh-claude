import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { HOST_CHROME_CSS } from '../src/client/host-chrome.ts'
import { CLAUDE_SESSION_ATTRIBUTE } from '../src/client/session-mark.ts'

/** The composer's trailing row the way the Host draws it (Host 2.0.9):
 *
 *  - `conversation.input.right` and `conversation.input.model` are slot
 *    anchors — `display:contents`, so what they contain is a flex item of the
 *    row rather than of the anchor;
 *  - the Host's own meter is a plain child of the row, between the model seat
 *    and the submit button;
 *  - the submit button is the `_primary` the row is recognised by. */
const COMPOSER_ROW = `
<div class="Q7WfXG_trailing">
  <div data-slot="conversation.input.right" style="display:contents">
    <span data-dsh-claude-context-meter="">
      <button type="button" aria-haspopup="dialog" aria-expanded="false">
        <svg width="14" height="14" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="5.5" stroke-width="2"></circle>
          <circle cx="7" cy="7" r="5.5" stroke-width="2"></circle>
        </svg>
      </button>
    </span>
  </div>
  <div data-slot="conversation.input.model" style="display:contents">
    <button class="zXf_Ea_trigger" type="button">claude-opus-5[1M]</button>
  </div>
  <span class="JdJrwG_root">
    <button class="JdJrwG_trigger" type="button" aria-haspopup="dialog" aria-expanded="false">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle class="JdJrwG_track" cx="7" cy="7" r="5.5"></circle>
        <circle class="JdJrwG_fill" cx="7" cy="7" r="5.5"></circle>
      </svg>
    </button>
  </span>
  <button class="Q7WfXG_primary" type="button">send</button>
</div>`

/** Every rule `HOST_CHROME_CSS` writes about the composer's row, split into the
 *  selector and the declarations it sets. */
function composerRules(): readonly { selector: string; body: string }[] {
  return [...HOST_CHROME_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' }))
    .filter(rule => rule.selector.includes('_trailing'))
}

function composer(): {
  ring: Element
  hostMeter: Element
  submit: Element
  document: Document
  off: () => void
  on: () => void
} {
  const dom = new JSDOM(`<!doctype html><html><body>${COMPOSER_ROW}</body></html>`)
  const { document } = dom.window
  // Scoped to the anchor: the flag also sits on `<body>`, which document order
  // reaches first.
  return {
    ring: document.querySelector('[data-slot="conversation.input.right"]>span') as Element,
    hostMeter: document.querySelector('.JdJrwG_root') as Element,
    submit: document.querySelector('.Q7WfXG_primary') as Element,
    document,
    on: () => { document.body.setAttribute(CLAUDE_SESSION_ATTRIBUTE, '') },
    off: () => { document.body.removeAttribute(CLAUDE_SESSION_ATTRIBUTE) },
  }
}

describe('a Claude composer row', () => {
  it('hides the Host meter by the class this Host build emits', () => {
    const row = composer()
    row.on()
    const byClass = composerRules().filter(rule => rule.selector.includes('JdJrwG_root'))
    expect(byClass).toHaveLength(1)
    expect(byClass[0]?.body).toBe('display:none')
    expect(row.hostMeter.matches(byClass[0]?.selector as string)).toBe(true)
    // The ring this plugin draws must never be caught by it.
    expect(row.ring.matches(byClass[0]?.selector as string)).toBe(false)
  })

  it('hides the Host meter by its shape when the build hash changes', () => {
    const row = composer()
    row.on()
    // A rebuilt Host: same markup, a new CSS Module prefix.
    const rebuilt = row.hostMeter.cloneNode(true) as Element
    rebuilt.className = 'Zz9Qq1_root'
    row.hostMeter.after(rebuilt)
    const byShape = composerRules().filter(rule => rule.selector.includes(':has(button[aria-haspopup="dialog"]'))
    expect(byShape).toHaveLength(1)
    expect(byShape[0]?.body).toBe('display:none')
    expect(rebuilt.matches(byShape[0]?.selector as string)).toBe(true)
    expect(row.hostMeter.matches(byShape[0]?.selector as string)).toBe(true)
    // This plugin's ring draws the same 14px geometry behind the same kind of
    // trigger, so the shape rule has to name it out.
    expect(row.ring.matches(byShape[0]?.selector as string)).toBe(false)
  })

  it('leaves this plugin its ring between the model seat and the submit button', () => {
    const row = composer()
    row.on()
    const ordered = composerRules().filter(rule => rule.body.startsWith('order:'))
    expect(ordered.map(rule => rule.body)).toEqual(['order:1', 'order:2'])
    expect(row.ring.matches(ordered[0]?.selector as string)).toBe(true)
    expect(row.submit.matches(ordered[1]?.selector as string)).toBe(true)
    // The model seat keeps the row's default order, so nothing moves it: it
    // stays ahead of the ring, which is where the Host drew it.
    const model = row.document.querySelector('.zXf_Ea_trigger') as Element
    for (const rule of ordered) expect(model.matches(rule.selector)).toBe(false)
  })

  it('does nothing at all for a session this plugin does not own', () => {
    const row = composer()
    row.off()
    for (const rule of composerRules()) {
      expect(row.hostMeter.matches(rule.selector)).toBe(false)
      expect(row.ring.matches(rule.selector)).toBe(false)
      expect(row.submit.matches(rule.selector)).toBe(false)
    }
  })
})
