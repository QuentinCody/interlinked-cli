// Boundary/contract wave (Plan 25 lanes 7-8,
// docs/plans/25-refactor-readiness-program.md): post-phase, advisory
// detectors. test_contract_annotation is adoption-triggered (see
// checks/test-contract-annotation.ts); unvalidated_input_boundary extends
// the boundary-parser family alongside the existing `unvalidated_json_boundary`
// (see checks/unvalidated-input-boundary.ts for exactly how the two differ).

import { detectTestContractAnnotation } from "../../checks/test-contract-annotation.js";
import { detectCommanderOptionAttribute } from "../../checks/commander-option-attribute.js";
import { detectNumericZeroDefault } from "../../checks/numeric-zero-default.js";
import { detectUnvalidatedInputBoundary } from "../../checks/unvalidated-input-boundary.js";
import type { CheckRegistration } from "../types.js";

export const BOUNDARY_CONTRACT_ENTRIES: CheckRegistration[] = [
	{
		id: "numeric_zero_default",
		phase: "post",
		name: "Numeric Zero Default",
		description:
			"Reports logical-or defaults on resolved numeric parser results, stable aliases and supported one-hop local raw-parser wrappers. A numeric zero would select the fallback. This arithmetic observation requires review of zero/default intent; unsupported numeric flow remains unmeasured.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Review whether zero is meaningful for this caller. Preserve explicit zero-sentinel contracts. If zero should survive numeric conversion, distinguish NaN explicitly; nullish coalescing alone does not handle NaN.",
		fn: detectNumericZeroDefault,
		resultsPropName: "numericZeroDefault",
		content_keywords: ["||", "Number", "parseInt", "parseFloat"],
	},
	{
		id: "commander_option_attribute",
		phase: "post",
		name: "Commander Option Attribute",
		description:
			"Flags dashed or negated option-key reads bound to Commander declarations, including supported one-hop local imported handlers and thin forwarding callbacks. Reads after mutation/escape and unsupported module mappings remain unmeasured. Hook reverse-import inventory is partial.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Read the Commander attribute name (for example dryRun for --dry-run), or explicitly normalize the options object at the handler boundary. Review custom Option mappings and cross-module handler evidence separately.",
		fn: detectCommanderOptionAttribute,
		resultsPropName: "commanderOptionAttribute",
	},
	{
		id: "test_contract_annotation",
		phase: "post",
		name: "Test Contract Annotation",
		description:
			"Adoption-triggered: once a mutation-directed test file (*.mutation-kill.*/*.mutation-hardening.*/*.survivor(s).*) has systematically adopted the `test-contract:` comment convention, flags an it()/test() block with no such comment in the contiguous comment block directly above it. Silent for files that never adopted the convention, or only used it as a spot annotation.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add a `// test-contract: <kind> — <what this case pins>` comment directly above the block, matching the convention this file has already adopted elsewhere (e.g. `// test-contract: boundary — parseWindow rejects the documented zero-width interval`).",
		fn: detectTestContractAnnotation,
		resultsPropName: "testContractAnnotation",
		content_keywords: ["test-contract:"],
	},
	{
		id: "unvalidated_input_boundary",
		phase: "post",
		name: "Unvalidated Input Boundary",
		description:
			"Flags an awaited .json() call without nearby validator-shaped evidence, and direct process.argv indexing at 2 or above outside a bin/cli entry file. Discarded safeParse and predicate calls do not count as validation. This bounded naming heuristic does not prove arbitrary parser contracts; JSON.parse is covered by unvalidated_json_boundary.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Pipe the .json() result through a schema parser before using it (`const parsed = MySchema.parse(await res.json());`), and read positional CLI args only in a recognized entry file (index.ts/cli.ts/bin/) — elsewhere, accept them as explicit function parameters instead of indexing process.argv directly.",
		fn: detectUnvalidatedInputBoundary,
		resultsPropName: "unvalidatedInputBoundary",
		content_keywords: [".json", "process.argv"],
	},
];
