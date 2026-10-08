import { describe, expect, it } from "vitest";
import {
	isRuntimeDataHeredoc,
	isTopLevelShellContext,
	strictRuntimeWord,
} from "./heredoc-runtime-mask.js";

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);

describe("strictRuntimeWord — positive (must resolve a runtime)", () => {
	it.each([
		["python3 -", "python3"],
		["/usr/bin/python3.12 -", "python3.12"],
		["FOO=1 env BAR=2 node -", "node"],
		["sudo python3 -", "python3"],
		["npx tsx -", "tsx"],
		["uv run python -", "python"],
	])("P: %s -> %s", (input, expected) => {
		expect(strictRuntimeWord(words(input))).toBe(expected);
	});
});

describe("strictRuntimeWord — negative (must not resolve a runtime)", () => {
	it.each([
		["sudo -u node bash"],
		["exec -a python3 bash"],
		["env -u X node"],
		["bash"],
		["ruby -"],
		["2>/dev/null python3"],
		["npx -p x bash"],
		["uv run bash"],
	])("N: %s", (input) => {
		expect(strictRuntimeWord(words(input))).toBeNull();
	});
});

describe("isTopLevelShellContext", () => {
	it.each([[""], ["cd /tmp && "], ["for i in 1; do echo $i; done\n"], ["x=$(date)\n"]])(
		"P: top level after %j",
		(prefix) => {
			expect(isTopLevelShellContext(prefix)).toBe(true);
		},
	);

	it.each([
		["x=$("],
		["bash <("],
		["{ "],
		["for i in 1; do "],
		["if true; then "],
		["case x in a) "],
		["echo `"],
		["exec > >(sh)\n"],
	])("N: nested after %j", (prefix) => {
		expect(isTopLevelShellContext(prefix)).toBe(false);
	});

	// Repair round 2: the prefix is the RAW command text before the operator,
	// read with shell quoting, comments and earlier heredoc bodies.
	it.each([
		['cd "$(pwd)" && '],
		["# note (draft\n"],
		["x=$((1<<2))\n"],
		[`echo "it's" && `],
		["cat <<'A' > n.md\n(open paren prose\nA\n"],
		["echo ${HOME} 2>&1\n"],
	])("P: top level after raw prefix %j", (prefix) => {
		expect(isTopLevelShellContext(prefix)).toBe(true);
	});

	it.each([
		[`eval "$(: '"'\\'; `],
		["eval $(case x in x) ;; esac; "],
		["eval $(cat <<'A'\n)\nA\n"],
		['x="$('],
		["coproc sh\n"],
		["exec >&p\n"],
		["exec 1>&3\n"],
		["mkfifo ff; sh < ff &\n"],
		["foreach i (1)\n"],
		["echo 'unterminated\n"],
		["cat <<'A'\nbody without a closer\n"],
		["x=$(cat <<'A'\nbody\nA)\n"],
	])("N: not top level after raw prefix %j", (prefix) => {
		expect(isTopLevelShellContext(prefix)).toBe(false);
	});
});

describe("isRuntimeDataHeredoc", () => {
	const base = {
		quotedTag: true,
		exactCloser: true,
		segmentBefore: "python3 - ",
		headerRest: "",
		shellPrefix: "python3 - ",
	};

	it("P: a top-level quoted python3 heredoc with a closer is data", () => {
		expect(isRuntimeDataHeredoc(base)).toBe(true);
		expect(isRuntimeDataHeredoc({ ...base, headerRest: " > out.txt || true" })).toBe(true);
	});

	it.each([
		["unquoted tag", { quotedTag: false }],
		["no exact closer", { exactCloser: false }],
		["pipe on the header line", { headerRest: " | sh" }],
		["trailing continuation", { headerRest: " \\" }],
		["process substitution on the header line", { headerRest: " > >(sh)" }],
		["shell target", { segmentBefore: "bash ", shellPrefix: "bash " }],
		["nested in $( )", { shellPrefix: "eval $(python3 - " }],
		["zsh coprocess on the header line", { headerRest: " >&p" }],
		["descriptor 3 on the header line", { headerRest: " >&3" }],
		["descriptor variable on the header line", { headerRest: " >&${COPROC[1]}" }],
		["descriptor path on the header line", { headerRest: " > /dev/fd/3" }],
	])("N: %s keeps the body scannable", (_label, patch) => {
		expect(isRuntimeDataHeredoc({ ...base, ...patch })).toBe(false);
	});
});
