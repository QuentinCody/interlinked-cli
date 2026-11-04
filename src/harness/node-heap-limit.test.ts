import { expect, it } from "vitest";
import { boundedNodeHeap } from "./node-heap-limit.js";

// test-contract: regression — the wrapper must preserve smaller user heap limits instead of appending a larger one.
it.each([
    ["", 3276], ["--trace-warnings", 3276], ["--max-old-space-size=1536", 1536],
    ["--max_old_space_size 512", 512], ["--max-old-space-size=9999", 3276],
    ["--max-old-space-size=512 --max_old_space_size=1024", 512],
])("bounds %s without increasing its requested limit", (options, expected) => {
    expect(boundedNodeHeap(options, 3276)).toBe(expected);
});

// test-contract: boundary — ambiguous or percentage overrides cannot claim a deterministic absolute heap cap.
it.each(["--max-old-space-size=0", "--max-old-space-size=-1", "--max-old-space-size", "--max-old-space-size-percentage=20",
    "--max_old_space_size_percentage=20", "--max-old-space-size='512'", '--max-old-space-size="512"',
    "--max-old-space-size=9007199254740992", "--max-old-space-size=512\\ "])("declines %s", options => {
    expect(boundedNodeHeap(options, 3276)).toBeNull();
});
