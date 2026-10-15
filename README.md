# Spec Manager

<p align="center">
  <a href="https://github.com/jordan-temim/spec-manager/actions/workflows/check.yml"><img src="https://github.com/jordan-temim/spec-manager/actions/workflows/check.yml/badge.svg" alt="Check" /></a>
  <a href="https://github.com/jordan-temim/spec-manager/tags"><img src="https://img.shields.io/github/v/tag/jordan-temim/spec-manager?sort=semver&label=version" alt="Latest version" /></a>
  <a href="https://github.com/jordan-temim/spec-manager/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
</p>
<p align="center">
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-2.1.293%2B-d97757" alt="Claude Code 2.1.293+" /></a>
  <a href="https://github.com/Fission-AI/OpenSpec"><img src="https://img.shields.io/badge/for-OpenSpec-6b9b74" alt="For OpenSpec" /></a>
  <a href="#how-it-works"><img src="https://img.shields.io/badge/network-none-brightgreen" alt="No network" /></a>
</p>

**A live [OpenSpec](https://github.com/Fission-AI/OpenSpec) pane for Claude Code**, in the desktop Code tab and the terminal.

> **Claude Code only.** Spec Manager is a pane drawn by Claude Code (desktop Code tab and terminal). Added from claude.ai or Cowork, it shows nothing there.
While you work with Claude on OpenSpec changes, it answers at a glance:

- **Where is each change in its cycle?** A stepper over OpenSpec's own steps: `proposal › specs › design › tasks › apply › archive`.
- **Whose turn is it?** A `YOU` or `AI` tag on each of your changes, and how many of each at the top (`2 [YOU]  1 [AI]`).
- **How far along is it?** Task progress per change and per `tasks.md` section.
- **Which are mine?** In a shared repository, other people's changes are greyed and named after their author.

It only reads your files and runs `openspec` and `git` locally: no network request, no telemetry (see [What it runs, reads and sends](#what-it-runs-reads-and-sends)).

## Install

```bash
claude plugin marketplace add jordan-temim/spec-manager
claude plugin install spec-manager@spec-manager --scope user
```

or, inside a terminal Claude Code session, `/plugin install spec-manager --marketplace jordan-temim/spec-manager`. A plugin installed at user scope also loads in the desktop Code tab.

Then start a new session in a project that has an `openspec/` folder: the pane opens by itself (elsewhere it stays closed until an `openspec/` folder appears), and `/spec-manager` reopens it. It needs Claude Code 2.1.293 or later and the `openspec` CLI (see [Requirements](#requirements)).

## What it looks like

### In the desktop Code tab

With several modules, the session opened at the repository top shows an overview: your modules first, then other people's, then the modules with nothing in progress.

<p align="center"><img src="https://github.com/jordan-temim/spec-manager/releases/download/v0.1.0/desktop-overview.png" alt="The overview in the desktop pane: five modules, three changes waiting on you, two on the AI" /></p>

`Open ›` on a module shows its changes: each one with its stepper, its task progress per `tasks.md` section, the task waiting on you and the AI's next one.

<p align="center"><img src="https://github.com/jordan-temim/spec-manager/releases/download/v0.1.0/desktop-module.png" alt="A module in the desktop pane: a change being implemented with its next task waiting on you, and a change the AI is planning" /></p>

### In the terminal

The same two views, drawn in text and docked to the right of the conversation (fullscreen renderer, `/tui fullscreen`).

<p align="center"><img src="https://github.com/jordan-temim/spec-manager/releases/download/v0.1.0/terminal-overview.png" alt="The overview in the terminal pane" /></p>

<p align="center"><img src="https://github.com/jordan-temim/spec-manager/releases/download/v0.1.0/terminal-module.png" alt="A module in the terminal pane" /></p>

Screenshots from a demo repository (a gym management app); the conversation, the sidebar and the project path are blurred.

## Phases and whose turn it is

| Phase | When | Tag | Below the stepper |
| --- | --- | --- | --- |
| Planning | a planning document is missing | `AI` | the document to write next |
| Plan to review | every planning document written, no task checked | `YOU` | the plan in a few lines: why, specs (requirements, scenarios), decisions, the open questions written out, task count |
| Implementing | at least one task checked | `YOU` if the next task is a user action, else `AI` | progress per section, your next user-action task, the AI's next task |
| Ready to archive | every task checked | `YOU` | the specs archiving will merge |

A plan to review sums up the change in a few lines before any code is written:

<p align="center"><img src="https://github.com/jordan-temim/spec-manager/releases/download/v0.1.0/desktop-review.png" alt="A plan to review in the desktop pane: why, specs, decisions, two open questions, task count" /></p>

A task is a **user action** when its text starts with `*(user action …)*` (or `*(action utilisateur …)*`); it is listed under `● Waiting on you`.

"Whose turn" is inferred from the files alone. OpenSpec does not record reviews: a checked box means the task was checked, not that someone reviewed it. `/opsx:explore` writes no file, so exploring shows nothing until a change exists.

`SPECS` lists the main specs (`openspec/specs/`) with their requirement count; `ARCHIVED` the three most recent archived changes.

## Several modules in one repository

A module is any folder holding an `openspec/`, up to 5 levels below the repository top (the nearest `.git` upward), skipping hidden folders, `node_modules`, `dist`, `build`, `target` and `vendor`.

- **Session opened inside a module:** the pane shows that module, with `‹ All modules` to go up.
- **Session opened at the top:** the overview above, one card per module with a line per active change (its name, the stepper as six dots lined up in a column, then its tag or its author). Yours first, the ones waiting on you on top. `Open ›` opens a module.
- **A single module:** shown directly.

From the prompt:

```
/spec-manager                 # reopens the pane, looking for modules afresh
/spec-manager paiement        # opens a module: folder name, end of its path, or part of it
/spec-manager all             # back to the overview
```

The last module you picked is remembered per repository, across sessions.

## Mine and other people's

A change is **yours** when you created it: you authored the first commit on its folder (compared with `git config user.email`), or it is not committed yet. Otherwise it belongs to whoever made that first commit.

- Only your changes get a `YOU` / `AI` tag and count in the totals.
- Someone else's show their author in a grey tag; their current step and "Waiting on …" stay grey.
- The overview lists **MINE**, then **OTHERS** (greyed), then modules with no active change.
- Outside git, or without a git identity, every change counts as yours.

## Colours

Each colour means one thing everywhere in the pane, on light and dark themes alike.

| Colour | Means | Where |
| --- | --- | --- |
| Terracotta `#d97757` (Claude's) | the AI | `AI` tag, `▶ AI next`, its task ids, the current step while the AI holds it |
| Sage `#6b9b74` | you | `YOU` tag, `● Waiting on you`, your task ids, open questions, the current step while you hold it |
| Slate blue `#4f82c9` | progress | filled bars; a card's frame under the pointer |
| Grey `#8f8d86` | done, or not yours | done steps, frames, other people's changes |
| Outlined pale grey | to come | upcoming steps |

Only the current step is coloured, and a slow light band sweeps across it (off when the system asks for reduced motion).

## Requirements

- Claude Code with plugin function hooks (2.1.293 or later). On an older version, `claude plugin list` shows the plugin as `failed to load` with `Hook load failed: … "hooks" … expected record`: run `claude update`.
- `git`, to tell your changes from other people's (optional).
- The `openspec` CLI on the `PATH` of the process running Claude Code (the pane runs `openspec list` and `openspec status --json`).
  Installed with nvm? nvm only sets the `PATH` in interactive shells. A small wrapper in `~/.local/bin/openspec` fixes that:

  ```bash
  #!/usr/bin/env bash
  for dir in $(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -rV); do
    [ -x "$dir/openspec" ] && exec "$dir/node" "$dir/openspec" "$@"
  done
  echo "openspec not found in ~/.nvm" >&2; exit 127
  ```

## Update and remove

To update to a newer release:

```bash
claude plugin marketplace update spec-manager
claude plugin update spec-manager@spec-manager
```

then start a new session (or restart the app and reopen the conversation): `/reload-plugins` does not always swap a running pane.

To remove it:

```bash
claude plugin uninstall spec-manager@spec-manager
claude plugin marketplace remove spec-manager
```

## Known limits

- **Terminal layout:** the pane docks to the right of the conversation in the fullscreen renderer (from 110 columns wide); in the classic one it sits above the prompt, with less room. Switch with `/tui fullscreen`.
- **Desktop clicks:** while the prompt has the focus, the first click on the pane only gives it the focus; the next one presses.
- **Shared repositories:** the pane reads your working copy, so other people's changes appear once merged and pulled. "Last activity" comes from file modification times, which a `git pull` resets.
- **Ownership** is decided by the first commit on a change's folder: someone who later takes over a change does not become its owner.

## What it runs, reads and sends

Spec Manager makes **no network request** and sends **nothing** anywhere: no telemetry, no analytics, no remote server. Everything stays on your machine.

**Programs it runs**, in the folder of each OpenSpec module, to read the state of your changes:

| Command | Why |
| --- | --- |
| `openspec list --json` | the active changes and their task counts |
| `openspec status --all --json` | which planning documents each change has |
| `openspec list --specs --sort name --json` | the main specs, for the SPECS block |
| `openspec list --archived --json` | the archived changes, for the ARCHIVED block |
| `git config user.email` | your git identity, to tell your changes from other people's |
| `git log --reverse --format=%ae%x09%an -- <change folder>` | who made the first commit on a change folder, i.e. its owner |

What `openspec` itself does when it runs is up to the OpenSpec CLI.

**What it reads:** the files under each `openspec/` folder (`tasks.md`, `proposal.md`, `design.md`, the change's specs: their headings and task lines, the first sentence of the proposal's Why, and the open questions listed in design.md), the folder names and modification times, and, through `git log`, the name and email of the author of each change folder's first commit, to show them in its pane. The plugin itself does not store or send them, nor write them into the conversation; how Claude Code handles what it displays is covered by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

**What it watches in the session:** a `tool.call` hook sees each tool call Claude makes, only to check whether it mentions `openspec` (an edit in an `openspec/` folder, an `openspec` command) and refresh the pane at once; it does not change, block, store or send a call. A `session.start` hook opens the pane where there is an OpenSpec module, and the `/spec-manager` command opens it anywhere or picks a module.

**What it keeps:** the last module you picked in each repository, in Claude Code's plugin storage on your machine.

The same, as a privacy policy: [Privacy](PRIVACY.md).

## How it works

- Finds the modules once a minute; every 5 seconds it fingerprints their `openspec/` folders (names and modification times) and only runs `openspec` and `git` when something changed. Any tool call mentioning `openspec` refreshes at once.
- The selected module is read in full (`openspec list`, `status`, `list --specs`, `list --archived`); the others light (`list`, `status`), enough for their cards.
- Reads `tasks.md`, `proposal.md`, `design.md` and the change's specs by their structure: headings (`## 1. Section`, `### D1.`, `### Requirement:`, `#### Scenario:`), task lines (`- [ ]`), the first sentence under `## Why`, and the bullets under `## Open Questions`.
- Ownership: `git log --reverse --format=%ae%x09%an -- <change folder>`, first line, against `git config user.email`.
- Bars, steppers and dots are SVG on the desktop (exact pixel widths, a light band animated on the current step); the terminal gets a text fallback.

## Development

```bash
claude plugin validate .
claude plugin test .
```

A GitHub workflow (`.github/workflows/check.yml`) runs both on every push and pull request, fails when the plugin code changes without a higher `version` in `plugin.json` (`claude plugin update` would skip such a release), tags each released version (`v0.1.0`, …) and publishes a GitHub release for it, titled and described by the release commit.

`hooks/register.tsx` is the whole mod; `types/index.d.ts` declares the state it keeps. `hooks/register.test.ts` covers the parsing and the rules (whose turn, ownership, module lookup); `hooks/overview.test.tsx` draws the pane on the terminal and the desktop against a fake two-module repository and clicks through it.

## License

[MIT](LICENSE)

Spec Manager is an independent project, not affiliated with or endorsed by the [OpenSpec](https://github.com/Fission-AI/OpenSpec) project or Anthropic. It only reads OpenSpec's file format and runs the `openspec` command you installed; it bundles none of OpenSpec's code.
