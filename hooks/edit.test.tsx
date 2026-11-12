import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const PANE = {
  plugin: 'project-link',
  component: 'Pane',
  requestId: 'project-link-messages',
  surface: 'desktop',
  props: {
    title: 'Edit messages',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// the history as the engine keeps it: a prompt, a tool call, its result, a plain reply, an engine note
const HISTORY: SessionMessage[] = [
  { role: 'user', text: 'Build a login page.', toolUses: [] },
  { role: 'assistant', text: 'I write the page.', toolUses: [{ tool_use_id: 't1', tool: 'Write', input: {} }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
  { role: 'assistant', text: 'Done. The page is at /login.', toolUses: [] },
  { role: 'user', text: '<system-reminder>note</system-reminder>', toolUses: [] },
]
// the same history as a compaction receives it, with the engine's handles
const HANDLED = HISTORY.map((m, i) => ({ ...m, handle: `h${i}` }))

/** Everything beneath the mod; `compacted` holds each compaction that reached the engine. */
const world = (on: On, history: SessionMessage[] = HISTORY) => {
  const clock = mock.clock(on, { now: 1 })
  const toasts: string[] = []
  const filled: string[] = []
  const compacted: SessionMessage[][] = []
  const runs: { command: string; args: string }[] = []
  // runs while a compaction is under way
  const during: { compacting?: () => Promise<unknown>; result?: SessionMessage[] } = {}
  // no home folder: project-link's mailbox stays off, so these tests see /messages and /edit alone
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.messages', () => ({ value: history }))
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('session.compact', async (_$, e) => {
    await during.compacting?.()
    compacted.push([...e.messages])
    return { messages: during.result ?? e.messages }
  })
  // a command the mod might queue: none should be
  on('command.run', (_$, e) => {
    runs.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  return { clock, toasts, filled, compacted, runs, during }
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
const edit = ($: Engine, args: string) =>
  $.command.run({ command: 'edit', args, origin: { kind: 'composer' } } as never)
// lets a promise chain the mod left running finish
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
// the person's /compact
const rebuild = ($: Engine, over: object = {}) =>
  $.session.compact({ trigger: 'manual', messages: HANDLED, ...over } as never)

test('/edit changes a message, and your next /compact summarizes the history with it', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await edit($, '1 Build a signup page with email only.')).text).toBe(
    'Message 1 is changed. It goes in at the next compaction: run /compact when you want it.',
  )

  await rebuild($)
  // the engine's compaction got the changed message and every other message whole
  expect(w.compacted[0]?.[0]).toEqual({ role: 'user', text: 'Build a signup page with email only.', toolUses: [] })
  expect(w.compacted[0]?.slice(1)).toEqual(HANDLED.slice(1))
  // the change went in once
  await rebuild($)
  expect(w.compacted[1]).toEqual(HANDLED)
})

test("Claude's plain reply can change too; a tool call, a tool result and an engine note cannot", async ($, on) => {
  world(on)
  await start($)
  for (const n of [2, 3, 5, 9]) {
    expect((await edit($, `${n} other text`)).text).toBe(`Message ${n} cannot be changed. /messages lists the ones that can.`)
  }
  await edit($, '4 Done. The page is at /signin.')
  const r = (await rebuild($)) as { messages: SessionMessage[] }
  expect(r.messages[3]).toEqual({ role: 'assistant', text: 'Done. The page is at /signin.', toolUses: [] })
})

test('the pane lists the messages that can change; Delete leaves "(deleted)" for Claude to reread', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount(PANE as never)
  expect((await ui.find({ type: 'Text', text: /^1\. You:/ }))?.text).toBe('1. You: Build a login page.')
  expect((await ui.find({ type: 'Text', text: /^4\. Claude:/ }))?.text).toBe('4. Claude: Done. The page is at /login.')
  expect(await ui.find({ type: 'Text', text: /^2\./ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^5\./ })).toBeUndefined()

  await ui.press({ key: 'delete-1' })
  const r = (await rebuild($)) as { messages: SessionMessage[] }
  expect(r.messages[0]).toEqual({ role: 'user', text: '(deleted)', toolUses: [] })
  await ui.unmount()
})

test('Edit puts the message in the prompt box as an /edit command', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'edit-4' })
  expect(w.filled).toEqual(['/edit 4 Done. The page is at /login.'])
  await ui.unmount()
})

test('Undo drops a change that waits', async ($, on) => {
  world(on)
  await start($)
  await edit($, '1 Build a signup page.')
  const ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'undo-1' })
  expect(((await rebuild($)) as { messages: SessionMessage[] }).messages).toEqual(HANDLED)
  await ui.unmount()
})

test("Claude Code's own compaction puts the changes in too; one with nothing waiting is the engine's alone", async ($, on) => {
  const w = world(on)
  await start($)
  await $.session.compact({ trigger: 'plugin', instructions: 'Keep the open tasks.', messages: HANDLED } as never)
  expect(w.compacted).toEqual([HANDLED])

  await edit($, '1 Build a signup page.')
  await $.session.compact({ trigger: 'auto', messages: HANDLED } as never)
  expect(w.compacted[1]?.[0]).toEqual({ role: 'user', text: 'Build a signup page.', toolUses: [] })
})

test('a change finds its message again after the history moved', async ($, on) => {
  world(on)
  await start($)
  await edit($, '4 Done. The page is at /signin.')
  const moved = [{ role: 'user', text: 'Summary of the start.', toolUses: [], handle: 's' }, ...HANDLED.slice(3)]
  const r = (await rebuild($, { messages: moved })) as { messages: SessionMessage[] }
  expect(r.messages[1]).toEqual({ role: 'assistant', text: 'Done. The page is at /signin.', toolUses: [] })
})

test('an edit compacts nothing by itself; a summary made ahead of time waits for your /compact', async ($, on) => {
  const w = world(on)
  await start($)
  await edit($, '1 Build a signup page.')
  await w.clock.advance(0)
  await settle()
  expect(w.runs).toEqual([])
  expect(await $.session.compact({ trigger: 'precompute', messages: HANDLED } as never)).toEqual({
    skip: 'Message changes wait for your /compact.',
  })
  expect(w.compacted).toHaveLength(0)
  // the change still waits for the person's /compact
  await rebuild($)
  expect(w.compacted[0]?.[0]).toEqual({ role: 'user', text: 'Build a signup page.', toolUses: [] })
})

test("a subagent's compaction leaves the changes waiting for the chat's own", async ($, on) => {
  const w = world(on)
  await start($)
  await edit($, '1 Build a signup page.')
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: HANDLED } as never)
  expect(w.compacted).toEqual([HANDLED])
  const r = (await rebuild($)) as { messages: SessionMessage[] }
  expect(r.messages[0]).toEqual({ role: 'user', text: 'Build a signup page.', toolUses: [] })
})

const row = (component: 'UserMessage' | 'AssistantMessage', text: string) => ({
  plugin: 'project-link',
  component,
  surface: 'desktop',
  props: component === 'UserMessage'
    ? { text, origin: { kind: 'composer' }, isExpanded: true }
    : { text, isFirstOfReply: true },
})

test('a message in the transcript has its own Edit and Delete; a tool call or an engine note has none', async ($, on) => {
  const w = world(on)
  await start($)
  const mine = await $.ui.mount(row('UserMessage', 'Build a login page.') as never)
  await mine.press({ key: 'edit-1' })
  expect(w.filled).toEqual(['/edit 1 Build a login page.'])

  const reply = await $.ui.mount(row('AssistantMessage', 'Done. The page is at /login.') as never)
  await reply.press({ key: 'delete-4' })
  // the change waits: its Undo takes Delete's place
  expect(await reply.find({ key: 'delete-4' })).toBeUndefined()
  expect(await reply.find({ key: 'undo-4' })).toBeDefined()
  const r = (await rebuild($)) as { messages: SessionMessage[] }
  expect(r.messages[3]).toEqual({ role: 'assistant', text: '(deleted)', toolUses: [] })

  const tool = await $.ui.mount(row('AssistantMessage', 'I write the page.') as never)
  expect(await tool.find({ key: 'edit-2' })).toBeUndefined()
  const note = await $.ui.mount(row('UserMessage', '<system-reminder>note</system-reminder>') as never)
  expect(await note.find({ key: 'edit-5' })).toBeUndefined()
  for (const ui of [mine, reply, tool, note]) await ui.unmount()
})

test('two messages with the same text get no buttons on their rows: /messages numbers them', async ($, on) => {
  world(on, [
    { role: 'user', text: 'yes', toolUses: [] },
    { role: 'assistant', text: 'Next step?', toolUses: [] },
    { role: 'user', text: 'yes', toolUses: [] },
  ])
  await start($)
  const ui = await $.ui.mount(row('UserMessage', 'yes') as never)
  expect(await ui.find({ key: 'edit-1' })).toBeUndefined()
  expect(await ui.find({ key: 'edit-3' })).toBeUndefined()
  // the reply between them is the only one with its text
  const reply = await $.ui.mount(row('AssistantMessage', 'Next step?') as never)
  expect(await reply.find({ key: 'edit-2' })).toBeDefined()
  for (const u of [ui, reply]) await u.unmount()
})

test('a text that a tool call repeats gets no buttons: they could act on the other message', async ($, on) => {
  world(on, [
    { role: 'user', text: 'Fix it.', toolUses: [] },
    { role: 'assistant', text: 'Let me check.', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
    { role: 'assistant', text: 'Let me check.', toolUses: [] },
  ])
  await start($)
  const ui = await $.ui.mount(row('AssistantMessage', 'Let me check.') as never)
  expect(await ui.find({ key: 'delete-4' })).toBeUndefined()
  await ui.unmount()
})

test('a row drawn before its message is stored gets its buttons when the turn ends', async ($, on) => {
  const history: SessionMessage[] = [{ role: 'user', text: 'Fix it.', toolUses: [] }]
  const w = world(on, history)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  await start($)
  const ui = await $.ui.mount(row('AssistantMessage', 'All fixed.') as never)
  expect(await ui.find({ key: 'edit-2' })).toBeUndefined()
  history.push({ role: 'assistant', text: 'All fixed.', toolUses: [] })
  await w.clock.advance(2000)
  await $.turn.complete({ turnId: 'a', answer: 'ok', durationMs: 1 } as never)
  expect(await ui.find({ key: 'edit-2' })).toBeDefined()
  await ui.unmount()
})

test('a change made while a compaction runs waits for the next one', async ($, on) => {
  const w = world(on)
  await start($)
  await edit($, '1 Build a signup page.')
  w.during.compacting = () => {
    w.during.compacting = undefined
    return edit($, '4 Done. The page is at /signin.')
  }
  await rebuild($)
  expect(w.compacted[0]?.[3]).toEqual(HANDLED[3])
  await rebuild($)
  expect(w.compacted[1]?.[0]).toEqual(HANDLED[0])
  expect(w.compacted[1]?.[3]).toEqual({ role: 'assistant', text: 'Done. The page is at /signin.', toolUses: [] })
})

test('a change whose message left the history does not show on the message now at its number', async ($, on) => {
  const history: SessionMessage[] = [...HISTORY]
  world(on, history)
  await start($)
  await edit($, '1 Build a signup page.')
  // /rewind: another message is first now
  history.splice(0, history.length, { role: 'user', text: 'Write the README.', toolUses: [] })
  const ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ key: 'undo-1' })).toBeUndefined()
  expect(await ui.find({ key: 'delete-1' })).toBeDefined()
  await ui.unmount()
})

test('a change never goes on a tool call with the same text, however near', async ($, on) => {
  const w = world(on, [
    { role: 'user', text: 'Fix it.', toolUses: [] },
    { role: 'assistant', text: 'Let me check.', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
    { role: 'assistant', text: 'Let me check.', toolUses: [] },
  ])
  await start($)
  await edit($, '4 I checked: the page loads.')
  // two summary lines put the tool call where the plain reply was
  const moved: SessionMessage[] = [
    { role: 'user', text: 'Summary.', toolUses: [] },
    { role: 'user', text: 'More summary.', toolUses: [] },
    { role: 'user', text: 'Fix it.', toolUses: [] },
    { role: 'assistant', text: 'Let me check.', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
    { role: 'assistant', text: 'Let me check.', toolUses: [] },
  ]
  await rebuild($, { messages: moved })
  expect(w.compacted[0]?.[3]).toEqual(moved[3])
  expect(w.compacted[0]?.[5]).toEqual({ role: 'assistant', text: 'I checked: the page loads.', toolUses: [] })
})

test('a change the compaction did not cover waits on, at the number its message has now', async ($, on) => {
  const history: SessionMessage[] = [...HISTORY]
  const w = world(on, history)
  await start($)
  await edit($, '4 Done. The page is at /signin.')
  // the compaction covers the first three messages, and its summary takes their place
  const after: SessionMessage[] = [{ role: 'user', text: 'Summary of the start.', toolUses: [] }, ...HISTORY.slice(3)]
  w.during.result = after
  await rebuild($, { messages: HANDLED.slice(0, 3) })
  history.splice(0, history.length, ...after)
  const ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ key: 'undo-2' })).toBeDefined()
  await ui.unmount()
  w.during.result = undefined
  const r = (await rebuild($, { messages: after })) as { messages: SessionMessage[] }
  expect(r.messages[1]).toEqual({ role: 'assistant', text: 'Done. The page is at /signin.', toolUses: [] })
})

test('an edit back to the first text drops the change that waits', async ($, on) => {
  world(on)
  await start($)
  await edit($, '1 Build a signup page.')
  expect(JSON.stringify(await edit($, '1 Build a login page.'))).toContain('no change waits')
  expect(((await rebuild($)) as { messages: SessionMessage[] }).messages).toEqual(HANDLED)
})

test('a /clear or a resume drops the changes that wait: they were for the chat that ended', async ($, on) => {
  world(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await start($)
  for (const reason of ['clear', 'resume']) {
    await edit($, '1 Build a signup page.')
    await $.session.end({ reason, sessionId: 's1' } as never)
    expect(((await rebuild($)) as { messages: SessionMessage[] }).messages).toEqual(HANDLED)
  }
})

test('an Undo while a compaction runs comes too late for it, and a toast says so', async ($, on) => {
  const w = world(on)
  await start($)
  await edit($, '1 Build a signup page.')
  const ui = await $.ui.mount(PANE as never)
  w.during.compacting = () => {
    w.during.compacting = undefined
    return ui.press({ key: 'undo-1' })
  }
  await rebuild($)
  expect(w.compacted[0]?.[0]).toEqual({ role: 'user', text: 'Build a signup page.', toolUses: [] })
  expect(w.toasts.join('\n')).toContain('went in anyway')
  await ui.unmount()
})
