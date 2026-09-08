import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTrajectoryFixture, makeCandidate } from "../__tests__/sequence-fixtures.js";
import type { SequenceDetector } from "./types.js";
import {
    defaultDetectorEnabledPredicate,
    formatSequenceFinding,
    runSequenceDetectorsForPhase,
} from "./dispatcher.js";

const { detectors } = vi.hoisted(() => {
    const detectors: SequenceDetector[] = [];
    return { detectors };
});
vi.mock("./registry.js", () => ({ ALL_SEQUENCE_DETECTORS: detectors }));
afterEach(() => { detectors.length = 0; });

function detector(overrides: Partial<SequenceDetector> = {}): SequenceDetector {
    return {
        id: "fixture", description: "dispatcher fixture", family: "quality",
        phase: "stop", default_enabled: false, determinism: "fully_deterministic",
        fn: () => [{ message: "matched" }], ...overrides,
    };
}

describe("defaultDetectorEnabledPredicate", () => {
    it("returns the detector's default_enabled flag", () => {
        expect(defaultDetectorEnabledPredicate(detector())).toBe(false);
        expect(defaultDetectorEnabledPredicate(detector({ default_enabled: true }))).toBe(true);
    });
});

describe("runSequenceDetectorsForPhase", () => {
    it("does not invoke a disabled detector", () => {
        const fn = vi.fn<SequenceDetector["fn"]>(() => [{ message: "matched" }]);
        detectors.push(detector({ fn }));
        const { session, lastEvent } = buildTrajectoryFixture([{ tool_name: "Read" }]);
        expect(runSequenceDetectorsForPhase({ phase: "stop", trajectory: session, candidate: lastEvent })).toEqual([]);
        expect(fn).not.toHaveBeenCalled();
    });

    it("runs an enabled detector only for its configured phase", () => {
        const fn = vi.fn<SequenceDetector["fn"]>(() => [{ message: "pre-tool match" }]);
        detectors.push(detector({ phase: "pre_block", fn }));
        const { session } = buildTrajectoryFixture([{ tool_name: "Bash" }]);
        const candidate = makeCandidate({ tool_name: "Bash" });
        const context = { trajectory: session, candidate, isEnabled: () => true };
        expect(runSequenceDetectorsForPhase({ ...context, phase: "stop" })).toEqual([]);
        expect(fn).not.toHaveBeenCalled();
        expect(runSequenceDetectorsForPhase({ ...context, phase: "pre_block" })).toEqual([
            { detector_id: "fixture", family: "quality", phase: "pre_block", match: { message: "pre-tool match" } },
        ]);
        expect(fn).toHaveBeenCalledExactlyOnceWith(session, candidate);
    });

    it("continues to later detectors after a detector throws", () => {
        const failed = vi.fn<SequenceDetector["fn"]>(() => { throw new Error("broken detector"); });
        detectors.push(detector({ id: "broken", fn: failed, default_enabled: true }), detector({ id: "working", default_enabled: true }));
        const { session, lastEvent } = buildTrajectoryFixture([{ tool_name: "Read" }]);
        expect(runSequenceDetectorsForPhase({ phase: "stop", trajectory: session, candidate: lastEvent })).toEqual([
            { detector_id: "working", family: "quality", phase: "stop", match: { message: "matched" } },
        ]);
        expect(failed).toHaveBeenCalledExactlyOnceWith(session, lastEvent);
    });

    it("returns one finding per match emitted by a firing detector", () => {
        detectors.push(detector({ default_enabled: true, fn: () => [{ message: "first" }, { message: "second", evidence: ["source"] }] }));
        const { session, lastEvent } = buildTrajectoryFixture([{ tool_name: "Read" }]);
        expect(runSequenceDetectorsForPhase({ phase: "stop", trajectory: session, candidate: lastEvent })).toEqual([
            { detector_id: "fixture", family: "quality", phase: "stop", match: { message: "first" } },
            { detector_id: "fixture", family: "quality", phase: "stop", match: { message: "second", evidence: ["source"] } },
        ]);
    });
});

describe("formatSequenceFinding", () => {
	it("renders a single-line message with detector id and [proven] tag", () => {
		const rendered = formatSequenceFinding({
			detector_id: "test_detector",
			family: "quality",
			phase: "stop",
			match: { message: "hello world" },
		});
		expect(rendered).toContain("[interlinked:sequence]");
		expect(rendered).toContain("[proven]");
		expect(rendered).toContain("test_detector");
		expect(rendered).toContain("hello world");
	});

	it("appends prior_summary on its own line when provided", () => {
		const rendered = formatSequenceFinding({
			detector_id: "x",
			family: "quality",
			phase: "stop",
			match: { message: "m", prior_summary: "saw 3 prior reads" },
		});
		expect(rendered.split("\n")[1]).toContain("saw 3 prior reads");
	});

	it("renders each evidence snippet on its own line", () => {
		const rendered = formatSequenceFinding({
			detector_id: "x",
			family: "quality",
			phase: "stop",
			match: { message: "m", evidence: ["a", "b"] },
		});
		const lines = rendered.split("\n");
		expect(lines.some((l) => l.includes("evidence: a"))).toBe(true);
		expect(lines.some((l) => l.includes("evidence: b"))).toBe(true);
	});
});
