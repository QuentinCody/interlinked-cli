import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testLegitimacyCases } from "../harness/checks/__fixtures__/test-legitimacy-cases.js";
import { isJsonObject } from "../lib/json-types.js";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("test legitimacy through the real hook and daemon", () => {
    let fixture: E2eFixture;
    beforeAll(async () => {
        fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false } } });
    });
    afterAll(async () => { await fixture?.close(); });

    it.each(testLegitimacyCases)("$name", async ({ name, content, path, lines }) => {
        const sessionId = `${fixture.sessionPrefix}-${name}`;
        const result = await fixture.hook({
            sessionId,
            tool: "Write",
            input: { file_path: join(fixture.cwd, path), content },
        });
        fixture.assertServed(result);
        expect(result.code).toBe(0);
        const output = result.stdout + result.stderr;
        // Advisory delivery retains the detailed finding in activity evidence and emits a compact review hint.
        const evidence = fixture.ledger("activity.jsonl").filter(row => isJsonObject(row) && row.session === sessionId);
        expect(JSON.stringify(evidence).includes("[interlinked:test_legitimacy]"), JSON.stringify(evidence)).toBe(lines.length > 0);
        expect(output).not.toContain("[interlinked:test_legitimacy]");
        expect(result.stdout).not.toContain('"deny"');
    });
});
