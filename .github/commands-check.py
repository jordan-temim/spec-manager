"""Fail if the plugin's code runs a command beyond its list, or one built at run time.

Reads the mod's own files (every .ts and .tsx under hooks/, sub-folders included, the
tests aside). Every `process` in the code must be `$.process.run([...], {...})`, its
command written out in the source, word for word one of ALLOWED: a command assembled
from variables could be anything, and `process` reached any other way ($ under another
name, destructured, optional chaining) would hide its calls. Each openspec run passes
`env: OPENSPEC_ENV` (its telemetry off) once, and every run one `timeoutMs` with a value.

Comments, strings and regular expressions are read as such, to find the calls and read
their commands and options: a call in a comment is not one, an apostrophe in a comment
opens no string. Then a second reading, of the raw text line by line, makes sure that
reading missed nothing. It passes over only the lines that are comments and nothing else
(`//` lines, `/* ... */` blocks opened at a line's start, a .tsx's `{/* ... */}`), and
there every `$.process.run(` must be one the first reading checked, at its very place.
And the word `process` is refused anywhere else but in `$.process.run(`: in a string
("process exited"), in a .tsx's text, in a comment after code on its line or in a `/*`
opened mid-line. Write it in a comment line of its own.

Its tests, run by the CI right after this check:
- .github/commands-check-unit-test.py (unittest) calls blanked(), comment_lines() and
  check() on small .ts and .tsx snippets: templates nested or holding code or a regular
  expression, a quoted string ending at its line, a .tsx's text and closing tags, a
  regular expression after `=>`, comment lines and a .tsx's {/* */}, options missing, in
  a variable or spread, a run hidden in a string or a template's text;
- .github/commands-check-test.py runs the script itself on whole folders, each case to
  pass or to be refused for a given reason.

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

# After one of these, a `/` opens a regular expression rather than a division. Not `<`
# nor `>`: in a .tsx, `</Text>` closes a tag, it opens no regular expression
REGEX_BEFORE = set("(,=:[!&|?{};+-*%~^") | {""}


def blanked(text, is_tsx=False):
    """Two copies of the text, the same length, newlines kept: `code` with comments
    blanked; `bare` with the contents of strings, template literals and regular
    expressions blanked too (their quotes kept). A template's `${...}` is code, read as
    code, templates nested in it included. A '...' or "..." string ends at its line's end,
    as in JavaScript: an apostrophe in a .tsx's text (<Text>Pas d'archive</Text>) blanks
    the rest of that line at most, never the lines after it"""
    code, bare = list(text), list(text)
    i, n = 0, len(text)
    last = ""  # the last character of code seen, spaces aside
    # One entry per template literal under way: how many `{` its current `${...}` has
    # opened. Empty: the scan is in plain code. A template's own text is scanned apart
    braces = []

    def blank(start, end, both):
        for k in range(start, end):
            if text[k] != "\n":
                bare[k] = " "
                if both:
                    code[k] = " "

    def template(start):
        """Scan a template's text from `start`; return where code takes over, and the `last`
        character code goes on from: just past its closing backtick (popping it), a value
        ended, so "`"; or just past a `${`, an expression starting, so "{", after which a
        `/` opens a regular expression"""
        j = start
        while j < n and text[j] != "`" and not (text[j] == "$" and text[j + 1 : j + 2] == "{"):
            j += 2 if text[j] == "\\" else 1
        blank(start, min(j, n), False)
        if j >= n:
            braces.pop()
            return n, "`"
        if text[j] == "`":
            braces.pop()
            return j + 1, "`"
        return j + 2, "{"

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
        elif ch == "`":
            braces.append(0)
            i, last = template(i + 1)
        elif ch == "{" and braces:
            braces[-1] += 1
            i, last = i + 1, ch
        elif ch == "}" and braces:
            if braces[-1] == 0:
                # The end of a ${...}: back to the template's own text
                i, last = template(i + 1)
            else:
                braces[-1] -= 1
                i, last = i + 1, ch
        elif ch in "'\"":
            j = i + 1
            while j < n and text[j] != ch and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            blank(i + 1, min(j, n), False)
            i, last = (j + 1 if j < n and text[j] == ch else j), ch
        elif ch == "/" and not (last == "}" and (nxt == ">" or is_tsx)) and (
            # After a `}`, a .tsx's `/` is a tag's (`prop={x}/>`) or its text's
            # (`<Text>{a}/{b}</Text>`): no regular expression there. In a .ts, a `}` ends a
            # block, and a `/` after it may open one; `}/>` never does
            last in REGEX_BEFORE
            # After an arrow's `=>` (a `>` alone, as in a .tsx tag, opens none)
            or (last == ">" and re.search(r"=>\s*$", text[:i]))
            or re.search(r"\b(return|typeof|case)\s*$", text[:i])
        ):
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


def comment_lines(text, code):
    """The lines that are comments and nothing else, as both readings say: on the raw
    text, a `//` line, or a line of a `/* ... */` block (opened at the start of a line)
    with nothing after its `*/`; and in `code`, the scan's copy with comments blanked, a
    line left blank. A .tsx's comment, `{/* ... */}`, counts as one too: its `{` before
    the `/*` and its `}` after the `*/` are all the code its lines may hold. A line only
    one of the readings takes for a comment is read as code: a mistake of either can no
    longer hide a line from the other"""
    lines, in_block = set(), False
    code_lines = code.split("\n")
    for number, line in enumerate(text.split("\n"), 1):
        if in_block or re.match(r"\s*\{?\s*/\*", line):
            closed = line.find("*/", 0 if in_block else line.find("/*") + 2)
            in_block = closed < 0
            raw = closed < 0 or line[closed + 2 :].strip() in ("", "}")
        else:
            raw = re.match(r"\s*//", line) is not None
        if raw and re.fullmatch(r"\s*\{?\s*\}?\s*", code_lines[number - 1]):
            lines.add(number)
    return lines


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
        code, bare = blanked(text, file.suffix == ".tsx")
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
            # The options, an object written out in the call: none, or a variable (`opts`),
            # and what the run passes cannot be read
            options = bare[end:call_end]
            shape = re.match(r"\s*,\s*\{", options)
            object_end = closing(bare, end + shape.end() - 1, "{", "}") if shape else -1
            # Nothing after the object but the call's own end (a trailing comma allowed)
            if object_end < 0 or not re.fullmatch(r"[\s,]*\)", bare[object_end:call_end]):
                problems.append(f"{where}: {' '.join(command[:2])} runs without its options written out as an object")
                continue
            for problem in init_problems(options, " ".join(command[:2])):
                problems.append(f"{where}: {problem}")
        # Any other `process` in the code: $ under another name, destructured, optional
        # chaining, $.process kept aside or another of its calls. Its calls would go unseen
        for m in re.finditer(r"\bprocess\b", bare):
            if m.start() not in allowed_at:
                problems.append(f"{name}:{line(m.start())}: process reached other than as $.process.run(: its calls unseen")
        # $ read by a computed key ($['process'], $?.[k]): what it reaches cannot be read
        for m in re.finditer(r"\$\s*(?:\?\.)?\s*\[", bare):
            problems.append(f"{name}:{line(m.start())}: $ read by a computed key: what it reaches unseen")
        # The same rules on the raw text, line by line, with no scan to trust: a call or a
        # `process` the scan took for a string (a template it misread, an apostrophe in a
        # .tsx's text) is still found. Only lines that are comments and nothing else are
        # passed over; a `process` in a string or after code on its line fails, to be safe
        comments = comment_lines(text, code)
        raw_line = lambda at: text.count("\n", 0, at) + 1  # noqa: E731
        # Call by call, at its exact place: every raw `$.process.run(` outside a comment
        # line must be one the scan checked. A call hidden on the line of a checked one, or
        # anywhere else, is found whatever the counts
        checked = {at - 2 for at in allowed_at}  # where each checked call's `$` stands
        for m in re.finditer(r"\$\.process\s*\.\s*run\s*\(", text):
            if raw_line(m.start()) not in comments and m.start() not in checked:
                problems.append(f"{name}:{raw_line(m.start())}: $.process.run( inside a string, a template or text: not checked")
        for m in re.finditer(r"\bprocess\b", text):
            if raw_line(m.start()) in comments:
                continue
            if not re.match(r"\s*\.\s*run\s*\(", text[m.end():]) or not re.search(r"\$\.$", text[: m.start()]):
                problems.append(f"{name}:{raw_line(m.start())}: the word process outside a comment line, other than in $.process.run(")
    return problems, runs, len(files)


if __name__ == "__main__":
    problems, runs, files = check(sys.argv[1] if len(sys.argv) > 1 else "hooks")
    if problems:
        sys.exit("commands check failed:\n  " + "\n  ".join(problems))
    if runs == 0:
        sys.exit("commands check failed: no $.process.run found, the check reads nothing")
    print(f"commands check: {runs} commands in {files} files, all on the list")
