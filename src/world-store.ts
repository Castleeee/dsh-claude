/**
 * Two-world configuration store for the Claude preset.
 *
 * The Claude preset is a second DSH configuration *world*: while it owns a
 * session, the global settings document is that world's, and switching back
 * restores the other world exactly as the user left it. Neither world may
 * contaminate the other, which is the whole point — a Claude-only model
 * reaching a `cordis` session is the failure this store exists to prevent.
 *
 * Only two worlds exist. `claude` is the Claude preset's own configuration.
 * `default` is every other preset's, shared, and is a restoration point rather
 * than a feature: it holds whatever the global document last was while a
 * non-Claude world owned it, refreshed live so switching back never resurrects
 * a stale snapshot.
 *
 * @module dsh-claude/world-store
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The Claude preset's world. */
export const CLAUDE_WORLD = 'claude'
/** Every other preset's world; the shared restoration point. */
export const DEFAULT_WORLD = 'default'

export type WorldId = typeof CLAUDE_WORLD | typeof DEFAULT_WORLD

/** Settings namespace carrying the default model selection. Mirrors
 *  `@deepseek-ai/dsh-agent-default-model`, which does not re-export it from a
 *  path this package can import without pulling the whole service. */
export const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'
/** Settings namespace carrying the default permission preset. */
export const PERMISSION_NS = 'permission'

const MAX_STORE_BYTES = 64 * 1024
const STORE_VERSION = 1

function isNamespace(value: string): boolean {
  return value === AGENT_DEFAULT_MODEL_NS || value === PERMISSION_NS
}

/** One world's captured configuration: namespace -> that namespace's stored
 *  section. A namespace absent from a world means "never captured", which is
 *  distinct from a captured empty section. */
export type WorldSections = Record<string, unknown>

export interface WorldStoreDocument {
  version: number
  /** The world the global document currently belongs to. Drives boot recovery
   *  after a crash that left the switch half-applied. */
  activeWorld: WorldId
  worlds: Record<WorldId, WorldSections>
}

function emptyDocument(): WorldStoreDocument {
  return { version: STORE_VERSION, activeWorld: DEFAULT_WORLD, worlds: { [CLAUDE_WORLD]: {}, [DEFAULT_WORLD]: {} } }
}

function isWorldId(value: unknown): value is WorldId {
  return value === CLAUDE_WORLD || value === DEFAULT_WORLD
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse a stored document, discarding anything malformed rather than failing
 *  the boot: a corrupt world file must not take the whole plugin down, and the
 *  safe reading of an unparseable file is "nothing captured yet". */
export function parseWorldDocument(text: string): WorldStoreDocument {
  if (Buffer.byteLength(text) > MAX_STORE_BYTES) return emptyDocument()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyDocument()
  }
  const root = plainObject(parsed)
  if (root === undefined) return emptyDocument()
  const activeWorld = isWorldId(root.activeWorld) ? root.activeWorld : DEFAULT_WORLD
  const document = emptyDocument()
  document.activeWorld = activeWorld
  const worlds = plainObject(root.worlds)
  if (worlds === undefined) return document
  for (const world of [CLAUDE_WORLD, DEFAULT_WORLD] as const) {
    const sections = plainObject(worlds[world])
    if (sections === undefined) continue
    for (const [ns, section] of Object.entries(sections)) {
      // Only the two namespaces this store owns may be captured; anything else
      // is a stale or hand-edited key and is dropped at the boundary.
      if (!isNamespace(ns)) continue
      document.worlds[world][ns] = section
    }
  }
  return document
}

/** Namespaces this store may route. */
export function routableNamespace(value: string): boolean {
  return isNamespace(value)
}

export interface WorldStoreOptions {
  /** Store location; overridden by tests. */
  path?: string
}

/**
 * The two-world configuration store.
 *
 * Reads are served from an in-memory copy that a write updates only after the
 * rename lands, so a failed write leaves both the file and the cached document
 * at their previous value. Writes are serialized through one chain: two
 * concurrent captures of the same world would otherwise interleave read,
 * modify, and write, and the last writer would silently drop the other's
 * namespace.
 */
export class ClaudeWorldStore {
  readonly path: string
  #document: WorldStoreDocument | undefined
  #pending: Promise<unknown> = Promise.resolve()

  constructor(options: WorldStoreOptions = {}) {
    this.path = options.path ?? dshHomePath('plugins', 'dsh-claude', 'worlds.json')
  }

  /** Read the store, loading it once and caching thereafter. */
  async read(): Promise<WorldStoreDocument> {
    if (this.#document === undefined) {
      let text: string
      try {
        text = await readFile(this.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        text = ''
      }
      this.#document = text === '' ? emptyDocument() : parseWorldDocument(text)
    }
    return this.#document
  }

  /** One world's captured sections, or `undefined` before it was ever captured. */
  async sectionsOf(world: WorldId): Promise<WorldSections | undefined> {
    const document = await this.read()
    const sections = document.worlds[world]
    return Object.keys(sections).length === 0 ? undefined : { ...sections }
  }

  /** The world the global document currently belongs to. */
  async activeWorld(): Promise<WorldId> {
    return (await this.read()).activeWorld
  }

  /** Capture one namespace's current value into one world, and record which
   *  world the global document belongs to. Serialized with every other write. */
  async capture(world: WorldId, ns: string, value: unknown, activeWorld: WorldId): Promise<void> {
    if (!isNamespace(ns)) throw new Error(`dsh-claude: refusing to capture unrelated settings namespace ${ns}`)
    await this.#mutate(document => {
      document.worlds[world][ns] = value
      document.activeWorld = activeWorld
    })
  }

  /** Record ownership without changing any captured section. */
  async setActiveWorld(world: WorldId): Promise<void> {
    await this.#mutate(document => { document.activeWorld = world })
  }

  /** Resolve once every write queued so far has landed. A caller tearing down
   *  or asserting on the file waits here rather than guessing a delay. */
  async settled(): Promise<void> {
    await this.#pending.catch(() => undefined)
  }

  /** Read, modify, and rewrite the document, holding the write chain. The
   *  in-memory copy is swapped only after the file write succeeds. */
  async #mutate(apply: (document: WorldStoreDocument) => void): Promise<void> {
    const operation = this.#pending.catch(() => undefined).then(async () => {
      const current = await this.read()
      // Clone so a failed write cannot leave the cache holding unpersisted state.
      const next = parseWorldDocument(JSON.stringify(current))
      apply(next)
      await this.#write(next)
      this.#document = next
    })
    this.#pending = operation
    return operation
  }

  async #write(document: WorldStoreDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
