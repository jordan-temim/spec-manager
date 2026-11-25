"""Unit tests of commands-check.py's readings: blanked(), comment_lines() and check(),
called on small TypeScript and .tsx snippets. Where commands-check-test.py runs the
script on whole folders, these pin what each reading does with each edge case.

    python3 .github/commands-check-unit-test.py
"""
import importlib.util
import pathlib
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location("commands_check", pathlib.Path(__file__).with_name("commands-check.py"))
cc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cc)

OK = "$.process.run(['openspec', 'list', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: T })"
CURL = "$.process.run(['curl', 'x'], { timeoutMs: T })"


def bare(text, is_tsx=False):
    return cc.blanked(text, is_tsx)[1]


def code(text):
    return cc.blanked(text)[0]


def problems(files):
    """check() on a temporary hooks folder holding `files`, {path: source}"""
    with tempfile.TemporaryDirectory() as root:
        for path, source in files.items():
            pathlib.Path(root, path).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(root, path).write_text(source)
        found, _, _ = cc.check(root)
    return found


class Blanked(unittest.TestCase):
    def test_both_copies_keep_the_length_and_the_newlines(self):
        text = "const a = 'x' // c\n/* b\n */ const r = /[']/g\nconst t = `a${`b${1}`}c`\n"
        for copy in cc.blanked(text):
            self.assertEqual(len(copy), len(text))
            self.assertEqual(copy.count("\n"), text.count("\n"))

    def test_comments_are_blanked_in_both_strings_only_in_bare(self):
        text = "f('process') // process\n"
        self.assertEqual(code(text), "f('process')           \n")
        self.assertEqual(bare(text), "f('       ')           \n")

    def test_a_templates_expression_is_code_its_text_is_not(self):
        text = "`text ${$.process.run([])} more`"
        self.assertIn("$.process.run(", bare(text))
        self.assertNotIn("text", bare(text))
        self.assertNotIn("more", bare(text))

    def test_nested_templates_close_at_their_own_backticks(self):
        # Every template's own text (a, b, c, d) blanked, the expressions (x) and the code
        # after them kept, each backtick and ${ } where it was
        self.assertEqual(bare("const a = `a${`b${x}c`}d`; after()"), "const a = ` ${` ${x} `} `; after()")

    def test_braces_in_a_templates_expression_close_it_at_the_right_one(self):
        self.assertTrue(bare("`${ { k: 1 }.k } t`; after()").endswith("; after()"))

    def test_a_quoted_string_ends_at_its_lines_end(self):
        # An apostrophe in a .tsx's text: the rest of its line at most, not the next lines
        text = "<Text>Pas d'archive</Text>\nnext()\n"
        self.assertEqual(bare(text).split("\n")[1], "next()")

    def test_a_closing_tag_opens_no_regular_expression(self):
        self.assertIn("after()", bare("<Text>a</Text>; after()"))

    def test_a_closing_tag_after_an_expression_opens_no_regular_expression(self):
        self.assertEqual(bare("const p = <A>{x}</A>; after('y')"), "const p = <A>{x}</A>; after(' ')")

    def test_a_self_closing_tag_after_a_props_expression_opens_no_regular_expression(self):
        self.assertEqual(bare("const p = <B prop={x}/>; after('y')"), "const p = <B prop={x}/>; after(' ')")

    def test_a_tsx_texts_slash_after_an_expression_opens_no_regular_expression(self):
        text = "const p = <Text>{a}/{b}</Text>; after('y')"
        self.assertEqual(bare(text, is_tsx=True), "const p = <Text>{a}/{b}</Text>; after(' ')")

    def test_a_regular_expression_after_a_block_still_is_one(self):
        # A `}` then `/` not closing a tag: a statement opening on a regular expression
        self.assertEqual(bare("if (a) { b() }\n/['`]/.test(s); after()"), "if (a) { b() }\n/    /.test(s); after()")

    def test_a_regular_expression_after_an_arrow_is_one(self):
        text = "const f = s => /[`']/.test(s); after()"
        self.assertIn("after()", bare(text))
        self.assertNotIn("`", bare(text).split("/")[1])

    def test_a_regular_expression_opening_a_templates_expression_is_one(self):
        text = "const a = `${/[{]/.test(s) ? 1 : 2} x`; after()"
        self.assertTrue(bare(text).endswith("; after()"))

    def test_a_division_is_not_a_regular_expression(self):
        text = "const r = a / 2; f('x'); const h = b / 3"
        self.assertIn("f(' ')", bare(text))


class CommentLines(unittest.TestCase):
    def lines(self, text):
        return cc.comment_lines(text, code(text))

    def test_line_comments_and_whole_block_comments(self):
        text = "// one\ncode()\n/* two\n * three\n */\ncode()"
        self.assertEqual(self.lines(text), {1, 3, 4, 5})

    def test_a_tsx_comment_counts(self):
        text = "<Box>\n  {/* one */}\n  {/* two\n      three */}\n</Box>"
        self.assertEqual(self.lines(text), {2, 3, 4})

    def test_code_after_a_comment_on_its_line_is_code(self):
        self.assertEqual(self.lines("/* note */ code()\n{/* note */} {code()}\n/* a\n */ code()"), {3})

    def test_a_star_line_outside_a_block_is_code(self):
        self.assertEqual(self.lines("const x = 2\n  * f()"), set())

    def test_a_comment_opener_in_a_string_is_no_comment(self):
        self.assertEqual(self.lines("const s = '/*'\ncode()\nconst t = '*/'"), set())


class Check(unittest.TestCase):
    def assertRefused(self, files, said):
        found = problems(files)
        self.assertTrue(any(said in p for p in found), f"no {said!r} in {found}")

    def test_the_plugins_own_commands_pass(self):
        self.assertEqual(problems({"load.ts": f"{OK}\n$.process\n  .run(['openspec', 'status', '--all', '--json'], {{ env: OPENSPEC_ENV, timeoutMs: T }})"}), [])

    def test_a_command_off_the_list(self):
        self.assertRefused({"load.ts": CURL}, "command not on the list: ['curl'")

    def test_options_missing_in_a_variable_or_spread(self):
        self.assertRefused({"load.ts": "$.process.run(['openspec', 'list', '--json'])"}, "options written out")
        self.assertRefused({"load.ts": "$.process.run(['openspec', 'list', '--json'], opts)"}, "options written out")
        self.assertRefused({"load.ts": "$.process.run(['openspec', 'list', '--json'], { ...o, env: OPENSPEC_ENV, timeoutMs: T })"}, "spreads")

    def test_options_read_as_keys(self):
        self.assertRefused({"load.ts": "$.process.run(['openspec', 'list', '--json'], { env: OPENSPEC_ENV_X, timeoutMs: T })"}, "OPENSPEC_ENV")
        self.assertRefused({"load.ts": "$.process.run(['openspec', 'list', '--json'], { env: OPENSPEC_ENV, timeoutMs: 0 })"}, "no limit")

    def test_a_run_hidden_in_a_string_or_a_template_text(self):
        self.assertRefused({"pane.tsx": f"{OK}\nconst p = <Text>Pas d'archive {CURL}</Text>"}, "not checked")
        self.assertRefused({"pane.tsx": f"{OK}; const p = <Text>d'x</Text>; {CURL}"}, "not checked")

    def test_a_run_in_a_templates_expression_is_read_as_code(self):
        self.assertRefused({"load.ts": f"{OK}\nconst a = `x${{{CURL}}}y`"}, "command not on the list: ['curl'")

    def test_process_reached_any_other_way(self):
        for source in ["const p = $.process", "const { process: p } = $", "$?.process.run([])", "const x = $; x.process.run([])"]:
            self.assertRefused({"load.ts": f"{OK}\n{source}"}, "process reached other")
        self.assertRefused({"load.ts": f"{OK}\n$['process'].run([])"}, "computed key")

    def test_the_word_process_outside_comment_lines(self):
        self.assertRefused({"load.ts": f"{OK}\nconst s = 'process exited'"}, "the word process")
        self.assertRefused({"load.ts": f"{OK} // process"}, "the word process")
        self.assertEqual(problems({"load.ts": f"// a process\n{OK}"}), [])

    def test_sub_folders_are_read_tests_are_not(self):
        self.assertRefused({"load.ts": OK, "lib/run.ts": CURL}, "lib/run.ts")
        self.assertEqual(problems({"load.ts": OK, "load.test.ts": CURL}), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
