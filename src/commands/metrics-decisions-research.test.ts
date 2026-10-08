import { expect, it } from "vitest";
import { decisionResearch } from "./metrics-decisions-research.js";
import { parseConfig } from "../lib/decision-metrics/config.js";
it("requires an explicit corpus and rejects unknown retrieval semantics", async () => {
    const config = parseConfig({ version: 1 });
    await expect(
        decisionResearch("retrieve", undefined, "/tmp", config, { retrieval: "memory" }),
    ).rejects.toThrow(/retrieval must/);
    await expect(decisionResearch("join-labels", undefined, "/tmp", config, {})).rejects.toThrow(
        /labels/,
    );
});
