"""Fail if the plugin's code runs a command beyond its list, or one built at run time.

Reads the mod's own files (hooks/*.ts and *.tsx, the tests aside). Every `$.process`
call must be `$.process.run([...], {...})` with its command written out in the source,
word for word one of ALLOWED: a command assembled from variables could be anything.
No word is left to the code: a variable in the command fails. Each openspec run passes
OPENSPEC_ENV (its telemetry off), and every run a timeoutMs. git is not on the list: the
plugin runs openspec alone.

    python3 .github/commands-check.py [hooks dir]
"""
import pathlib
import re
import sys

# Each command, word for word; DIR stands for a variable, which no command holds
DIR = object()
ALLOWED = {
    ("openspec", "list", "--json"),
    ("openspec", "status", "--all", "--json"),
    ("openspec", "list", "--specs", "--sort", "name", "--json"),
    ("openspec", "list", "--archived", "--json"),
}


def closing(text, start, opening, close):
    """Index just past the bracket matching text[start], strings skipped"""
    depth, i, quote = 0, start, None
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 1
            elif ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch == opening:
            depth += 1
        elif ch == close:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def words(argv):
    """The array's words: a string literal as itself, a bare name as DIR, else None"""
    out = []
    for part in [p.strip() for p in argv.split(",") if p.strip()]:
        literal = re.fullmatch(r"'([^'\\`$]*)'", part)
        if literal:
            out.append(literal.group(1))
        elif re.fullmatch(r"[A-Za-z_]\w*", part):
            out.append(DIR)
        else:
            return None
    return tuple(out)


def check(root):
    problems, runs = [], 0
    files = [f for f in sorted(pathlib.Path(root).glob("*.ts*")) if ".test." not in f.name and f.suffix in (".ts", ".tsx")]
    for file in files:
        text = file.read_text()
        # $.process kept aside (`const p = $.process`, `$["process"]`): its calls would go unseen
        for m in re.finditer(r"\$\.process\b(?!\s*\.\s*\w)|\$\s*\[\s*['\"`]process", text):
            problems.append(f"{file.name}:{text.count(chr(10), 0, m.start()) + 1}: $.process taken aside, its calls unseen")
        for m in re.finditer(r"\$\.process\s*\.\s*(\w+)", text):
            where = f"{file.name}:{text.count(chr(10), 0, m.start()) + 1}"
            if m.group(1) != "run":
                problems.append(f"{where}: $.process.{m.group(1)}, not run")
                continue
            runs += 1
            at = m.end()
            while at < len(text) and text[at].isspace():
                at += 1
            if text[at : at + 1] != "(":
                problems.append(f"{where}: $.process.run not called")
                continue
            at += 1
            while at < len(text) and text[at].isspace():
                at += 1
            if text[at : at + 1] != "[":
                problems.append(f"{where}: the command is not written out as an array")
                continue
            end = closing(text, at, "[", "]")
            command = words(text[at + 1 : end - 1]) if end > 0 else None
            if command is None or command not in ALLOWED:
                shown = text[at:end] if end > 0 else text[at : at + 60]
                problems.append(f"{where}: command not on the list: {' '.join(shown.split())}")
                continue
            call_end = closing(text, m.end() + text[m.end() :].index("("), "(", ")")
            init = text[end:call_end]
            if "timeoutMs:" not in init:
                problems.append(f"{where}: {command[0]} {command[1]} runs without a timeoutMs")
            if command[0] == "openspec" and "env: OPENSPEC_ENV" not in init:
                problems.append(f"{where}: openspec {command[1]} runs without env: OPENSPEC_ENV")
    return problems, runs


if __name__ == "__main__":
    problems, runs = check(sys.argv[1] if len(sys.argv) > 1 else "hooks")
    if problems:
        sys.exit("commands check failed:\n  " + "\n  ".join(problems))
    if runs == 0:
        sys.exit("commands check: no $.process.run found, the check reads nothing")
    print(f"commands check: {runs} commands, all on the list")
