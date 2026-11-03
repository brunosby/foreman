---
name: long-task
description: Use for work that takes several steps or touches several files - a feature, a refactor, a migration, a list of requirements - so it starts from a written plan: explore, plan, implement in small verified stages, review, propose a commit, keeping PLAN.md and PROGRESS.md for the task. Not for quick edits, a single-file fix or questions.
when_to_use: The user asks to implement, build, refactor, migrate or rewrite something larger than one change, or gives a list of requirements. Phrases like "implementar uma funcionalidade", "criar o módulo", "refatorar", "migrar para", "lista de requisitos", "implement this feature", "refactor the", "migrate to", "here are the requirements". Also when picking up a task that has a PLAN.md or PROGRESS.md.
---
Always communicate with the user in the language they are using.

1. **Explore.** Read how the affected part works. Change nothing yet.
2. **Completion criteria.** If there is no `GOAL.md` for this task, use the completion-criteria skill first.
3. **Plan.** Write `PLAN.md`: the task in one line, then small stages, each with what changes and how it is checked. If the session is already in plan mode, write it after leaving plan mode.
4. **Check the plan and go on.** Check PLAN.md against the request and GOAL.md (anything missing, edge cases, how each stage is checked), show the user the stages in a few lines, and start implementing without waiting for approval. A choice with a sensible default is taken and named in that summary; stop and ask only for a choice that has no sensible default and would be costly to undo.
5. **Implement** one stage at a time. After each stage, run its check and update `PROGRESS.md`: done, checks that passed, what is left. If a new conversation picks the task up, PROGRESS.md is where it resumes.
6. **Verify.** Run the full test command and show the command and its result, including tests that existed before the task (regressions). "It should work" is not verification.
7. **Review the result.** Before proposing a commit, run `/code-review` on the diff once (if it is not available, review the diff yourself for unmet requirements, edge cases, missing tests and side effects). Fix what it finds that matters, run the tests again, and do not review again: extra fix-and-review rounds tend to break more than they fix.
8. **Close.** Update GOAL.md with its final Status line. Propose a commit message and wait for the user's go-ahead: never commit or push without it.
9. **Clean up.** PLAN.md and PROGRESS.md belong to this task only. Ask the user whether to delete them or keep them out of the commit.

Stop and ask the user when a stage fails twice for the same reason, when the plan turns out wrong, or when you need access or information you do not have.
