import { expect, it } from "vitest";
import { buildTrajectoryFixture, makeCandidate } from "../__tests__/sequence-fixtures.js";
import { sameCommandThriceNoObserve } from "./security.js";

function repeated(command: string) {
    const { session } = buildTrajectoryFixture([
        { tool_name: "Bash", tool_input: { command } },
        { tool_name: "Bash", tool_input: { command } },
    ]);
    return sameCommandThriceNoObserve.fn(session, makeCandidate({ tool_name: "Bash", tool_input: { command } }));
}

it.each([
    "tail -18 .interlinked/agent-output/coverage-project-recovery/full-suite.log",
    "head -20 report.txt", "cat report.txt", "ls /tmp", "rg -n failure report.txt",
    "git status --short", "git diff --stat", "node --version",
])("treats a simple observation as observation: %s", command => {
    expect(repeated(command)).toEqual([]);
});

it.each(["tail log.txt > snapshot.txt", "tail log.txt; npm run repair", "tail log.txt | bash", "cat $(npm run repair)", "npm run repair"])(
    "keeps compound, writing and unknown commands eligible: %s", command => {
        expect(repeated(command)).toHaveLength(1);
    });

it("reports recorded repetition without claiming to know whether the output was read", () => {
    const [finding] = repeated("npm run repair");
    expect(finding?.message).toContain("matching command observations");
    expect(finding?.message).not.toMatch(/third time|without observing|No intervening file read/);
});
