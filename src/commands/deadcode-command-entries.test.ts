import { expect, it } from "vitest";
import { scriptCommandEntries } from "./deadcode-command-entries.js";

it("finds documented invocation targets in shell blocks and inline code", () => {
	const files = new Map([
		["docs/migration.md", [
			"```bash", "node --expose-gc --import tsx scripts/bench.ts src/input.ts", "```",
			"Run `npx tsx scripts/scan.ts` to repeat it.", "Merely mentioning scripts/stale.ts is insufficient.",
			"```js", "node scripts/stale.ts", "```",
			"`echo node scripts/stale.ts`", "`node -e 'scripts/stale.ts'`",
		].join("\n")],
		["docs/fixtures/example.md", "`node scripts/stale.ts`"],
	]);
	const known = new Set(["scripts/bench.ts", "scripts/scan.ts", "scripts/stale.ts", "src/input.ts"]);
	expect([...scriptCommandEntries([...files.keys()], path => files.get(path) ?? null, known)].sort()).toEqual(["scripts/bench.ts", "scripts/scan.ts"]);
});

it("credits workflow run targets and preserves unknowns when the directory changes", () => {
	const workflow = `jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: node scripts/unused.ts
        run: node --import tsx scripts/job.ts scripts/unused.ts
      - run: |
          cd nested
          node scripts/unused.ts
`;
	const known = new Set(["scripts/job.ts", "scripts/nested.ts", "nested/scripts/nested.ts", "scripts/unused.ts"]);
	const result = scriptCommandEntries([".github/workflows/job.yml", ".github/workflows/nested.yml"],
		path => path.endsWith("/job.yml") ? workflow : "defaults:\n  run:\n    working-directory: nested\njobs:\n  test:\n    steps:\n      - run: node scripts/nested.ts", known);
	expect([...result]).toEqual(["scripts/job.ts"]);
});
