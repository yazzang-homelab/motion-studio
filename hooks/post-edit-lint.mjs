// PostToolUse (Write|Edit|MultiEdit): lint film/lib code of a studio project for determinism and
// house-rule violations right after Claude changes it. Errors → exit 2 with a short stderr report
// (Claude sees it next to the tool result). Warnings only → additionalContext JSON. Otherwise silent.
// The logic is in lib/lint-handler.mjs (importable, so tests can call handle() without spawning node);
// this file only wires it to stdin/stdout/exit code.
import { runHook } from './lib/common.mjs';
import { handle } from './lib/lint-handler.mjs';

runHook(handle);
