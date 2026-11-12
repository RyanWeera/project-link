import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Message } from '../types'
import { register as registerEdit } from './edit'
import {
  clip, describeChat, folderName, isSlug, mailbox, needsCompact, oneLine, plain, projectSlug, related, resultPrompt, slug, taskPrompt,
  type Chat, type Io, type Mailbox, type Project, type Scope,
} from './mail'

const POLL_MS = 4000
const ANNOUNCE_MS = 60_000
const FAILED = { result: 'project-link hit an error reading its mailbox; try again.' }
const notSetUp = (p: Project) =>
  `${p.name} has not run project-link yet, so its inbox name is unknown. Open that project once with project-link installed, then send again.`

const pending = atom({ plugin: 'project-link', key: 'pending' } as const, [])

let box: Mailbox | undefined
let claudeDir = ''
let myPath = ''
// this session's id and when it last did anything: the most recently active session of a project takes its messages
let sid = ''
let lastActive = 0
// last model request of this session (turn or keepwarm ping); 0 = unknown, as after a resume
let lastRequest = 0
// slash commands other sessions asked this one to run: never from before this session started or older than 10 minutes
let startedAt = 0
const ranCmds = new Set<string>()
const CMD_MAX_AGE_MS = 10 * 60_000
// the only commands another session can run here; any other could end the chat, wipe it, change who is
// signed in, install a plugin, or rewrite this chat's history
const ALLOWED = new Set(['reload-plugins', 'compact'])
// auto mode (off until /autolink on): work and replies go straight to Claude; capped per session so two
// projects can't ping-pong forever
let autoOn = false
let autoCount = 0
const AUTO_CAP = 30
// a message passed on more than this many times waits for a button
const MAX_HOPS = 100
// auto mode applies to these senders only ('*' = every reachable project); none until /autolink trust
let trust: '*' | string[] = []
let scope: Scope = 'tree'
// hops of the latest work that reached this session; whatever it sends on is one deeper
let inbound: number | undefined
// the running main-session turn, if any
let turnId: string | undefined
// identical messages already auto-run: a repeat waits for a button
const autoSeen = new Set<string>()
const autoLog: string[] = []
const LOG_MAX = 20
// messages auto mode declined to run: they stay in the bar for the buttons
const held = new Set<string>()
// ids that are no longer waiting: not read again on each poll
const finished = new Set<string>()
const toasted = new Set<string>()
const noted = new Set<string>()

type Action = 'start' | 'decline' | 'give' | 'dismiss'

function ioFor($: EngineInterface): Io {
  return {
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path),
    now: () => $.clock.now(),
  }
}

/** Runs slash commands other sessions asked for. Every live session runs them, not just the leader. */
async function runCommands($: EngineInterface) {
  if (box === undefined) return
  const now = await $.clock.now()
  for (const c of await box.commands(ranCmds)) {
    ranCmds.add(c.id)
    // a request dated in the future is not run: it would run in every new session until that date
    if (c.createdAt < startedAt || now - c.createdAt > CMD_MAX_AGE_MS || c.createdAt > now + 60_000) continue
    if (c.fromSession === sid || !c.targets.includes(box.me.slug)) continue
    const name = c.command.toLowerCase()
    const why = !autoOn ? 'auto mode is off here'
      : autoCount >= AUTO_CAP ? `session cap of ${AUTO_CAP} auto actions reached`
      : trust !== '*' && !trust.includes(c.fromSlug) ? 'sender not trusted, see /autolink trust'
      : !ALLOWED.has(name) ? 'not allowed'
      : !(await box.canReach(c.fromSlug, myPath, scope)) ? 'sender is out of reach'
      : undefined
    if (why !== undefined) {
      log(`did not run /${c.command} from ${c.from} (${why})`)
      await box.ack(c, sid, false, why).catch(() => undefined)
      continue
    }
    autoCount++
    try {
      // acked first: /reload-plugins can reload this mod, and the old instance's await then never returns
      await box.ack(c, sid, true, 'ran').catch(() => undefined)
      // with no args: a sender's /compact text would become this chat's summary instructions
      await $.command.run({ command: name, args: '' })
      log(`ran /${name} for ${c.from}`)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      log(`could not run /${c.command} for ${c.from}: ${text}`)
      await box.ack(c, sid, false, text).catch(() => undefined)
    }
  }
}

// a poll can wait on a queued command; the next one must not act on the same messages meanwhile
let isPolling = false

async function poll($: EngineInterface) {
  if (box === undefined || isPolling) return
  isPolling = true
  await loadAuto($)
  await runCommands($).catch(() => undefined)
  try {
    if (!(await box.isLeader(sid))) {
      await update($, pending, () => [])
      return
    }
    const fresh = await box.inbox(finished)
    const waiting = fresh.filter(m => m.status === 'new')
    for (const m of fresh) if (m.status !== 'new') finished.add(m.id)
    for (const m of waiting) {
      if (m.kind === 'result' && !noted.has(m.id)) {
        await box.noteResult(m)
        noted.add(m.id)
      }
    }
    for (const m of waiting) {
      if (finished.has(m.id) || !autoOn || held.has(m.id)) continue
      const why =
        autoBlock(m) ??
        (m.kind === 'result' && !(await box.answersMine(m)) ? 'not a reply to work sent from here' : undefined) ??
        (await box.canReach(m.fromSlug, myPath, scope) ? undefined : 'sender is out of reach')
      if (why !== undefined) {
        held.add(m.id)
        log(`held for you (${why}): ${m.kind} from ${m.from}, id ${m.id}`)
        continue
      }
      autoCount++
      autoSeen.add(autoKey(m))
      log(`auto ${m.kind === 'task' ? 'started work from' : 'delivered reply from'} ${m.from}: "${m.title}"`)
      $.ui.toast(`${m.kind === 'task' ? 'Working on' : 'Reply received:'} "${m.title}" (${m.from}, auto)`)
      void act($, m, m.kind === 'task' ? 'start' : 'give').catch(() => undefined)
    }
    const shown = waiting.filter(m => !finished.has(m.id))
    await update($, pending, () => shown)
    const arrived = shown.filter(m => !toasted.has(m.id))
    for (const m of arrived) toasted.add(m.id)
    const [one] = arrived
    if (arrived.length === 1 && one) $.ui.toast(headline(one) + one.title)
    else if (arrived.length > 1) $.ui.toast(`📨 ${arrived.length} project-link messages waiting`)
  } catch {
    // a bad read this round; the next poll tries again
  } finally {
    isPolling = false
  }
}

/** auto.json is one setting for every project: read it again each poll, so /autolink in one session reaches the others. */
async function loadAuto($: EngineInterface) {
  try {
    const c = JSON.parse(await $.fs.read(`${claudeDir}/project-link/auto.json`)) as { on?: unknown; trust?: unknown; scope?: unknown }
    autoOn = c.on === true
    trust = c.trust === '*' ? '*' : Array.isArray(c.trust) ? c.trust.filter(isSlug) : []
    scope = c.scope === 'children' ? 'children' : 'tree'
  } catch {
    // no settings, or settings that do not parse: auto mode is off and nothing is trusted
    autoOn = false
    trust = []
    scope = 'tree'
  }
}

const autoKey = (m: Message) => `${m.fromSlug}|${m.kind}|${m.title}|${m.body}`

function autoBlock(m: Message): string | undefined {
  if (autoCount >= AUTO_CAP) return `session cap of ${AUTO_CAP} auto actions reached`
  if (trust !== '*' && !trust.includes(m.fromSlug)) return 'sender not trusted, see /autolink trust'
  if ((m.hops ?? 0) > MAX_HOPS) return `passed on more than ${MAX_HOPS} times`
  if (autoSeen.has(autoKey(m))) return 'identical to one already run'
  return undefined
}

function log(text: string) {
  autoLog.push(text)
  if (autoLog.length > LOG_MAX) autoLog.shift()
}

function headline(m: Message) {
  if (m.kind === 'task') return `📨 Work from ${m.from}: `
  return m.outcome === 'declined' ? `⛔ ${m.from} declined: ` : `✅ ${m.from} finished: `
}

/** This chat as other sessions see it: cache age, size, and token-lens's quality score. */
async function chat($: EngineInterface): Promise<Chat> {
  const tokens = (await $.session.usage().catch(() => undefined))?.context.tokens ?? null
  let quality: number | null = null
  try {
    // token-lens writes this file after each answer of the session
    const id = await $.session.id().catch(() => sid)
    const q = JSON.parse(await $.fs.read(`${claudeDir}/token-lens/quality-${id}.json`)) as { score?: unknown }
    const v = q.score
    if (typeof v === 'number') quality = v
  } catch {
    // no token-lens score for this session
  }
  return { lastRequest, tokens, quality }
}

const beat = ($: EngineInterface) => chat($).then(c => box?.heartbeat(sid, lastActive, c)).catch(() => undefined)

/**
 * Compacts the chat before an incoming message lands: when the sender asked (`want` true), or, unless it said no,
 * when the cache is cold and the quality low, so the message does not re-write a poor context into the cache.
 * It queues the built-in /compact: a mod's own compaction call is refused in the desktop app's (SDK) sessions.
 */
async function compactIfCold($: EngineInterface, want?: boolean) {
  if (want === false) return
  // a chat in a turn is warm; the sender's true still compacts it (the /compact waits until idle)
  if (want !== true && (turnId !== undefined || !needsCompact(await chat($), await $.clock.now()))) return
  const isDone = await $.command.run({ command: 'compact', args: 'Keep the open tasks and the latest requests; a message from another session follows.' })
    .then(() => true, () => false)
  // a refused compaction leaves the chat cold
  if (isDone) lastRequest = await $.clock.now()
}

function press($: EngineInterface, m: Message, action: Action) {
  return act($, m, action).catch((err: unknown) => $.ui.toast(`project-link: ${String(err)}`))
}

async function act($: EngineInterface, m: Message, action: Action) {
  if (box === undefined) return
  finished.add(m.id)
  await update($, pending, list => list.filter(x => x.id !== m.id))
  if (action === 'start' || action === 'give') {
    // the status first: a session that becomes leader meanwhile must not take it too
    if (!(await box.claim(m, action === 'start' ? 'started' : 'done', sid))) return
    inbound = m.hops ?? 0
    await compactIfCold($, m.compact)
    const r = await $.prompt.submit({ text: action === 'start' ? taskPrompt(m) : resultPrompt(m) })
      .catch((err: unknown) => ({ drop: String(err) }))
    if (r.drop !== undefined) {
      // refused (a hook, another mod): back in the bar for the buttons
      await box.setStatus(m, 'new')
      finished.delete(m.id)
      held.add(m.id)
      await update($, pending, list => [...list.filter(x => x.id !== m.id), m])
      $.ui.toast(`project-link could not hand "${m.title}" to Claude: ${r.drop}`)
    }
  } else if (action === 'decline') {
    await box.reply(m.id, `The "${box.me.name}" project declined this request.`, 'declined')
  } else {
    await box.setStatus(m, 'dismissed')
  }
}

async function setUp($: EngineInterface, isInteractive: boolean) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
  if (configDir === undefined) return
  claudeDir = configDir
  myPath = await $.session.root()
  const name = oneLine(folderName(myPath))
  box = mailbox(ioFor($), `${configDir}/project-link`, { name, slug: projectSlug(myPath) })
  await box.claimSlug(myPath)

  await $.tool.register({
    name: 'list_projects',
    description:
      'List the other Claude Code projects on this computer that you can send work to with send_work, and whether each is open right now.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'send_work',
    description:
      'Send a piece of work to another Claude Code project on this computer (project-link). It shows up in that project for the user to start; ' +
      'when that project finishes, its reply comes back to this one. Use it when the user asks to hand off, delegate, ask or tell something to another project. ' +
      'The other project cannot see this conversation, so write `task` to stand on its own: the goal, the context, file paths, and what to send back. ' +
      'Use this (not SendMessage / send_message) to talk to another session. ' +
      'The message waits until the other session finishes its current work. ' +
      COMPACT_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project to send to, by folder name (see list_projects).' },
        title: { type: 'string', description: 'A short title, a few words (one line, up to 120 characters).' },
        task: { type: 'string', description: 'The full request, written to stand on its own.' },
        compact: COMPACT_PROP,
      },
      required: ['project', 'title', 'task'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'reply_work',
    description:
      'Answer a project-link work request (a message starting "[project-link] Work request" with an id). Call it once when the work is done, ' +
      'or set declined if it cannot be done. The reply goes back to the project that asked.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The work request id.' },
        result: { type: 'string', description: 'What you did, the results, and anything the other project needs to carry on.' },
        declined: { type: 'boolean', description: 'True if you could not or should not do it; explain why in result.' },
      },
      required: ['id', 'result'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'work_status',
    description: 'Show project-link work waiting in this project, work in progress here, and work sent from here with its status.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'read_project_context',
    description:
      'Read what the newest Claude session of another reachable project has been doing: its latest user and assistant turns. ' +
      'Use it to understand what each project is working on, e.g. to pick the right project to route a prompt to.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project, by folder name (see list_projects).' },
        turns: { type: 'number', description: 'How many recent turns to return (default 20, max 60).' },
      },
      required: ['project'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'project_overview',
    description:
      'A short entry per reachable project: open now, when it was last active, the last thing the user asked and the last thing Claude said. ' +
      'Use it first to see what every project is doing; then read_project_context for detail on the ones that matter.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'route_prompt',
    description:
      'Deliver a prompt, word for word, to the right project: use this after improving or rewriting the user prompt. ' +
      'Pick the project with project_overview / read_project_context. The prompt is sent to that project as a work request and its reply comes back here. ' +
      'Use this (not SendMessage / send_message) to prompt another session. It waits until that session finishes its current work. ' +
      COMPACT_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project to deliver to, by folder name.' },
        prompt: { type: 'string', description: 'The finished prompt, exactly as the project should receive it.' },
        title: { type: 'string', description: 'Optional short title (one line, up to 120 characters); defaults to the start of the prompt.' },
        compact: COMPACT_PROP,
      },
      required: ['project', 'prompt'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'run_command',
    description:
      'Make other Claude sessions run /reload-plugins or /compact (no other command is allowed; arguments are dropped). Every open session of the target projects runs it, ' +
      'not only the most recent one; this session does not. Use it when the user wants the same command run in other chats ("reload plugins in every other chat"). ' +
      'Each session runs it once idle, and only where auto mode is on and this project is trusted. work_status shows which sessions ran it.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The slash command with its arguments, e.g. "/reload-plugins".' },
        project: { type: 'string', description: 'A project by folder name, or "all" (default): every reachable project and this project\'s other sessions.' },
      },
      required: ['command'],
    },
    isDeferred: false,
  })
  await $.command.register({
    name: 'autolink',
    description:
      'project-link: /autolink on|off, trust <project...>|all, scope tree|children, log - control automatic sending and receiving',
  })
  await $.command.register({
    name: 'inbox',
    description: 'project-link: show work waiting here and work sent from here',
  })

  await loadAuto($)
  // a headless run (claude -p, an SDK worker) sends work with the tools but takes none: nobody can press Start there
  if (!isInteractive) return
  sid = await $.session.id().catch(() => `s${Math.random().toString(36).slice(2, 10)}`)
  lastActive = await $.clock.now()
  startedAt = lastActive
  await beat($)
  await box.announce(myPath)
  $.clock.every(ANNOUNCE_MS, () => void beat($))
  $.clock.every(POLL_MS, () => void poll($))
  $.clock.every(ANNOUNCE_MS, () => void box?.announce(myPath).catch(() => undefined))
  $.clock.after(0, () => void poll($))
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const COMPACT_HELP =
  'list_projects shows whether the target chat is cold (its prompt cache expired) and its quality score (token-lens, 0-100). ' +
  'Left to decide, a cold chat with quality under 70 compacts before your message lands; a warm or good one takes it as is. Set compact to choose yourself.'
const COMPACT_PROP = {
  type: 'boolean',
  description:
    'Optional. true: the target chat compacts before your message lands (for a cold chat of low quality). ' +
    'false: it takes the message as is (for a good chat whose detail matters). Leave it out to let the target decide by its cache and quality.',
}

/** What a sender learns about the chat its message lands on. */
async function chatNote(p: Project, now: number, compact: boolean | undefined) {
  const told = compact === undefined ? '' : ` You set compact: ${compact}, so it ${compact ? 'compacts first' : 'takes it as is'}.`
  return ` Target ${describeChat(await box?.chatOf(p), now)}.${told}`
}

export const register: Register = (on, options) => {
  // /messages and /edit: change or delete earlier messages so Claude rereads the new text
  registerEdit(on, options)

  on('session.start', async ($, e, next) => {
    await setUp($, e.isInteractive)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__project-link__list_projects' }, async $ => {
    if (box === undefined) return { result: 'project-link could not find the Claude config folder.' }
    const now = await $.clock.now()
    const projects = await box.projects(`${claudeDir}/projects`, myPath, scope)
    if (projects.length === 0) return { result: 'No other projects found yet.' }
    const lines = await Promise.all(projects.map(async p =>
      p.isSetUp === false
        ? `- ${p.name} (not set up: it has not run project-link, so it cannot take work yet)`
        : `- ${p.name}${p.slug === slug(p.name) ? '' : ` [slug ${p.slug}]`}${box?.isActive(p, now) ? ` (open now; ${describeChat(await box.chatOf(p), now)})` : ''}`))
    return { result: `Projects you can send work to:\n${lines.join('\n')}` }
  }).catch(() => FAILED)

  on('tool.call', { tool: 'mcp__project-link__send_work' }, async ($, e) => {
    if (box === undefined) return { result: 'project-link could not find the Claude config folder.' }
    const [project, title, task] = [str(e.project), oneLine(str(e.title)), str(e.task)]
    if (project === '' || title === '' || oneLine(task) === '') return { result: 'project, title and task are all required.' }
    const target = box.resolve(project, await box.projects(`${claudeDir}/projects`, myPath, scope))
    if (typeof target === 'string') return { result: target }
    if (target.isSetUp === false) return { result: notSetUp(target) }
    const compact = typeof e.compact === 'boolean' ? e.compact : undefined
    const sent = await box.send(target, title, task, inbound === undefined ? 0 : inbound + 1, compact)
    const now = await $.clock.now()
    const isOpen = box.isActive(target, now)
    return {
      result:
        (sent.deduped
          ? `Already sent and still waiting: "${title}" to ${target.name} (id ${sent.id}); no second copy was made. `
          : `Sent "${title}" to ${target.name} (id ${sent.id}). `) +
        (isOpen
          ? 'Status: waiting. That project is open; one session there (the most recently active) takes it when its current turn ends: auto mode there starts it, otherwise its user presses Start.'
          : 'Status: waiting. That project is not open right now: it shows up there the next time it is opened, for auto mode or its user to start.') +
        (isOpen ? await chatNote(target, now, compact) : '') +
        ' Check work_status for started/done/declined and which session picked it up. Its reply will come back to this project.',
    }
  }).catch(() => FAILED)

  on('tool.call', { tool: 'mcp__project-link__reply_work' }, async ($, e) => {
    if (box === undefined) return { result: 'project-link could not find the Claude config folder.' }
    const [id, result] = [str(e.id), str(e.result)]
    if (id === '' || oneLine(result) === '') return { result: 'id and result are both required.' }
    const sent = await box.reply(id, result, e.declined === true ? 'declined' : 'done')
    if (typeof sent === 'string') return { result: sent }
    finished.add(id)
    return { result: `Reply sent to ${sent.to}.` }
  }).catch(() => FAILED)

  on('tool.call', { tool: 'mcp__project-link__work_status' }, async () => {
    if (box === undefined) return { result: 'project-link could not find the Claude config folder.' }
    return { result: await box.summary() }
  }).catch(() => FAILED)

  on('tool.call', { tool: 'mcp__project-link__read_project_context' }, async ($, e) => {
    if (box === undefined) return { result: 'project-link could not find the Claude config folder.' }
    const q = str(e.project)
    if (q === '') return { result: 'project is required.' }
    const target = box.resolve(q, await box.projects(`${claudeDir}/projects`, myPath, scope))
    if (typeof target === 'string') return { result: target }
    const n = Math.min(60, Math.max(1, typeof e.turns === 'number' ? Math.floor(e.turns) : 20))
    return { result: await box.context(target, `${claudeDir}/projects`, n, cwd => related(myPath, cwd, scope)) }
  }).catch(() => FAILED)

  on('tool.call', { tool: 'mcp__project-link__project_overview' }, async () => {
    if (box === undefined) return { result: 'project-link could not find the Claude config folder.' }
    const projects = await box.projects(`${claudeDir}/projects`, myPath, scope)
    return { result: await box.overview(projects, `${claudeDir}/projects`, cwd => related(myPath, cwd, scope)) }
  }).catch(() => FAILED)

  on('tool.call', { tool: 'mcp__project-link__route_prompt' }, async ($, e) => {
    if (box === undefined) return { result: 'project-link could not find the Claude config folder.' }
    const [project, prompt] = [str(e.project), str(e.prompt)]
    if (project === '' || oneLine(prompt) === '') return { result: 'project and prompt are both required.' }
    const target = box.resolve(project, await box.projects(`${claudeDir}/projects`, myPath, scope))
    if (typeof target === 'string') return { result: target }
    if (target.isSetUp === false) return { result: notSetUp(target) }
    const title = oneLine(str(e.title)) || clip(oneLine(prompt), 60).trimEnd()
    const body = `A prompt routed to you from "${box.me.name}". That project's Claude wrote it from a request of the user there; act on it as a work request:\n\n${prompt}`
    const compact = typeof e.compact === 'boolean' ? e.compact : undefined
    const sent = await box.send(target, title, body, inbound === undefined ? 0 : inbound + 1, compact)
    const now = await $.clock.now()
    return {
      result:
        (sent.deduped
          ? `Already routed and still waiting (id ${sent.id}); no second copy was made. `
          : `Routed to ${target.name} (id ${sent.id}). `) +
        (box.isActive(target, now)
          ? 'Status: waiting. That project is open; one session there (the most recently active) takes it when its current turn ends: auto mode there starts it, otherwise its user presses Start.'
          : 'Status: waiting. That project is not open right now: it shows up there the next time it is opened, for auto mode or its user to start.') +
        (box.isActive(target, now) ? await chatNote(target, now, compact) : '') + ' ' +
        'Check work_status for started/done/declined and which session picked it up. Its reply will come back to this project.',
    }
  }).catch(() => FAILED)

  on('tool.call', { tool: 'mcp__project-link__run_command' }, async (_$, e) => {
    if (box === undefined) return { result: 'project-link could not find the Claude config folder.' }
    const m = /^\/?([a-z0-9:_-]+)\s*(.*)$/is.exec(str(e.command))
    if (m === null) return { result: 'command must be a slash command such as "/reload-plugins".' }
    const [name, args] = [(m[1] ?? '').toLowerCase(), (m[2] ?? '').trim()]
    if (!ALLOWED.has(name)) return { result: `/${name} is not allowed from another session. Allowed: ${[...ALLOWED].map(c => `/${c}`).join(', ')}.` }
    const all = await box.projects(`${claudeDir}/projects`, myPath, scope)
    const which = str(e.project)
    let targets: string[]
    if (which === '' || which.toLowerCase() === 'all') {
      targets = [box.me.slug, ...all.filter(p => p.isSetUp !== false).map(p => p.slug)]
    } else {
      const target = box.resolve(which, all)
      if (typeof target === 'string') return { result: target }
      if (target.isSetUp === false) return { result: notSetUp(target) }
      targets = [target.slug]
    }
    const c = await box.broadcast(targets, name, sid)
    return {
      result:
        `Asked every open session of ${targets.length} project${targets.length === 1 ? '' : 's'} to run /${name} (id ${c.id})${args ? ', with no arguments (they are dropped)' : ''}; ` +
        'each runs it when idle (this session does not). Check work_status in a minute to see which sessions ran it.',
    }
  }).catch(() => FAILED)

  // the engine puts another session's direct message inside the running turn: hold it for a turn of its own.
  // An idle chat that is cold and of low quality compacts first, as for project-link messages.
  // on a timer: a call from this hook would end with its dispatch. Reports from this session's own subagents (<agent-message>) still land at once.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'peer' || !e.text.startsWith('<cross-session-message')) return next(e)
    const busy = e.turnId !== undefined
    if (!busy && !needsCompact(await chat($), await $.clock.now())) return next(e)
    const land = () =>
      $.prompt.submit({ text: e.text }).then(r => {
        if (r.drop !== undefined) $.ui.toast(`project-link could not deliver a message from another session (${r.drop}): ${oneLine(e.text)}`)
      })
    $.clock.after(0, () => void (busy ? land() : compactIfCold($).then(land))
      .catch(() => $.ui.toast('project-link lost a message from another session; it could not be held.')))
    return { drop: busy ? 'A message from another session waits until this work is done.' : 'A message from another session waits while this cold chat compacts.' }
  })

  on('turn.start', async ($, e, next) => {
    // a subagent's turn is part of the main turn; taking its id would leave the main turn open forever
    if (e.agentId !== undefined) return next(e)
    turnId = e.turnId
    lastActive = await $.clock.now()
    lastRequest = lastActive
    void beat($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.turnId === turnId) {
      turnId = undefined
      lastRequest = await $.clock.now()
    }
    return next(e)
  })

  // keepwarm pings go through model.fork: a pinged chat is warm, so it is not compacted
  on('model.fork', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.value.isAnswered) lastRequest = await $.clock.now()
    return r
  })

  on('command.run', { command: 'autolink' }, async ($, e) => {
    if (box === undefined) return { text: 'project-link could not find the Claude config folder.' }
    const words = String((e as { args?: unknown }).args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [cmd, ...rest] = words
    const save = () => $.fs.write(`${claudeDir}/project-link/auto.json`, JSON.stringify({ on: autoOn, trust, scope }))
    await loadAuto($)
    if (cmd === 'on' || cmd === 'off') {
      autoOn = cmd === 'on'
      autoCount = 0
      held.clear()
      await save()
    } else if (cmd === 'trust' && rest.length > 0) {
      // names are project slugs, e.g. video-site; a bare "trust" only shows the list
      const named = rest.map(slug).filter(isSlug)
      if (rest[0] !== 'all' && named.length === 0) return { text: 'No project slug in that, so the trust list is unchanged. A slug is a folder name such as video-site, or p-88o62 for a folder name with no ASCII letter or digit (list_projects shows it).' }
      trust = rest[0] === 'all' ? '*' : named
      held.clear()
      await save()
    } else if (cmd === 'scope' && (rest[0] === 'tree' || rest[0] === 'children')) {
      scope = rest[0]
      await save()
    } else if (cmd === 'log') {
      return { text: autoLog.length ? autoLog.join('\n') : 'Nothing automatic yet this session.' }
    }
    const isKnown = cmd === undefined || ['on', 'off', 'trust'].includes(cmd) || (cmd === 'scope' && (rest[0] === 'tree' || rest[0] === 'children'))
    // each slug with its folder: a slug goes to the first folder of that name to run project-link
    const named = trust === '*' ? [] : await Promise.all(trust.map(async s => `${s} (${plain((await box?.pathOf(s)) ?? 'not set up yet')})`))
    return {
      text:
        (isKnown ? '' : `Unknown: /autolink ${words.join(' ')}\n`) +
        `project-link auto mode: ${autoOn ? 'ON' : 'OFF'} (${autoCount}/${AUTO_CAP} auto actions this session)\n` +
        `trusted senders: ${trust === '*' ? 'all reachable projects' : named.join(', ') || 'none'}\n` +
        `scope: ${scope === 'tree' ? 'own folder, its subfolders, parents and siblings' : 'own folder, its subfolders and parents'}\n` +
        'Commands: /autolink on|off, /autolink trust <project-slug...>|all, /autolink scope tree|children, /autolink log',
    }
  })

  on('command.run', { command: 'inbox' }, async () => {
    if (box === undefined) return { text: 'project-link could not find the Claude config folder.' }
    return { text: await box.summary() }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pending)
    const m = list[0]
    if (e.props.hasSurvey || m === undefined) return next(e)
    const more = list.length > 1 ? `  (+${list.length - 1} more, /inbox)` : ''
    const flat = plain(m.body)
    const preview = flat.length > 200 ? `(${m.body.length} characters) ${clip(flat, 200)}...` : flat
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{headline(m)}</Text>
          <Text wrap="truncate-end">
            {m.title}
            {m.compact === true ? ' (compacts this chat first)' : ''}
            {more}
          </Text>
        </Box>
        {e.props.maxRows >= 3 && (
          <Text dimColor wrap="truncate-end">
            {preview}
          </Text>
        )}
        {m.kind === 'task' ? (
          <Box>
            <Button key="start" label="Start" onPress={() => press($, m, 'start')} />
            <Text> </Text>
            <Button key="decline" label="Decline" dimColor onPress={() => press($, m, 'decline')} />
          </Box>
        ) : (
          <Box>
            <Button key="give" label="Give to Claude" onPress={() => press($, m, 'give')} />
            <Text> </Text>
            <Button key="dismiss" label="Dismiss" dimColor onPress={() => press($, m, 'dismiss')} />
          </Box>
        )}
      </Box>
    )
  })
}
