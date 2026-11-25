# Privacy

Spec Manager runs on your machine. The plugin itself makes no network request and sends no data anywhere: no telemetry, no analytics, no remote server, no third party.

## What it reads

Nothing before you run `/spec-manager` in a session: a session start reads and runs nothing. From then on it stays inside the repository, following no symbolic link.

- The files under each `openspec/` folder of the project you open in Claude Code: `tasks.md`, `proposal.md`, `design.md` and the change's specs: their headings and task lines, the first sentence of the proposal's Why, and the open questions listed in design.md, plus folder names and modification times.
- No personal data: it runs no `git`, so it reads no name or email, neither yours nor your teammates'.
- Nothing from the conversation: it reads neither your messages, nor Claude's answers, nor the tool calls Claude makes. Everything it shows comes from the files above. Of the session it asks only its folder, to find the repository, and its id, to keep each session's state apart; that a session ended (and why: exit, /clear, resume) is all it hears of its end.

The pane is part of Claude Code's interface, and how Claude Code handles what it displays is covered by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

## What it keeps

The last module you picked in each repository, in Claude Code's plugin storage on your machine. The plugin stores nothing else.

## What it sends

The plugin itself sends nothing.

The `openspec` command the pane runs is the OpenSpec CLI you installed; what it does is up to OpenSpec. The pane runs it with `OPENSPEC_TELEMETRY=0` and `DO_NOT_TRACK=1`, which turn its telemetry off. That normally suffices, but a wrapper or a version manager between Claude Code and OpenSpec can set the environment again: it is up to each user to check their machine, and to turn telemetry off in OpenSpec's own config too if they want it off for their own commands.

## Questions

Open an issue: https://github.com/jordan-temim/spec-manager/issues
