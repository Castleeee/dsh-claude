import { useEffect } from 'react'

/** Marks the document for as long as a Claude Session is on screen.
 *
 *  The Host draws a context meter, session statistics, and a tab strip from
 *  what DSH assembled for the session — for this preset all three describe
 *  something DSH does not hold, because the conversation, the tools, and the
 *  context live in Claude Code. The plugin draws its own reading of the CLI in
 *  the same seats, and this attribute is what stands the Host's copies down
 *  (`host-chrome.ts`). It is set from a session-scoped component, so every
 *  other preset keeps the Host's chrome untouched.
 *
 *  Two components mark the same document, so the attribute is reference
 *  counted: the last one to unmount clears it. */
export const CLAUDE_SESSION_ATTRIBUTE = 'data-dsh-claude-session'

let marks = 0

export function useClaudeSessionMark(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined
    marks += 1
    document.body.dataset.dshClaudeSession = ''
    return () => {
      marks -= 1
      if (marks <= 0) {
        marks = 0
        delete document.body.dataset.dshClaudeSession
      }
    }
  }, [active])
}
