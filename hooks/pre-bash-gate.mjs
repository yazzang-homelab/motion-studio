// PreToolUse (Bash|PowerShell): block FINAL renders of a studio project until the critique loop
// has passed (tools/gate.mjs#checkGate). Drafts, stills and previews are never gated.
// Fail open on anything unexpected: a missing gate module or an unparsable command means "allow".
// The logic is in lib/gate-handler.mjs (importable, so tests can call handle() without spawning node);
// this file only wires it to stdin/stdout/exit code.
import { runHook } from './lib/common.mjs';
import { handle } from './lib/gate-handler.mjs';

runHook(handle);
