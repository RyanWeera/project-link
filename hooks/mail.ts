import type { CommandReq, Message, Status } from '../types'

/** The file system and clock the mailbox runs on: `$` in a session, memory in tests. */
export type Io = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<readonly { name: string; kind: string; mtimeMs?: number }[]>
  now: () => Promise<number>
}

/** isSetUp false: found only as a session folder; it never ran project-link, so its inbox name is a guess */
export type Project = { name: string; slug: string; lastSeen?: number; dir?: string; isSetUp?: false }

/** A session's chat as other sessions see it: its last model request (0 = unknown), context size, token-lens quality score. */
export type Chat = { lastRequest: number; tokens: number | null; quality: number | null }

const ACTIVE_MS = 3 * 60_000
// cold = past the 1h prompt cache, as in cache-tax
const COLD_MS = 60 * 60 * 1000
// under the quality floor, as the crab band's "sagging"; with no score, a chat this big counts as low quality
const QUALITY_FLOOR = 70
const BIG_TOKENS = 50000

/** A cold chat of low quality is compacted before a message lands: the message would re-write all of it into the cache. */
export const needsCompact = (c: Chat, now: number) =>
  now - c.lastRequest >= COLD_MS && (c.quality ?? ((c.tokens ?? 0) >= BIG_TOKENS ? 0 : 100)) < QUALITY_FLOOR

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

export const describeChat = (c: Chat | undefined, now: number) => {
  if (c === undefined) return 'chat state unknown (no session there has reported it)'
  const age = c.lastRequest === 0 ? 'no model call since it opened' : `last model call ${span(now - c.lastRequest)} ago`
  return (
    `chat ${now - c.lastRequest >= COLD_MS ? 'cold' : 'warm'} (${age}), ` +
    `${c.tokens === null ? 'size unknown' : `${Math.round(c.tokens / 1000)}k tokens`}, ` +
    `${c.quality === null ? 'quality unknown' : `quality ${Math.round(c.quality)}/100`}; ` +
    `left to decide, it ${needsCompact(c, now) ? 'compacts first' : 'takes the message as is'}`
  )
}

const numOr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const trimSep = (path: string) => path.replace(/[\\/]+$/, '')

export const folderName = (path: string) => trimSep(path).split(/[\\/]/).pop() || path

export const parentOf = (path: string) => {
  const t = trimSep(path)
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  return cut <= 0 ? t : t.slice(0, cut)
}

/** Claude Code's folder name under ~/.claude/projects for a path: each non-alphanumeric becomes '-'. */
export const encodePath = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

const norm = (path: string) => trimSep(path).replace(/\\/g, '/').toLowerCase()

export type Scope = 'tree' | 'children'

/** Reachable from `me`: its own subfolders, its ancestors, and its siblings' trees. */
export const related = (me: string, other: string, scope: Scope = 'tree') => {
  const [a, b] = [norm(me), norm(other)]
  const p = norm(parentOf(me))
  return b === a || b.startsWith(`${a}/`) || a.startsWith(`${b}/`) || (scope === 'tree' && b.startsWith(`${p}/`))
}

const shortHash = (text: string) => {
  let h = 0
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h.toString(36).slice(0, 5)
}

/** The inbox name for a project folder; a name with no ASCII letter or digit falls back to a hash of the path. */
export const projectSlug = (path: string) => slug(folderName(path)) || `p-${shortHash(norm(path))}`

/** Same test on ~/.claude/projects folder names (paths are lossy there). */
const relatedDir = (me: string, dir: string, scope: Scope) => {
  const [a, b] = [encodePath(me).toLowerCase(), dir.toLowerCase()]
  const p = encodePath(parentOf(me)).toLowerCase()
  return b.startsWith(`${a}-`) || a.startsWith(`${b}-`) || (scope === 'tree' && b.startsWith(`${p}-`))
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: { type?: string; text?: string; name?: string }) =>
      c.type === 'text' ? (c.text ?? '') : c.type === 'tool_use' ? `[tool: ${c.name}]` : '')
    .filter(Boolean).join(' ')
}

// ids and slugs become file names: nothing that can climb out of the mailbox folder
const SLUG = /^[a-z0-9-]+$/
export const isSlug = (v: unknown): v is string => typeof v === 'string' && SLUG.test(v)
// a title or project name shows in lists Claude reads: one short line
const LINE_MAX = 120
// characters that draw nothing can carry hidden bytes; FE0E or FE0F right after an emoji stays, as it picks how the emoji draws
const HIDDEN = /(?![\uFE0E\uFE0F])\p{Default_Ignorable_Code_Point}|(?<!\p{Extended_Pictographic})[\uFE0E\uFE0F]/gu
// control and format characters (terminal escapes, bidi marks), half surrogate pairs (two halves join when what is between them goes),
// line separators and hidden characters can change how a line shows
const isLine = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= LINE_MAX && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(v) && v.replace(HIDDEN, '') === v
/** Text with its control, format and hidden characters taken out, then its whitespace made single spaces. */
export const plain = (text: string) => text.replace(/(?![\t-\r])[\p{Cc}\p{Cf}\p{Cs}]/gu, '').replace(HIDDEN, '').replace(/\s+/g, ' ')
/** The first n characters of text, without a half emoji at the end. */
export const clip = (text: string, n: number) => text.slice(0, n).replace(/[\uD800-\uDBFF]$/, '')
export const oneLine = (text: string) => clip(plain(text).trim(), LINE_MAX).trimEnd()
// a body keeps its line breaks (each as \n: a lone \r can draw text over text), but loses what the bar cannot show:
// invisible characters can carry words the person never saw
const seen = (text: string) => text.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, '\n').replace(/(?![\t\n])[\p{Cc}\p{Cf}\p{Cs}]/gu, '').replace(HIDDEN, '')

const STATUSES: readonly string[] = ['new', 'started', 'declined', 'done', 'dismissed'] satisfies Status[]

const isMessage = (x: unknown): x is Message => {
  const m = x as Partial<Message> | null
  return (
    typeof m === 'object' && m !== null &&
    isSlug(m.id) && (m.kind === 'task' || m.kind === 'result') &&
    isLine(m.from) && isLine(m.to) && isSlug(m.fromSlug) && isSlug(m.toSlug) &&
    isLine(m.title) && typeof m.body === 'string' &&
    typeof m.status === 'string' && STATUSES.includes(m.status) && typeof m.createdAt === 'number' &&
    (m.replyTo === undefined || isSlug(m.replyTo)) &&
    (m.hops === undefined || (Number.isInteger(m.hops) && m.hops >= 0)) &&
    (m.outcome === undefined || m.outcome === 'done' || m.outcome === 'declined') &&
    (m.pickedBy === undefined || isLine(m.pickedBy)) &&
    (m.compact === undefined || typeof m.compact === 'boolean')
  )
}

const isCommand = (x: unknown): x is CommandReq => {
  const c = x as Partial<CommandReq> | null
  return (
    typeof c === 'object' && c !== null &&
    isSlug(c.id) && isLine(c.from) &&
    typeof c.command === 'string' && /^[a-z0-9:_-]+$/i.test(c.command) &&
    c.args === '' && isSlug(c.fromSlug) && typeof c.fromSession === 'string' &&
    typeof c.createdAt === 'number' && Array.isArray(c.targets) && c.targets.every(t => typeof t === 'string')
  )
}

export const taskPrompt = (m: Message) =>
  `[project-link] Work request from the "${m.from}" project (id ${m.id}).\n\n` +
  `Title: ${m.title}\n\n${seen(m.body)}\n\n` +
  `Do this work here in this project. If it really belongs to one of the sub-projects or sibling projects reachable from here, ` +
  `forward it with the project-link send_work tool (use list_projects and read_project_context to pick the right one) and relay its reply. ` +
  `When you are finished, or if you cannot do it, call the ` +
  `project-link reply_work tool with id "${m.id}" and a clear summary: what you did, the results, ` +
  `and anything the "${m.from}" project needs to know to carry on.`

export const resultPrompt = (m: Message) =>
  m.outcome === 'declined'
    ? `[project-link] The "${m.from}" project declined the work you sent ("${m.title}", id ${m.replyTo}).\n\n${seen(m.body)}`
    : `[project-link] The "${m.from}" project finished the work you sent ("${m.title}", id ${m.replyTo}). Their reply:\n\n` +
      `${seen(m.body)}\n\nCarry on with this result.`

/** One project's view of the shared mailbox folder (`root`). */
export const mailbox = (io: Io, root: string, me: Project) => {
  const inboxOf = (s: string) => `${root}/inbox/${s}`
  const outboxOf = (s: string) => `${root}/outbox/${s}`
  const registry = `${root}/projects`

  const list = (dir: string) => io.list(dir).catch(() => [])
  const readJson = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse(await io.read(path))
    } catch {
      return undefined
    }
  }
  const save = (path: string, value: unknown) => io.write(path, JSON.stringify(value, null, 2))
  const newId = (now: number) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const readDir = async (dir: string, skip?: ReadonlySet<string>) => {
    const out: Message[] = []
    for (const e of await list(dir)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
      if (skip?.has(e.name.slice(0, -5))) continue
      const m = await readJson(`${dir}/${e.name}`)
      if (isMessage(m)) out.push(m)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** The folder a project registered when it ran project-link, if it did. */
  const pathOf = async (s: string) => {
    if (!isSlug(s)) return undefined
    const p = (await readJson(`${registry}/${s}.json`)) as { path?: unknown } | undefined
    return typeof p?.path === 'string' ? p.path : undefined
  }

  const box = {
    me,
    pathOf,

    /** Two projects with the same folder name get distinct inboxes: the later one adds a path hash, so it never takes the first one's mail. */
    async claimSlug(path: string) {
      const other = (await readJson(`${registry}/${me.slug}.json`)) as { path?: unknown } | undefined
      if (typeof other?.path === 'string' && norm(other.path) !== norm(path)) me.slug = `${me.slug}-${shortHash(norm(path))}`
    },

    /** Marks this project as seen now, so others can tell it is open. */
    async announce(path: string) {
      await save(`${registry}/${me.slug}.json`, { name: me.name, slug: me.slug, path, lastSeen: await io.now() })
    },

    /** Whether the project behind `fromSlug` is one this project reaches (the list_projects test): auto mode trusts no sender outside it. */
    async canReach(fromSlug: string, myPath: string, scope: Scope) {
      const path = await pathOf(fromSlug)
      if (path === undefined) return false
      return norm(path) === norm(myPath) || related(myPath, path, scope)
    },

    /** Projects work can go to: ones the mod has seen, plus Claude Code projects beside this one. */
    async projects(claudeProjectsDir: string, myPath: string, scope: Scope = 'tree'): Promise<Project[]> {
      const found = new Map<string, Project>()
      for (const e of await list(registry)) {
        const p = (await readJson(`${registry}/${e.name}`)) as Partial<Project> | undefined
        const path = (p as { path?: unknown } | undefined)?.path
        // an entry with no path cannot be placed in the scope, so it is not reachable
        if (!isLine(p?.name) || !isSlug(p.slug) || typeof path !== 'string') continue
        if (path !== myPath && !related(myPath, path, scope)) continue
        found.set(p.slug, {
          name: p.name, slug: p.slug, lastSeen: typeof p.lastSeen === 'number' ? p.lastSeen : undefined,
          dir: encodePath(path),
        })
      }
      // a folder the registry already names is that project; its folder name is only a guess at the name
      const known = new Set([...found.values()].map(p => p.dir?.toLowerCase()))
      const mine = encodePath(myPath).toLowerCase()
      const parent = `${encodePath(parentOf(myPath))}-`.toLowerCase()
      for (const e of await list(claudeProjectsDir)) {
        const d = e.name.toLowerCase()
        if (e.kind !== 'dir' || d === mine || known.has(d) || !relatedDir(myPath, e.name, scope)) continue
        // name = the part after the closest known prefix (own folder, else parent); an ancestor has no such
        // part, and its slug cannot be told from the folder name, so it shows up only once it has run project-link
        const cut = d.startsWith(`${mine}-`) ? mine.length + 1 : d.startsWith(parent) ? parent.length : -1
        if (cut < 0) continue
        const rest = e.name.slice(cut)
        const s = slug(rest)
        if (s !== '' && !found.has(s)) found.set(s, { name: oneLine(rest.replace(/-+/g, ' ')), slug: s, dir: e.name, isSetUp: false })
      }
      found.delete(me.slug)
      return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
    },

    /** Picks a project by slug or name: exact, else the only one containing it. */
    resolve(query: string, projects: readonly Project[]): Project | string {
      const q = slug(query)
      const name = query.trim().toLowerCase()
      // a name with no ASCII letter or digit has a hashed slug: its name picks it
      const named = projects.filter(p => p.name.toLowerCase() === name)
      if (named.length === 0 && (q === me.slug || name === me.name.toLowerCase())) return `"${query}" is this project. Pick another one.`
      const exact = projects.find(p => p.slug === q) ?? (named.length === 1 ? named[0] : undefined)
      if (exact) return exact
      const hits = named.length > 1 ? named : projects.filter(p => q !== '' && p.slug.includes(q))
      const [only] = hits
      if (hits.length === 1 && only) return only
      const names = projects.map(p => p.name).join(', ') || 'none yet'
      return hits.length > 1
        ? `"${query}" matches several projects: ${hits.map(p => `${p.name} [slug ${p.slug}]`).join(', ')}. Use the slug.`
        : `No project called "${query}". Known projects: ${names}.`
    },

    /** The newest session of a project: its last-modified time and user/assistant turns. */
    async latest(p: Project, claudeProjectsDir: string, reach: (cwd: string) => boolean): Promise<{ mtimeMs: number; turns: { who: 'USER' | 'CLAUDE'; text: string }[] } | string> {
      if (p.dir === undefined) return `No session folder known for ${p.name} yet.`
      const dir = `${claudeProjectsDir}/${p.dir}`
      const files = (await list(dir)).filter(e => e.kind === 'file' && e.name.endsWith('.jsonl'))
      const [newest] = files.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
      if (newest === undefined) return `${p.name} has no sessions yet.`
      let raw = ''
      try {
        raw = await io.read(`${dir}/${newest.name}`)
      } catch {
        // the host refuses reads over 4 MiB; there is no ranged read to take just the tail
        return `Could not read ${p.name}'s session (too large to read, or in use).`
      }
      const turns: { who: 'USER' | 'CLAUDE'; text: string }[] = []
      let cwd: string | undefined
      for (const line of raw.split('\n')) {
        try {
          const j = JSON.parse(line) as { type?: string; cwd?: unknown; message?: { content?: unknown } }
          if (cwd === undefined && typeof j.cwd === 'string') cwd = j.cwd
          if (j.type !== 'user' && j.type !== 'assistant') continue
          const text = plain(textOf(j.message?.content)).trim()
          // skip harness-injected blocks (system reminders, command echoes)
          if (text && !/^<(system-reminder|command-|local-command|user-prompt)/.test(text)) {
            turns.push({ who: j.type === 'user' ? 'USER' : 'CLAUDE', text })
          }
        } catch {
          // a partial line while the session is writing
        }
      }
      // projects-old/School and projects/old-School share one folder name; the folder the session started in tells them apart
      if (cwd !== undefined ? !reach(cwd) : p.isSetUp === false) return `${p.name} is outside this project's reach.`
      return { mtimeMs: newest.mtimeMs ?? 0, turns }
    },

    /** The last `count` turns of a project's newest session. */
    async context(p: Project, claudeProjectsDir: string, count: number, reach: (cwd: string) => boolean): Promise<string> {
      const l = await box.latest(p, claudeProjectsDir, reach)
      if (typeof l === 'string') return l
      const tail = l.turns.slice(-count).map(t => `${t.who}: ${clip(t.text, 600)}`)
      return tail.length ? [`Latest ${tail.length} turns in ${p.name}:`, ...tail].join('\n\n') : `${p.name}'s session is empty.`
    },

    /** A short entry per project: open now, last activity, last thing the user asked, last thing Claude said. */
    async overview(projects: readonly Project[], claudeProjectsDir: string, reach: (cwd: string) => boolean): Promise<string> {
      const now = await io.now()
      const cut = (t: string, n: number) => (t.length > n ? `${clip(t, n)}...` : t)
      const out: string[] = []
      for (const p of projects) {
        const l = await box.latest(p, claudeProjectsDir, reach)
        const isOpen = box.isActive(p, now)
        const open = isOpen ? 'open now' : 'not open'
        const chat = isOpen ? `\n    ${describeChat(await box.chatOf(p), now)}` : ''
        if (typeof l === 'string') {
          out.push(`- ${p.name} (${open}): ${l}${chat}`)
          continue
        }
        const user = [...l.turns].reverse().find(t => t.who === 'USER')
        const claude = [...l.turns].reverse().find(t => t.who === 'CLAUDE')
        out.push(
          `- ${p.name} (${open}, active ${l.mtimeMs ? `${span(now - l.mtimeMs)} ago` : 'unknown'})${chat}
` +
            `    last ask: ${user ? cut(user.text, 160) : '-'}
    last reply: ${claude ? cut(claude.text, 160) : '-'}`,
        )
      }
      return out.length ? out.join('\n') : 'No reachable projects.'
    },

    isActive: (p: Project, now: number) => p.lastSeen !== undefined && now - p.lastSeen < ACTIVE_MS,

    /** Sends a task; a still-waiting identical one to the same project is returned instead of a second copy. */
    async send(to: Project, title: string, body: string, hops = 0, compact?: boolean): Promise<Message & { deduped?: true }> {
      const twin = (await readDir(inboxOf(to.slug))).find(
        t => t.kind === 'task' && t.status === 'new' && t.fromSlug === me.slug && t.title === title && t.body === body,
      )
      if (twin) return { ...twin, deduped: true }
      const now = await io.now()
      const m: Message = {
        id: newId(now), kind: 'task', from: me.name, fromSlug: me.slug,
        to: to.name, toSlug: to.slug, title, body, createdAt: now, status: 'new', hops,
        ...(compact === undefined ? {} : { compact }),
      }
      await save(`${inboxOf(to.slug)}/${m.id}.json`, m)
      await save(`${outboxOf(me.slug)}/${m.id}.json`, m)
      return m
    },

    /** Asks every live session of the `targets` projects to run a slash command. */
    async broadcast(targets: string[], command: string, fromSession: string): Promise<CommandReq> {
      const now = await io.now()
      const c: CommandReq = { id: newId(now), from: me.name, fromSlug: me.slug, fromSession, command, args: '', targets, createdAt: now }
      await save(`${root}/commands/${c.id}.json`, c)
      return c
    },

    /** Command requests not in `skip`, oldest first. */
    async commands(skip: ReadonlySet<string>): Promise<CommandReq[]> {
      const out: CommandReq[] = []
      for (const e of await list(`${root}/commands`)) {
        if (e.kind !== 'file' || !e.name.endsWith('.json') || skip.has(e.name.slice(0, -5))) continue
        const c = await readJson(`${root}/commands/${e.name}`)
        if (isCommand(c)) out.push(c)
      }
      return out.sort((a, b) => a.createdAt - b.createdAt)
    },

    /** This session ran (or refused) a command request. */
    async ack(c: CommandReq, sessionId: string, ran: boolean, text: string) {
      await save(`${root}/command-acks/${c.id}/${sessionId}.json`, { project: me.name, session: sessionId, ran, text, at: await io.now() })
    },

    async acks(id: string): Promise<{ project: string; session: string; ran: boolean; text: string }[]> {
      const out = []
      for (const e of await list(`${root}/command-acks/${id}`)) {
        const a = (await readJson(`${root}/command-acks/${id}/${e.name}`)) as { project?: unknown; session?: unknown; ran?: unknown; text?: unknown } | undefined
        if (typeof a?.project === 'string' && typeof a.session === 'string') out.push({ project: oneLine(a.project), session: oneLine(a.session), ran: a.ran === true, text: typeof a.text === 'string' ? oneLine(a.text) : '' })
      }
      return out
    },

    /** Marks this session as alive in its project; `active` is when it last did anything, `chat` what senders see of it. */
    async heartbeat(sessionId: string, active: number, chat?: Chat) {
      await save(`${root}/sessions/${me.slug}/${sessionId}.json`, { seen: await io.now(), active, ...chat })
    },

    /** Of a project's live sessions, the most recently active one: it handles incoming messages. */
    async leader(projectSlug: string) {
      const now = await io.now()
      let best: { id: string; active: number; chat?: Chat } | undefined
      for (const e of await list(`${root}/sessions/${projectSlug}`)) {
        // one file per session ever opened stays here: skip the old ones unread
        if (e.mtimeMs !== undefined && e.mtimeMs > 0 && now - e.mtimeMs >= ACTIVE_MS) continue
        const s = (await readJson(`${root}/sessions/${projectSlug}/${e.name}`)) as Record<string, unknown> | undefined
        // a heartbeat dated in the future would win every election
        if (typeof s?.seen !== 'number' || typeof s.active !== 'number' || now - s.seen >= ACTIVE_MS || s.seen > now + 60_000) continue
        const id = e.name.replace(/\.json$/, '')
        const active = Math.min(s.active, s.seen)
        if (!best || active > best.active || (active === best.active && id < best.id)) {
          const chat = typeof s.lastRequest === 'number' ? { lastRequest: s.lastRequest, tokens: numOr(s.tokens), quality: numOr(s.quality) } : undefined
          best = { id, active, chat }
        }
      }
      return best
    },

    async isLeader(sessionId: string): Promise<boolean> {
      const best = await box.leader(me.slug)
      return best === undefined || best.id === sessionId
    },

    /** The chat of the session that would take a message sent to `p`. */
    chatOf: async (p: Project) => (await box.leader(p.slug))?.chat,

    /** Everything in this project's inbox, oldest first, minus ids in `skip`. */
    inbox: (skip?: ReadonlySet<string>) => readDir(inboxOf(me.slug), skip),
    outbox: () => readDir(outboxOf(me.slug)),

    /** Takes a new message for this session: false when another session took it first. */
    async claim(m: Message, status: Status, sessionId: string) {
      const path = `${inboxOf(me.slug)}/${m.id}.json`
      const now = await readJson(path)
      if (!isMessage(now) || now.status !== 'new') return false
      await save(path, { ...now, status, pickedBy: sessionId })
      // a session that wrote meanwhile overwrote ours: the last writer has it
      const after = await readJson(path)
      return isMessage(after) && after.pickedBy === sessionId
    },

    /** Whether a result answers a task this project sent to that sender. */
    async answersMine(result: Message) {
      const sent = result.replyTo === undefined ? undefined : await readJson(`${outboxOf(me.slug)}/${result.replyTo}.json`)
      return isMessage(sent) && sent.toSlug === result.fromSlug
    },

    async setStatus(m: Message, status: Status, pickedBy?: string) {
      await save(`${inboxOf(me.slug)}/${m.id}.json`, { ...m, status, ...(pickedBy ? { pickedBy } : {}) })
    },

    /** Answers a task in this inbox: the result lands in the sender's inbox. */
    async reply(taskId: string, body: string, outcome: 'done' | 'declined'): Promise<Message | string> {
      if (!isSlug(taskId)) return `No work request with id "${taskId}" in this project.`
      const task = await readJson(`${inboxOf(me.slug)}/${taskId}.json`)
      if (!isMessage(task) || task.kind !== 'task') return `No work request with id "${taskId}" in this project.`
      if (task.status === 'done' || task.status === 'declined') return `Work request "${taskId}" already has a reply (${task.status}).`
      const now = await io.now()
      const result: Message = {
        id: newId(now), kind: 'result', from: me.name, fromSlug: me.slug,
        to: task.from, toSlug: task.fromSlug, title: task.title, body, createdAt: now,
        status: 'new', replyTo: task.id, outcome, hops: (task.hops ?? 0) + 1,
      }
      await save(`${inboxOf(task.fromSlug)}/${result.id}.json`, result)
      await save(`${inboxOf(me.slug)}/${task.id}.json`, { ...task, status: outcome })
      return result
    },

    /** Records a result on the sender's own copy of the task. */
    async noteResult(result: Message) {
      if (result.replyTo === undefined || result.outcome === undefined) return
      const path = `${outboxOf(me.slug)}/${result.replyTo}.json`
      const sent = await readJson(path)
      if (isMessage(sent) && sent.toSlug === result.fromSlug && sent.status !== result.outcome) await save(path, { ...sent, status: result.outcome })
    },

    /** The text `/inbox` and the work_status tool show. */
    async summary() {
      const inbox = await box.inbox()
      const waiting = inbox.filter(m => m.status === 'new')
      const working = inbox.filter(m => m.kind === 'task' && m.status === 'started')
      const sent = (await box.outbox()).slice(-10)
      // the receiver's own copy has the live state; ours only learns the final result
      const live = await Promise.all(sent.map(async m => {
        const theirs = await readJson(`${inboxOf(m.toSlug)}/${m.id}.json`)
        return isMessage(theirs) ? theirs : m
      }))
      const line = (m: Message) => `- ${m.title} (${m.kind === 'task' ? 'from' : 'reply from'} ${m.from}, id ${m.id})`
      // a waiting message has not run, and its sender may be untrusted: Claude reads where it came from, not its words
      const held = (m: Message) => `- ${m.kind === 'task' ? 'work' : 'a reply'} from ${m.from}, id ${m.id} (the bar above the prompt of this project's most recently active session shows it in turn)`
      const state = (m: Message) =>
        m.status === 'new' ? "waiting: not picked up yet (auto mode starts it when the target's current turn ends; otherwise its user presses Start)"
        : m.status === 'started' ? `started${m.pickedBy ? ` by session ${m.pickedBy.slice(0, 8)}` : ''}, no reply yet`
        : m.status === 'dismissed' ? 'dismissed by the target'
        : `${m.status}${m.pickedBy ? ` (session ${m.pickedBy.slice(0, 8)})` : ''}`
      const cmds = (await box.commands(new Set())).filter(c => c.fromSlug === me.slug).slice(-3)
      const cmdLines = await Promise.all(cmds.map(async c => {
        const acks = await box.acks(c.id)
        const ran = acks.filter(a => a.ran).map(a => `${a.project} (${a.session.slice(0, 8)})`)
        const skipped = acks.filter(a => !a.ran).map(a => `${a.project} (${a.session.slice(0, 8)}): ${a.text}`)
        return `- /${c.command} (id ${c.id}): ran in ${ran.length} session${ran.length === 1 ? '' : 's'}${ran.length ? ` — ${ran.join(', ')}` : ''}` +
          (skipped.length ? `; not run: ${skipped.join('; ')}` : '')
      }))
      const parts = [
        `Project: ${me.name}`,
        waiting.length ? `Waiting for you:\n${waiting.map(held).join('\n')}` : 'Nothing waiting.',
        working.length ? `In progress here:\n${working.map(line).join('\n')}` : '',
        cmdLines.length ? `Commands sent from here:\n${cmdLines.join('\n')}` : '',
        sent.length
          ? `Sent from here (latest ${sent.length}):\n${live.map(m => `- ${m.title} -> ${m.to}: ${state(m)} (id ${m.id})`).join('\n')}`
          : 'Nothing sent yet.',
      ]
      return parts.filter(Boolean).join('\n\n')
    },
  }
  return box
}

export type Mailbox = ReturnType<typeof mailbox>
