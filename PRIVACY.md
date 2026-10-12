# Privacy

Spec Manager runs on your machine. The plugin itself makes no network request and sends no data anywhere: no telemetry, no analytics, no remote server, no third party.

## What it reads

- The files under each `openspec/` folder of the project you open in Claude Code: `tasks.md`, `proposal.md`, `design.md` and the change's specs, by their headings only, plus folder names and modification times.
- Through `git log`, the **name and email** of the author of each OpenSpec change folder's first commit, and through `git config user.email`, **your own git email**, in order to tell your changes from other people's and show the author's name in its pane. The plugin itself does not send them anywhere and does not write them into the conversation.
- The tool calls Claude makes in the session: it looks at them only to check whether one mentions `openspec`, and refreshes the pane; it does not change, block, store or send them.

The pane is part of Claude Code's interface, and how Claude Code handles what it displays is covered by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

## What it keeps

The last module you picked in each repository, in Claude Code's plugin storage on your machine. The plugin stores nothing else, and not the names and emails it reads from git.

## What it sends

The plugin itself sends nothing.

The `openspec` command the pane runs is the OpenSpec CLI you installed; what it does is up to OpenSpec.

## Questions

Open an issue: https://github.com/jordan-temim/spec-manager/issues
