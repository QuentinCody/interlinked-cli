import { describe, expect, it } from "vitest";
import { isLiteralContext, literalContextRegions, maskLiteralContext } from "./literal-context.js";

/** True when the FIRST occurrence of `needle` in `cmd` lies in a data-only region. */
function exempt(cmd: string, needle: string): boolean {
	const start = cmd.indexOf(needle);
	expect(start, `fixture must contain ${needle}`).toBeGreaterThanOrEqual(0);
	return isLiteralContext(cmd, start, start + needle.length);
}

// Shapes taken from the 2026-10-08 two-rater block adjudication
// (scratch/2026-10-08-decisions-orthogonal/e16-adjudication/literal-fp-commands.jsonl).
describe("literal-context — positive (must fire: the text is data)", () => {
	it("P1: a for-loop list consumed only by echo and `interlinked harness test` (docker prune sample)", () => {
		const cmd = `for c in 'docker system prune -af' 'docker system "prune" -af'; do echo "== $c"; interlinked harness test "$c" 2>&1 | head -4; done`;
		expect(exempt(cmd, "docker system prune -af")).toBe(true);
	});

	it("P2: a for-loop whose body runs `timeout 30 npx tsx src/index.ts harness test` piped to a pure node -e reader (terraform sample)", () => {
		const cmd = `for c in 'terraform apply -replace=aws_instance.web -auto-approve'; do printf '%s => ' "$c"; timeout 30 npx tsx src/index.ts harness test "$c" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).decision)})'; done`;
		expect(exempt(cmd, "-auto-approve")).toBe(true);
	});

	it("P3: a for-loop list after an rg prefix, with `timeout 60 interlinked harness test` (git stash sample)", () => {
		const cmd = `rg -n "restore-worktree" src/harness/rules/*.ts | head; for c in 'git stash push -- src/a.ts && git stash drop'; do echo "== $c"; timeout 60 interlinked harness test "$c" 2>&1 | head -4; echo "rc=$?"; done`;
		expect(exempt(cmd, "git stash drop")).toBe(true);
	});

	it("P4: a direct `interlinked harness test` argument", () => {
		expect(exempt(`interlinked harness test 'wrangler kv namespace delete --namespace-id abc123'`, "wrangler kv namespace delete")).toBe(true);
	});

	it("P5: a JS string literal in a node -e regex self-test (kubectl sample)", () => {
		const cmd = `node -e '\nconst re = new RegExp("\\\\bkubectl\\\\b", "i");\nconst cases = { "CONTROL": "kubectl delete deployments --all" };\nfor (const [k,v] of Object.entries(cases)) console.log(re.test(v), k);\n'`;
		expect(exempt(cmd, "kubectl delete deployments --all")).toBe(true);
	});

	it("P6: a JS line comment in a node -e program (pkill sample)", () => {
		const cmd = `node -e '\nconst b64=[\n "cGtpbGwgLTkgbm9kZQ==",      // pkill -9 node\n];\nfor(const e of b64) console.log(Buffer.from(e,"base64").toString("utf8"));'`;
		expect(exempt(cmd, "pkill -9 node")).toBe(true);
	});

	it("P7: a JS string after `cd …;` in a node -e program (curl DELETE sample)", () => {
		const cmd = `cd /repo; node -e 'const re=/\\bwrangler\\s+secret\\s+delete\\b/i; for (const c of ["curl -X DELETE https://api.example.com/x"]) console.log(re.test(c), c)'`;
		expect(exempt(cmd, "curl -X DELETE")).toBe(true);
	});

	it("P8: a printf argument piped only to base64 (wrangler delete sample)", () => {
		expect(exempt(`printf '%s' 'wrangler delete my-worker' | base64`, "wrangler delete my-worker")).toBe(true);
	});

	it("P9: the pattern argument of grep -rn (DROP TABLE sample), with a later xargs grep segment", () => {
		const cmd = `grep -rn "destructive\\|rm -rf\\|DROP TABLE" src/harness/rules/a.ts | head -20\necho "---"\nfind src -iname '*.ts' | xargs grep -ln "destructive" 2>/dev/null`;
		expect(exempt(cmd, "DROP TABLE")).toBe(true);
	});

	it("P10: a Python triple-quoted string inside python3 -c editing markdown (git checkout sample)", () => {
		const cmd = `python3 -c "\np='scratch/CAMPAIGN.md'; s=open(p).read()\ns+='''\n- \\\`git checkout -- <file>\\\` blocked by builtin \\"git checkout -- . discards all unstaged changes\\" rule\n'''\nopen(p,'w').write(s)"`;
		expect(exempt(cmd, "git checkout -- .")).toBe(true);
	});

	it("P11: a Python string in a quoted-delimiter heredoc program", () => {
		const cmd = `python3 - <<'PY'\nimport json\nprint(json.dumps({'command': 'git push --force origin main'}))\nPY`;
		expect(exempt(cmd, "git push --force origin main")).toBe(true);
	});

	it("P12: a `sed -n '/…/p'` script and an rg -e pattern", () => {
		expect(exempt(`sed -n '/DROP TABLE/p' notes.sql`, "DROP TABLE")).toBe(true);
		expect(exempt(`rg -n -e 'docker system prune' docs/`, "docker system prune")).toBe(true);
	});

	it("P13: echo into a scratch file when no segment runs a shell", () => {
		expect(exempt(`echo 'kubectl delete pods --all' > /tmp/notes.txt`, "kubectl delete pods --all")).toBe(true);
	});

	it("P14: maskLiteralContext blanks exactly the data regions and keeps the structure", () => {
		const cmd = `printf '%s' 'wrangler delete my-worker' | base64`;
		const masked = maskLiteralContext(cmd);
		expect(masked).toHaveLength(cmd.length);
		expect(masked).not.toContain("wrangler");
		expect(masked.startsWith("printf '")).toBe(true);
		expect(masked.endsWith("' | base64")).toBe(true);
	});
});

describe("literal-context — negative (must not fire: the text may execute)", () => {
	it("N1: a bare destructive command", () => {
		expect(literalContextRegions("docker system prune -af")).toEqual([]);
	});

	it("N2: echo piped into sh", () => {
		expect(exempt(`echo 'rm -rf /' | sh`, "rm -rf /")).toBe(false);
	});

	it("N3: node -e that requires child_process", () => {
		expect(exempt(`node -e 'require("child_process").execSync("git push --force")'`, "git push --force")).toBe(false);
	});

	it("N4: node -e with a dynamic require that could resolve to child_process", () => {
		expect(exempt(`node -e 'const m=require("child_"+"process"); m.x("pkill -9 node")'`, "pkill -9 node")).toBe(false);
	});

	it("N5: python3 -c that calls os.system", () => {
		expect(exempt(`python3 -c "import os; os.system('kubectl delete pods --all')"`, "kubectl delete pods --all")).toBe(false);
	});

	it("N6: a for-loop that evals the loop variable", () => {
		expect(exempt(`for c in 'docker system prune -af'; do eval "$c"; done`, "docker system prune -af")).toBe(false);
	});

	it("N7: a for-loop that runs the loop variable as the command", () => {
		expect(exempt(`for c in 'docker system prune -af'; do $c; done`, "docker system prune -af")).toBe(false);
	});

	it("N8: a for-loop whose output is piped to sh", () => {
		expect(exempt(`for c in 'rm -rf /'; do echo "$c"; done | sh`, "rm -rf /")).toBe(false);
	});

	it("N9: bash -c payload", () => {
		expect(exempt(`bash -c 'docker system prune -af'`, "docker system prune -af")).toBe(false);
	});

	it("N10: printf piped into xargs", () => {
		expect(exempt(`printf '%s' 'rm -rf /tmp/x' | xargs -I{} sh -c '{}'`, "rm -rf /tmp/x")).toBe(false);
	});

	it("N11: a heredoc body piped to sh, and a python heredoc whose output is piped to sh", () => {
		expect(exempt(`cat <<'EOF' | sh\ndocker system prune -af\nEOF`, "docker system prune -af")).toBe(false);
		expect(exempt(`python3 - <<'PY' | sh\nprint('rm -rf /')\nPY`, "rm -rf /")).toBe(false);
	});

	it("N12: a python heredoc that imports subprocess", () => {
		const cmd = `python3 - <<'PY'\nimport subprocess\nsubprocess.run(['sh','-c','git push --force origin main'])\nPY`;
		expect(exempt(cmd, "git push --force origin main")).toBe(false);
	});

	it("N13: command substitution inside a double-quoted echo argument", () => {
		expect(exempt(`echo "$(docker system prune -af)"`, "docker system prune -af")).toBe(false);
	});

	it("N14: echo into a /tmp script that a later segment runs", () => {
		expect(exempt(`echo 'docker system prune -af' > /tmp/x.sh; bash /tmp/x.sh`, "docker system prune -af")).toBe(false);
	});

	it("N15: perl system() and ruby backticks", () => {
		expect(exempt(`perl -e 'system("docker system prune -af")'`, "docker system prune -af")).toBe(false);
		expect(exempt("ruby -e '`docker system prune -af`'", "docker system prune -af")).toBe(false);
	});

	it("N16: grep FILE operands are not exempt, and rg --pre disables the context", () => {
		expect(exempt(`grep -n foo 'rm -rf /'`, "rm -rf /")).toBe(false);
		expect(exempt(`rg --pre 'rm -rf /' foo`, "rm -rf /")).toBe(false);
	});

	it("N17: an unterminated quote yields no regions", () => {
		expect(literalContextRegions(`echo 'docker system prune -af`)).toEqual([]);
	});

	it("N19: program output duplicated onto a zsh coprocess, and loop output written to a script that runs", () => {
		const coproc = "coproc sh\npython3 - <<'EOF' >&p\nprint(\"docker system prune -af\")\nEOF";
		expect(exempt(coproc, "docker system prune -af")).toBe(false);
		const loop = `for c in 'docker system prune -af'; do echo "$c"; done > /tmp/x.sh; bash /tmp/x.sh`;
		expect(exempt(loop, "docker system prune -af")).toBe(false);
	});

	it("N18: a `harness test` look-alike from another launcher is not exempt", () => {
		expect(exempt(`sh harness test 'docker system prune -af'`, "docker system prune -af")).toBe(false);
	});

	// 2026-10-15 review: the file-redirect carve-out survived executors the
	// SHELLS denylist did not name.
	it("N20: echo into a temp file that sudo bash, make, php or find -exec then runs", () => {
		expect(exempt(`echo 'rm -rf /' > /tmp/x.sh; sudo bash /tmp/x.sh`, "rm -rf /")).toBe(false);
		expect(exempt(`printf 'all:\\n\\trm -rf /\\n' > scratch/Makefile && make -f scratch/Makefile`, "rm -rf /")).toBe(false);
		expect(exempt(`echo '<?php system("rm -rf /");' > /tmp/x.php; php /tmp/x.php`, "rm -rf /")).toBe(false);
		expect(exempt(`echo 'rm -rf /' > /tmp/x.sh; find /tmp -name x.sh -exec sh {} \\;`, "rm -rf /")).toBe(false);
	});

	it("N21: a path that is the argument of a file-access call is an operand, not data", () => {
		expect(exempt(`python3 -c "print(open('.env').read())"`, ".env")).toBe(false);
		expect(exempt(`python3 -c "print(open(file='.env').read())"`, ".env")).toBe(false);
		expect(exempt(`node -e "console.log(require('fs').readFileSync('/Users/me/.ssh/id_rsa','utf8'))"`, "/Users/me/.ssh/id_rsa")).toBe(false);
		expect(exempt(`python3 -c "from pathlib import Path; print(Path('.interlinked/scanner/pending/x').read_text())"`, ".interlinked/scanner/pending/x")).toBe(false);
		expect(exempt(`ruby -e 'puts File.read("/etc/shadow")'`, "/etc/shadow")).toBe(false);
	});

	it("N22: an attached --regexp= or -eX pattern leaves the FILE operand visible", () => {
		expect(exempt(`grep --regexp=KEY ~/.ssh/id_rsa`, "~/.ssh/id_rsa")).toBe(false);
		expect(exempt(`grep -eKEY ~/.ssh/id_rsa`, "~/.ssh/id_rsa")).toBe(false);
		expect(exempt(`grep -ie KEY ~/.ssh/id_rsa`, "~/.ssh/id_rsa")).toBe(false);
		expect(exempt(`grep --file=pats ~/.ssh/id_rsa`, "~/.ssh/id_rsa")).toBe(false);
	});
});

describe("literal-context — positive (must fire) — 2026-10-15 review shapes", () => {
	it("P15: an attached --regexp= / -eX / -ieX pattern is data", () => {
		expect(exempt(`grep --regexp='rm -rf /' notes.txt`, "rm -rf /")).toBe(true);
		expect(exempt(`grep -e'rm -rf /' notes.txt`, "rm -rf /")).toBe(true);
		expect(exempt(`grep -ie 'rm -rf /' notes.txt`, "rm -rf /")).toBe(true);
		expect(literalContextRegions(`grep --regexp=KEY notes.txt`).map((r) => r.context)).toEqual(["grep pattern"]);
	});

	it("P16: a program literal that is not a file-access argument stays data", () => {
		expect(exempt(`python3 -c "print('rm -rf /')"`, "rm -rf /")).toBe(true);
		expect(exempt(`python3 -c "x = ['rm -rf /']; print(x)"`, "rm -rf /")).toBe(true);
		expect(exempt(`node -e "console.log(JSON.stringify({cmd: 'rm -rf /'}))"`, "rm -rf /")).toBe(true);
		expect(exempt(`python3 -c "p = 'scratch/notes.md'; print(open(p).read(), 'rm -rf /')"`, "rm -rf /")).toBe(true);
	});

	it("P17: echo into a temp file beside inert commands only is still data", () => {
		expect(exempt(`mkdir -p /tmp/n && echo 'kubectl delete pods --all' > /tmp/n/notes.txt && cat /tmp/n/notes.txt | wc -l`, "kubectl delete pods --all")).toBe(true);
	});
});
