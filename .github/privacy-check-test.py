"""Cases for privacy-check.py's reading of the validator's report.

Each case is a report as `claude plugin validate --json` writes it, piped to the
check; it must pass or fail as said, and a failure must name what it found.

    python3 .github/privacy-check-test.py
"""
import json
import pathlib
import subprocess
import sys

CHECK = pathlib.Path(__file__).with_name("privacy-check.py")
HOOKS = "session.start, session.end, command.run{command=spec-manager}, ui.render{component=Pane, requestId=spec-manager}"
CALLS = "$.clock.every, $.fs.read (via loadDigest, readKept), $.process.run (via a, b, c), $.ui.open"


def report(*notes):
    return {"contents": [{"file": "plugin.json", "type": "plugin", "notes": []}, {"file": "hooks.json", "type": "hooks", "notes": list(notes)}]}


CASES = [
    ("matchers with commas and (via a, b) suffixes are read whole",
     report(f"./register.tsx hooks: {HOOKS}", f"./register.tsx calls: {CALLS}"), True, None),
    ("a second module is checked too",
     report(f"./register.tsx hooks: {HOOKS}", f"./register.tsx calls: {CALLS}",
            "./second.tsx hooks: tool.call", "./second.tsx calls: $.session.messages"),
     False, "tool.call, $.session.messages"),
    ("a module with hooks and no calls line fails",
     report(f"./register.tsx hooks: {HOOKS}", f"./register.tsx calls: {CALLS}", "./second.tsx hooks: session.start"),
     False, "./second.tsx"),
    ("a note that only mentions the word stands for nothing",
     report("this plugin hooks: nothing it should not", f"./register.tsx hooks: {HOOKS}", f"./register.tsx calls: {CALLS}"),
     True, None),
    ("a report without the lines fails",
     report("some other note"), False, "no 'hooks:' line"),
    ("a module path holding a space, and a list wrapped over lines, are read whole",
     report(f"./my mod.tsx hooks: {HOOKS}", "./my mod.tsx calls: $.clock.every,\n  $.fs.read (via a, b)"), True, None),
    ("a module's note naming calls in another shape fails, not skipped",
     report(f"./register.tsx hooks: {HOOKS}", f"./register.tsx calls: {CALLS}", "./second.tsx calls:$.model.complete"),
     False, "does not read as one"),
    ("a call off the list next to a via suffix fails",
     report(f"./register.tsx hooks: {HOOKS}", "./register.tsx calls: $.fs.read (via a, b), $.model.complete"),
     False, "$.model.complete"),
]

failed = 0
for name, case, should_pass, said in CASES:
    run = subprocess.run([sys.executable, str(CHECK)], input=json.dumps(case), capture_output=True, text=True)
    out = run.stdout + run.stderr
    ok = (run.returncode == 0) == should_pass and (said is None or said in out)
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     exit {run.returncode}: {out.strip()}"))
    failed += not ok
sys.exit(1 if failed else 0)
