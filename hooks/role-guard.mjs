// PreToolUse (Write|Edit|MultiEdit): keep motion-studio subagents inside their write lanes.
// Lanes are relative to the studio project root. The main session and every other agent are
// never restricted (silent). A plugin subagent reports agent_type "motion-studio:<name>"; the
// last ":"-segment is the role, so the guard also covers same-named project agents.
// The logic is in lib/role-handler.mjs (importable, so tests can call handle() without spawning node);
// this file only wires it to stdin/stdout/exit code.
import { runHook } from './lib/common.mjs';
import { handle } from './lib/role-handler.mjs';

runHook(handle);
