import { describe, test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// the test runner has timers; the engine types leave them out
declare function setTimeout(fn: (v?: unknown) => void, ms: number): unknown

const HOME = 'C:/Users/me'
const MAIL = `${HOME}/.claude/project-link`
const HERE = 'C:/Users/me/Docs/projects/Plugin Lab'
const SURFACES = ['desktop', 'terminal'] as const
const BAND = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const VIEW_PANE = {
  plugin: 'project-link',
  component: 'Pane',
  requestId: 'project-link-view',
  surface: 'desktop',
  props: { title: 'Make thumbnails', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const task = (id: string) => ({
  id, kind: 'task', from: 'Video Site', fromSlug: 'video-site',
  to: 'Plugin Lab', toSlug: 'plugin-lab', title: 'Make thumbnails',
  body: 'Make 3 thumbnails for clip 12.', createdAt: 1, status: 'new',
})

// the engine hands fs hooks Windows paths; the memory keys them with forward slashes
const norm = (path: string) => path.replace(/\\/g, '/')

/** Everything beneath the mod: a file system and prompt box in memory, this project's folder and home. */
const world = (on: On) => {
  const files = new Map<string, string>()
  const submitted: string[] = []
  // set to make the next prompt.submit refuse, as another mod or a settings hook can
  const refuse = { next: undefined as string | undefined }
  const clock = mock.clock(on, { now: 5_000_000 })
  mock.env(on, { USERPROFILE: HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: HERE }))
  on('session.id', () => ({ value: 'test-session' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__project-link__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  // the engine's own band when the mod has nothing to show
  on('ui.render', () => ({ type: 'Box' as const, children: [] }))
  on('fs.read', ($, e) => ({ value: files.get(norm(e.path)) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const dir = norm(e.path)
    const kinds = new Map<string, 'file' | 'dir'>()
    for (const key of files.keys()) {
      if (!key.startsWith(`${dir}/`)) continue
      const [first, ...rest] = key.slice(dir.length + 1).split('/')
      kinds.set(first ?? '', rest.length > 0 ? 'dir' : 'file')
    }
    return { value: [...kinds].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('prompt.submit', ($, e) => {
    if (refuse.next !== undefined) return { drop: refuse.next }
    submitted.push(e.text)
    return { text: e.text }
  })
  // the chat's size, and every compaction it was asked for (the built-in /compact the mod queues)
  const chat = { tokens: 0 }
  const compacted: unknown[] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: chat.tokens } } }) as never)
  const ran: string[] = []
  on('command.run', (_$, e) => {
    ran.push(`${e.command} ${e.args}`.trim())
    if (e.command === 'compact') {
      compacted.push(e.args)
      submitted.push('/compact')
    }
    return { text: 'ok' }
  })
  files.set(`${MAIL}/auto.json`, '{"on":false}')
  current = clock
  return { files, submitted, chat, compacted, ran, clock, refuse, opened }
}

// the latest world's clock: the mod's first poll runs on it just after session.start
let current: { advance: (ms: number) => Promise<unknown> } | undefined
const start = async ($: Engine) => {
  const r = await $.session.start({ cwd: HERE, surface: 'desktop', isInteractive: true })
  await current?.advance(0)
  return r
}

describe('receiving work', () => {
  for (const surface of SURFACES) {
    test(`a task shows in the bar and Start hands it to Claude (${surface})`, async ($, on) => {
      const w = world(on)
      w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
      await start($)

      const band = await $.ui.mount({ plugin: 'project-link', surface, component: 'AbovePrompt', props: BAND })
      expect(JSON.stringify(await band.drawn())).toContain('Make thumbnails')
      await band.press({ key: 'start' })

      expect(w.submitted).toHaveLength(1)
      expect(w.submitted[0]).toContain('Work request from the "Video Site" project (id t1)')
      expect(JSON.parse(w.files.get(`${MAIL}/inbox/plugin-lab/t1.json`) ?? '{}').status).toBe('started')
      expect(await band.find({ key: 'start' })).toBeUndefined()
    })
  }

  test('Decline sends a declined reply back to the sender', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/inbox/plugin-lab/t2.json`, JSON.stringify(task('t2')))
    await start($)

    const band = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await band.press({ key: 'decline' })

    const back = [...w.files.entries()].find(([k]) => k.startsWith(`${MAIL}/inbox/video-site/`))
    expect(back).toBeDefined()
    expect(JSON.parse(back?.[1] ?? '{}')).toMatchObject({ kind: 'result', replyTo: 't2', outcome: 'declined' })
    expect(w.submitted).toHaveLength(0)
  })

  test('a Start that the prompt box refuses puts the task back in the bar', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    await start($)
    const band = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    w.refuse.next = 'blocked by a test hook'
    await band.press({ key: 'start' })
    expect(w.submitted).toHaveLength(0)
    expect(JSON.parse(w.files.get(`${MAIL}/inbox/plugin-lab/t1.json`) ?? '{}').status).toBe('new')
    expect(await band.find({ key: 'start' })).toBeDefined()
    w.refuse.next = undefined
    await band.press({ key: 'start' })
    expect(w.submitted).toHaveLength(1)
  })
})

describe('reading a whole message', () => {
  test('View in the bar opens a pane with the whole body, cleaned as Claude gets it', async ($, on) => {
    const w = world(on)
    const long = 'Step one. '.repeat(30)
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify({ ...task('t1'), body: `${long}\r\nLast line\u200B.\x1b` }))
    await start($)
    const band = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(JSON.stringify(await band.drawn())).not.toContain('Last line')

    await band.press({ key: 'view' })
    expect(w.opened).toEqual(['project-link-view'])
    const pane = await $.ui.mount(VIEW_PANE as never)
    expect((await pane.find({ type: 'Text', text: /Last line/ }))?.text).toBe(`${long}\nLast line.`)
    expect((await pane.find({ type: 'Text', text: /^📨/ }))?.text).toBe('📨 Work from Video Site: Make thumbnails')
    // viewing hands nothing to Claude and leaves the task waiting
    expect(w.submitted).toHaveLength(0)
    expect(await band.find({ key: 'start' })).toBeDefined()
  })

  test('/inbox shows a View button for each waiting message; Claude still reads only ids', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    w.files.set(`${MAIL}/inbox/plugin-lab/t2.json`, JSON.stringify({ ...task('t2'), title: 'Cut the trailer', body: 'Cut a 30 second trailer.' }))
    await start($)
    const { text } = (await $.command.run({ command: 'inbox', args: '' } as never)) as { text: string }
    expect(text).not.toContain('Cut a 30 second trailer')

    const props = { command: 'inbox', args: '', text, isErrored: false }
    const row = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'CommandOutput', props } as never)
    expect(await row.find({ key: 'view-t1' })).toBeDefined()
    await row.press({ key: 'view-t2' })
    const pane = await $.ui.mount(VIEW_PANE as never)
    expect((await pane.find({ type: 'Text', text: /trailer\.$/ }))?.text).toBe('Cut a 30 second trailer.')
  })
})

describe('auto mode', () => {
  test('a task and a reply go straight to Claude with no button', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/auto.json`, '{"on":true,"trust":"*"}')
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site' }))
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    // the reply answers a task this project sent
    w.files.set(`${MAIL}/outbox/plugin-lab/s1.json`, JSON.stringify({
      ...task('s1'), from: 'Plugin Lab', fromSlug: 'plugin-lab', to: 'Video Site', toSlug: 'video-site', title: 'Thumbs',
    }))
    w.files.set(`${MAIL}/inbox/plugin-lab/r1.json`, JSON.stringify({ ...task('r1'), kind: 'result', title: 'Thumbs', replyTo: 's1', outcome: 'done' }))
    await start($)
    await new Promise(r => setTimeout(r, 20))
    expect(w.submitted).toHaveLength(2)
    expect(w.submitted.join('\n')).toContain('Work request from the "Video Site" project (id t1)')
    expect(w.submitted.join('\n')).toContain('finished the work you sent ("Thumbs"')
  })
})

describe('auto mode is off and narrow until you turn it on', () => {
  const settle = () => new Promise(r => setTimeout(r, 20))

  test('auto mode on with no trusted sender holds the task', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/auto.json`, '{"on":true}')
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site' }))
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    await start($)
    await settle()
    expect(w.submitted).toHaveLength(0)
    expect(JSON.stringify(await $.command.run({ command: 'autolink', args: 'log' } as never))).toContain('sender not trusted')
  })

  test('with no settings file, a task waits for Start', async ($, on) => {
    const w = world(on)
    w.files.delete(`${MAIL}/auto.json`)
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site' }))
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    await start($)
    await settle()
    expect(w.submitted).toHaveLength(0)
  })

  test('a trusted name from a folder out of reach waits for Start', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/auto.json`, '{"on":true,"trust":"*"}')
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'D:/Elsewhere/Video Site' }))
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    await start($)
    await settle()
    expect(w.submitted).toHaveLength(0)
    expect(JSON.stringify(await $.command.run({ command: 'autolink', args: 'log' } as never))).toContain('sender is out of reach')
  })
})

describe('a direct message from another session', () => {
  const peer = '<cross-session-message from="local_1">Please check the nav.</cross-session-message>'
  const raise = ($: Engine, text: string, over: object) =>
    $.prompt.submit({ text, origin: { kind: 'peer' }, wait: false, ...over } as never)

  test('inside a running turn it waits for a turn of its own', async ($, on) => {
    const w = world(on)
    await start($)
    const r = await raise($, peer, { turnId: 'a' })
    expect(r).toMatchObject({ drop: 'A message from another session waits until this work is done.' })
    expect(w.submitted).toEqual([])
    await w.clock.advance(0)
    expect(w.submitted).toEqual([peer])
  })

  test('with no running turn it enters as it came', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await raise($, peer, {})).toEqual({ text: peer })
    expect(w.submitted).toEqual([peer])
  })

  test("a report from this session's own subagent still lands inside the turn", async ($, on) => {
    const w = world(on)
    await start($)
    const report = '<agent-message from="a1">[Subagent hand-back] done</agent-message>'
    expect(await raise($, report, { turnId: 'a' })).toEqual({ text: report })
    expect(w.submitted).toEqual([report])
  })

  test('a prompt the person types during a turn still lands inside it', async ($, on) => {
    const w = world(on)
    await start($)
    const typed = 'Stop, use the other file.'
    expect(await raise($, typed, { turnId: 'a', origin: { kind: 'composer' } })).toEqual({ text: typed })
    expect(w.submitted).toEqual([typed])
  })
})

describe('a cold chat', () => {
  test('a big chat with an unknown last request is compacted before the task lands', async ($, on) => {
    const w = world(on)
    w.chat.tokens = 120_000
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    await start($)
    const band = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await band.press({ key: 'start' })

    expect(w.compacted).toHaveLength(1)
    expect(w.submitted[0]).toBe('/compact')
    expect(w.submitted[1]).toContain('(id t1)')
  })

  test('a small chat is sent to as it is', async ($, on) => {
    const w = world(on)
    w.chat.tokens = 8_000
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    await start($)
    const band = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await band.press({ key: 'start' })

    expect(w.compacted).toHaveLength(0)
    expect(w.submitted).toHaveLength(1)
  })

  const QUALITY = `${HOME}/.claude/token-lens/quality-test-session.json`
  const press = async ($: Engine, key: string) => {
    const band = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await band.press({ key })
  }

  test('a big cold chat of good quality takes the task as is; a small one of low quality compacts', async ($, on) => {
    const w = world(on)
    w.chat.tokens = 120_000
    w.files.set(QUALITY, '{"score": 85}')
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    await start($)
    await press($, 'start')
    expect(w.compacted).toHaveLength(0)

    w.chat.tokens = 9_000
    w.files.set(QUALITY, '{"score": 50}')
    w.files.set(`${MAIL}/inbox/plugin-lab/t2.json`, JSON.stringify(task('t2')))
    await start($)
    await press($, 'start')
    expect(w.compacted).toHaveLength(1)
    expect(w.submitted.slice(-2)).toEqual(['/compact', expect.stringContaining('(id t2)')])
  })

  test("the sender's compact: false wins over the rule", async ($, on) => {
    const w = world(on)
    w.chat.tokens = 120_000
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify({ ...task('t1'), compact: false }))
    await start($)
    await press($, 'start')
    expect(w.compacted).toHaveLength(0)
  })

  test("the sender's compact: true compacts a warm chat too", async ($, on) => {
    const w = world(on)
    on('turn.start', (_$, e) => ({ turnId: e.turnId ?? 'a' }) as never)
    on('turn.complete', () => ({ text: 'ok' }) as never)
    w.chat.tokens = 8_000
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify({ ...task('t1'), compact: true }))
    await start($)
    await $.turn.start({ turnId: 'a' } as never)
    await $.turn.complete({ turnId: 'a', answer: 'ok', durationMs: 1 } as never)
    await press($, 'start')
    expect(w.compacted).toHaveLength(1)
  })

  test('an idle cold chat of low quality compacts before a direct message from another session lands', async ($, on) => {
    const w = world(on)
    w.files.set(QUALITY, '{"score": 40}')
    await start($)
    const peer = '<cross-session-message from="local_1">Please check the nav.</cross-session-message>'
    const r = await $.prompt.submit({ text: peer, origin: { kind: 'peer' }, wait: false } as never)
    expect(r).toMatchObject({ drop: 'A message from another session waits while this cold chat compacts.' })
    await w.clock.advance(0)
    await new Promise(res => setTimeout(res, 20))
    expect(w.submitted).toEqual(['/compact', peer])
  })

  test('a chat that ran a turn a minute ago is warm and is not compacted', async ($, on) => {
    const w = world(on)
    on('turn.start', (_$, e) => ({ turnId: e.turnId ?? 'a' }) as never)
    on('turn.complete', () => ({ text: 'ok' }) as never)
    w.chat.tokens = 120_000
    w.files.set(`${MAIL}/inbox/plugin-lab/t1.json`, JSON.stringify(task('t1')))
    await start($)
    await $.turn.start({ turnId: 'a' } as never)
    await $.turn.complete({ turnId: 'a', answer: 'ok', durationMs: 1 } as never)
    const band = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await band.press({ key: 'start' })

    expect(w.compacted).toHaveLength(0)
  })
})

describe('reading another project', () => {
  test('read_project_context returns the latest turns of the newest session', async ($, on) => {
    const w = world(on)
    w.files.set(`${HOME}/.claude/projects/C--Users-me-Docs-projects-School/s1.jsonl`, [
      // hidden characters in the other chat do not reach this Claude
      JSON.stringify({ type: 'user', cwd: 'C:\\Users\\me\\Docs\\projects\\School', message: { content: 'fix the\u202E nav\u{E0049}\u{E0067}\uFE01\u{E0100}\uFE02' } }),
      JSON.stringify({ type: 'assistant', cwd: 'C:\\Users\\me\\Docs\\projects\\School', message: { content: [{ type: 'text', text: 'on it' }] } }),
    ].join(String.fromCharCode(10)))
    await start($)
    const r = await $.tool.call({ tool: 'mcp__project-link__read_project_context', project: 'school' })
    expect(String(r.result)).toContain('USER: fix the nav')
    expect(String(r.result)).not.toContain(String.fromCodePoint(0xe0049))
    expect(String(r.result)).not.toMatch(/[\uFE00-\uFE0F]/)
    expect(String(r.result)).toContain('CLAUDE: on it')
  })

  test('a registered folder whose session folder an out-of-reach one shares is not read either', async ($, on) => {
    const w = world(on)
    // projects/old-School is a sibling; projects-old/School writes its sessions to the same folder
    w.files.set(`${MAIL}/projects/old-school.json`, JSON.stringify({ name: 'old-School', slug: 'old-school', path: 'C:/Users/me/Docs/projects/old-School' }))
    w.files.set(`${HOME}/.claude/projects/C--Users-me-Docs-projects-old-School/s1.jsonl`,
      JSON.stringify({ type: 'user', cwd: 'C:\\Users\\me\\Docs\\projects-old\\School', message: { content: 'private notes' } }))
    await start($)
    const r = await $.tool.call({ tool: 'mcp__project-link__read_project_context', project: 'old-school' })
    expect(String(r.result)).toContain('outside this project')
    expect(String(r.result)).not.toContain('private notes')
  })

  test('a folder whose name only looks reachable is not read', async ($, on) => {
    const w = world(on)
    // projects-old/School encodes to the same prefix as a sibling of this project
    w.files.set(`${HOME}/.claude/projects/C--Users-me-Docs-projects-old-School/s1.jsonl`,
      JSON.stringify({ type: 'user', cwd: 'C:\\Users\\me\\Docs\\projects-old\\School', message: { content: 'private notes' } }))
    await start($)
    const r = await $.tool.call({ tool: 'mcp__project-link__read_project_context', project: 'old school' })
    expect(String(r.result)).toContain('outside this project')
    expect(String(r.result)).not.toContain('private notes')
  })
})

describe('sending work', () => {
  test('send_work drops the task in the other project, and the reply comes back to Claude', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site' }))
    await start($)

    const sent = await $.tool.call({ tool: 'mcp__project-link__send_work', project: 'video', title: 'Thumbs', task: 'Make 3 thumbnails.' })
    expect(String(sent.result)).toContain('Sent "Thumbs" to Video Site')
    const [path, text] = [...w.files.entries()].find(([k]) => k.startsWith(`${MAIL}/inbox/video-site/`)) ?? ['', '{}']
    const id = JSON.parse(text).id as string
    expect(path).toEndWith(`${id}.json`)

    // the other project replies: its result lands in this project's inbox
    w.files.set(`${MAIL}/inbox/plugin-lab/r1.json`, JSON.stringify({
      id: 'r1', kind: 'result', from: 'Video Site', fromSlug: 'video-site',
      to: 'Plugin Lab', toSlug: 'plugin-lab', title: 'Thumbs', body: 'Thumbnails are in /thumbs.',
      createdAt: 2, status: 'new', replyTo: id, outcome: 'done',
    }))
    await start($)

    const band = await $.ui.mount({ plugin: 'project-link', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await band.press({ key: 'give' })

    expect(w.submitted[0]).toContain('finished the work you sent ("Thumbs"')
    expect(w.submitted[0]).toContain('Thumbnails are in /thumbs.')
    expect(JSON.parse(w.files.get(`${MAIL}/outbox/plugin-lab/${id}.json`) ?? '{}').status).toBe('done')
  })

  test("the sender sees the target's chat, and its compact choice travels with the task", async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site', lastSeen: 5_000_000 }))
    w.files.set(`${MAIL}/sessions/video-site/s1.json`, JSON.stringify({ seen: 5_000_000, active: 1, lastRequest: 5_000_000 - 2 * 3600_000, tokens: 120_000, quality: 55 }))
    w.files.set(`${MAIL}/projects/p-88o62.json`, JSON.stringify({ name: '\u65E5\u672C', slug: 'p-88o62', path: 'C:/Users/me/Docs/projects/\u65E5\u672C' }))
    await start($)

    const list = await $.tool.call({ tool: 'mcp__project-link__list_projects' })
    expect(String(list.result)).toContain('Video Site (open now; chat cold (last model call 2h ago), 120k tokens, quality 55/100; left to decide, it compacts first)')
    expect(String(list.result)).toContain('- \u65E5\u672C [slug p-88o62]')

    const sent = await $.tool.call({ tool: 'mcp__project-link__send_work', project: 'video', title: 'Thumbs', task: 'Make 3 thumbnails.', compact: false })
    expect(String(sent.result)).toContain('Target chat cold')
    expect(String(sent.result)).toContain('You set compact: false, so it takes it as is.')
    const [, text] = [...w.files.entries()].find(([k]) => k.startsWith(`${MAIL}/inbox/video-site/`)) ?? ['', '{}']
    expect(JSON.parse(text).compact).toBe(false)
  })

  test('send_work refuses an unknown project and names the known ones', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/projects/school.json`, JSON.stringify({ name: 'School', slug: 'school', path: 'C:/Users/me/Docs/projects/School' }))
    await start($)

    const sent = await $.tool.call({ tool: 'mcp__project-link__send_work', project: 'nope', title: 'x', task: 'y' })

    expect(String(sent.result)).toContain('No project called "nope". Known projects: School.')
  })

  test('a task, prompt or result made only of invisible characters is refused', async ($, on) => {
    world(on)
    await start($)
    const sent = await $.tool.call({ tool: 'mcp__project-link__send_work', project: 'video', title: 'Thumbs', task: '\u200B\u3164' })
    expect(String(sent.result)).toContain('are all required')
    const routed = await $.tool.call({ tool: 'mcp__project-link__route_prompt', project: 'video', prompt: '\u200B' })
    expect(String(routed.result)).toContain('are both required')
    const replied = await $.tool.call({ tool: 'mcp__project-link__reply_work', id: 'x1', result: '\uFE01' })
    expect(String(replied.result)).toContain('are both required')
  })
})

describe('auto-mode safety', () => {
  const settle = () => new Promise(r => setTimeout(r, 20))

  test('an untrusted sender, a deep hop count and a repeat all wait for a button', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/auto.json`, JSON.stringify({ on: true, trust: ['video-site'] }))
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site' }))
    w.files.set(`${MAIL}/inbox/plugin-lab/a.json`, JSON.stringify({ ...task('a'), fromSlug: 'stranger', from: 'Stranger' }))
    w.files.set(`${MAIL}/inbox/plugin-lab/b.json`, JSON.stringify({ ...task('b'), hops: 101 }))
    w.files.set(`${MAIL}/inbox/plugin-lab/c.json`, JSON.stringify({ ...task('c'), title: 'ok', body: 'fine' }))
    w.files.set(`${MAIL}/inbox/plugin-lab/d.json`, JSON.stringify({ ...task('d'), title: 'ok', body: 'fine' }))
    await start($)
    await settle()
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('(id c)')
    const log = await $.command.run({ command: 'autolink', args: 'log' } as never)
    expect(JSON.stringify(log)).toContain('identical to one already run')
    expect(JSON.stringify(log)).toContain('sender not trusted')
    expect(JSON.stringify(log)).toContain('passed on more than')
  })

  test('a result that answers no task sent from here waits for a button', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/auto.json`, JSON.stringify({ on: true, trust: '*' }))
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site' }))
    w.files.set(`${MAIL}/inbox/plugin-lab/r9.json`, JSON.stringify({ ...task('r9'), kind: 'result', replyTo: 'never-sent', outcome: 'done' }))
    await start($)
    await settle()
    expect(w.submitted).toHaveLength(0)
    const log = await $.command.run({ command: 'autolink', args: 'log' } as never)
    expect(JSON.stringify(log)).toContain('not a reply to work sent from here')
  })

  test('route_prompt delivers the prompt word for word with the next hop count', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/auto.json`, '{"on":false}')
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site' }))
    await start($)
    const r = await $.tool.call({ tool: 'mcp__project-link__route_prompt', project: 'video', prompt: 'Make 3 thumbnails, bold text.' })
    expect(String(r.result)).toContain('Routed to Video Site')
    const [, text] = [...w.files.entries()].find(([k]) => k.startsWith(`${MAIL}/inbox/video-site/`)) ?? ['', '{}']
    expect(JSON.parse(text).body).toContain('Make 3 thumbnails, bold text.')
  })

  test('project_overview shows each project with its last ask', async ($, on) => {
    const w = world(on)
    w.files.set(`${HOME}/.claude/projects/C--Users-me-Docs-projects-School/s1.jsonl`, JSON.stringify({ type: 'user', cwd: 'C:\\Users\\me\\Docs\\projects\\School', message: { content: 'fix the nav' } }))
    await start($)
    const r = await $.tool.call({ tool: 'mcp__project-link__project_overview' })
    expect(String(r.result)).toContain('School')
    expect(String(r.result)).toContain('last ask: fix the nav')
  })
})

describe('commands from other sessions', () => {
  const req = (id: string, over: object = {}) => JSON.stringify({
    id, from: 'Video Site', fromSlug: 'video-site', fromSession: 'other',
    command: 'reload-plugins', args: '', targets: ['plugin-lab'], createdAt: 5_000_000, ...over,
  })
  const put = (w: ReturnType<typeof world>, id: string, over?: object) => {
    w.files.set(`${MAIL}/auto.json`, '{"on":true,"trust":"*"}')
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site' }))
    w.files.set(`${MAIL}/commands/${id}.json`, req(id, over))
  }
  const ack = (w: ReturnType<typeof world>, id: string) =>
    JSON.parse(w.files.get(`${MAIL}/command-acks/${id}/test-session.json`) ?? 'null')

  test('a command aimed at this project runs here once, and is acknowledged', async ($, on) => {
    const w = world(on)
    put(w, 'c1', { command: 'compact' })
    await start($)
    await new Promise(r => setTimeout(r, 20))
    expect(w.ran).toEqual(['compact'])
    expect(ack(w, 'c1')).toMatchObject({ ran: true })
  })

  test('not run: another project, my own request, stale or future-dated, or a denied command', async ($, on) => {
    const w = world(on)
    put(w, 'c1', { targets: ['elsewhere'] })
    put(w, 'c2', { fromSession: 'test-session' })
    put(w, 'c3', { createdAt: 1 })
    put(w, 'c4', { command: 'clear' })
    put(w, 'c5', { command: 'edit' })
    // a sender writes no args: these are not project-link's requests
    put(w, 'c7', { command: 'compact', args: 'the plan' })
    put(w, 'c6', { createdAt: 5_000_000 + 60 * 60_000 })
    await start($)
    await new Promise(r => setTimeout(r, 20))
    expect(w.ran).toEqual([])
    expect(ack(w, 'c4')).toMatchObject({ ran: false, text: 'not allowed' })
    expect(ack(w, 'c5')).toMatchObject({ ran: false, text: 'not allowed' })
    expect(ack(w, 'c7')).toBeNull()
  })

  test('auto mode off holds it', async ($, on) => {
    const w = world(on)
    put(w, 'c1')
    w.files.set(`${MAIL}/auto.json`, '{"on":false}')
    await start($)
    await new Promise(r => setTimeout(r, 20))
    expect(w.ran).toEqual([])
    expect(ack(w, 'c1')).toMatchObject({ ran: false, text: 'auto mode is off here' })
  })

  test('run_command asks every project, but not this session', async ($, on) => {
    const w = world(on)
    w.files.set(`${MAIL}/projects/video-site.json`, JSON.stringify({ name: 'Video Site', slug: 'video-site', path: 'C:/Users/me/Docs/projects/Video Site', lastSeen: 5_000_000 }))
    await start($)
    const r = await $.tool.call({ tool: 'mcp__project-link__run_command', command: '/reload-plugins' })
    expect(String(r.result)).toContain('/reload-plugins')
    const sent = [...w.files.entries()].find(([k]) => k.startsWith(`${MAIL}/commands/`))
    expect(JSON.parse(sent?.[1] ?? '{}')).toMatchObject({ command: 'reload-plugins', fromSession: 'test-session', targets: ['plugin-lab', 'video-site'] })
    await new Promise(r => setTimeout(r, 20))
    expect(w.ran).toEqual([])
    const denied = await $.tool.call({ tool: 'mcp__project-link__run_command', command: '/clear' })
    expect(String(denied.result)).toContain('not allowed')
  })
})
