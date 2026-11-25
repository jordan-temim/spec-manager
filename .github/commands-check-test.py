"""Cases for commands-check.py: a hooks folder holding the case's files, which must pass
or fail as said. A refusal is the check's own: exit 1, "commands check failed" on stderr
naming what it found, and no traceback, so a crash never reads as a refusal.

    python3 .github/commands-check-test.py
"""
import pathlib
import subprocess
import sys
import tempfile

CHECK = pathlib.Path(__file__).with_name("commands-check.py")
OK_OPENSPEC = "$.process.run(['openspec', 'list', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: T })"
OK_SPLIT = "$.process\n  .run(['openspec', 'status', '--all', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: T })"
CURL = "$.process.run(['curl', 'https://example.com'], { timeoutMs: T })"
# The main reading's own refusal of CURL: the call read as code, its command off the list.
# A case about how the scan reads expects this, not a safety net's catch-all
MAIN_REFUSAL = "command not on the list: ['curl'"


def run_ok(init):
    return f"$.process.run(['openspec', 'list', '--json'], {init})"


# (name, files as {path: source}, passes, what a refusal names)
CASES = [
    ("the plugin's own commands pass, a call split over lines too", {"load.ts": f"{OK_OPENSPEC}\n{OK_SPLIT}"}, True, None),
    ("double quotes and a shorthand timeoutMs pass", {"load.ts": 'const timeoutMs = 1\n$.process.run(["openspec", "list", "--json"], { cwd, env: OPENSPEC_ENV, timeoutMs })'}, True, None),
    # What the command may be
    ("git is not on the list", {"load.ts": "$.process.run(['git', 'config', 'user.email'], { cwd, timeoutMs: T })"}, False, "['git', 'config'"),
    ("a command off the list fails", {"load.ts": CURL}, False, "curl"),
    ("an openspec verb off the list fails", {"load.ts": "$.process.run(['openspec', 'archive', 'x'], { env: OPENSPEC_ENV, timeoutMs: T })"}, False, "archive"),
    ("a command built at run time fails", {"load.ts": "$.process.run(argv, { timeoutMs: T })"}, False, "not written out"),
    ("a variable in the command fails", {"load.ts": "$.process.run(['openspec', 'list', name], { env: OPENSPEC_ENV, timeoutMs: T })"}, False, "not on the list"),
    ("a spread into the command fails", {"load.ts": "$.process.run(['openspec', ...rest], { env: OPENSPEC_ENV, timeoutMs: T })"}, False, "not on the list"),
    ("a template string fails", {"load.ts": "$.process.run([`openspec`, 'list', '--json'], { env: OPENSPEC_ENV, timeoutMs: T })"}, False, "not on the list"),
    # Its options, read as code, not as text
    ("openspec without its env fails", {"load.ts": run_ok("{ cwd, timeoutMs: T }")}, False, "OPENSPEC_ENV"),
    ("an env that only starts like OPENSPEC_ENV fails", {"load.ts": run_ok("{ env: OPENSPEC_ENV_DEBUG, timeoutMs: T }")}, False, "OPENSPEC_ENV"),
    ("a second env key fails: the last one wins", {"load.ts": run_ok("{ env: OPENSPEC_ENV, timeoutMs: T, env: {} }")}, False, "OPENSPEC_ENV"),
    ("an env named only in a comment fails", {"load.ts": run_ok("{ timeoutMs: T /* env: OPENSPEC_ENV */ }")}, False, "OPENSPEC_ENV"),
    ("an env named only in a string fails", {"load.ts": run_ok("{ cwd: 'env: OPENSPEC_ENV', timeoutMs: T }")}, False, "OPENSPEC_ENV"),
    ("spread options fail", {"load.ts": run_ok("{ ...opts, env: OPENSPEC_ENV, timeoutMs: T }")}, False, "spreads"),
    ("a run without timeout fails", {"load.ts": run_ok("{ cwd, env: OPENSPEC_ENV }")}, False, "timeoutMs"),
    ("a timeoutMs named only in a comment fails", {"load.ts": run_ok("{ env: OPENSPEC_ENV // timeoutMs: T\n }")}, False, "timeoutMs"),
    ("a timeoutMs of undefined fails", {"load.ts": run_ok("{ env: OPENSPEC_ENV, timeoutMs: undefined }")}, False, "no limit"),
    ("a timeoutMs of 0 fails", {"load.ts": run_ok("{ env: OPENSPEC_ENV, timeoutMs: 0 }")}, False, "no limit"),
    ("a second timeoutMs fails", {"load.ts": run_ok("{ env: OPENSPEC_ENV, timeoutMs: T, timeoutMs: undefined }")}, False, "more than once"),
    ("a run with no options fails", {"load.ts": "$.process.run(['openspec', 'list', '--json'])"}, False, "options written out"),
    ("a run whose options are a variable fails", {"load.ts": "$.process.run(['openspec', 'list', '--json'], opts)"}, False, "options written out"),
    ("a run with a third argument fails", {"load.ts": run_ok("{ env: OPENSPEC_ENV, timeoutMs: T }, extra")}, False, "options written out"),
    ("a trailing comma after the options passes", {"load.ts": run_ok("{ env: OPENSPEC_ENV, timeoutMs: T },\n")}, True, None),
    ("a call never closed fails, not read on into the next one", {"load.ts": f"$.process.run(['openspec', 'list', '--json'], {{ cwd\n{OK_OPENSPEC.replace('$.process.run(', 'f(')}"}, False, "never closed"),
    # Comments, strings and regular expressions are not code
    ("an apostrophe in a comment inside the call is not a string", {"load.ts": run_ok("{\n  // the caller's own folder\n  cwd,\n  env: OPENSPEC_ENV,\n  timeoutMs: T,\n}")}, True, None),
    # A `/` read as a division or as a regular expression, by what comes before it
    ("a division hides no run on its line", {"load.ts": f"{OK_OPENSPEC}\nconst r = total / 2; {CURL}; const h = w / 2"}, False, MAIN_REFUSAL),
    ("a division after a call's ) hides no run", {"load.ts": f"{OK_OPENSPEC}\nconst r = f(a) / g(b); {CURL}; const h = 1 / 2"}, False, MAIN_REFUSAL),
    ("a regular expression after return is one", {"load.ts": f"function f() {{ return /[')]/ }}\n{CURL}"}, False, MAIN_REFUSAL),
    ("a regular expression in a call's arguments is one", {"load.ts": f"s.replace(/[`'\"]/g, '')\n{OK_OPENSPEC}"}, True, None),
    ("a // in a string is no comment", {"load.ts": f"const url = 'https://example.com'\n{OK_OPENSPEC}"}, True, None),
    ("a quote in a regular expression opens no string", {"load.ts": f"const q = /['`]/g\n{CURL}"}, False, MAIN_REFUSAL),
    ("a command in a comment is not run", {"load.ts": f"// $.process.run(['curl', 'x'])\n{OK_OPENSPEC}"}, True, None),
    ("process in a comment line is not code", {"load.ts": f"// a process that runs\n/* another\n * process\n */\n{OK_OPENSPEC}"}, True, None),
    ("process in a .tsx's comment {/* */} is not code", {"pane.tsx": f"{OK_OPENSPEC}\nconst p = (\n  <Box>\n    {{/* a process note */}}\n    {{/* a longer\n        process note */}}\n  </Box>\n)"}, True, None),
    ("code after a .tsx's comment {/* */} on its line is read", {"pane.tsx": f"{OK_OPENSPEC}\n{{/* note */}} {{$.process.spawn(['sh'])}}"}, False, "process reached other"),
    ("process in a .tsx's text fails, to be safe", {"pane.tsx": f"{OK_OPENSPEC}\nconst p = <Text>process exited</Text>"}, False, "the word process"),
    ("process in a string fails, to be safe", {"load.ts": f"const s = 'process'\n{OK_OPENSPEC}"}, False, "the word process"),
    ("process in a comment after code fails, to be safe", {"load.ts": f"{OK_OPENSPEC} // a process"}, False, "the word process"),
    # Templates and .tsx text, read right
    ("a run inside a template's ${...} is checked", {"load.ts": f"{OK_OPENSPEC}\nconst a = `x${{{CURL}}}y`"}, False, MAIN_REFUSAL),
    ("a run inside a template nested in a template is checked", {"load.ts": f"{OK_OPENSPEC}\nconst a = `a${{`b${{{CURL}}}`}}c`"}, False, MAIN_REFUSAL),
    ("code after a nested template is still code", {"load.ts": f"const a = `a${{`b${{1}}`}}c`\n{CURL}"}, False, MAIN_REFUSAL),
    ("braces in a template's expression close it at the right one", {"load.ts": f"const a = `${{ {{ k: 1 }}.k }}`\n{OK_OPENSPEC}"}, True, None),
    ("an apostrophe in a .tsx's text hides no run", {"pane.tsx": f"{OK_OPENSPEC}\nconst p = <Text>Pas d'archive</Text>\n{CURL}\nconst z = 'q'"}, False, MAIN_REFUSAL),
    ("a self-closing tag after a prop's {...} opens no regular expression", {"pane.tsx": f"{OK_OPENSPEC}\nconst p = <B prop={{x}}/>; {CURL}"}, False, MAIN_REFUSAL),
    # The run sits in the {...} right after the `/`, where a regular expression read there
    # would blank it
    ("a / in a .tsx's text after an expression opens no regular expression", {"pane.tsx": f"{OK_OPENSPEC}\nconst p = <Text>{{a}}/{{{CURL}}}</Text>"}, False, MAIN_REFUSAL),
    ("the same / after an expression, in a .tsx's text, hides no allowed run", {"pane.tsx": f"const p = <Text>{{a}}/{{{OK_OPENSPEC}}}</Text>"}, True, None),
    ("a regular expression after a block, in a .ts, still is one", {"load.ts": f"if (a) {{ b() }}\n/['`]/.test(s); {CURL}"}, False, MAIN_REFUSAL),
    ("a closing tag opens no regular expression", {"pane.tsx": f"{OK_OPENSPEC}\nconst p = <Text>a</Text>; {CURL}"}, False, MAIN_REFUSAL),
    ("an apostrophe in a .tsx's text, the run on its own line, is still found", {"pane.tsx": f"{OK_OPENSPEC}\nconst p = <Text>Pas d'archive {CURL}</Text>"}, False, "not checked"),
    # process reached any other way
    ("another $.process call fails", {"load.ts": f"{OK_OPENSPEC}\n$.process.spawn(['sh'])"}, False, "process reached other"),
    ("$.process kept in a variable fails", {"load.ts": f"{OK_OPENSPEC}\nconst p = $.process\np.run(['curl', 'x'])"}, False, "process reached other"),
    ("process destructured from $ fails", {"load.ts": f"{OK_OPENSPEC}\nconst {{ process: p }} = $\np.run(['curl', 'x'])"}, False, "process reached other"),
    ("optional chaining on $ fails", {"load.ts": f"{OK_OPENSPEC}\n$?.process.run(['curl', 'x'], {{ timeoutMs: T }})"}, False, "process reached other"),
    ("$ under another name fails", {"load.ts": f"{OK_OPENSPEC}\nconst x = $\nx.process.run(['curl', 'x'])"}, False, "process reached other"),
    ("$['process'] fails", {"load.ts": f"{OK_OPENSPEC}\n$['process'].run(['curl', 'x'])"}, False, "computed key"),
    # A line is passed over as a comment only if both readings agree it is one
    ("code after a /* */ on its line is read", {"pane.tsx": f"{OK_OPENSPEC}\n/* note */ const p = <Text>d'x</Text>; {CURL}"}, False, "not checked"),
    ("code after a block comment's last line is read", {"pane.tsx": f"{OK_OPENSPEC}\n/* a\n * note\n */ const p = <Text>d'x</Text>; {CURL}"}, False, "not checked"),
    ("a * line outside a comment is code", {"load.ts": f"{OK_OPENSPEC}\nconst x = 2\n  * f($.process.spawn(['sh']))"}, False, "process reached other"),
    ("a /* in a string opens no comment", {"load.ts": f"const s = '/*'\n{CURL}\nconst t = '*/'"}, False, MAIN_REFUSAL),
    ("a run hidden after a checked one, on the same line, is found", {"pane.tsx": f"{OK_OPENSPEC}; const p = <Text>d'x</Text>; {CURL}"}, False, "not checked"),
    ("two allowed runs on one line pass", {"load.ts": f"{OK_OPENSPEC}; {OK_OPENSPEC}"}, True, None),
    # #9: what the scan's readings must catch, each refused for its own reason
    ("process alone in a template's ${...} is code", {"load.ts": f"{OK_OPENSPEC}\nconst a = `${{process}}`"}, False, "process reached other"),
    # A `{` read as code would count as a brace of the ${...}, the template's own end then
    # read as a new template's start, hiding the lines after it
    ("a regular expression opening a template's ${...} is one", {"load.ts": f"const a = `${{/[{{]/.test(s) ? 1 : 2}} x`\n{CURL}\nconst b = `y`"}, False, MAIN_REFUSAL),
    ("a regular expression opening a template's ${...} leaves the rest read right", {"load.ts": f"const a = `${{/[{{]/.test(s) ? 1 : 2}} x`\n{OK_OPENSPEC}\nconst b = `y`"}, True, None),
    ("process in a template's ${...} is code", {"load.ts": f"{OK_OPENSPEC}\nconst a = `${{$.process}}`"}, False, "process reached other"),
    ("a regular expression after => is one", {"load.ts": f"const f = (s: string) => /[`']/.test(s)\n{CURL}\nconst t = `x`"}, False, MAIN_REFUSAL),
    ("a division after => ... is still a division", {"load.ts": f"const f = (a: number) => a / 2; {CURL}; const h = 1 / 2"}, False, MAIN_REFUSAL),
    # Which files are read
    ("a file in a sub-folder is checked too", {"load.ts": OK_OPENSPEC, "lib/run.ts": CURL}, False, "lib/run.ts"),
    ("a test file is not the mod's code: whatever it runs, it is not read", {"load.ts": OK_OPENSPEC, "load.test.ts": CURL}, True, None),
    ("a folder with no command at all fails: the check would read nothing", {"load.ts": "const x = 1"}, False, "no $.process.run"),
]

failed = 0
for name, files, should_pass, said in CASES:
    with tempfile.TemporaryDirectory() as root:
        for path, source in files.items():
            pathlib.Path(root, path).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(root, path).write_text(source)
        run = subprocess.run([sys.executable, str(CHECK), root], capture_output=True, text=True)
    crashed = "Traceback" in run.stderr
    if should_pass:
        ok = not crashed and run.returncode == 0 and run.stdout.startswith("commands check:")
    else:
        ok = not crashed and run.returncode == 1 and run.stderr.startswith("commands check failed") and said in run.stderr
    shown = (run.stdout + run.stderr).strip()
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     exit {run.returncode}: {shown}"))
    failed += not ok
print(f"{len(CASES) - failed} of {len(CASES)} cases as expected")
sys.exit(1 if failed else 0)
