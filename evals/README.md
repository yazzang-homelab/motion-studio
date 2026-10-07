# motion-studio evals

This suite runs the plugin against realistic requests with `claude plugin eval` and scores what comes out: the reply,
the files the run wrote, and which tools it called. By default every case also runs without the plugin, so the
headline number is the uplift `Δ` (with-plugin score minus no-plugin score), not the raw pass rate.

Everything here is plain files: one directory per case with `prompt.md` (run limits in frontmatter, the user's message
as the body), `graders/*.md` (one check each), and a `case.yaml` + `scaffold.sh` when the workspace needs seeding.

## Cases

| Case | Tags | Skill under test | Graded on | Tools | Budget |
|---|---|---|---|---|---|
| `trigger-motion-reel` | smoke, trigger | motion-reel | review checkpoint named (regex); asks for inputs, code-rendered plan, checkpoint (judge) | Read Glob Grep Skill | 8 turns / 180 s |
| `trigger-showreel` | smoke, trigger | showreel | variation axes named (regex); anatomy + 3 structurally different variants (judge) | Read Glob Grep Skill | 8 / 180 s |
| `trigger-product-reel-assets` | smoke, trigger | product-reel | a browser capture named: Playwright, headless or `capture.mjs` (regex); screenshots, logo, colors and fonts from the live page into the project, nothing redrawn or guessed, asks for what it cannot capture (judge) | Read Glob Grep Skill | 8 / 180 s |
| `springs-closed-form` | smoke | springs | `Math.exp` + cos/sin (regex); no timer or clock calls in code blocks, comments and prose excluded (regex); exact overdamped branch + superposition (judge) | Read Glob Grep Skill | 8 / 180 s |
| `ui-morph-spec-xml` | smoke | ui-morph-spec | all six XML sections (regex); one shape, cursor, beats, seamless loop, approval gate (judge) | Read Glob Grep Skill | 8 / 240 s |
| `director-brief-sections` | smoke | director-brief | skeleton headings (regex); keys in `.env` (regex); brief quality (judge) | Read Glob Grep Skill | 10 / 480 s (skill runs at effort max) |
| `route-b-remotion-license` | smoke | seek-engine | names a company license (regex); license gate before the switch + handoff (judge) | Read Glob Grep Skill | 8 / 180 s |
| `neg-unrelated` | smoke, negative | none may fire | no motion-studio skill called (`tool_used`, `arm: both`); `@keyframes` answer (regex) | Read Glob Grep Skill | 5 / 120 s |
| `critique-writes-log` | scaffold | critique-loop | Round 2 appended to `docs/review_log.md`: 7 axes, timestamped P0-P2, honest low scores, planted defects named, round 1 untouched (regex + judge); contact sheet read (`tool_used`) | + Write Edit | 25 / 600 s |
| `critic-agent-dispatch` | scaffold | motion-critic agent | review handed to `motion-studio:motion-critic` (`tool_used: Agent` on `subagent_type`); Round 2 with all 7 axes appended to `docs/review_log.md`, round 1 untouched (regex) | + Write Edit Agent | 25 / 900 s |
| `determinism-edit` | scaffold | lint hook + house rules | sparkle added to `film/film.js` with no `Math.random`/clock/timer calls in code and seeded RNG near the effect (regex); pure function of time (judge) | + Write Edit | 30 / 900 s |
| `render-smoke` | render | render path | an MP4 created under `out/9x16/` (a partial range is `clip_0.00-2.00.mp4`; `silent.mp4` is kept for full renders); its `clip_0.00-2.00.json` sidecar says motion-studio rendered 9x16 from 0 to 2 s; path reported | + Write Edit Bash | 30 / 900 s |

`tool_used: Skill` graders (`skill-fired`) are display-only in a two-arm run: the runner excludes them from the score
in both arms so they cannot inflate `Δ`. The negative case's grader sets `arm: both`, so it always counts.

`critic-agent-dispatch/graders/critic-dispatched.md` is a `tool_used: Agent` grader, so it is scored in both arms: the
dispatch is what the case tests. Its `input_match` looks for `motion-critic` (bare or `motion-studio:`-scoped) as the
value of the Agent input's `subagent_type` field, the key named in the tool reference; any key containing `agent` is
accepted in case a trace spells it differently. A general-purpose agent told to "act as the motion-critic" does not
count. In the baseline arm the agent type does not exist, so a dispatch there fails with `Agent type ... not found`;
whether the runner still counts that failed call is unverified. `Agent` needs no `--allow-tools` grant.

## Run it

Run every command from the repo root (the plugin root). Put the target (`.`) before `--tag`, `--allow-tools` and
`--json`: they take lists or optional values and would swallow a target that follows.

### 1. Zero-cost lint (every change, any OS)

```bash
claude plugin eval . --trust-plugin --no-publish --max-cost-usd 0 --scaffold --allow-tools Write Edit \
  --output-dir "$(mktemp -d)/out" --json "$(mktemp -d)/eval-lint.json" 2> eval-lint.err
```

| Signal | Meaning |
|---|---|
| exit 2, JSON `partialReason: "cost_ceiling"`, `costUsd: 0` | success: every case loaded, nothing ran |
| stderr `failed to load` (plus one line per bad case) | a case file does not parse; the exit code is still 2, so grep stderr |
| stderr `cannot pass with the granted tools` | a grader needs a tool the case does not allow |
| exit 1 | no cases found, or a bad option |

`node scripts/eval-lint.mjs` wraps this command and fails on those stderr signals. `claude plugin validate` does not
look at `evals/` at all. Keep `--scaffold --allow-tools Write Edit`: without them the lint warns about every
file-based grader. Point `--output-dir` at a directory that does not exist yet: even a zero-case lint writes
`aggregate-result.json` there, and without it (`--json` alone is not enough) every lint leaves an
`evals/results/<timestamp>/` directory behind.

### 2. Self-test (zero cost; proves the graders mean what they say)

```bash
node evals/_selftest/selftest.mjs                      # authoring rules + every regex/tool_used grader vs samples
node evals/_selftest/selftest.mjs --scaffold           # also runs the scaffolds and grades the workspaces
node evals/_selftest/selftest.mjs --scaffold --render  # also installs and renders render-smoke (Linux/macOS)
```

The self-test enforces the authoring rules below, grades each regex and `tool_used` grader against passing and
failing samples in `evals/_selftest/samples.mjs`, and checks that the contact-sheet fixture matches its generator.
With `--scaffold` it runs each scaffold in a temp dir and confirms that the untouched workspace fails the outcome
graders (no free passes) while a simulated good edit passes them and a bad one fails, cross-checked with the
project's own `tools/lint.mjs`, the shipped gate parser and, where a case relies on a hook, the hooks' own
studio-project detection. Node built-ins only; on Windows it runs the scaffolds with Git Bash, like the runner
(set `EVAL_BASH` to override). `npm run eval:selftest` runs the `--scaffold` form, and CI runs it in the `eval-lint`
job.

### 3. Windows smoke subset (paid)

Native Windows has no Bash sandbox, so a case that grants Bash is refused (score 0, $0.00). Run the answer-only
cases, then the scaffolded ones (their scaffolds run in Git Bash):

```bash
claude plugin eval . --tag smoke --trust-plugin --no-publish --ablation none --runs 1 --max-cost-usd 3
claude plugin eval . --tag scaffold --trust-plugin --no-publish --ablation none --runs 1 --scaffold \
  --allow-tools Write Edit --max-cost-usd 9
```

`--ablation none --runs 1` is for iterating. Confirm a change at the default 3 runs with the baseline arm before
trusting it. Iterate on one case with `--case <name>`.

### 4. Full suite on Linux or macOS (paid; CI)

Linux needs `bubblewrap` and `socat` (`sudo apt-get install -y bubblewrap socat`); on Ubuntu 24.04 and later the
AppArmor user-namespace restriction may need a `bwrap` profile (see the Claude Code sandboxing docs). macOS needs
nothing extra. The `render-smoke` scaffold runs `npm install`, downloads Playwright's headless shell
(`chromium-headless-shell`) into the workspace and pins it in `studio.json`, so the scaffold needs network; the agent's
run does not. There is no fallback to an installed Chrome: the render uses the plugin's default browser everywhere. On
Linux the shell also needs its system libraries (`npx playwright install-deps chromium-headless-shell`; the
`evals.yml` workflow has a step for it).

```bash
# everything except the render case, without a shell grant
claude plugin eval . --tag smoke scaffold --trust-plugin --no-publish --scaffold --allow-tools Write Edit \
  --model <agent-model> --judge-model sonnet --threshold 0.8 --max-cost-usd 30 -j 2 --json results.json
# the render case: Bash, confined by the OS sandbox to the workspace
claude plugin eval . --tag render --trust-plugin --no-publish --scaffold --allow-tools Write Edit Bash \
  --model <agent-model> --judge-model sonnet --threshold 0.8 --max-cost-usd 10 --json results-render.json
```

`.github/workflows/evals.yml` runs the same suite manually or weekly in one invocation, with the shell grant
narrowed to `"Bash(node *)" "Bash(npm *)" "Bash(npx *)"`; with that narrowing the agent cannot run helper commands
such as `ls`, which costs turns but not correctness. Pin `--model` so a model rollout is not mistaken for a plugin
regression, and keep the judge a different model from the agent.

## Cost

A suite makes cases x runs agent runs per arm (x2 with the baseline arm) plus 3 judge calls per `llm` grader per
run. This suite has 12 cases and 9 `llm` graders.

| Scope | Agent runs | Cost |
|---|---|---|
| zero-cost lint, self-test | 0 | $0.00 (measured) |
| Windows smoke subset, `--runs 1 --ablation none` | 8 | about $1-4 [estimate] |
| Windows scaffold subset, `--runs 1 --ablation none` | 3 | about $2-7 [estimate]; `critic-agent-dispatch` also pays for a subagent |
| full suite, 3 runs, two arms | 72 | about $24-55 at Opus-class prices [estimate] |

Measured reference from the research phase (Claude Code 2.1.284, Windows): one scaffolded write-a-file case with a
haiku agent and a haiku judge, 1 run, cost $0.035 in 110 s. Costs are list-price estimates. `--max-cost-usd` stops
new runs once the ceiling is reached (runs in flight still finish). Usage-limit errors mid-suite score 0 and are not
marked `partial`: check `cases[].arms.with[].error` before reading a drop as a regression.

## Read the results

Each paid run writes `evals/results/<timestamp>/aggregate-result.json` and `report.html` (kept local with
`--no-publish`); `evals/results/` belongs in the repo `.gitignore`. Gate CI on `aggregates.casesPassed` and
`aggregates.casesTotal`, leave documents with `partial: true` and runs with `skippedPaidGraders` out of trends, and
read the judge's votes and evidence in the report when an `llm` grader fails.

## Authoring rules

| Rule | Why |
|---|---|
| `prompt.md` frontmatter uses only `schema_version name description tags plugins runs expected_outcome model max_turns timeout_seconds allowed_tools append_system_prompt env` | any other key is a load error |
| single-quote every `pattern` and `input_match` | double-quoted YAML breaks on `\d` and `\s` |
| `runs: 3` or more | one run of an agent says little |
| keep a `negative` case with `tool_used`, `tool: Skill`, `min: 0`, `max: 0`, `arm: both` | proves the skills do not over-trigger |
| every case has an outcome grader besides `tool_used` | grade what the user gets, not only the route |
| budgets: trigger 5-8 turns / 120-180 s; other answers up to 10 / 600 s (sized to the skill effort); scaffold and render 25-40 / 600-900 s | an under-set budget scores 0 in both arms |
| a file grader (`file_exists`, `{ source: file, path }`) needs Write, Edit or Bash in `allowed_tools` | tools follow graders |
| `file_exists` sees only files created during the run | grade scaffolded files by their content |
| Bash only in `render`-tagged cases | native Windows refuses any shell grant |
| leave `AskUserQuestion` out of `allowed_tools` | nobody answers in a headless run; without the tool the skill asks in its reply, where the graders can read it |
| no absolute paths or `~/` in prompts and graders | runs start in a temp workspace |
| scaffolds: `#!/usr/bin/env bash`, `set -euo pipefail`, LF, find the case dir via `${BASH_SOURCE[0]}` | the scaffold env is minimal; `EVAL_*` vars do not reach it |
| give each new regex or `tool_used` grader a passing and a failing sample in `_selftest/samples.mjs` | the self-test enforces it |
| a case that relies on a plugin hook sets `studioProject: true` in its `WORKSPACE_CHECKS` entry | the hooks stay silent outside a studio project (`studio.json` plus `film/`, `tools/` or `index.html`) |
| never store fixtures under a directory named `out/` | the repo `.gitignore` ignores `out/` at any depth; copy them there in the scaffold |

## Fixtures

`critique-writes-log/fixtures/contact.png` comes from `node evals/critique-writes-log/make-contact-sheet.mjs` (Node
zlib only; `--check` compares pixels with a fresh render). It is a 12-still 9:16 contact sheet with four planted
defects the critic must find by looking at it:

| Time | Defect |
|---|---|
| 00:02.00-00:02.50 | centered title on a purple-blue gradient; the second still is washed out |
| 00:03.00 | two words drawn on top of each other |
| 00:03.50 | labels in all four corners plus a frame border (00:05.50 adds a tiny corner URL) |
| 00:04.00-00:05.00 | three identical, nearly empty stills |

`critic-agent-dispatch` copies the same three fixtures (its scaffold reads `../critique-writes-log/fixtures/`, so
there is one sheet and one generator) and adds an empty `film/` dir, so the plugin hooks treat the workspace as a
studio project and the critic's write goes through role-guard's `motion-critic` lane.

`determinism-edit` and `render-smoke` build their workspace with the plugin's own
`skills/studio-init/scripts/init.mjs`, so they always test the template that ships.

## Limits

- A judge sees text or one image per grader, so "found the planted defects" is judged from the log against the known
  defect list, not by comparing the log with the image.
- `render-smoke` has not yet run inside the Linux bubblewrap sandbox; Chromium's needs there (a writable temp dir,
  `/dev/shm`) are the most likely failure point.
- Trace graders do not see tool calls made inside subagents. `critic-agent-dispatch` grades the main session's
  `Agent` call and the file the subagent wrote, never the subagent's own calls.
