import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { absentHelpItem, checkReadmeCommandDrift } from "./readme-command-drift.js";
import { checkUnreadConfigKeys } from "./unread-config-key.js";
import { checkSummaryFileCoverage, summaryEvidenceFromLogs, type BoundedLog } from "./summary-file-coverage.js";
import { DEFAULT_ADVISORY_SKIPS } from "./advisory.js";
import { VERIFY_ADVISORY_CATALOGUE } from "./catalogue-types.js";

function program(): Command {
    const root = new Command("interlinked").option("--json");
    root.command("semantic").command("search <query>").option("--top <n>");
    root.command("verify [target]").option("--all-checks");
    return root;
}
describe("readme_command_drift", () => {
    it("MUST-FIRE: nonexistent commands and long flags", () => {
        expect(absentHelpItem("interlinked semantix", program())).toContain("semantix");
        expect(absentHelpItem('interlinked semantic search "atomic index" --typo', program())).toContain("--typo");
        expect(checkReadmeCommandDrift("Use `interlinked verify --typo`.", "README.md", program())).toMatchObject([{ line: 1, check: "readme_command_drift" }]);
    });
    it("MUST-NOT-FIRE: existing options, option values, prose and ambiguous shell", () => {
        expect(absentHelpItem('interlinked semantic search "atomic index" --top 5 --json', program())).toBeNull();
        expect(checkReadmeCommandDrift("interlinked invented in prose\n```ts\ninterlinked invented\n```", "README.md", program())).toEqual([]);
        expect(absentHelpItem("interlinked verify | cat", program())).toBeNull();
        expect(absentHelpItem("interlinked verify --all-checks > findings.json", program())).toBeNull();
        expect(absentHelpItem("interlinked semantic search/list", program())).toBeNull();
        expect(absentHelpItem("interlinked semantic …", program())).toBeNull();
        expect(checkReadmeCommandDrift("Use `interlinked future-command`.", "docs/plans/future.md", program())).toEqual([]);
    });
});
describe("unread_config_key", () => {
    const declared = [{ key: "rareSetting", path: "limits.rareSetting", file: "defaults.ts", line: 3 }];
    it("MUST-FIRE: only declaration and writes, no read", () => {
        for (const content of ["config.rareSetting = 3;", "config['rareSetting'] = 3;", "delete config.rareSetting;", "delete config['rareSetting'];"]) {
            expect(checkUnreadConfigKeys(declared, [{ file: "a.ts", content }]).findings).toHaveLength(1);
        }
    });
    it("MUST-NOT-FIRE: dot, bracket, destructuring and uncertain dynamic access", () => {
        for (const content of ["use(config.rareSetting);", "use(config['rareSetting']);", "config['rareSetting'] += 1;", "const { rareSetting: renamed } = config;", "use(config[key]);"]) {
            expect(checkUnreadConfigKeys(declared, [{ file: "a.ts", content }]).findings).toEqual([]);
        }
        expect(checkUnreadConfigKeys(declared, [{ file: "a.ts", content: "use(config[key]);" }]).unavailable).toBe(1);
    });
});
describe("summary_file_coverage", () => {
    const base = { root: "/repo", session: "s", complete: true, diffPaths: ["src/changed.ts"] };
    it("MUST-FIRE: omitted changed file and additional mentioned file", () => {
        const findings = checkSummaryFileCoverage({ ...base, message: "Updated src/other.ts." });
        expect(findings.map(item => item.file)).toEqual(["src/other.ts", "src/changed.ts"]);
    });
    it("MUST-NOT-FIRE: matching absolute/relative mentions or incomplete evidence", () => {
        expect(checkSummaryFileCoverage({ ...base, message: "Updated /repo/src/changed.ts:8." })).toEqual([]);
        expect(checkSummaryFileCoverage({ ...base, complete: false, message: "Updated src/other.ts." })).toEqual([]);
        expect(checkSummaryFileCoverage({ ...base, diffPaths: ["README.md"], message: "Updated README.md. See https://example.com/src/other.ts." })).toEqual([]);
        expect(checkSummaryFileCoverage({ ...base, diffPaths: [], message: "Updated README.md." })).toMatchObject([{ file: "README.md" }]);
    });
    it("MUST-NOT-FIRE: attempted writes and truncated logs cannot establish a net diff", () => {
        const log = (rows: Record<string, unknown>[]): BoundedLog => ({ rows, available: true, truncated: false, malformed: 0, bytes: 100 });
        const activity = log([{ type: "session_start", session: "s", ts: "2026-10-28T10:00:00Z" }, { type: "agent_stop", session: "s", ts: "2026-10-28T11:00:00Z", last_assistant_message: "Updated src/other.ts." }]);
        const touches = log([{ session_id: "s", ts: "2026-10-28T10:30:00Z", path: "src/changed.ts", observation_complete: false }]);
        expect(summaryEvidenceFromLogs("/repo", activity, touches)[0]?.complete).toBe(false);
        touches.rows[0] = { ...touches.rows[0], observation_complete: true, before_sha256: "a", after_sha256: "b" };
        touches.truncated = true;
        expect(summaryEvidenceFromLogs("/repo", activity, touches)[0]?.complete).toBe(false);
    });
});
it("all catalogue checks are default-skipped, verify-only advisories", () => {
    for (const entry of VERIFY_ADVISORY_CATALOGUE) expect(DEFAULT_ADVISORY_SKIPS.has(entry.id)).toBe(true);
});
