import { describe, expect, it } from "vitest";
import { fixtureEnvironment, socketPaths } from "./fixture.js";

describe("e2e isolation", () => {
    it("keeps child diagnostics but drops ambient credentials and routing", () => {
        expect(fixtureEnvironment({ PATH: "/bin", HOME: "/home/test", TMPDIR: "/tmp", NODE_V8_COVERAGE: "/coverage", INTERLINKED_HOME: "/live", INTERLINKED_SOCKET: "/live.sock", INTERLINKED_ACCESS_TOKEN: "secret", NODE_OPTIONS: "--require bad" }))
            .toEqual({ PATH: "/bin", HOME: "/home/test", TMPDIR: "/tmp", NODE_V8_COVERAGE: "/coverage" });
    });
    it("uses discoverable production socket names and rejects long paths", () => {
        expect(socketPaths("/tmp/test")).toEqual({ raw: "/tmp/test/.interlinked/harness.sock", framed: "/tmp/test/.interlinked/harness-default.sock" });
        expect(() => socketPaths(`/tmp/${"x".repeat(100)}`)).toThrow("100 bytes");
    });
});
