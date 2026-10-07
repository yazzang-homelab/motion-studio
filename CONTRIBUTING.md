# Contributing to motion-studio

Thanks for helping. This file covers the development setup, the rules every change follows, how to test, and how a
release is cut. The public data formats and tool reference are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Setup

```bash
git clone https://github.com/yazzang-homelab/motion-studio
cd motion-studio
npm install                      # dev only: playwright + ffmpeg-static for the browser/ffmpeg tests
npx playwright install chromium-headless-shell   # the browser for the tests (Windows: required)
npm i -g @anthropic-ai/claude-code   # for npm run validate and npm run eval:lint
claude --plugin-dir .            # load the working tree as the plugin
```

The block runs unchanged in Windows PowerShell 5.1: it has one command per line and no `&&`.

Requirements: Node 20 or later (keep 20.11 working), a browser for the browser tests, and optionally Python 3.12+ with
librosa 1.0 for the librosa beat engine. The browser is Playwright's headless shell (`npx playwright install
chromium-headless-shell`, about 115 MB). On Windows it is required: never run the tests against an installed Chrome or Edge
on a Windows account with a lockout policy. Every launch of one with a fresh profile counts as a failed Windows logon (Chrome
tests the account for a blank password), and one laptop logged 464 of them in 24 h and 45 lockouts. The tools,
`capture.mjs`, `states.mjs` and `canvas-frames.mjs` only start an installed Chrome or Edge on explicit request (`studio.json`
`browser`, `MOTION_BROWSER`, `MOTION_CHROME_PATH`), with a warning and a launch guard (a limit of N lets N - 1 launches pass: 3 of the
default 4 in 10 minutes); see `docs/ARCHITECTURE.md` section 9.10. On macOS and Linux an installed Chrome or Edge is still the
first choice of `auto`.

Do not commit a root `package-lock.json` (it is ignored on purpose): with a lockfile at the plugin root, Claude Code
runs `npm ci` into every user's plugin cache on install, and the root dependencies are for development only.

## Repository layout

| Path | Contents |
|---|---|
| `.claude-plugin/` | `plugin.json` (the only place the version lives) and `marketplace.json` (one entry, `"source": "./"`, no version) |
| `skills/<name>/` | `SKILL.md` + `references/` + `assets/` (+ `scripts/`) |
| `skills/studio-init/template/` | The film-project scaffold that `init.mjs` copies. It lives inside a skill so skills-only installs get it |
| `agents/` | One `.md` per subagent |
| `hooks/` | `hooks.json` + Node hook scripts + `hooks/lib/` |
| `evals/` | `claude plugin eval` cases |
| `scripts/` | Repository tooling: plugin lint, eval lint |
| `test/` | `node:test` suites (`*.test.mjs`) and fixtures |
| `docs/`, `prompts/` | Architecture reference, prompt-template index |
| `.github/workflows/` | `ci.yml` (free) and `evals.yml` (paid, manual or weekly) |

There is no `CLAUDE.md` at the repository root on purpose: a root `CLAUDE.md` is not loaded for plugin users and the
validator warns about it. The house rules for film projects live in `skills/studio-init/template/CLAUDE.md`.

## Rules for every change

Code:

1. Node 20+ ESM. Tools are `.mjs`; browser libraries are `.js` inside a `"type": "module"` package.
2. Dependencies: plugin-level scripts (hooks, `init.mjs`, `scripts/`) use Node built-ins only. Template tools may use
   only `playwright` (or `playwright-core`) and the optional `ffmpeg-static`. Python appears only in `tools/beats.py`.
3. Cross-platform: `path.join`/`path.resolve`, `pathToFileURL`/`fileURLToPath` (never `new URL(import.meta.url).pathname`),
   `spawn(bin, args, { shell: false })`. On Windows, never spawn `.cmd` shims without `shell: true` (Node rejects it
   with EINVAL); use `process.execPath` plus the JS entry where possible. No `sh -c`, `sed`, `md5` or `open`.
   Normalize backslashes before matching paths. LF line endings (enforced by `.gitattributes`).
4. Determinism: film code is a pure function of time. One seeded RNG per element (`rngFor(name, i)`), never a shared
   stream. No timers, `Date`, `performance.now`, `Math.random` or `requestAnimationFrame` in film or library code.
   The only exception is preview code in `lib/runtime.js`, and every such line carries `// studio-allow preview`.
5. CLIs: `--help` prints usage; an unknown or invalid flag prints an error plus usage and exits 2; failures exit 1, and so does a
   `studio.json` that does not validate (a configuration error, also in `mix`: only a bad flag is a usage error). Human logs go
   to stderr; `--json` prints exactly one JSON line on stdout: the result on success and
   `{"ok":false,"error":"<message>"}` on any usage, configuration or runtime error. Run the CLI body through `main()` from
   `tools/studio.mjs`, which does this. `gate.mjs` and `lint.mjs` keep their own dependency-free CLI for the hooks; each has a
   local `wantsJson` with the same rule as `studio.mjs` (last of `--json` and `--no-json` wins, nothing after a bare `--` counts) and
   prints the same envelope, and `gate.mjs` loads `studio.mjs` only inside its CLI. `deliver.mjs` prints
   `{"ok":false,"error":...,"failed":[...]}`, also when the run cannot start. A new export of `studio-web.mjs` must be added to
   the re-export list in `studio.mjs` (a test compares the two).
6. Configuration comes from `studio.json` via `tools/studio.mjs#loadConfig`; flags override it.
7. No stubs and no placeholder implementations. Keep files focused (aim for under 600 lines; `test/gate.test.mjs` enforces it for the
   `critique*`, `refs*`, `stills` and `deliver` files).
8. Comments explain why, briefly.

Hooks must read stdin fully, never throw, exit 0 silently on internal errors (only lint errors exit 2), respect
`MOTION_STUDIO_HOOKS=off`, add well under a second on top of Node startup and use no dependencies.

Markdown we ship: English (README.ko.md in Korean), imperative voice, tables for parameters, no emoji.

## Skills, agents and evals

Skills (`skills/<name>/SKILL.md`):

- Allowed frontmatter: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `allowed-tools`, `effort`,
  `model`, `disable-model-invocation`. The validator does not reject unknown keys, so `scripts/lint-plugin.mjs` does.
- `description` at most 230 characters, front-loaded: all installed skills share one listing budget.
- Body under 500 lines (aim for 120 to 300); move depth into `references/*.md` and prompt templates into `assets/`.
- Reference bundled files as `${CLAUDE_SKILL_DIR}/...`; inside a film project, call the project's own `tools/*.mjs`.
- `${CLAUDE_PLUGIN_ROOT}` is substituted only in plugin skills, so a skills-only install (`npx skills add`) sees it as
  literal text. Every command that uses it needs the sibling form (`${CLAUDE_SKILL_DIR}/../<skill>/...`) named within 8
  lines, with the words "skills-only" (`npm run lint` warns otherwise; `--strict` fails).
- Commands that run longer than about 2 minutes (final renders, `build`, `mix`, `deliver`) are documented with their expected
  time and run in the background with a polled log; never leave a bare foreground call in a skill or agent.
- End with a "Next" line that routes to the following skill.

Agents (`agents/<name>.md`):

- Allowed frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `skills`,
  `color`. Plugin agents ignore `hooks`, `mcpServers` and `permissionMode`.
- `color` is one of red, blue, green, yellow, purple, orange, pink, cyan.
- The description is prose ("Use this agent when ... Typical triggers include ..."); worked scenarios go in a
  `## When to invoke` section. Subagents cannot ask the user questions; they return them to the main session.

Evals (`evals/<case>/prompt.md` + `graders/*.md`, plus `case.yaml` only when a scaffold is needed):

- Frontmatter keys only from the accepted set; single-quote every regex in YAML.
- Every case has at least one outcome grader besides `tool_used`; keep `runs: 3`; no absolute paths or `~/`.
- Keep at least one case that must not fire any skill.
- Cases that grant Bash run only on Linux or macOS (the eval sandbox refuses shell tools on native Windows); tag them.

## Testing

| Command | What it checks | Cost |
|---|---|---|
| `npm test` | Unit tests over `test/*.test.mjs`; browser and ffmpeg tests skip when unavailable | Free |
| `npm run test:smoke` | End to end with `SMOKE=1`: temp project, 1 s render at 12 fps twice with matching frame hashes, a partial clip, stills, score, sfx, mix, critique, deliver | Free, needs a browser + ffmpeg |
| `npm run lint` | Frontmatter allowlists, agent colors, names, description lengths, CRLF, JSON parse, a skills-only fallback next to every `${CLAUDE_PLUGIN_ROOT}` command, tests that create temp directories without removing them | Free |
| `npm run validate` | `claude plugin validate . --strict` and `claude plugin validate .claude-plugin/plugin.json --strict` | Free |
| `npm run eval:lint` | Loads every eval case with `--max-cost-usd 0`; fails on load errors or infeasible graders | Free |
| `npm run eval:selftest` | Grades every regex and `tool_used` grader against passing and failing samples and runs each scaffold, untouched and edited (Node built-ins only; Git Bash on Windows) | Free |
| `claude plugin eval . --tag smoke --ablation none --runs 1 --allow-tools Write Edit` | A quick paid run of the smoke cases | Paid |

Notes:

- Run the suites with `npm test`, not `node --test test/`. On Node 20 a directory argument named `test` makes the
  runner execute every `.mjs` below it, including fixtures and leftovers in `test/.tmp/`.
- Hooks are unit-tested by piping JSON fixtures (including Windows backslash paths) to the scripts on stdin. On a
  machine whose managed settings set `allowManagedHooksOnly`, plugin hooks never fire live; CI runners do not have
  that restriction.
- Tests build scratch film projects in the OS temp directory and must remove them afterwards (in `after()` or `finally`, also
  from a synchronous `process.on('exit')` handler when a crash could skip the hook); `npm run lint` warns about a test that
  calls `mkdtemp` and never removes anything. `MS_TEST_PARALLEL=N` sets the child-process pool of `hooks.test.mjs` and
  `init.test.mjs` (default min(4, max(2, cpus / 4))). The smoke test links the
  repository's `node_modules` into its project (or set `MOTION_SMOKE_NODE_MODULES`), and keeps the project on failure
  or with `MOTION_SMOKE_KEEP=1`. `test/.tmp/` is ignored by git for any local scratch work.
- Determinism checks compare frame hashes on one machine and one browser build only.
- Fixtures that would be loadable JavaScript are stored as `<name>.js.txt` (or `.mjs.txt`, `.cjs.txt`) and restored to
  their real names in a temp copy; `hooks.test.mjs` fails on any `.js`, `.mjs` or `.cjs` below `test/` other than
  `test/*.test.mjs`. Never store eval fixtures under a directory named `out/` (the root `.gitignore` ignores it).
- Browser and ffmpeg tests skip when playwright, a browser or ffmpeg is missing. Point them at your own copies with
  `FFMPEG_PATH`, `MOTION_CHROME_PATH` (on Windows the headless shell:
  `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-<build>\chrome-headless-shell-win64\chrome-headless-shell.exe`; never a
  `chrome.exe` or `msedge.exe`, see below), `MOTION_PYTHON` (a Python with librosa, for the librosa beat test),
  `MOTION_SMOKE_NODE_MODULES` (a `node_modules` that holds playwright) and `MOTION_TEMPLATE_DIR` (test another template
  copy). `MOTION_SMOKE_KEEP=1` keeps the smoke project and `MOTION_SMOKE_STEP_MS` sets its per-step timeout.
- Browser policy: a test must never start an installed Chrome or Edge on Windows (each fresh-profile launch is a failed logon
  that counts toward the account lockout). Run browser tests with the default policy (the headless shell) or with
  `MOTION_CHROME_PATH` at the headless shell. A test of the installed-browser path uses a fake Playwright and its own
  `MOTION_LAUNCH_LOG` in a temp directory, as `test/browser-policy.test.mjs` and `test/capture.test.mjs` do; that file also holds
  the guard tests, the check that `tools/studio-web.mjs` and `skills/product-reel/scripts/capture.mjs` carry a byte-identical policy block
  (edit both together; the block between the `browser-policy` markers is the only place the rule lives; `states.mjs` and
  `canvas-frames.mjs` reach it through `capture-session.mjs`, and no script may be embedded in `agents/asset-scout.md` again), and one real-browser test that reads the Security log around a launch.
  The variables:
  `MOTION_BROWSER` (`auto`, `chrome`, `msedge`, `chromium`), `MOTION_LAUNCH_LOG`, `MOTION_SYSTEM_BROWSER_MAX` (1 to 9, default 4)
  and `MOTION_ALLOW_LOCKOUT_RISK` (see `docs/ARCHITECTURE.md` section 12). Slow start is expected on Windows with a real-time
  antivirus (15 to 25 s per tool run, measured), so give browser tests generous timeouts.
- Some suites take minutes on a slow machine: the end-to-end mix test (four concurrent cases), the CLI cases in
  `test/studio.test.mjs` that render with a real browser, and the doctor CLI test. Run one file with
  `node --test test/gate.test.mjs`; `npm test -- --test-name-pattern <text>` forwards flags to the runner. `npm test` runs at most
  min(4, cpus - 1) test files at once (`--test-concurrency`; every child process costs about 2 s to create on the measured laptop, so
  more files in parallel only make each test slower); `npm test -- --test-concurrency=N` overrides it. The whole suite took about
  45 minutes on that laptop, most of it browser starts.
- CI (`.github/workflows/ci.yml`): the unit-test job installs Playwright's headless shell on all three operating systems before
  `npm test` (`npx playwright install chromium-headless-shell`, with `--with-deps` on Linux only), because on Windows the default policy
  never starts the runner's preinstalled Chrome and the browser tests would skip. It has a 90-minute limit (was 40; a hosted runner is
  assumed not slower than the laptop above [assumption]). The `smoke` job installs the shell with `--with-deps`; on Ubuntu `auto`
  still tries the runner's Chrome first. `evals.yml` runs `npx playwright install-deps chromium-headless-shell`; the render eval's
  scaffold downloads the shell itself and has no system-Chrome fallback. Keep any workflow step that starts a browser on the
  bundled shell.

## Credit policy

- Never paste another creator's prompt, post text or code. X posts carry no license. Describe the pattern in your own
  words and link the source. The only exceptions are the credited showreel one-liner and short attributed phrases (under
  about 15 words) that correct a claim or name an example; each one gets a row in the table of
  [prompts/README.md](prompts/README.md#what-is-quoted-verbatim).
- Repositories without a license are ideas-only. For permissively licensed code, prefer reimplementing; if you do copy
  a snippet, keep its license notice and say so in `CREDITS.md`.
- Every new idea source gets a row in `CREDITS.md`: what it is, license, what was taken and where it lives, what was
  not taken.
- Never add brand assets, mascots or media from other creators.

## Contribution license

motion-studio is dual-licensed: [PolyForm Noncommercial 1.0.0](LICENSE) for everyone, and a paid commercial license
([COMMERCIAL.md](COMMERCIAL.md)). For that to work, every contribution must be licensable under both. By opening a pull
request you confirm that:

1. the contribution is your own work, or you have the right to submit it, and it contains no code you may not license
   this way;
2. you grant yazzang, the project maintainer, a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license
   (including patent rights you hold that the contribution would infringe) to use, copy, modify, distribute and sublicense
   the contribution, under the PolyForm Noncommercial License, under commercial license terms, or under any other terms;
3. you keep the copyright in your contribution.

Add this line to the pull request description: `I agree to the contribution license in CONTRIBUTING.md.` Pull requests
without it are not merged.

## Pull requests

1. Branch from `main`; keep one topic per pull request.
2. Run `npm run lint`, `npm run validate`, `npm test`, `npm run eval:lint` and `npm run eval:selftest` before pushing.
3. Update `CHANGELOG.md` under `[Unreleased]`, and the docs when behavior, flags or data formats change
   (`README.md`, `README.ko.md`, `docs/ARCHITECTURE.md`).
4. CI must pass on Ubuntu, Windows and macOS.

## Releasing

Follow the publishing checklist in [README.md](README.md#publishing-checklist): bump the version in
`.claude-plugin/plugin.json` and `package.json`, move the `[Unreleased]` notes into a dated section, run the checks,
then `claude plugin tag . --dry-run` and `claude plugin tag . --push`.
