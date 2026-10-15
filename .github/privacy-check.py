"""Fail if the plugin listens to, or calls, anything beyond what it needs.

Reads `claude plugin validate . --json` on stdin. Spec Manager must hook only its
session start, its own command and the drawing of its pane, and call only the
clock, files, openspec/git, its own state and store, and its pane: nothing that
reaches the conversation (messages, prompts, answers, tool calls, the model) or
sends anything out.

    claude plugin validate . --json | python3 .github/privacy-check.py
"""
import json
import re
import sys

ALLOWED_HOOKS = {
    "session.start",
    "command.run{command=spec-manager}",
    "ui.render{component=Pane, requestId=spec-manager}",
}
ALLOWED_CALLS = {
    "$.clock.every", "$.clock.now",
    "$.command.register",
    "$.fs.exists", "$.fs.list", "$.fs.read",
    "$.process.run",
    "$.session.cwd",
    "$.state.get", "$.state.set",
    "$.store.get", "$.store.set",
    "$.ui.open", "$.ui.resolve",
}

report = json.load(sys.stdin)
notes = [n for c in report.get("contents", []) for n in c.get("notes", [])]


def listed(prefix):
    line = next((n for n in notes if prefix in n), None)
    if line is None:
        sys.exit(f"privacy check: no '{prefix}' line in the validator report")
    body = line.split(prefix, 1)[1]
    # "$.fs.read (via a, b), $.ui.open" -> ["$.fs.read", "$.ui.open"]; keep {...} matchers whole
    items, depth, current = [], 0, ""
    for ch in body:
        depth += ch in "{(" and 1 or ch in "})" and -1 or 0
        if ch == "," and depth == 0:
            items.append(current.strip())
            current = ""
        else:
            current += ch
    items.append(current.strip())
    return {re.sub(r"\s*\(via .*\)$", "", i) for i in items if i}


hooks = listed("hooks: ")
calls = listed("calls: ")
bad = sorted(hooks - ALLOWED_HOOKS) + sorted(calls - ALLOWED_CALLS)
if bad:
    sys.exit("privacy check failed, the plugin now hooks or calls: " + ", ".join(bad))
print(f"privacy check: {len(hooks)} hooks and {len(calls)} calls, all allowed")
