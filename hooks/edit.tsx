import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, ResolveInput, SessionMessage } from 'claude-code'

import type { Change } from '../types'
import { clip } from './mail'

const PANE = 'project-link-messages'
const TITLE = 'Edit messages'
const DELETED = '(deleted)'
// register.tsx has matcherless hooks on these events; the engine refuses a second one without a matcher
const ANY = /./
const ANY_TEXT = /^[\s\S]*$/

// Changes waiting for the next compaction: kept across a reload, dropped at /clear or a resume, lost when the chat closes.
const edits = atom({ plugin: 'project-link', key: 'edits' } as const, [], { shape: 'edits-1' })
// Bumped when the history changes, so the pane reads it again.
const tick = atom({ plugin: 'project-link', key: 'historyTick' } as const, 0)

/** Yours or Claude's plain text: not a tool call or result, and not a note the engine or another session put in (they start with a tag). */
const isEditable = (m: SessionMessage) =>
  m.text.trim() !== '' && m.toolUses.length === 0 && !m.toolResults?.length && !m.text.trimStart().startsWith('<')

const sameMessage = (a: Change, b: Change) => a.index === b.index && a.role === b.role && a.old === b.old
const same = (a: Change, b: Change) => sameMessage(a, b) && a.text === b.text

/** The change that waits for message n, if n is still the message it was made to: /rewind can put another there. */
const waitingFor = (changes: readonly Change[], n: number, m: SessionMessage) =>
  changes.find(x => x.index === n - 1 && x.role === m.role && x.old === m.text)

const preview = (text: string, width: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${clip(line, width - 3)}...` : line
}

/** Where change c's message is now: the editable message with its role and old text nearest to where it was, or -1. */
function find(messages: readonly SessionMessage[], c: Change) {
  let at = -1
  messages.forEach((m, i) => {
    if (isEditable(m) && m.role === c.role && m.text === c.old && (at < 0 || Math.abs(i - c.index) < Math.abs(at - c.index))) at = i
  })
  return at
}

/** The history with each change in place: a changed message is rebuilt from its new text, every other one kept whole. */
function withChanges(messages: readonly SessionMessage[], changes: readonly Change[]) {
  const out = [...messages]
  const missed: Change[] = []
  for (const c of changes) {
    const at = find(out, c)
    if (at < 0) missed.push(c)
    else out[at] = { role: c.role, text: c.text ?? DELETED, toolUses: [] }
  }
  return { messages: out, missed }
}

/** Records a change to message n (from 1, as /messages numbers them); null deletes it. `shown` is the text the pane showed for n. */
async function change($: EngineInterface, n: number, text: string | null, shown?: string) {
  const m = (await $.session.messages())[n - 1]
  if (m === undefined || !isEditable(m)) return `Message ${n} cannot be changed. /messages lists the ones that can.`
  // a compaction since the pane drew can put another message at n
  if (shown !== undefined && m.text !== shown) return `Message ${n} moved. Open /messages again.`
  const c: Change = { index: n - 1, role: m.role, old: m.text, text }
  const isSame = text === m.text.trim()
  await update($, edits, list => [...list.filter(x => !sameMessage(x, c)), ...(isSame ? [] : [c])])
  if (isSame) return `Message ${n} has its first text again: no change waits for it.`
  return `Message ${n} ${text === null ? 'is deleted' : 'is changed'}. It goes in at the next compaction: run /compact when you want it.`
}

// What the last Edit press put in the prompt box: /edit checks that its message is still at that number.
let filled: { n: number; old: string } | undefined

/** The Edit button, and Delete or (for a change that waits) Undo, for message n: the pane's row and the message's own. */
function actions($: EngineInterface, e: ResolveInput, n: number, m: SessionMessage, c: Change | undefined) {
  const { Button } = $.ui.resolve(e)
  return [
    <Button
      key={`edit-${n}`}
      label="Edit"
      onPress={() => {
        filled = { n, old: m.text }
        return $.prompt.fill({ text: `/edit ${n} ${c?.text ?? m.text}` })
      }}
    />,
    c === undefined ? (
      <Button key={`delete-${n}`} label="Delete" onPress={() => change($, n, null, m.text).then(t => $.ui.toast(t))} />
    ) : (
      <Button key={`undo-${n}`} label="Undo" onPress={() => update($, edits, list => list.filter(x => !sameMessage(x, c)))} />
    ),
  ]
}

// Each transcript row is drawn by a hook call of its own: the rows drawn together share one read of the history.
// Reading the tick makes a row draw again after each turn: the engine can draw a row before its message is stored.
let recent: { at: number; t: number; messages: Promise<readonly SessionMessage[]> } | undefined
async function history($: EngineInterface) {
  const t = await read($, tick)
  const now = await $.clock.now()
  if (recent === undefined || recent.t !== t || now - recent.at > 1000) recent = { at: now, t, messages: $.session.messages() }
  return recent.messages
}

/**
 * A transcript row with its buttons under it, shown while the pointer is on the row (the mod API has no right-click menu).
 * The history has no id to match a row's to: the row is found by role and text. A row that is no editable message, or whose text another
 * message repeats ("yes", or a tool call's "Let me check."), is kept as it is: /messages numbers those.
 */
async function withActions($: EngineInterface, e: ResolveInput, row: RenderElement, role: SessionMessage['role'], text: string) {
  const all = await history($)
  const hits = all.flatMap((m, i) => (m.role === role && m.text.trim() === text.trim() ? [i + 1] : []))
  const [n] = hits
  const m = n === undefined ? undefined : all[n - 1]
  if (hits.length !== 1 || n === undefined || m === undefined || !isEditable(m)) return row
  const c = waitingFor(await read($, edits), n, m)
  const { Box } = $.ui.resolve(e)
  return (
    <Box key={`message-${n}`} flexDirection="column">
      {row}
      {c === undefined ? (
        <Box display="none" hover={{ display: 'flex' }}>{actions($, e, n, m, c)}</Box>
      ) : (
        // a change that waits keeps its Undo in view
        <Box>{actions($, e, n, m, c)}</Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', { cwd: ANY_TEXT }, async ($, e, next) => {
    await $.command.register({
      name: 'messages',
      description: "Edit or delete your earlier messages and Claude's replies, so Claude rereads the changed text",
      immediate: true,
    })
    await $.command.register({
      name: 'edit',
      description: 'Change one earlier message (the Edit button in /messages fills this in)',
      argumentHint: '<number> <new text>',
    })
    return next(e)
  })

  on('command.run', { command: 'messages' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'The Edit messages pane is open.' }
  })

  on('command.run', { command: 'edit' }, async ($, e) => {
    const [, n, text] = /^\s*(\d+)\s+([\s\S]*\S)\s*$/.exec(e.args) ?? []
    if (n === undefined || text === undefined) return { text: 'Write /edit <number> <new text>. /messages shows the numbers.' }
    const shown = filled?.n === Number(n) ? filled.old : undefined
    filled = undefined
    return { text: await change($, Number(n), text, shown) }
  })

  // the person's /compact (or the engine's own) summarizes the history with the changes in place
  on('session.compact', async ($, e, next) => {
    // a subagent's compaction is of its own transcript, not the chat the changes are for
    if (e.agentId !== undefined) return next(e)
    const changes = await read($, edits)
    if (changes.length === 0) return next(e)
    // a summary made ahead of time would be of the history without the changes
    if (e.trigger === 'precompute') return { skip: 'Message changes wait for your /compact.' }
    const { messages, missed } = withChanges(e.messages, changes)
    const r = await next({ ...e, messages })
    // another hook vetoed it: the changes keep waiting
    if (r.skip !== undefined) return r
    // the rest wait on (a compaction can cover only part of the chat, and an edit can come while it runs), each at its message's new number
    let gone = 0
    let late = 0
    await update($, edits, list => {
      late = changes.filter(c => !missed.includes(c) && !list.some(x => same(c, x))).length
      const left = list.filter(x => !changes.some(c => !missed.includes(c) && same(c, x)))
      const kept = left.flatMap(x => {
        const at = find(r.messages, x)
        return at < 0 ? [] : [{ ...x, index: at }]
      })
      gone = left.length - kept.length
      return kept
    })
    await update($, tick, n => n + 1)
    if (late > 0) $.ui.toast(`${late} message change(s) went in anyway: the compaction had started before you changed them again.`)
    if (gone > 0) $.ui.toast(`${gone} message change(s) not made: that text is no longer in the history.`)
    return r
  })

  // a /clear or a resume goes on with another chat: the changes that wait were for the one that ended
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      filled = undefined
      await update($, edits, () => [])
    }
    return next(e)
  })

  // the pane reads the history again after each turn
  on('turn.complete', { turnId: ANY }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    await update($, tick, n => n + 1)
    return r
  })

  // your messages and Claude's plain replies in the transcript: Edit and Delete under each, on hover
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) =>
    e.props.from !== undefined || e.props.task !== undefined ? next(e) : withActions($, e, await next(e), 'user', e.props.text))
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) =>
    e.props.isSummary ? next(e) : withActions($, e, await next(e), 'assistant', e.props.text))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, tick)
    const changes = await read($, edits)
    const rows = (await $.session.messages()).flatMap((m, i) => (isEditable(m) ? [{ m, n: i + 1, c: waitingFor(changes, i + 1, m) }] : []))
    const width = Math.max(20, e.props.bodyColumns - 26)

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No messages to edit yet.</Text>}
        {rows.map(({ m, n, c }) => {
          const shown = c === undefined ? m.text : (c.text ?? DELETED)
          return (
            <Box>
              <Text dimColor={c !== undefined}>
                {n}. {m.role === 'user' ? 'You' : 'Claude'}: {preview(shown, width)}
              </Text>
              {actions($, e, n, m, c)}
            </Box>
          )
        })}
        {rows.some(r => r.c !== undefined) && <Text dimColor>Dim rows go in at the next compaction: run /compact when you want them.</Text>}
      </Box>
    )
  })
}
