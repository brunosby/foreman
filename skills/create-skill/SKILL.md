---
name: create-skill
description: Turn an explanation the user keeps repeating (a publishing routine, a review checklist, a report format) into a new skill, tested on a real case. Run only when the user asks.
disable-model-invocation: true
argument-hint: "[what the skill should do]"
---
Always communicate with the user in the language they are using. Write the skill itself in English.

The user wants a skill for: $ARGUMENTS

1. Ask for what you do not have: when it should be used, the steps, and one real example of input and expected output. If the user already explained it in this conversation, reuse that.
2. Before writing anything, run the real example without a skill: do the task as you would now and compare with the expected output. Note what went wrong or was missing. If nothing did, tell the user the skill may not be needed. What went wrong is what the skill must prevent.
3. Pick the scope with the user: this project (`.claude/skills/<name>/SKILL.md`) or every project (`~/.claude/skills/<name>/SKILL.md`).
4. Draft the file:
   - `name`: short, lowercase, hyphens.
   - `description`: one sentence on when to use it. This is all Claude sees until the skill is needed, so name the situation, not the topic.
   - `disable-model-invocation: true` if it has side effects or the user wants to decide when it runs.
   - Instructions: numbered steps, concrete and checkable, aimed at what went wrong in step 2. Keep it under about 60 lines; move long reference material to a separate file next to SKILL.md.
5. Show the draft and write it only after the user approves.
6. Test it on the same real example. Show the result next to the one from step 2, fix the skill where it still goes wrong, and say what you changed.
