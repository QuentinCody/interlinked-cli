// Cross-repo falsification of `snapshot_overuse` (2026-10-21, scratch/2026-10-21-cross-repo/
// falsify-result.json: 6 read, 5 confirmed false positives, all in zod). The detector
// counted every `toMatchInlineSnapshot(` line as an opaque recorded blob. An inline
// snapshot that carries its literal in the test source is `toEqual` with serialization
// help — the expected value is reviewable in a diff — so it is an explicit assertion.
// The refinement counts only OPAQUE snapshots (file snapshots and inline calls with no
// string/template literal argument) and strips comments first. A recorded inline
// literal counts only when snapshots are nearly every assertion in the file. Repair
// (P6-P9, after an independent verifier): an earlier "opaque is a third of the
// assertions" ratio gate cleared no confirmed FP and silenced file-snapshot-heavy
// files, so it is gone; an identifier argument is not a literal; and a file of 16/16
// inline snapshots (zod continuability.test.ts, the sampled true positive) fires.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { checkSnapshotOveruse } from "../../checks/testing.js";

const ZOD_TEST = "packages/zod/src/v4/classic/tests/array.test.ts";

describe("snapshot_overuse — negative (must not fire)", () => {
	it("N1: zod packages/zod/src/v4/classic/tests/array.test.ts:13 — inline snapshot of a small issue array is an explicit assertion", () => {
		// Trimmed from zod array.test.ts (tests "array min/max", "array length").
		const content = [
			'import { expect, test } from "vitest";',
			'import * as z from "zod/v4";',
			"",
			'test("array min/max", () => {',
			"  const schema = z.array(z.string()).min(2).max(2);",
			'  const r1 = schema.safeParse(["asdf"]);',
			"  expect(r1.success).toEqual(false);",
			"  expect(r1.error!.issues).toMatchInlineSnapshot(`",
			"    [",
			"      {",
			'        "code": "too_small",',
			'        "inclusive": true,',
			'        "message": "Too small: expected array to have >=2 items",',
			'        "minimum": 2,',
			'        "origin": "array",',
			'        "path": [],',
			"      },",
			"    ]",
			"  `);",
			'  const r2 = schema.safeParse(["asdf", "asdf", "asdf"]);',
			"  expect(r2.success).toEqual(false);",
			"  expect(r2.error!.issues).toMatchInlineSnapshot(`",
			'    [{ "code": "too_big", "inclusive": true, "maximum": 2, "origin": "array", "path": [] }]',
			"  `);",
			"});",
			"",
			'test("array length", () => {',
			"  const schema = z.array(z.string()).length(2);",
			'  const r1 = schema.safeParse(["asdf"]);',
			"  expect(r1.success).toEqual(false);",
			"  expect(r1.error!.issues).toMatchInlineSnapshot(`",
			'    [{ "code": "too_small", "exact": true, "minimum": 2, "origin": "array", "path": [] }]',
			"  `);",
			'  const r2 = schema.safeParse(["asdf", "asdf", "asdf"]);',
			"  expect(r2.success).toEqual(false);",
			"  expect(r2.error!.issues).toMatchInlineSnapshot(`",
			'    [{ "code": "too_big", "exact": true, "maximum": 2, "origin": "array", "path": [] }]',
			"  `);",
			"  expect(result).toMatchInlineSnapshot(`",
			'    { "data": ["asdf", "asdf"], "success": true }',
			"  `);",
			"  expect(result).toMatchInlineSnapshot(`",
			'    { "data": [], "success": true }',
			"  `);",
			"});",
		].join("\n");
		expect(checkSnapshotOveruse(content, ZOD_TEST)).toEqual([]);
	});

	it("N2: zod packages/zod/src/v4/classic/tests/codec.test.ts:33 — inline snapshots of scalar literals are toBe assertions", () => {
		// Verbatim lines from zod codec.test.ts (33, 38, 51, 53, 66, 67, 133, 137).
		const content = [
			'test("codec decode/encode", () => {',
			"  expect(decodedResult).toBeInstanceOf(Date);",
			'  expect(decodedResult.toISOString()).toMatchInlineSnapshot(`"2024-01-15T10:30:00.000Z"`);',
			'  expect(typeof encodedResult).toBe("string");',
			'  expect(encodedResult).toMatchInlineSnapshot(`"2024-01-15T10:30:00.000Z"`);',
			'  expect(backToString).toMatchInlineSnapshot(`"2024-12-25T15:45:30.123Z"`);',
			"  expect(toDate).toBeInstanceOf(Date);",
			"  expect(toDate.getTime()).toMatchInlineSnapshot(`1735141530123`);",
			"  expect(validDate.getFullYear()).toMatchInlineSnapshot(`2024`);",
			"  expect(validDate.getTime()).toMatchInlineSnapshot(`1705314600000`);",
			"  expect(decodedNumber).toMatchInlineSnapshot(`42.5`);",
			'  expect(encodedString).toMatchInlineSnapshot(`"42.5"`);',
			"});",
		].join("\n");
		expect(
			checkSnapshotOveruse(content, "packages/zod/src/v4/classic/tests/codec.test.ts"),
		).toEqual([]);
	});

	it("N3: zod packages/zod/src/v4/classic/tests/default.test.ts:141 — inline result objects beside a majority of explicit expects", () => {
		// Trimmed from zod default.test.ts: the safeParse result IS the property under
		// test (which default applies); the file holds 65 expect() calls, 9 inline.
		const inline = [
			'  expect(obj.safeParse({ a: "a1", b: "b1", c: "c1", d: "d1" })).toMatchInlineSnapshot(`',
			"    {",
			'      "data": {',
			'        "a": "a1",',
			'        "b": "b1",',
			'        "c": "c1",',
			'        "d": "d1",',
			"      },",
			'      "success": true,',
			"    }",
			"  `);",
		];
		const explicit = [
			'  expect(z.string().default("asdf").parse(undefined)).toBe("asdf");',
			"  expect(stringWithDefault.parse(undefined)).toBe(DEFAULT);",
			"  expect(result.success).toBe(true);",
			'  expect(result.data).toEqual({ a: "a" });',
			"  expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<string | undefined>();",
			"  expect(obj.parse({})).toEqual({ a: 1, b: 2 });",
		];
		const content = [
			'test("basic defaults", () => {',
			...explicit,
			...explicit,
			...explicit,
			"});",
			'test("prefault and default interplay", () => {',
			...inline,
			...inline,
			...inline,
			...inline,
			...inline,
			...inline,
			"});",
		].join("\n");
		expect(
			checkSnapshotOveruse(content, "packages/zod/src/v4/classic/tests/default.test.ts"),
		).toEqual([]);
	});

	it("N4: zod packages/zod/src/v4/classic/tests/discriminated-unions.test.ts:132 — inline issue arrays paired with explicit toMatchObject", () => {
		// Trimmed from zod discriminated-unions.test.ts (lines 132 and 559-561).
		const issue = [
			"    expect(e.issues).toMatchInlineSnapshot(`",
			"      [",
			"        {",
			'          "code": "invalid_type",',
			'          "expected": "object",',
			'          "message": "Invalid input: expected object, received null",',
			'          "path": [],',
			"        },",
			"      ]",
			"    `);",
		];
		const content = [
			'test("null input", () => {',
			"  try {",
			"    schema.parse(null);",
			"  } catch (e: any) {",
			...issue,
			...issue,
			...issue,
			...issue,
			"  }",
			"});",
			'test("literal union within discriminated union", () => {',
			'  const u = z.discriminatedUnion("a", [schema]);',
			"  const result = u.safeParse(input);",
			"  expect(result).toMatchObject({ success: false });",
			"  expect(result).toMatchInlineSnapshot(`",
			"    {",
			'      "error": [ZodError: [',
			"      {",
			'        "expected": "string",',
			'        "code": "invalid_type",',
			"      }",
			"    ]],",
			'      "success": false,',
			"    }",
			"  `);",
			"});",
		].join("\n");
		expect(
			checkSnapshotOveruse(
				content,
				"packages/zod/src/v4/classic/tests/discriminated-unions.test.ts",
			),
		).toEqual([]);
	});

	it("N5: zod packages/zod/src/v4/classic/tests/error-utils.test.ts:17 — a formatter's exact output pinned inline is the contract", () => {
		// Trimmed from zod error-utils.test.ts ("regular error", ".flatten()", toDotPath).
		const content = [
			'test("regular error", () => {',
			"  expect(parsed).toMatchInlineSnapshot(`",
			"    {",
			'      "error": [ZodError: [',
			"      {",
			'        "expected": "number",',
			'        "code": "invalid_type",',
			'        "path": [',
			'          "f1"',
			"        ],",
			'        "message": "Invalid input: expected number, received undefined"',
			"      }",
			"    ]],",
			'      "success": false,',
			"    }",
			"  `);",
			"});",
			'test(".flatten()", () => {',
			"  const flattened = parsed.error!.flatten();",
			"  expect(flattened).toMatchInlineSnapshot(`",
			"    {",
			'      "fieldErrors": {',
			'        "f1": [',
			'          "Invalid input: expected number, received undefined",',
			"        ],",
			"      },",
			'      "formErrors": [],',
			"    }",
			"  `);",
			"});",
			'test("toDotPath", () => {',
			'  expect(z.core.toDotPath(["a", "b", 0, "c"])).toMatchInlineSnapshot(`"a.b[0].c"`);',
			'  expect(z.core.toDotPath(["a", "b c", 0, "d"])).toMatchInlineSnapshot(`"a["b c"][0].d"`);',
			'  expect(z.core.toDotPath(["a", 0, "b"])).toMatchInlineSnapshot(`"a[0].b"`);',
			'  expect(z.core.toDotPath([])).toMatchInlineSnapshot(`""`);',
			"});",
		].join("\n");
		expect(
			checkSnapshotOveruse(content, "packages/zod/src/v4/classic/tests/error-utils.test.ts"),
		).toEqual([]);
	});

	it("N6: zod packages/zod/src/v4/classic/tests/string-formats.test.ts:106 — the literal sits on the line AFTER the matcher's paren", () => {
		// Verbatim shape from zod string-formats.test.ts:106-108 (and template-literal
		// .test.ts:564-569): Prettier wraps the long regex literal onto its own line,
		// so a same-line scan sees a bare `toMatchInlineSnapshot(` and reads it as empty.
		const call = [
			"  expect(b.def.pattern).toMatchInlineSnapshot(",
			"    `/\\\\^\\\\(\\\\?:\\\\\\\\d\\\\{14,19\\\\}\\\\|\\\\\\\\d\\\\{4\\\\}\\\\)\\\\$/u`",
			"  );",
		];
		const content = [
			'test("z.e164", () => {',
			...call,
			...call,
			...call,
			...call,
			...call,
			...call,
			"});",
		].join("\n");
		expect(
			checkSnapshotOveruse(content, "packages/zod/src/v4/classic/tests/string-formats.test.ts"),
		).toEqual([]);
	});

	it("N7: zod packages/zod/src/v4/classic/tests/to-json-schema.test.ts:238 — a commented-out empty slot is not a snapshot", () => {
		// Verbatim lines 238 and 279 of zod to-json-schema.test.ts, repeated to the
		// old threshold: comment-stripping runs before the scan.
		const content = [
			'test("unrepresentable", () => {',
			"    // expect(z.toJSONSchema(z.regex(/asdf/))).toMatchInlineSnapshot();",
			"    // expect(z.toJSONSchema(z.cidr())).toMatchInlineSnapshot();",
			"    // expect(z.toJSONSchema(z.regex(/asdf/))).toMatchInlineSnapshot();",
			"    // expect(z.toJSONSchema(z.cidr())).toMatchInlineSnapshot();",
			"    // expect(z.toJSONSchema(z.regex(/asdf/))).toMatchInlineSnapshot();",
			"    expect(() => z.toJSONSchema(z.bigint())).toThrow();",
			"});",
		].join("\n");
		expect(
			checkSnapshotOveruse(content, "packages/zod/src/v4/classic/tests/to-json-schema.test.ts"),
		).toEqual([]);
	});

	it("N8: (class pin) an identifier property-matcher argument followed by an inline literal is recorded in source", () => {
		// `toMatchInlineSnapshot(matchers, \`...\`)`: the literal is the SECOND argument.
		const content = Array.from(
			{ length: 5 },
			(_, i) => `expect(user${i}).toMatchInlineSnapshot(userMatchers, \`{ "id": Any<Number> }\`);`,
		).join("\n");
		expect(checkSnapshotOveruse(content, "src/user.test.ts")).toEqual([]);
	});
});

describe("snapshot_overuse — positive (must fire)", () => {
	it("P1: five file snapshots (`toMatchSnapshot()`) with one explicit assertion beside them", () => {
		const content = [
			'describe("Widget", () => {',
			'  it("renders", () => { expect(render(<Widget />).container).toMatchSnapshot(); });',
			'  it("renders open", () => { expect(render(<Widget open />).container).toMatchSnapshot(); });',
			'  it("renders closed", () => { expect(render(<Widget open={false} />).container).toMatchSnapshot(); });',
			'  it("renders disabled", () => { expect(render(<Widget disabled />).container).toMatchSnapshot(); });',
			'  it("renders with title", () => {',
			'    expect(screen.getByText("Title")).toBeInTheDocument();',
			'    expect(render(<Widget title="Title" />).container).toMatchSnapshot();',
			"  });",
			"});",
		].join("\n");
		const matches = checkSnapshotOveruse(content, "src/Widget.test.tsx");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(2);
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
		expect(nonNull(matches[0]).text).toContain("Use explicit assertions");
	});

	it("P2: five EMPTY inline slots (`toMatchInlineSnapshot()`) — recorded on first run, never reviewed", () => {
		const content = Array.from(
			{ length: 5 },
			(_, i) => `it("case ${i}", () => { expect(format(input${i})).toMatchInlineSnapshot(); });`,
		).join("\n");
		const matches = checkSnapshotOveruse(content, "src/format.test.ts");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
	});

	it("P3: property matchers with NO literal (`toMatchInlineSnapshot({ id: expect.any(Number) })`) are still empty slots", () => {
		const content = Array.from(
			{ length: 5 },
			(_, i) =>
				`expect(user${i}).toMatchInlineSnapshot({ id: expect.any(Number), createdAt: expect.any(Date) });`,
		).join("\n");
		const matches = checkSnapshotOveruse(content, "src/user.test.ts");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
	});

	it("P4: file, file-path and thrown-error snapshots count; a recorded inline literal beside them does not", () => {
		const content = [
			"expect(tree).toMatchSnapshot();",
			'expect(html).toMatchFileSnapshot("./__fixtures__/page.html");',
			"expect(() => parse(bad)).toThrowErrorMatchingSnapshot();",
			"expect(() => parse(worse)).toThrowErrorMatchingSnapshot();",
			"expect(doc).toMatchSnapshot();",
			'expect(summary).toMatchInlineSnapshot(`{ "count": 2 }`);',
		].join("\n");
		const matches = checkSnapshotOveruse(content, "src/render.test.ts");
		expect(matches).toHaveLength(1);
		// Exactly the five opaque calls — the inline literal is an explicit assertion.
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
		expect(nonNull(matches[0]).line).toBe(1);
	});

	it("P5: six file snapshots that are over a third of the file's assertions still fire", () => {
		const explicit = Array.from({ length: 10 }, (_, i) => `expect(v${i}).toBe(${i});`);
		const snaps = Array.from({ length: 6 }, (_, i) => `expect(view${i}).toMatchSnapshot();`);
		const content = [...explicit, ...snaps].join("\n");
		const matches = checkSnapshotOveruse(content, "src/feature/widget.test.tsx");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("6 snapshot assertions");
		expect(nonNull(matches[0]).line).toBe(11);
	});
	it("P6: repair — every assertion in the file is an inline snapshot (zod continuability.test.ts:35, 16 of 16)", () => {
		// Shape of zod continuability.test.ts: 16 inline snapshots and 16 expect() calls.
		// Each literal is reviewable, but the file states no property of its own — it is
		// a recorded transcript of serialized output. The sampled true positive.
		const formats = ["email", "uuid", "url", "emoji", "nanoid", "cuid", "cuid2", "ulid"];
		const call = (format: string): string[] => [
			"  expect(",
			"    z",
			`      .${format}()`,
			"      .refine(() => false)",
			'      .safeParse("invalid_value").error!.issues',
			"  ).toMatchInlineSnapshot(`",
			"    [",
			`      { "code": "invalid_format", "format": "${format}", "path": [] },`,
			'      { "code": "custom", "message": "Invalid input", "path": [] },',
			"    ]",
			"  `);",
		];
		const content = [
			'import { expect, test } from "vitest";',
			'import * as z from "zod/v4";',
			'test("continuability", () => {',
			...formats.flatMap(call),
			...formats.flatMap(call),
			"});",
		].join("\n");
		const matches = checkSnapshotOveruse(
			content,
			"packages/zod/src/v4/classic/tests/continuability.test.ts",
		);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(9);
		expect(nonNull(matches[0]).text).toContain("16 snapshot assertions");
		expect(nonNull(matches[0]).text).toContain("100% of its assertions");
	});

	it("P7: repair — six file snapshots beside twenty explicit assertions still fire (no ratio exemption for opaque snapshots)", () => {
		const explicit = Array.from({ length: 20 }, (_, i) => `expect(v${i}).toBe(${i});`);
		const snaps = Array.from({ length: 6 }, (_, i) => `expect(render${i}).toMatchSnapshot();`);
		const matches = checkSnapshotOveruse([...explicit, ...snaps].join("\n"), "src/feature/widget.test.tsx");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("6 snapshot assertions");
		expect(nonNull(matches[0]).line).toBe(21);
	});

	it("P8: repair — ten file snapshots beside twenty-five explicit assertions still fire", () => {
		const explicit = Array.from({ length: 25 }, (_, i) => `expect(v${i}).toBe(${i});`);
		const snaps = Array.from({ length: 10 }, (_, i) => `expect(view${i}).toMatchSnapshot();`);
		const matches = checkSnapshotOveruse([...snaps, ...explicit].join("\n"), "src/feature/widget.test.tsx");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("10 snapshot assertions");
		expect(nonNull(matches[0]).line).toBe(1);
	});

	it("P9: repair — an identifier argument (`toMatchInlineSnapshot(expectedVar)`) carries no literal in source", () => {
		const content = Array.from(
			{ length: 5 },
			(_, i) => `expect(format(input${i})).toMatchInlineSnapshot(expected${i});`,
		).join("\n");
		const matches = checkSnapshotOveruse(content, "src/format.test.ts");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
	});
});
