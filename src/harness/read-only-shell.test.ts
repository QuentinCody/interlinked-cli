import { describe, expect, it } from "vitest";
import { isProvablyReadOnlyShellCommand } from "./read-only-shell.js";

// The answer "read-only" removes a call from write attribution, so a wrong
// "yes" hides a real write. The classifier fails closed: unknown means "no".

describe("isProvablyReadOnlyShellCommand — positive (must be read-only)", () => {
	const readOnly = [
		"rg -n --no-heading 'foo|bar' src -g '*.ts' | cut -c1-170 | head -20",
		"cd /repo && sed -n 262,322p src/commands/verify.ts | cut -c1-190",
		'sed -n "1,40p" tsconfig.json',
		"ls -la scratch | head -n 5; wc -l src/a.ts",
		"cat a.txt | sort | uniq -c | sort -rn | head -15",
		"rg --files src -g '*.ts' | wc -l",
		"git status --short && git log --oneline -5",
		"git --no-optional-locks diff --stat",
		"rg -c . file.txt 2>/dev/null; ls missing 2>&1",
		"find . -name '*.test.ts' -newer package.json",
		"rg 'a > b' src",
		"echo hello",
		"test -f x && echo yes || echo no",
		"FOO=1 rg x src",
	];
	it.each(readOnly)("P: %s", (command) => {
		expect(isProvablyReadOnlyShellCommand(command)).toBe(true);
	});
});

describe("isProvablyReadOnlyShellCommand — negative (must not be called read-only)", () => {
	const notProvable = [
		"node scratch/probe/measure.mjs",
		"node --test a.test.mjs",
		"npx vitest run a.test.ts",
		"sed -i '' 's/a/b/' src/a.ts",
		"sed 's/a/b/w out.txt' src/a.ts",
		"sed -n '1,5p;w out.txt' src/a.ts",
		"rg foo src > out.txt",
		"rg foo src >> out.txt",
		"cat a | tee b",
		"cat a | xargs rm",
		"echo $(rm -rf x)",
		'echo "`touch x`"',
		'echo "$(touch x)"',
		"find . -name '*.tmp' -delete",
		"find . -name '*.ts' -exec rm {} ;",
		"awk '{print > \"out\"}' a",
		"sort -o out.txt in.txt",
		"sort --output=out.txt in.txt",
		"uniq in.txt out.txt",
		"git checkout main",
		"git diff --output=x.patch",
		"git branch new-branch",
		"interlinked harness status",
		"rg foo src & touch x",
		"cat <<EOF > x\nhi\nEOF",
		"cat < in.txt",
		"ls; rm x",
		"",
		"   ",
	];
	it.each(notProvable)("N: %s", (command) => {
		expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
	});
});
