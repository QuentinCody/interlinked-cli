// @codegen-data — portable pinned profile metadata, with no project measurements or executable policy.

export interface StandardsGroup {
	readonly id: string;
	readonly title: string;
	readonly source: { readonly startLine: number; readonly endLine: number; readonly sha256: string };
	readonly checkIds: readonly string[];
	readonly syntaxRules: readonly string[];
	readonly discoveryFamilies: readonly string[];
	readonly unmeasured: string;
}

export interface StandardsProfile {
	readonly id: string;
	readonly version: string;
	readonly source: { readonly url: string; readonly revision: string; readonly rawUrl: string; readonly sha256: string };
	readonly standards: readonly StandardsGroup[];
}

/** Pinned public guidance metadata. Choosing the profile creates a report without adopting policy. */
export const DMMULROY_TYPESCRIPT_PROFILE: StandardsProfile = {
	"id": "dmmulroy-typescript",
	"version": "1",
	"source": {
		"url": "https://gist.github.com/dmmulroy/9c80f1f499b031aa0b6525b5d9ae25f0",
		"revision": "db1b93212222dc5b1a723e48aedb2ed1835b1ed7",
		"rawUrl": "https://gist.githubusercontent.com/dmmulroy/9c80f1f499b031aa0b6525b5d9ae25f0/raw/dfa1b73e171b89b2d2c47eea6d322d6ce4048486/coding-standards-draft.md",
		"sha256": "059a56054945277ea835ebcbf2030bb6613113c2cd066226f88e1424e7307642"
	},
	"standards": [
		{
			"id": "s01",
			"source": {
				"startLine": 1,
				"endLine": 44,
				"sha256": "f36a9f19e87aa36b0ac343b1f26b48834f413793eb2fcab5e62239f02b40a317"
			},
			"checkIds": [],
			"title": "Project conventions",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Project conventions and policy adoption require explicit context."
		},
		{
			"id": "s02",
			"source": {
				"startLine": 46,
				"endLine": 76,
				"sha256": "b3b3a07c22e75e655b4b1227105129d89c914ff724f1e5a2cefdc013e72feb0c"
			},
			"checkIds": [
				"throw_literal",
				"promise_reject_non_error",
				"floating_promises"
			],
			"title": "Failure representations",
			"syntaxRules": [
				"throw_statement"
			],
			"discoveryFamilies": [
				"error_handling"
			],
			"unmeasured": "Expected failures and defects require API contracts and failure evidence."
		},
		{
			"id": "s03",
			"source": {
				"startLine": 78,
				"endLine": 96,
				"sha256": "1f94f539b5936dc4e68b79fd89b8d1fd3aa2f00dc166c737d61a100d33730b5b"
			},
			"checkIds": [
				"discriminated_union_exhaustiveness"
			],
			"title": "Exhaustive handling",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Exhaustiveness responsibility and helper conventions require project context."
		},
		{
			"id": "s04",
			"source": {
				"startLine": 98,
				"endLine": 136,
				"sha256": "9c9f82b089e80a20de3c208065c66f460cf5855d17f7fdd960b0a28ef06b3963"
			},
			"checkIds": [
				"lossy_error_rethrow",
				"catch_rewrap_loses_cause",
				"json_stringify_error",
				"error_dispatch_by_instanceof"
			],
			"title": "Error information",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Error union precision and serialization safety require boundary evidence."
		},
		{
			"id": "s05",
			"source": {
				"startLine": 138,
				"endLine": 156,
				"sha256": "eb4fdcb3c867b08b3bb280ce7e671a68edee190e33bc0f8ea3e7964054d61e03"
			},
			"checkIds": [],
			"title": "Safe observability",
			"syntaxRules": [
				"observability_sink",
				"sensitive_sink_name_candidate",
				"secret_unwrap"
			],
			"discoveryFamilies": [
				"secret_flow"
			],
			"unmeasured": "Sensitive origins and redaction ownership require provenance."
		},
		{
			"id": "s06",
			"source": {
				"startLine": 158,
				"endLine": 197,
				"sha256": "8e7e94b921122ab402d3850e2674cff74e5806bd4d2dd5fc8df15e0761f483d7"
			},
			"checkIds": [
				"unvalidated_json_boundary",
				"unvalidated_input_boundary"
			],
			"title": "Boundary parsing",
			"syntaxRules": [
				"raw_json_parse",
				"discarded_parser_syntax",
				"fallible_schema_parse"
			],
			"discoveryFamilies": [
				"parser_result"
			],
			"unmeasured": "Parser outcome and domain-use integrity require binding and control-flow evidence."
		},
		{
			"id": "s07",
			"source": {
				"startLine": 199,
				"endLine": 208,
				"sha256": "de36a978b21df6101c6b840aea412872f3083b8f41a8c47b4c8a4579a6d03e42"
			},
			"checkIds": [
				"same_typed_primitive_params",
				"double_cast_unknown"
			],
			"title": "Domain value construction",
			"syntaxRules": [
				"type_assertion"
			],
			"discoveryFamilies": [
				"brand_ownership"
			],
			"unmeasured": "Domain construction authority requires explicit ownership policy."
		},
		{
			"id": "s08",
			"source": {
				"startLine": 210,
				"endLine": 212,
				"sha256": "42fa0c814ab4da0b888dc6ebac77d2bd5950da3ff436e83414070203db1a889e"
			},
			"checkIds": [
				"many_optional_params"
			],
			"title": "Required input shapes",
			"syntaxRules": [
				"partial_type"
			],
			"discoveryFamilies": [],
			"unmeasured": "Patch semantics and required inputs require operation-specific invariants."
		},
		{
			"id": "s09",
			"source": {
				"startLine": 214,
				"endLine": 235,
				"sha256": "cb55d924541e58fc0fe7eabc95bbeb479889ca63ffa2b145df9eecfd5147c079"
			},
			"checkIds": [
				"discriminated_union_exhaustiveness"
			],
			"title": "Lifecycle representation",
			"syntaxRules": [
				"boolean_state_bag_candidate"
			],
			"discoveryFamilies": [],
			"unmeasured": "Correlated lifecycle constraints require domain invariants."
		},
		{
			"id": "s10",
			"source": {
				"startLine": 238,
				"endLine": 255,
				"sha256": "9bdaa84b9490c793fd84c977aa8ab6b53d5db55629a66a0a5b8a376e5f5321a5"
			},
			"checkIds": [
				"boolean_trap",
				"positional_optional_boolean",
				"flag_argument"
			],
			"title": "Boolean arguments",
			"syntaxRules": [
				"positional_boolean_argument",
				"boolean_parameter"
			],
			"discoveryFamilies": [],
			"unmeasured": "Behavior-control booleans require the actual callee contract."
		},
		{
			"id": "s11",
			"source": {
				"startLine": 257,
				"endLine": 268,
				"sha256": "72cb6d2eb8746390045dbde2dec232b00392b5460159e9f8fb1708efb41e3e5e"
			},
			"checkIds": [
				"single_use_trivial_helper"
			],
			"title": "Abstraction responsibility",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Abstraction value requires consumer responsibilities and alternatives."
		},
		{
			"id": "s12",
			"source": {
				"startLine": 270,
				"endLine": 301,
				"sha256": "70e0e28aa5da372427dd390dc1f865f46ccb6fd1159e02eb9cfbcc2ad089de73"
			},
			"checkIds": [
				"hybrid_class"
			],
			"title": "Domain module cohesion",
			"syntaxRules": [
				"mutable_public_class_field"
			],
			"discoveryFamilies": [],
			"unmeasured": "Domain cohesion requires supplied responsibilities and consumers."
		},
		{
			"id": "s13",
			"source": {
				"startLine": 303,
				"endLine": 320,
				"sha256": "8f71eb70f76395c29331100ef7128ded1692befe3a6e74d3e9faca1a8e86880d"
			},
			"checkIds": [
				"fuzzy_responsibility_name"
			],
			"title": "Application capabilities",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Injection style and capability boundaries require local architecture."
		},
		{
			"id": "s14",
			"source": {
				"startLine": 322,
				"endLine": 348,
				"sha256": "16d779f3920311050374d28cf4511554aee10ad4c7474020c2bd2fe1cdc2345a"
			},
			"checkIds": [
				"public_api_leaks_internal_type"
			],
			"title": "Dependency boundaries",
			"syntaxRules": [
				"value_import_declaration"
			],
			"discoveryFamilies": [],
			"unmeasured": "Minimal dependency shapes require consumer and type-graph evidence."
		},
		{
			"id": "s15",
			"source": {
				"startLine": 350,
				"endLine": 367,
				"sha256": "1b415236a5287dfb193b012aa2a4651eeab2ad94e2ec6b750f5f56ae2e1e98c0"
			},
			"checkIds": [
				"single_use_trivial_helper"
			],
			"title": "Reuse decisions",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Reuse and extension decisions require existing implementation alternatives."
		},
		{
			"id": "s16",
			"source": {
				"startLine": 369,
				"endLine": 375,
				"sha256": "52631724969e98d90a57f7813f312e00bce86a93aa0541eb7f2af06015122043"
			},
			"checkIds": [
				"public_api_leaks_internal_type"
			],
			"title": "Persistence boundaries",
			"syntaxRules": [
				"raw_json_parse"
			],
			"discoveryFamilies": [],
			"unmeasured": "Persistence versus domain representations require boundary ownership."
		},
		{
			"id": "s17",
			"source": {
				"startLine": 377,
				"endLine": 403,
				"sha256": "1032fb1e72aee3146b7e74d017517f9af5bd3149097d76363d21f39ca1ebc39b"
			},
			"checkIds": [
				"process_env_outside_config",
				"top_level_side_effect"
			],
			"title": "Effects and core logic",
			"syntaxRules": [
				"ambient_clock_random",
				"process_env_access",
				"module_init_effect"
			],
			"discoveryFamilies": [
				"module_initialization"
			],
			"unmeasured": "Functional purity and shell ownership require explicit role policy."
		},
		{
			"id": "s18",
			"source": {
				"startLine": 405,
				"endLine": 407,
				"sha256": "27c6721e6f241744cdbc84d601501d60b7d7097e8322a927c58722dc3762240e"
			},
			"checkIds": [],
			"title": "Entrypoint translation",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Shared application policy requires entrypoint and behavior evidence."
		},
		{
			"id": "s19",
			"source": {
				"startLine": 409,
				"endLine": 422,
				"sha256": "9b65f9a9a7eb729214a4366a116f87167c317e67eebecf9156aa73a82a4c7e34"
			},
			"checkIds": [],
			"title": "Durable coordination",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Workflow choice requires retry, compensation and coordination requirements."
		},
		{
			"id": "s20",
			"source": {
				"startLine": 424,
				"endLine": 424,
				"sha256": "9a0dbac9c861356f0f81ca86bb0796cc435488943922588ef99b112fb8c0a32e"
			},
			"checkIds": [],
			"title": "Transaction lifetime",
			"syntaxRules": [
				"transaction_api_candidate",
				"transaction_external_effect_candidate"
			],
			"discoveryFamilies": [
				"transaction_scope"
			],
			"unmeasured": "Transaction safety requires real lifetime and I/O contracts."
		},
		{
			"id": "s21",
			"source": {
				"startLine": 426,
				"endLine": 434,
				"sha256": "b8d3a7eedbe4b3b577bb42ace2bd5bbf1fff6a582c92648c954fc43752ad612a"
			},
			"checkIds": [
				"untested_idempotent",
				"comment_claims_idempotent_mutates"
			],
			"title": "Retry semantics",
			"syntaxRules": [
				"property_runner"
			],
			"discoveryFamilies": [],
			"unmeasured": "Replay safety requires retry contracts and effect observations."
		},
		{
			"id": "s22",
			"source": {
				"startLine": 436,
				"endLine": 451,
				"sha256": "29c999b3c4ba5cad1160ee79e822aa50179f7f3be3d8b526f6b8e4320916813e"
			},
			"checkIds": [
				"mocking_the_sut",
				"mocking_the_sut_self",
				"mock_only_test",
				"over_mocking"
			],
			"title": "Behavioral test seams",
			"syntaxRules": [
				"module_mock_call"
			],
			"discoveryFamilies": [],
			"unmeasured": "Test seams and mock suitability require observable behavior contracts."
		},
		{
			"id": "s23",
			"source": {
				"startLine": 453,
				"endLine": 463,
				"sha256": "d80ff59e6ee6b8515c7423c5439b39a63a4d0818f8f34f01f91a3a469220310c"
			},
			"checkIds": [
				"private_member_test_access",
				"mock_return_echo",
				"catch_without_assertion_guard"
			],
			"title": "Observable assertions",
			"syntaxRules": [
				"spy_assertion",
				"snapshot_assertion"
			],
			"discoveryFamilies": [],
			"unmeasured": "Interactions and persistence assertions require behavior and execution evidence."
		},
		{
			"id": "s24",
			"source": {
				"startLine": 465,
				"endLine": 485,
				"sha256": "e8fc6b8f3fc1d554f398b327cda191753a9a9e1e72afd8fce555d0604e13d45d"
			},
			"checkIds": [
				"untested_inverse_pair",
				"untested_idempotent"
			],
			"title": "Property relationships",
			"syntaxRules": [
				"property_runner"
			],
			"discoveryFamilies": [],
			"unmeasured": "Properties require valid generators, meaningful relationships and execution evidence."
		},
		{
			"id": "s25",
			"source": {
				"startLine": 487,
				"endLine": 495,
				"sha256": "a826b056d08e5c032c35c21156646555a87e53c1f2c7acfec12d90d0dab58249"
			},
			"checkIds": [],
			"title": "Compiler options",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Compiler options describe configuration and do not establish a clean compilation."
		},
		{
			"id": "s26",
			"source": {
				"startLine": 497,
				"endLine": 506,
				"sha256": "f2c61d38e96466294aa634dc1904010426e2c23d94d48140625a1122019951ec"
			},
			"checkIds": [
				"hybrid_class"
			],
			"title": "Mutation ownership",
			"syntaxRules": [
				"mutable_public_class_field"
			],
			"discoveryFamilies": [],
			"unmeasured": "Localized mutation requires ownership and caller exposure evidence."
		},
		{
			"id": "s27",
			"source": {
				"startLine": 508,
				"endLine": 534,
				"sha256": "326bbb6b1519b6c403ae5502c9c5b2ef334b6341e8ff52475695b320991732f9"
			},
			"checkIds": [
				"unjustified_cast",
				"non_null_assertion",
				"double_cast_unknown"
			],
			"title": "Type escape evidence",
			"syntaxRules": [
				"type_assertion",
				"explicit_any",
				"non_null_ast"
			],
			"discoveryFamilies": [
				"brand_ownership"
			],
			"unmeasured": "Cast soundness requires parser, constructor and provenance evidence."
		},
		{
			"id": "s28",
			"source": {
				"startLine": 536,
				"endLine": 555,
				"sha256": "0590ab34c99d67e0721c02c30a47305ee2f97ea1a22d2062e849871cb9fbf218"
			},
			"checkIds": [
				"import_from_own_barrel"
			],
			"title": "Import ownership",
			"syntaxRules": [
				"value_import_declaration",
				"reexport_declaration"
			],
			"discoveryFamilies": [],
			"unmeasured": "Import ownership and type-only usage require resolved graph evidence."
		},
		{
			"id": "s29",
			"source": {
				"startLine": 557,
				"endLine": 559,
				"sha256": "f25215ba6627260da1fd23ea719e932cf59977526927a7cea9ceec5c9ea3e6a3"
			},
			"checkIds": [
				"public_api_leaks_internal_type"
			],
			"title": "Export exposure",
			"syntaxRules": [
				"typescript_namespace",
				"exported_declaration"
			],
			"discoveryFamilies": [],
			"unmeasured": "Public exports and interoperability require consumers and package entrypoints."
		},
		{
			"id": "s30",
			"source": {
				"startLine": 561,
				"endLine": 591,
				"sha256": "20e1870e731e27ae60a540bf81d36e66200c40cb7c5e1cb889139b2ca77f11c4"
			},
			"checkIds": [
				"fuzzy_responsibility_name",
				"single_use_trivial_helper"
			],
			"title": "Code navigation",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Cohesion and discoverability require source and change-responsibility review."
		},
		{
			"id": "s31",
			"source": {
				"startLine": 593,
				"endLine": 627,
				"sha256": "0b41589e8b8954f6b3bbb9e51ec437500cc4a2faf498772bf2ecda55d31d3c1f"
			},
			"checkIds": [
				"jsdoc_param_drift"
			],
			"title": "API documentation",
			"syntaxRules": [
				"exported_declaration",
				"exported_without_jsdoc"
			],
			"discoveryFamilies": [],
			"unmeasured": "Documentation usefulness and failure contracts require source review."
		},
		{
			"id": "s32",
			"source": {
				"startLine": 629,
				"endLine": 639,
				"sha256": "64234836d804cc87baef09b9a07c12ac6101689ddee81f9942d3a4972051b43e"
			},
			"checkIds": [],
			"title": "Field explanations",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Useful field explanations require domain context."
		},
		{
			"id": "s33",
			"source": {
				"startLine": 642,
				"endLine": 654,
				"sha256": "fb4e2e89f49d6148b23a2a7fae231d5fff40d064bbb45d15768fa13d3fd27eac"
			},
			"checkIds": [
				"process_env_outside_config",
				"top_level_side_effect",
				"resource_handle_leak"
			],
			"title": "Resource boundaries",
			"syntaxRules": [
				"process_env_access",
				"module_collection_state_candidate",
				"ambient_clock_random"
			],
			"discoveryFamilies": [
				"resource_ownership",
				"module_initialization"
			],
			"unmeasured": "Resource lifetime and framework ownership require cleanup and ownership evidence."
		},
		{
			"id": "s34",
			"source": {
				"startLine": 656,
				"endLine": 670,
				"sha256": "f6b34a100bb8359337f09111fcbc731e192113f3555321d6d547c24855eea3f9"
			},
			"checkIds": [],
			"title": "Agent workflow",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "Agent workflow claims require session and review evidence."
		},
		{
			"id": "s35",
			"source": {
				"startLine": 672,
				"endLine": 706,
				"sha256": "9afe4219526742f263f42ffb77f26720bf612da9e9633dc24ffb42bde69bdf2a"
			},
			"checkIds": [],
			"title": "Unspecified future topics",
			"syntaxRules": [],
			"discoveryFamilies": [],
			"unmeasured": "The source explicitly leaves future topics undeveloped."
		}
	]
};
