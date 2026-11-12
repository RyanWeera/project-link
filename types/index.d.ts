export type Status = 'new' | 'started' | 'declined' | 'done' | 'dismissed'

/** One mailbox file: a task sent to a project, or the result sent back. */
export type Message = {
  id: string
  kind: 'task' | 'result'
  from: string
  fromSlug: string
  to: string
  toSlug: string
  title: string
  body: string
  createdAt: number
  status: Status
  /** results only: the task this answers, and how it ended */
  replyTo?: string
  outcome?: 'done' | 'declined'
  /** forwarding depth: a reply or forward carries the hops of what caused it, plus one */
  hops?: number
  /** tasks only: the session of the target project that picked this up */
  pickedBy?: string
  /** tasks only: the sender's choice for the target chat: true compacts it first, false sends as is; unset = the target decides (needsCompact) */
  compact?: boolean
}

/** A slash command one session asks every live session of the target projects to run. */
export type CommandReq = {
  id: string
  from: string
  fromSlug: string
  fromSession: string
  /** without the slash, e.g. 'reload-plugins' */
  command: string
  args: string
  /** project slugs whose sessions run it */
  targets: string[]
  createdAt: number
}

/** One change to a message of the history, waiting to go in (/messages, /edit). */
export type Change = {
  /** the message's place in the history, from 0: where it was when the change was made, or where a compaction moved it */
  index: number
  role: 'user' | 'assistant'
  /** its text then, to find it again if the history moved */
  old: string
  /** the new text; null deletes the message */
  text: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'project-link': { pending: Message[]; edits: Shaped<Change[]>; historyTick: number }
  }
}
