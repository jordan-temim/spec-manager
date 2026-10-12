# Privacy

Spec Manager runs entirely on your machine. It makes no network request and sends no data anywhere: no telemetry, no analytics, no remote server, no third party.

## What it reads

- The files under each `openspec/` folder of the project you open in Claude Code: `tasks.md`, `proposal.md`, `design.md` and the change's specs, by their headings only, plus folder names and modification times.
- Through `git log`, the **name and email** of the author of each OpenSpec change folder's first commit, and through `git config user.email`, **your own git email**. They are used only to tell your changes from other people's and to show the author's name next to a change.
- The tool calls Claude makes in the session, only to check whether one mentions `openspec` and refresh the pane. A call is never changed, blocked, stored or sent.

## What it keeps

The last module you picked in each repository, in Claude Code's plugin storage on your machine. Nothing else is stored; names and emails read from git are not.

## What it sends

Nothing.

The `openspec` command the pane runs is the OpenSpec CLI you installed; what it does is up to OpenSpec.

## Questions

Open an issue: https://github.com/jordan-temim/spec-manager/issues
