// interlinked-tdd: exempt
// The one embedded Python program `interlinked check` runs for Python source. It is
// the concatenation of two data parts; behaviour is tested in check-python-run.test.ts
// and check-python-imports.test.ts (real interpreter, real temp trees).
import { PYTHON_CONFIG_PART } from "./check-python-script-config.js";
import { PYTHON_DEAD_PART } from "./check-python-script-dead.js";
import { PYTHON_GRAPH_PART } from "./check-python-script-graph.js";
import { PYTHON_PARSE_PART } from "./check-python-script-parse.js";
import { PYTHON_RESOLVE_PART } from "./check-python-script-resolve.js";

/** Standard-library-only analyzer. Target source is parsed with `ast`, never imported or executed. */
export const PYTHON_CHECK_SCRIPT = `${PYTHON_PARSE_PART}${PYTHON_CONFIG_PART}${PYTHON_DEAD_PART}${PYTHON_GRAPH_PART}${PYTHON_RESOLVE_PART}`;
