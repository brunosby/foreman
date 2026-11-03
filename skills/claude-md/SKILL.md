---
name: claude-md
description: Adds or fixes one line in CLAUDE.md, CLAUDE.local.md or .claude/rules/ when the user states a rule that must hold in every session ("from now on", "always", "never", "a partir de agora", "sempre", "nunca", "lembre disso no projeto") or when a command or path named there no longer exists. Not for task notes, decisions or a full rewrite of the file.
---
Always communicate with the user in the language they are using. Write the line in the language the file already uses.

CLAUDE.md is read at the start of every session and again after /compact, so each line costs context in every session and a wrong line misleads every session. Change as little as possible.

1. Find the file. Use the first that fits:
   - a rule for this project that the whole team should follow: `CLAUDE.md` at the project root (or `.claude/CLAUDE.md` if that is the one that exists);
   - a rule only for this user on this machine (their paths, their preferences): `CLAUDE.local.md`, and make sure it is in `.gitignore`;
   - a rule that applies only to some files, or a CLAUDE.md already near 200 lines: a file in `.claude/rules/` with a `paths:` list in its frontmatter;
   - only `AGENTS.md` exists: edit `AGENTS.md`.
2. Decide if the line belongs there. Write it only if it is all of these:
   - true in every future session, not only for the current task;
   - not something Claude can see by reading the code (the folder layout, the framework, what a function does);
   - specific and checkable ("run `npm run test:unit` before committing", not "write good tests").
   Leave out decisions about the current task, history, and anything secret. If it does not belong, say so in one line and stop.
3. Edit by delta. Read the file, then change only the line that is wrong or add one line under the section it fits. Never reorder, reformat or rewrite the rest. If a line already says the same thing, change that line instead of adding a second one.
   - For a stale command or path: check what exists now (the `scripts` in package.json, the file on disk) and replace only that command or path. If nothing replaces it, delete the line.
4. Keep the file under 200 lines. If the edit would pass that, move a block that applies only to some files into `.claude/rules/` and leave nothing else changed.
5. Show the change as a short diff (the old line and the new line) and apply it without waiting, so the work goes on. If `.claude/foreman.json` sets `"claudeMd": "ask"`, show the diff and wait for the user to agree first.

For a full review of every instruction file, suggest the user runs `/doctor prompt-audit` instead of rewriting the file here.
