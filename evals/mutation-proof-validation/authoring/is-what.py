NAME = "is-what"
T = ["test/index.test.ts"]
FAULTS = [
 ("src/isPositiveNumber.ts", "payload > 0", "payload >= 0", "killed", "positive", "0 is not a positive number", T, "boundary: > to >="),
 ("src/isNegativeNumber.ts", "payload < 0", "payload > 0", "killed", "negative", "isNegativeNumber is true only below zero", T, "flipped comparison"),
 ("src/isNumber.ts", " && !Number.isNaN(payload as number)", "", "killed", "nan-not-number", "NaN is not a number", T, "dropped guard"),
 ("src/isFullArray.ts", "payload.length > 0", "payload.length > 1", "killed", "full-array", "a one-element array is full", T, "off-by-one"),
 ("src/isPlainObject.ts", "if (getType(payload) !== 'Object') return false", "if (getType(payload) === 'Array') return false", "killed", "plain-object", "only Object-tagged values are plain objects", T, "weakened guard"),
 ("src/isHexDecimal.ts", "return length === undefined || payload.length === length", "return length === undefined || payload.length >= length", "killed", "hex-length", "a hex string with the wrong length is rejected", T, "comparison weakened"),
 ("src/isDate.ts", " && !Number.isNaN((payload as Date).valueOf())", "", "killed", "invalid-date", "an Invalid Date is not a date", T, "dropped guard"),
 ("src/isPrimitive.ts", "    isNull(payload) ||\n", "", "killed", "primitive-null", "null is a primitive", T, "dropped branch"),
 ("src/isEmptyString.ts", "export function isEmptyString", "// is-what: true only for ''\nexport function isEmptyString", "survived", "comment", "comment-only change", T, "comment change"),
 ("src/isFullObject.ts", "Object.keys(payload).length > 0", "Object.keys(payload).length !== 0", "survived", "equiv-full-object", "length is never negative", T, "equivalent rewrite"),
 ("src/isPrimitive.ts", "import { isBigInt } from './isBigInt.js'\nimport { isBoolean } from './isBoolean.js'", "import { isBoolean } from './isBoolean.js'\nimport { isBigInt } from './isBigInt.js'", "survived", "reorder", "independent imports reordered", T, "reorder of independent declarations"),
 ("src/isNumber.ts", "import { getType } from './getType.js'", "import { getType } from './getType.js'\nthrow new Error('fault: isNumber throws at import')", "inconclusive", "load", "module loads", T, "module throws at import"),
 ("src/isNaNValue.ts", "export function isNaNValue(", "function isNaNValue(", "inconclusive", "export", "isNaNValue is exported", T, "exported function removed (index re-exports it)"),
]
