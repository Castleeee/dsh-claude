import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { HOST_CHROME_CSS } from '../src/client/host-chrome.ts'
import { CLAUDE_SESSION_ATTRIBUTE } from '../src/client/session-mark.ts'

/** The Host's own meter, as a plain child of the row it sits in. Its CSS Module
 *  prefix is the only part that moves between builds, so the markup is written
 *  once and rendered under either prefix. */
function hostMeter(prefix: string): string {
  return `
    <span class="${prefix}_root">
      <button class="${prefix}_trigger" type="button" aria-haspopup="dialog" aria-expanded="false">
        <svg width="14" height="14" viewBox="0 0 14 14">
          <circle class="${prefix}_track" cx="7" cy="7" r="5.5"></circle>
          <circle class="${prefix}_fill" cx="7" cy="7" r="5.5"></circle>
        </svg>
      </button>
    </span>`
}

/** The ring this plugin draws: the same 14px geometry behind the same kind of
 *  dialog trigger, which is why the shape rule has to name it out. */
const PLUGIN_RING = `
  <span data-dsh-claude-context-meter="">
    <button type="button" aria-haspopup="dialog" aria-expanded="false">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="5.5" stroke-width="2"></circle>
        <circle cx="7" cy="7" r="5.5" stroke-width="2"></circle>
      </svg>
    </button>
  </span>`

/** Host 2.0.9 put its meter in the composer's trailing row, between the model
 *  seat and the submit button:
 *
 *  - `conversation.input.right` and `conversation.input.model` are slot anchors —
 *    `display:contents`, so what they contain is a flex item of the row rather
 *    than of the anchor;
 *  - the submit button is the `_primary` the row is recognised by. */
const TRAILING_ROW = `
  <div class="Q7WfXG_trailing">
    <div data-slot="conversation.input.right" style="display:contents">${PLUGIN_RING}</div>
    <div data-slot="conversation.input.model" style="display:contents">
      <button class="zXf_Ea_trigger" type="button">claude-opus-5[1M]</button>
    </div>
    ${hostMeter('JdJrwG')}
    <button class="Q7WfXG_primary" type="button">send</button>
  </div>`

/** 0.2.0 moved it one row down, into the dock strip below the card, where it is
 *  a sibling of the `conversation.composer.dock` render rather than of the model
 *  seat. The row is centred, so the two sit side by side in the middle. */
const DOCK_ROW = `
  <div class="yhfFVG_dock">
    <div data-slot="conversation.composer.dock" style="display:contents">${PLUGIN_RING}</div>
    ${hostMeter('y0jqnG')}
  </div>`

/** Every rule `HOST_CHROME_CSS` writes, split into the selector and the
 *  declarations it sets. */
function chromeRules(): readonly { selector: string; body: string }[] {
  return [...HOST_CHROME_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' }))
}

/** The rules aimed at one Host generation's row, picked by the marker only that
 *  row's class carries. */
function rulesForRow(marker: string): readonly { selector: string; body: string }[] {
  return chromeRules().filter(rule => rule.selector.includes(marker))
}

function render(html: string): { document: Document; on: () => void; off: () => void } {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  const { document } = dom.window
  return {
    document,
    on: () => { document.body.setAttribute(CLAUDE_SESSION_ATTRIBUTE, '') },
    off: () => { document.body.removeAttribute(CLAUDE_SESSION_ATTRIBUTE) },
  }
}

describe('the Host meter in the trailing row (through 2.0.9)', () => {
  it('hides it by the class that build emitted', () => {
    const row = render(TRAILING_ROW)
    row.on()
    const byClass = rulesForRow('_trailing').filter(rule => rule.selector.includes('JdJrwG_root'))
    expect(byClass).toHaveLength(1)
    expect(byClass[0]?.body).toBe('display:none')
    const meter = row.document.querySelector('.JdJrwG_root') as Element
    const ring = row.document.querySelector('[data-dsh-claude-context-meter]') as Element
    expect(meter.matches(byClass[0]?.selector as string)).toBe(true)
    // The ring this plugin draws must never be caught by it.
    expect(ring.matches(byClass[0]?.selector as string)).toBe(false)
  })
})

describe('the Host meter in the dock row (0.2.0)', () => {
  it('hides it by the class that build emitted', () => {
    const row = render(DOCK_ROW)
    row.on()
    const byClass = rulesForRow('_dock').filter(rule => rule.selector.includes('y0jqnG_root'))
    expect(byClass).toHaveLength(1)
    expect(byClass[0]?.body).toBe('display:none')
    const meter = row.document.querySelector('.y0jqnG_root') as Element
    const ring = row.document.querySelector('[data-dsh-claude-context-meter]') as Element
    expect(meter.matches(byClass[0]?.selector as string)).toBe(true)
    expect(ring.matches(byClass[0]?.selector as string)).toBe(false)
  })

  it('hides it by its shape when the build hash changes', () => {
    const row = render(DOCK_ROW)
    row.on()
    // A rebuilt Host: same markup, a new CSS Module prefix.
    const host = row.document.querySelector('.y0jqnG_root') as Element
    const rebuilt = host.cloneNode(true) as Element
    rebuilt.className = 'Zz9Qq1_root'
    host.after(rebuilt)
    const byShape = rulesForRow('_dock').filter(rule => rule.selector.includes(':has(button[aria-haspopup="dialog"]'))
    expect(byShape).toHaveLength(1)
    expect(byShape[0]?.body).toBe('display:none')
    expect(rebuilt.matches(byShape[0]?.selector as string)).toBe(true)
    // The plugin's ring draws the same geometry behind the same kind of trigger,
    // so the shape rule has to name it out. It sits inside the dock's slot
    // anchor, which is `display:contents` and not the row itself, so the direct
    // child combinator is a second guard.
    const ring = row.document.querySelector('[data-dsh-claude-context-meter]') as Element
    expect(ring.matches(byShape[0]?.selector as string)).toBe(false)
  })
})

describe('the composer rows this plugin does not touch', () => {
  it('reorders nothing: every rule only hides a Host control', () => {
    // The ring reaches its seat through the slot's own `order`
    // (`conversation.composer.dock`, ahead of the session statistics), so
    // nothing here readjusts a row. The rule that used to reorder the trailing
    // row went stale the moment the Host moved its meter out of it.
    const rules = chromeRules()
    expect(rules.filter(rule => rule.body.startsWith('order:'))).toHaveLength(0)
  })

  it('does nothing at all for a session this plugin does not own', () => {
    for (const html of [TRAILING_ROW, DOCK_ROW]) {
      const row = render(html)
      row.off()
      const ring = row.document.querySelector('[data-dsh-claude-context-meter]') as Element
      const meter = row.document.querySelector('[class$="_root"]') as Element
      for (const rule of chromeRules()) {
        expect(ring.matches(rule.selector)).toBe(false)
        expect(meter.matches(rule.selector)).toBe(false)
      }
    }
  })
})
