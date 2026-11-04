# foreman

A Claude Code plugin for **how Claude works**: a plan-first flow for long tasks, written completion criteria, and hooks that point multi-step requests to that flow, hold their code edits until there is a plan, ask for a test run before work is called done, check that answers about the project and research rest on files read and pages found, flag CLAUDE.md lines that name what no longer exists, and guard secret files, risky commands and unfinished goals.

It adds text to the context only when a trigger fires: a short statement when a prompt looks like multi-step work or is a question about the project or a research request, one line with the current step of PROGRESS.md every 20 tool calls during a task, three lines of working rules when a subagent starts, and a Stop reminder when code changed without a test run, an answer skipped the files or cited an unseen link, or CLAUDE.md names a missing command or path. Skills load only when used; the hooks run as code and never call a model. It keeps no memory between sessions and does not touch tool output.

## Components

| Component | Kind | Runs | What it does |
|---|---|---|---|
| `long-task` | skill | when Claude sees it fits | Explore, write the plan and show its stages (no waiting for approval; it stops only for a choice with no sensible default), implement in small checked stages, verify, review the diff with `/code-review`, propose a commit. Keeps `PLAN.md` and `PROGRESS.md` for the current task only. |
| `create-skill`, `loop-design` | skills | only when you call them | See [Manual skills](#manual-skills). |
| `completion-criteria` | skill | when Claude sees it fits | Writes `GOAL.md` before the work starts: required evidence, stop conditions, and a final `Status:` line. |
| `claude-md` | skill | when Claude sees it fits | Adds or fixes one line in `CLAUDE.md`, `CLAUDE.local.md` or `.claude/rules/` (or `AGENTS.md` when it is the only one) for a rule that must hold in every session, or for a command or path there that no longer exists. Edits by delta, never rewrites the file, keeps it under 200 lines, leaves out what the code already shows and task decisions. Shows the diff and applies it; with `"claudeMd": "ask"` it waits. For a full audit it points to `/doctor prompt-audit`. |
| grounding statement | UserPromptSubmit hook | when the prompt is a question about the project or a research request | Rules on the text, no model call. A question in a project folder (`.git`, `package.json`, `pyproject.toml`…) that names no other subject, or that names this project, a `span`, a path or a file, is about the project; a conceptual question ("what is a reducer?") or one about Claude Code itself is not. "Pesquise/procure/search/look up", sources, papers, "latest version", "still supported" or a price make it research, unless it says "in the code". Adds a statement: answers about the code come from files read for this answer (a file read earlier may have changed), research answers cite only pages that a search or fetch returned. `node scripts/foreman.js ask "<prompt>"` shows the class. |
| grounding check | Stop hook | after such a question, or any turn that searched the web | Asks once for a corrected answer when the project answer read no file of the project in the whole session, or read none in this turn while a file it read before has changed since; when the answer names a path (folder plus extension) that does not exist; or when it cites a link that no search or fetch result of the session contains. |
| stale CLAUDE.md | Stop hook | after a turn that edited `package.json` or a build config, or moved or removed files | Checks the `` `spans` `` of the instruction files: `npm/pnpm/yarn/bun run X` must be a script in `package.json`, a path must exist. Names what is stale once per request and points to the `claude-md` skill. `node scripts/foreman.js stale` runs the check. |
| secret files | PreToolUse hook | always | Reading is what puts a secret into the context (and from there into the API, the transcript and subagents); writing is not. Denies Read/Grep/Glob and shell commands that name `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials.json`, `secrets.yaml`, `.netrc`, `.npmrc` and similar. Templates such as `.env.example` and public keys pass. For an env-style file, the denial lists the variable names it defines (never the values), so code can be pointed at the right name. A recursive search (`grep -r`, `ag`, `rg --hidden`/`-uu`) over a folder that holds such a file is denied unless it excludes the file (`--exclude=.env`). The Grep tool searches hidden files, so a Grep over a folder that holds such a file is denied too, unless git ignores the file or the Grep's `glob` or `type` leaves it out (`!.env`, `type: js`). A wildcard that would match such a file in the folder (`cat .e*`, `type .en?`) counts as naming it. A negated `glob` with a folder (`!node_modules/**`) leaves out only that folder, so the file next to it still counts (in a measured session this exact Grep returned the values of `.env` before 0.9.0). Commands that use the file only as a path, without printing its contents, pass: `ls`, `test -f`, `stat`, `Test-Path`, `git check-ignore`, `git ls-files`, `git status`, and, unless `"secrets": "block"`, `git rm --cached`, `rm`, `chmod`, `touch` and the target of `>`/`>>`. Copy, move and `xargs` stay denied, since a copy under another name could then be read. Writing such a file (Write, Edit, `echo KEY= >> .env`) is allowed; `"secrets": "block"` denies it too. A git command that would put such a file into the repository is denied: `git add` of the file or of a folder or `-A`/`.`/`-u` that holds it unless git ignores it (`-f` always), and `git commit` while it is staged (or with `-a` while it is tracked and changed); the denial says to add it to `.gitignore`. If the check itself fails, the call is denied, not let through (the hook is set with `onFailure: "block"`, Claude Code 2.1.295 or later). |
| risky commands | PreToolUse hook | always | Asks before shell commands that delete data (`rm -r`, `git clean -f`, `git checkout -- <path>`, `git restore <path>`, `git switch --discard-changes`, `DROP TABLE`), change repository history (`git push --force`, `reset --hard`, `rebase`, `commit --amend`) or reach an external destination (`git push`, `curl -d`, `ssh`, `npm publish`, `gh pr create`). A delete whose every target is inside a folder the build or tests regenerate (`dist`, `build`, `coverage`, `logs`, `out`, `.next`, `.cache`…; setting `generatedDirs`), or that is a log or temp file (`*.log`, `*.tmp`), does not ask. |
| long-task hint | UserPromptSubmit hook | when the prompt looks like multi-step work | A heuristic on the text (action verb, scope words, a list of requirements, length; questions and small fixes count against) adds a statement: the score, the foreman skills, and that in this project such a request is answered first with one YES/NO line per skill and the Skill call for each YES. From score 7 (a list of requirements plus scope words, or a long spec) it states that the task starts with long-task. A request that asks for done, completion or acceptance criteria by name ("critérios de conclusão", "definition of done") gets a statement that they are written by the completion-criteria skill: in measured sessions such a request was answered without the skill 2 of 2 times. `node scripts/foreman.js task "<prompt>"` shows the score. |
| test before done | Stop hook | when code changed | If the turn edited code files (with the edit tools or through the shell: `sed -i`, `> file`, `tee`, `cp`/`mv` onto a file) and no test or lint command ran after the last edit, asks once to run the project's tests and report the command and result. In a project whose only check is `npm run build`, the build counts as the check. The limit counts per request, not per session. Turns that only touched docs or only edited comments, and projects with no test setup, are exempt. Every Stop reminder also asks that the last message still gives the result of the request: measured, the reminder's follow-up became the last message and the task summary was left above it. `test` inside `echo` or a commit message does not count as a run. |
| plan gate | PreToolUse hook | **off by default** (`"planGate": true`); after a prompt that scored as clearly multi-step (7 or more) | In the measured sessions the decision step alone already planned 10/10 and the gate added 15% to the cost (US$ 0.228 vs 0.199) with no gain, so it starts off. Denies code edits (edit tools and shell edits into code files) until `PLAN.md` is written after the request or the session used plan mode, and says what is missing. `PLAN.md`, `GOAL.md` and `PROGRESS.md` are never held. Edits sent in one model response count as one hold; after `planGateHolds` (2) held responses the gate lets go. A prompt that says to skip the plan ("sem plano", "skip the plan") is not gated. A medium request (score 4 to 6) gets nothing by default, and with `"hintMedium": true` only the hint, which also says that a request that already lists its steps is usually done directly: in a measured session such a request stopped for plan approval and cost 35% more than doing it directly, with the same result. `"planGate": false` turns it off. |
| plan reminder | PreToolUse hook | every 20 tool calls while `PROGRESS.md` is current | One line with the current step of `PROGRESS.md` (the first open `- [ ]` item, else a "next"/"left" line). Stops when `GOAL.md` has a final status. `planReminderEvery: 0` turns it off. |
| after /compact | SessionStart hook | after compacting | Puts the current `GOAL.md`, `PLAN.md` and `PROGRESS.md` back, each capped. When the session used plan mode, `PLAN.md` is left out, since Claude Code already puts the plan-mode plan back after compacting. |
| subagent rules | SubagentStart hook | every subagent | Three lines: secret files cannot be read and are never committed, run the tests before reporting code changes, no destructive or outbound commands. |
| open goal | Stop hook | in the session that wrote `GOAL.md` | If `GOAL.md` has no final `Status:` line, asks Claude to check the evidence and write one: `completed`, `blocked - <what is needed>` or `budget exhausted`. At most 3 reminders per session and task, then it tells you and lets go. |

The hooks never return `allow`: when they have nothing to say, the normal permission flow decides. Both Stop reminders go in one message and share the `continuationLimit`.

## Install

```text
/plugin marketplace add brunosby/foreman
/plugin install foreman@foreman
```

If the short form fails because you have no GitHub SSH key, use the HTTPS URL: `/plugin marketplace add https://github.com/brunosby/foreman.git`.

To try a local clone instead, pass its folder: `/plugin marketplace add ./foreman`.

Restart the session. Requires Node.js 16+ on the PATH.

## Settings

`.claude/foreman.json` in the repo, or `~/.claude/foreman/config.json` for every project:

```json
{
  "secrets": true,
  "secretPatterns": ["*.p8"],
  "secretAllow": [".env.test"],
  "secretNames": true,
  "risky": { "delete": true, "history": true, "external": true },
  "riskyPatterns": ["terraform\\s+apply"],
  "generatedDirs": ["dist", "build", "coverage", "logs"],
  "continuationLimit": 3,
  "goalMaxAgeHours": 12,
  "activation": "detect",
  "verify": true,
  "headless": false,
  "subagent": true,
  "compact": true,
  "planGate": false,
  "planGateHolds": 2,
  "planReminderEvery": 20,
  "grounding": true,
  "researchDomains": ["docs.example.org"],
  "claudeMd": true,
  "shadow": []
}
```

- `secrets`: `true` (default) blocks reading secret files and putting them into git, and allows writing them; `"block"` also denies writing; `false` turns the rule off.
- `secretNames`: `true` (default) adds the variable names of a blocked env-style file (`.env*`, `*.env`, `*.ini`, `*.properties`, `*.toml`) to the denial. `false` keeps the denial silent about the content.
- `activation`: `detect` (default) adds the long-task hint to prompts that look like clearly multi-step work (score 7 or more; with `"hintMedium": true` also to medium ones, 4 to 6, at the cost of a plan step on requests that already list their steps); `always` instead reminds Claude of the skills once at session start; `off` does neither.
- `headless`: for `claude -p` and other runs with nobody to answer. Risky commands are denied with the reason and an alternative instead of asked. `FOREMAN_HEADLESS=1` does the same. The hook payload does not say reliably whether a run is headless, so this is never guessed.
- `planGate`: `true` turns the plan gate on (off by default). `planGateHolds` is how many model responses get their code edits held before the gate lets go.
- `planReminderEvery`: `0` turns the plan reminder off.
- `grounding`: `true` (default) adds the statement and the Stop check; `"hint"` only the statement; `false` neither. `researchDomains` adds preferred sites to the research statement.
- `claudeMd`: `true` (default) runs the stale CLAUDE.md check and lets the `claude-md` skill apply its one-line edit; `"ask"` makes the skill wait for agreement; `false` turns the check off.
- `shadow`: rules listed here (`activation`, `verify`, `secrets`, `risky`, `goal`, `plan`, `grounding`, `claudemd`) only record in `~/.claude/foreman/shadow.jsonl` what they would have done.

`node scripts/foreman.js replay [~/.claude/projects] [days]` runs the guards, the long-task heuristic and the test-before-done check over your existing transcripts, without a session, and counts how often each would act. It also shows what multi-step requests cost per request (replies and tokens, cache reads weighted at a tenth), with and without long-task: with strong models a plan is expected to lower cost and turns more than to raise the success rate, so that is the number to watch, not only whether a plan was made.

`continuationLimit: 0` turns the Stop hook off. A `GOAL.md` not modified for `goalMaxAgeHours` is treated as left over from an earlier task and ignored.

Check what the hooks would do: `node scripts/foreman.js check "git push --force"`, `node scripts/foreman.js path .env.local`, `node scripts/foreman.js config`.

## Without the plugin: plan mode

Claude Code can do the planning part on its own. Start a large request with `/plan`, or set `"defaultMode": "plan"` in the project's `.claude/settings.json`: plan mode blocks edits until you approve the plan, and the approved plan is put back after compacting. The plan gate counts plan mode as a plan.

## Checking that the skills are seen and used

- Free: run `/context`, or start `claude --debug`, in a normal session and check that long-task appears with its description and not only its name. When the skill list goes over its budget (1% of the context window), the descriptions of the least used skills are dropped first.
- Free: `claude plugin details foreman` shows the fixed tokens the plugin adds, before and after a description change.
- Free, over time: `/skill-doctor` shows which skills were used.

## Manual skills

Two skills run only when you call them; Claude does not see them in its skill list and the decision step does not weigh them:

- `/foreman:create-skill <what it should do>`: turns an explanation you keep repeating into a skill, tested on a real case before and after.
- `/foreman:loop-design`: designs a bounded recurring automation (issue triage, a CI monitor) for your approval before anything is built or scheduled.

## Secrets: pair the hook with Claude Code's deny rules

Claude Code's own permission rules block secret files in its file tools, and they are the first layer to set up. In the project's `.claude/settings.json`:

```json
{ "permissions": { "deny": ["Read(./.env)", "Read(./.env.*)", "Read(./**/*.pem)", "Read(./**/*.key)"] } }
```

In measured sessions (Claude Code 2.1.309, plugin off) these rules denied the Read of `.env` and kept it out of a Grep over the project root with `glob: "!node_modules/**"`, but `grep -r … .` in the shell still printed its lines. The hook covers that part: shell reads and recursive searches, and git commands that would commit the file. It also checks the file tools, for projects where the deny rules are not set.

## Left to Claude Code

Earlier versions shipped more. These were removed because Claude Code does the same natively:

- `init-project` skill: use `/init`.
- `reviewer` subagent: use `/code-review` (the long-task skill now calls it).

## Limits

- The guard hooks read the command text. A script that opens files or the network by itself (`python tool.py`, `node -e "...readFileSync('.env')"`) passes, and so do `env`/`printenv` once the variables are loaded. For that boundary use the Claude Code sandbox.
- In the default permission mode Claude Code already asks before any shell command outside your allow list, so the risky-command `ask` matters mostly with a broad allow list or in auto mode. A hook's `ask` forces a prompt even in auto mode, which already has its own classifier. In a `claude -p` run with nobody to answer, an `ask` becomes a denial without an alternative; set `headless` for those runs. Turn off the categories you do not need.
- A hook cannot call a skill or rewrite the prompt; it can only add text or block. The decision step makes the model commit to a choice, which worked far better than a plain hint (see below), but the call is still the model's; the plan gate is what holds every time.
- Text added by a hook is written as a statement about the request and the project, not as an order: per the hooks documentation, orders injected out of band can be taken for prompt injection and shown to the user instead of used. Whether this explains the sessions where the hint was ignored is a hypothesis, not a measurement.
- The plan gate sees the edit tools and shell edits into code files (`sed -i`, `> file`, `tee`, `cp`/`mv`). Code written by a script Claude creates and then runs goes past it. A request flagged by mistake costs up to `planGateHolds` denied responses unless the user says to skip the plan.
- The long-task hint is a text heuristic: it can miss a large request written in a few words, and flag a long message that is not a task. The replay shows how it behaves on your own prompts.
- Copying a template onto `.env` (`cp .env.example .env`) is denied too, because the command names `.env`. Run it yourself.
- The grounding check proves that a file was read or that a link came from a result, not that the answer is right: a page that exists can still say something else, and a file read in the turn can still be misread. It checks the cheap, common failure (no reading, a stale read, an invented path or link), nothing more.
- The question classes are text rules and favour precision: a project question written as a statement ("explain the timer") gets no statement. In a measured session without the plugin (Haiku), Claude read the code first for 3 of 6 project questions (the misses named no subject and were taken as about Claude Code), re-read a changed file 0 of 2 times, and cited a link outside its search results in 2 of 4 research answers; it always searched when asked to.
- The stale CLAUDE.md check sees only commands and paths written inside backticks. A rule stated only in the conversation is not captured: in the same measured session such rules held across `/compact` 2 of 2 times, so no capture was added.
- Claude Code itself ends a turn after 8 consecutive Stop-hook continuations; the 3-reminder limit here stays below that on purpose.

## Measured: making the long-task skill actually run

In `claude -p` sessions (Sonnet 5.5, a generated Python repository, 5 multi-step requests run twice each, up to 10 turns):

| Approach | long-task called | Planned before writing code | Mean cost |
| --- | --- | --- | --- |
| Hint only ("load the long-task skill") | 6/10 | 6/10 | US$ 0.185 |
| The skill's steps injected into context | 0/10 | 0/10 | US$ 0.229 |
| Plan gate (below) | 7/10 | 8/10 | US$ 0.200 |
| YES/NO decision step (current) | 10/10 | 10/10 | US$ 0.199 |
| Decision step + plan gate | 10/10 | 10/10 | US$ 0.228 |

The heuristic flagged all 5 multi-step requests and none of 5 small ones. With the decision step the gate never had to act.

### Plan gate: notes from the earlier test

The gate above follows these notes from the earlier sessions: holds are counted per model response, not per tool call (three writes in one response once got the third through); the denial does not offer a way around it (one that did was used as one); there is a cap on holds; the plan files are never held. In those sessions the gate added nothing on top of the decision step and raised the mean cost (US$ 0.228 against 0.199), so turn it off with `"planGate": false` if it only adds denials in your work.

## Tests

```bash
node --test test/*.test.js
```

All 68 unit tests pass on 0.9.0 (run on 2026-11-04), including a negated Grep glob that names a folder, commands that use a secret file only as a path, comment-only edits, denied calls in the Stop checks, the plan gate, the plan reminder and the compact skip of PLAN.md. They cover question classes on a held-out list of 32 prompts, the grounding and stale CLAUDE.md checks on synthetic transcripts, secret names, variable names of a blocked env file, risky categories including commands that discard uncommitted edits, quoted text, settings, Stop counter per session and task, long-task heuristic, test-before-done check, headless mode, shadow mode, subagent rules, replay, package structure. Checked in real `claude -p` sessions (Claude Code 2.1.310): reading `.env` was denied, `rm -rf src` was stopped even with `Bash(rm:*)` allowed, and an open `GOAL.md` led Claude to record its evidence and add `Status: completed` before finishing.
