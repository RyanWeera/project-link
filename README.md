# project-link

A Claude Code mod that lets the Claude Code projects on one computer send work to each other and get the results back. It also lets you edit or delete earlier messages in a chat, so Claude rereads the changed text.

## Install

At the prompt of a terminal session:

```
/plugin install project-link --marketplace RyanWeera/project-link
```

Answer `y` to add the marketplace, then pick a scope. User scope makes it work in every project.

From a shell:

```bash
claude plugin install project-link --marketplace RyanWeera/project-link
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `RyanWeera/project-link`, then Add plugin.

## What it does

### Projects send work to each other

Each open project has a mailbox under `~/.claude/project-link/`. Claude gets these tools:

| Tool | What it does |
|---|---|
| `list_projects` | The other projects this one can reach, whether each is open, and the state of its chat |
| `project_overview` | A short entry per project: open now, last active, last request, last reply |
| `read_project_context` | The latest turns of another project's newest session (it reads that chat with no prompt to you; a session file over 4 MiB cannot be read) |
| `send_work` | Sends a task to another project; the result comes back here. It refuses a project that has not run project-link yet, which `list_projects` shows as "not set up" |
| `route_prompt` | Delivers a prompt word for word to another project, where it arrives as a work request that this project's Claude wrote |
| `reply_work` | Answers a work request when the work is done (or declines it) |
| `run_command` | Makes the other open sessions run `/reload-plugins` or `/compact` |
| `work_status` | Work waiting here, work in progress, and work sent from here |

Commands:

- `/inbox` shows the work waiting here and the work sent from here, with a View button for each message that still waits.
- `/autolink on|off` turns auto mode on or off. `/autolink trust <project-slug...>|all` sets which projects may start work here without a button press. A slug is the folder name in lower case with dashes, such as `video-site`. A folder name with no ASCII letter or digit, or a second folder of the same name, gets a slug with a short hash, such as `p-88o62`, and `list_projects` shows it. `/autolink trust` with no names shows the list. `/autolink scope tree|children` sets which folders count as reachable. `/autolink log` lists what ran by itself.

Auto mode is off when you install the mod. Until you turn it on, every task and result waits in a bar above the prompt: a task with Start and Decline, a result with Give to Claude and Dismiss. A task waits for one session of the target project, the most recently active one, to end its turn. A session claims a task before it starts it, so two sessions of one project almost never both start the same task.

`/autolink on` lets a task or a result reach Claude with no button press, up to 30 a session. The trust list starts empty, so also run `/autolink trust <project-slug...>` or `/autolink trust all`. A message still waits for a button when its sender is not trusted, when the sender's folder is out of reach of this one, when it was passed on more than 100 times, when it repeats one that already ran, or when it is a result that answers no task sent from this project. The settings are one file for all projects: `/autolink` in one session changes them for every project at its next check. A headless session (`claude -p`, an SDK worker) can send work but takes none.

`work_status` and `/inbox` show only the sender and id of a message that waits, so its words reach Claude only after you press Start or Give. The bar shows the first 200 characters of a message. To read all of it first, press View in the bar or under `/inbox`: a pane opens with the whole text, cleaned the way Claude gets it (control and hidden characters removed, line breaks kept). Arrow keys scroll it and Esc closes it. Claude does not read the pane, and View does not start the work. A title is one line of up to 120 characters. `/autolink` shows the folder of each trusted slug: a slug goes to the first folder of that name that runs project-link. The bar says when a task asks to compact this chat first.

The sender name, the trust list and the reach check hold only for messages sent with the project-link tools. A program or a Claude session that can write files in `~/.claude/project-link/` can put a message there under any sender name. If that is a risk for you, keep auto mode off or trust few projects. A session opened in a parent folder, such as your home folder, is in reach of every project under it in both scopes.

`run_command` sends only `/reload-plugins` and `/compact`, with no arguments: a sender cannot give `/compact` its summary instructions. A session runs it only when auto mode is on there and the sender is trusted and in reach, and each run counts toward the 30 a session. A session with auto mode off refuses it, and `work_status` shows why.

### Other sessions do not interrupt you

A message from another Claude session waits until the running turn ends, then gets a turn of its own. A prompt that you type during a turn still reaches Claude inside the running turn.

### A cold chat is compacted first

When a chat has not called the model for an hour, its prompt cache is cold, and a new message writes the whole chat into the cache again. If that chat is also of low quality, project-link compacts it before the message lands. Low quality means a score under 70, or 50k tokens or more when there is no score. The score comes from the [token-lens](https://github.com/RyanWeera/token-lens) mod if it is installed. Senders see the target chat's state in `list_projects`, and `send_work` and `route_prompt` take `compact: true` or `compact: false` to choose.

### Edit or delete earlier messages

- Put the pointer on one of your messages or on a plain-text reply of Claude's: Edit and Delete buttons show under it. The mod API has no right-click menu, so the buttons show on hover instead. A message whose text repeats another one, such as "yes", has no buttons: use `/messages` for it. A message from before a compaction cannot be changed: the summary took its place, so Claude no longer rereads it. Nor can a message you type while Claude works: it reaches Claude inside a tool result, and a tool result cannot be changed. The buttons find a message by its text, so such a row shows them only when a later message has the same text, and then they change that later message.
- `/messages` opens a pane that lists your messages and Claude's plain-text replies, each with Edit and Delete buttons.
- `/edit <number> <new text>` changes one message. The Edit button fills this in for you.

A deleted message stays in the chat as "(deleted)". Tool calls, tool results and notes from the engine cannot be changed. An edited message keeps only its text: an image or a file attached to it is lost. An edit never starts a compaction by itself: a change waits for the next compaction, so run `/compact` when you want it in. Undo drops a change that waits. The compaction puts the waiting changes into the chat, then summarizes it as usual, so Claude works from the changed text after that. Every compaction of the chat does this: your `/compact`, the one Claude Code starts by itself when the chat is full, and the ones project-link runs for a cold chat or for another project. A change that waits is kept only while the chat is open: if you close it first, the change is lost. `/clear` and a resume also drop it.

## Files it writes

Everything stays on your computer, under `~/.claude/project-link/` (or `$CLAUDE_CONFIG_DIR/project-link/`):

- `inbox/` and `outbox/`: the messages of each project.
- `projects/`: each project that ran the mod, with its folder and when it was last open.
- `sessions/`: a heartbeat for each open session, with the state of its chat.
- `commands/` and `command-acks/`: `run_command` requests and which sessions ran them.
- `auto.json`: your `/autolink` settings, one file for all projects.

The mod deletes none of these files. Delete old ones by hand when you want to.

It reads `~/.claude/projects/` to find the other projects and their latest turns, and `~/.claude/token-lens/` for the quality score.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

The mod API is in early access and can change between Claude Code releases.

## License

MIT, see [LICENSE](LICENSE).
