// SessionStart (startup|resume|clear|compact): when the session starts inside a studio project,
// add a short factual status (title, formats, timing, critique-gate state, finals on disk) and the
// next suggested command. Outside a studio project: no output.
// The logic is in lib/session-handler.mjs (importable, so tests can call handle() without spawning node);
// this file only wires it to stdin/stdout/exit code.
import { runHook } from './lib/common.mjs';
import { handle } from './lib/session-handler.mjs';

runHook(handle);
