"""Fail if the plugin's code runs a command beyond its list, or one built at run time.

Reads the mod's own files (every .ts and .tsx under hooks/, sub-folders included, the
tests aside). Every `process` in the code must be `$.process.run([...], {...})`, its
command written out in the source, word for word one of ALLOWED: a command assembled
from variables could be anything, and `process` reached any other way ($ under another
name, destructured, optional chaining) would hide its calls. Each openspec run passes
`env: OPENSPEC_ENV` (its telemetry off) once, and every run one `timeoutMs` with a value.

Comments, strings and regular expressions are read as such: a word in them is not code,
an apostrophe in a comment opens no string.

    python3 .github/commands-check.py [hooks dir]
"""
import pathlib
import re
import sys

# Each command, word for word
ALLOWED = {
    ("openspec", "list", "--json"),
    ("openspec", "status", "--all", "--json"),
    ("openspec", "list", "--specs", "--sort", "name", "--json"),
    ("openspec", "list", "--archived", "--json"),
}

# After one of these, a `/` opens a regular expression rather than a division
REGEX_BEFORE = set("(,=:[!&|?{};+-*%<>~^") | {""}


def blanked(text):
    """Two copies of the text, the same length, newlines kept: `code` with comments
    blanked; `bare` with string and regex contents blanked too (their quotes kept)"""
    code, bare = list(text), list(text)
    i, n = 0, len(text)
    last = ""  # the last character of code seen, spaces aside

    def blank(start, end, both):
        for k in range(start, end):
            if text[k] != "\n":
                bare[k] = " "
                if both:
                    code[k] = " "

    while i < n:
        ch, nxt = text[i], text[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            end = text.find("\n", i)
            end = n if end < 0 else end
            blank(i, end, True)
            i = end
        elif ch == "/" and nxt == "*":
            end = text.find("*/", i + 2)
            end = n if end < 0 else end + 2
            blank(i, end, True)
            i = end
        elif ch in "'\"`":
            j = i + 1
            while j < n and text[j] != ch:
                j += 2 if text[j] == "\\" else 1
            blank(i + 1, min(j, n), False)
            i, last = j + 1, ch
        elif ch == "/" and (last in REGEX_BEFORE or re.search(r"\b(return|typeof|case)\s*$", text[:i])):
            j, in_class = i + 1, False
            while j < n and text[j] != "\n" and (text[j] != "/" or in_class):
                if text[j] == "\\":
                    j += 1
                elif text[j] == "[":
                    in_class = True
                elif text[j] == "]":
                    in_class = False
                j += 1
            blank(i + 1, min(j, n), False)
            i, last = j + 1, "/"
        else:
            if not ch.isspace():
                last = ch
            i += 1
    return "".join(code), "".join(bare)


def closing(bare, start, opening, close):
    """Index just past the bracket matching bare[start]; strings and comments are already
    blanked, so their brackets do not count. -1 when it is never closed"""
    depth = 0
    for i in range(start, len(bare)):
        if bare[i] == opening:
            depth += 1
        elif bare[i] == close:
            depth -= 1
            if depth == 0:
                return i + 1
    return -1


def words(argv):
    """The array's words, each a plain string literal; None as soon as one is not"""
    out = []
    for part in [p.strip() for p in argv.split(",") if p.strip()]:
        literal = re.fullmatch(r"'([^'\\`$]*)'|\"([^\"\\`$]*)\"", part)
        if not literal:
            return None
        out.append(literal.group(1) if literal.group(1) is not None else literal.group(2))
    return tuple(out)


def init_problems(init, command):
    """What is wrong with a run's options, read with strings and comments blanked"""
    problems = []
    keys = re.findall(r"(?<![\w$.])(\w+)\s*(?=[:,}])", init)
    if keys.count("timeoutMs") != 1:
        problems.append(f"{command} runs without one timeoutMs" if "timeoutMs" not in keys else f"{command} gives timeoutMs more than once")
    elif re.search(r"\btimeoutMs\s*:\s*(?:undefined|null|0+|-[\w.]*|Infinity)\s*[,}]", init):
        problems.append(f"{command} runs with a timeoutMs that sets no limit")
    if command.startswith("openspec"):
        if keys.count("env") != 1 or not re.search(r"\benv\s*:\s*OPENSPEC_ENV\s*[,}]", init):
            problems.append(f"{command} runs without env: OPENSPEC_ENV, once")
    if re.search(r"\.\.\.", init):
        problems.append(f"{command} spreads its options: what it passes cannot be read")
    return problems


def check(root):
    problems, runs = [], 0
    files = [f for f in sorted(pathlib.Path(root).rglob("*")) if f.is_file() and f.suffix in (".ts", ".tsx") and ".test." not in f.name]
    for file in files:
        text = file.read_text()
        code, bare = blanked(text)
        name = file.relative_to(root)
        line = lambda at: bare.count("\n", 0, at) + 1  # noqa: E731
        allowed_at = set()
        for m in re.finditer(r"\$\.process\s*\.\s*run\s*\(", bare):
            runs += 1
            where = f"{name}:{line(m.start())}"
            allowed_at.add(m.start() + 2)  # where its `process` stands
            call_end = closing(bare, m.end() - 1, "(", ")")
            if call_end < 0:
                problems.append(f"{where}: $.process.run( never closed")
                continue
            at = m.end()
            while at < call_end and bare[at].isspace():
                at += 1
            if bare[at] != "[":
                problems.append(f"{where}: the command is not written out as an array")
                continue
            end = closing(bare, at, "[", "]")
            command = words(code[at + 1 : end - 1]) if 0 < end <= call_end else None
            if command is None or command not in ALLOWED:
                shown = " ".join(code[at : end if end > 0 else at + 60].split())
                problems.append(f"{where}: command not on the list: {shown}")
                continue
            for problem in init_problems(bare[end:call_end], " ".join(command[:2])):
                problems.append(f"{where}: {problem}")
        # Any other `process` in the code: $ under another name, destructured, optional
        # chaining, $.process kept aside or another of its calls. Its calls would go unseen
        for m in re.finditer(r"\bprocess\b", bare):
            if m.start() not in allowed_at:
                problems.append(f"{name}:{line(m.start())}: process reached other than as $.process.run(: its calls unseen")
        # $ read by a computed key ($['process'], $?.[k]): what it reaches cannot be read
        for m in re.finditer(r"\$\s*(?:\?\.)?\s*\[", bare):
            problems.append(f"{name}:{line(m.start())}: $ read by a computed key: what it reaches unseen")
    return problems, runs, len(files)


if __name__ == "__main__":
    problems, runs, files = check(sys.argv[1] if len(sys.argv) > 1 else "hooks")
    if problems:
        sys.exit("commands check failed:\n  " + "\n  ".join(problems))
    if runs == 0:
        sys.exit("commands check failed: no $.process.run found, the check reads nothing")
    print(f"commands check: {runs} commands in {files} files, all on the list")
