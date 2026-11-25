"""Cases for commands-check.py: a hooks folder holding one file, which must pass or fail
as said, a failure naming what it found.

    python3 .github/commands-check-test.py
"""
import pathlib
import subprocess
import sys
import tempfile

CHECK = pathlib.Path(__file__).with_name("commands-check.py")
OK_OPENSPEC = "$.process.run(['openspec', 'list', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: T })"
OK_SPLIT = "$.process\n  .run(['openspec', 'status', '--all', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: T })"

CASES = [
    ("the plugin's own commands pass, a call split over lines too", f"{OK_OPENSPEC}\n{OK_SPLIT}", True, None),
    ("git is not on the list", "$.process.run(['git', 'config', 'user.email'], { cwd, timeoutMs: T })", False, "['git', 'config'"),
    ("a variable in the command fails", "$.process.run(['openspec', 'list', name], { env: OPENSPEC_ENV, timeoutMs: T })", False, "not on the list"),
    ("a command off the list fails", "$.process.run(['curl', 'https://example.com'], { timeoutMs: T })", False, "curl"),
    ("an openspec verb off the list fails", "$.process.run(['openspec', 'archive', 'x'], { env: OPENSPEC_ENV, timeoutMs: T })", False, "archive"),
    ("a command built at run time fails", "$.process.run(argv, { timeoutMs: T })", False, "not written out"),
    ("a variable where a word is expected fails", "$.process.run(['openspec', verb, '--json'], { env: OPENSPEC_ENV, timeoutMs: T })", False, "not on the list"),
    ("a spread into the command fails", "$.process.run(['openspec', ...rest], { env: OPENSPEC_ENV, timeoutMs: T })", False, "not on the list"),
    ("a template string fails", "$.process.run([`openspec`, 'list', '--json'], { env: OPENSPEC_ENV, timeoutMs: T })", False, "not on the list"),
    ("openspec without its env fails", "$.process.run(['openspec', 'list', '--json'], { cwd, timeoutMs: T })", False, "OPENSPEC_ENV"),
    ("a run without timeout fails", "$.process.run(['openspec', 'list', '--json'], { cwd, env: OPENSPEC_ENV })", False, "timeoutMs"),
    ("another $.process call fails", f"{OK_OPENSPEC}\n$.process.spawn(['sh'])", False, "spawn"),
    ("$.process kept in a variable fails", f"{OK_OPENSPEC}\nconst p = $.process\np.run(['curl', 'x'])", False, "taken aside"),
    ("$['process'] fails", f"{OK_OPENSPEC}\n$['process'].run(['curl', 'x'])", False, "taken aside"),
    ("a file with no command at all fails: the check would read nothing", "const x = 1", False, "no $.process.run"),
]

failed = 0
for name, source, should_pass, said in CASES:
    with tempfile.TemporaryDirectory() as root:
        pathlib.Path(root, "load.ts").write_text(source)
        # A test file is not the mod's code: whatever it holds, it is not read
        pathlib.Path(root, "load.test.ts").write_text("$.process.run(['rm', '-rf', '/'])")
        run = subprocess.run([sys.executable, str(CHECK), root], capture_output=True, text=True)
    out = run.stdout + run.stderr
    ok = (run.returncode == 0) == should_pass and (said is None or said in out)
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"\n     exit {run.returncode}: {out.strip()}"))
    failed += not ok
sys.exit(1 if failed else 0)
