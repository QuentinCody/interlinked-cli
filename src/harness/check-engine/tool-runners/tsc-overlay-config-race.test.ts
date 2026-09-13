import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { selectCheckerConfig } from "../../config-graph.js";
import { clearOverlayServiceCache, runOverlayCheckInProcessTyped } from "./tsc-overlay-service.js";

vi.mock("../../config-graph.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../config-graph.js")>();
	return { ...actual, selectCheckerConfig: vi.fn(actual.selectCheckerConfig) };
});

const directories: string[] = [];
afterEach(() => {
	clearOverlayServiceCache();
	vi.mocked(selectCheckerConfig).mockReset();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("reports not measured when the selected config disappears before service construction", async () => {
	const actual = await vi.importActual<typeof import("../../config-graph.js")>("../../config-graph.js");
	const dir = mkdtempSync(join(tmpdir(), "overlay-config-race-"));
	directories.push(dir);
	const config = join(dir, "tsconfig.json");
	const target = join(dir, "a.ts");
	writeFileSync(config, JSON.stringify({ compilerOptions: { noEmit: true }, files: ["a.ts"] }));
	writeFileSync(target, "export const x = 1;");
	vi.mocked(selectCheckerConfig).mockImplementation((...args) => {
		const selection = actual.selectCheckerConfig(...args);
		// A real filesystem race between config selection and the subsequent read.
		unlinkSync(config);
		return selection;
	});
	expect(runOverlayCheckInProcessTyped({ projectRoot: dir, filePath: target, content: "export const x = 2;" }))
		.toMatchObject({ status: "not_measured", reason: expect.stringContaining("config_unusable") });
});
