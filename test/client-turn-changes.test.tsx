import { describe, expect, it } from 'vitest'
import { rewindCardModel } from '../src/client/ClaudeTurnChanges.tsx'

/**
 * The changed-files card's render rule.
 *
 * The component itself cannot be server-rendered here (its dry run is fetched
 * in an effect), so the rule that decides whether a row exists at all is kept
 * as a pure function and pinned down directly. It is the part with a history:
 * the previous version drew a one-line "no snapshot for this turn" card for
 * every non-200 answer, which is a permanent row of noise under every Claude
 * turn that cannot be rewound.
 */
describe('Claude changed-files card', () => {
  it('draws nothing before the dry run answers', () => {
    expect(rewindCardModel(undefined).visible).toBe(false)
  })

  it('draws nothing when the rewind is refused', () => {
    const refused = { status: 409, payload: { error: 'no-rewind-target' } }
    expect(rewindCardModel(refused).visible).toBe(false)
  })

  it('draws nothing when the turn changed no files', () => {
    const empty = { status: 200, payload: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } }
    expect(rewindCardModel(empty).visible).toBe(false)
  })

  it('reads files and counts off the dry run', () => {
    const answer = {
      status: 200,
      payload: {
        canRewind: true,
        filesChanged: ['/work/a.md', '/work/b.ts'],
        insertions: 42,
        deletions: 7,
      },
    }
    expect(rewindCardModel(answer)).toEqual({
      visible: true,
      files: ['/work/a.md', '/work/b.ts'],
      add: 42,
      remove: 7,
      canRewind: true,
    })
  })

  it('lists the files without offering a rewind Claude cannot do', () => {
    const held = { status: 200, payload: { canRewind: false, filesChanged: ['/work/a.md'] } }
    const model = rewindCardModel(held)
    expect(model.visible).toBe(true)
    expect(model.canRewind).toBe(false)
    // A missing figure is zero, never NaN: the row still has to read.
    expect(model.add).toBe(0)
    expect(model.remove).toBe(0)
  })
})
