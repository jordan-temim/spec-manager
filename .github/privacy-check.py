"""Fail if the plugin listens to, or calls, anything beyond what it needs.

Reads `claude plugin validate . --json` on stdin. Spec Manager must hook only its
session start and end, its own command and the drawing of its pane, and call only the
clock, files, openspec/git, the session's folder and id (to keep each session's
state apart), its own state and store, and its pane: nothing that
reaches the conversation (messages, prompts, answers, tool calls, the model) or
sends anything out.

    claude plugin validate . --json | python3 .github/privacy-check.py
"""
import json
import re
import sys

ALLOWED_HOOKS = {
    "session.start", "session.end",
    "command.run{command=spec-manager}",
    "ui.render{component=Pane, requestId=spec-manager}",
}
ALLOWED_CALLS = {
    "$.clock.every", "$.clock.now",
    "$.command.register",
    "$.fs.exists", "$.fs.list", "$.fs.read",
    "$.process.run",
    "$.session.cwd", "$.session.id",
    "$.state.get", "$.state.set",
    "$.store.get", "$.store.set",
    "$.ui.open", "$.ui.panes", "$.ui.resolve",
}

report = json.load(sys.stdin)
notes = [n for c in report.get("contents", []) for n in c.get("notes", [])]


def items_of(body):
    # "$.fs.read (via a, b), $.ui.open" -> ["$.fs.read", "$.ui.open"]; keep {...} matchers whole
    items, depth, current = [], 0, ""
    for ch in body:
        if ch in "{(":
            depth += 1
        elif ch in "})":
            depth -= 1
        if ch == "," and depth == 0:
            items.append(current.strip())
            current = ""
        else:
            current += ch
    items.append(current.strip())
    return {re.sub(r"\s*\(via .*\)$", "", i) for i in items if i}


def listed(kind):
    # One line per hooks module, "<module> hooks: ..." and "<module> calls: ...": every
    # module's lines count, and a note merely mentioning the word does not
    # A module's line starts with its path (./register.tsx); that path may hold spaces, and a
    # long list may wrap. A module's note that names the kind but does not read as one is
    # an error, never skipped: its hooks or calls would go unchecked
    pattern = re.compile(r"^(\./.+?) " + kind + r": (.*)$", re.S)
    found = {}
    for note in notes:
        m = pattern.match(note)
        if m:
            found.setdefault(m.group(1), set()).update(items_of(" ".join(m.group(2).split())))
        elif note.startswith("./") and f" {kind}:" in note:
            sys.exit(f"privacy check: a module's '{kind}:' note does not read as one: {note[:120]}")
    if not found:
        sys.exit(f"privacy check: no '{kind}:' line in the validator report")
    return found


hooks = listed("hooks")
calls = listed("calls")
# A module that hooks something must say what it calls too, or its calls went unchecked
if set(hooks) != set(calls):
    sys.exit("privacy check: hooks and calls lines do not name the same modules: "
             + ", ".join(sorted(set(hooks) ^ set(calls))))
all_hooks = set().union(*hooks.values())
all_calls = set().union(*calls.values())
bad = sorted(all_hooks - ALLOWED_HOOKS) + sorted(all_calls - ALLOWED_CALLS)
if bad:
    sys.exit("privacy check failed, the plugin now hooks or calls: " + ", ".join(bad))
print(f"privacy check: {len(hooks)} module(s), {len(all_hooks)} hooks and {len(all_calls)} calls, all allowed")
