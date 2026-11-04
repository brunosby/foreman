---
name: completion-criteria
description: Before starting a task that needs proof it is done (a bug fix, a feature, a migration, an unattended run), write GOAL.md with the required evidence and the stop conditions. Use when the user asks for done, completion or acceptance criteria ("critérios de conclusão", "definição de pronto", "definition of done") before the work, or when the long-task skill needs them. Not for questions or edits that a single test run proves.
---
Always communicate with the user in the language they are using. Write GOAL.md in English.

A task is finished when its evidence is recorded, not when it feels done. Write the criteria before the work starts, while they are still neutral.

1. Ask the user, or work out from the request, what would prove the task is done. Each item must be observable: a command and its result, a file that exists, a test that passes, a report.
   Always include the regression check: the project's full test command, run after the last change. Its evidence is the command and its result (exit code or summary line), not a list of what you believe still works.
2. Write `GOAL.md` at the project root from the template. Adapt the evidence to the task; keep the stop conditions.
3. Show it to the user in a few lines and start; adjust it if they correct it.
4. While working, record each piece of evidence under the item it proves: the command, its exit code or result, the file path.
5. When stopping, add exactly one Status line: `Status: completed`, `Status: blocked - <what you need from the user>`, or `Status: budget exhausted`. Each one calls for a different next step, so pick the true one.

```markdown
Task: <one line>

Required evidence:
- A reproduction of the original problem (or the starting state).
- A focused change covering the reported case.
- Verification results after the change.
- Regression check: the full test command, run after the last change, with its exit code or summary line.
- A final report listing changed files and open issues.

Stop conditions:
- Requirements met, with recorded evidence.
- A blocker that needs information or access from the user.
- The configured attempt or spending limit is reached.
```

If the plugin's Stop hook reminds you that GOAL.md has no final status, check the evidence and write the Status line. Do not start new work just to satisfy the reminder. For a quick condition in the current session only, the built-in `/goal` command is an alternative; its evaluator reads the conversation, so keep test results and output paths in the transcript.

If `.claude/foreman.json` sets `"taskDir"` (a folder relative to the project root), GOAL.md, PLAN.md and PROGRESS.md go in that folder instead of the root.
