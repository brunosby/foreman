// Replays foreman's rules over existing Claude Code transcripts, without running a session:
// how often each guard would deny or ask, which prompts the activation heuristic would point to
// long-task (and whether the session used the skill anyway), and how many turns changed code
// without running a test afterwards, and what multi-step requests cost with and without the plan
// (with strong models a plan is expected to cut cost and turns more than to raise the success rate). Read-only.
//   node foreman.js replay [transcripts-dir] [days]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./foreman.js');

const DAY = 864e5;

function transcripts(dir, days, now = Date.now()) {
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 1) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { if (now - fs.statSync(p).mtimeMs <= days * DAY) out.push(p); } catch (_) { /* gone */ }
      }
    }
  };
  walk(dir, 0);
  return out;
}

// A typed prompt, not a tool result, a command wrapper or a system note.
function promptText(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain || !o.message) return null;
  const c = o.message.content;
  let t = null;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return t && !t.trimStart().startsWith('<') ? t : null;
}

function replay(dir, days = 90) {
  const files = transcripts(dir || path.join(os.homedir(), '.claude', 'projects'), days);
  const r = {
    sessions: files.length, prompts: 0, calls: 0,
    guards: { deny: 0, ask: 0, byMatch: {}, examples: [] },
    activation: { flagged: 0, flaggedThenSkill: 0, notFlaggedSkill: 0, examples: [] },
    cost: { planned: emptyCost(), unplanned: emptyCost() },
    verify: { turnsWithCodeEdits: 0, untested: 0, examples: [] },
  };
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const turns = [];
    let cur = null;
    const seen = new Set();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch (_) { continue; }
      const p = promptText(o);
      if (p !== null) {
        cur = { prompt: p, calls: [], cwd: o.cwd || '', replies: 0, tokens: 0 };
        turns.push(cur);
        r.prompts++;
        continue;
      }
      if (o.type !== 'assistant' || o.isSidechain || !cur || !o.message || !Array.isArray(o.message.content)) continue;
      // One reply is written as several lines, one per content block, each with the same id and usage.
      if (!o.message.id || !seen.has(o.message.id)) {
        if (o.message.id) seen.add(o.message.id);
        cur.replies++;
        cur.tokens += usageTokens(o.message.usage);
      }
      for (const b of o.message.content) if (b && b.type === 'tool_use') cur.calls.push({ name: b.name, input: b.input || {} });
    }
    const cfg = F.config(null); // the user settings, so the replay counts what the hooks would do for this user
    for (const t of turns) {
      r.calls += t.calls.length;
      for (const c of t.calls) {
        const d = F.preToolDecision(c.name, c.input, cfg);
        if (!d) continue;
        r.guards[d.permissionDecision]++;
        const m = (/\(([^)]+)\)\. Confirm/.exec(d.permissionDecisionReason) || [null, 'secret file'])[1];
        r.guards.byMatch[m] = (r.guards.byMatch[m] || 0) + 1;
        if (r.guards.examples.length < 6) r.guards.examples.push(`${d.permissionDecision}: ${String(c.input.command || c.input.file_path || '').slice(0, 90)}`);
      }
      const usedSkill = t.calls.some((c) => c.name === 'Skill' && /long-task/.test(String(c.input.skill || '')));
      if (F.isLargeTask(t.prompt)) {
        r.activation.flagged++;
        if (usedSkill) r.activation.flaggedThenSkill++;
        const k = r.cost[usedSkill ? 'planned' : 'unplanned'];
        k.turns++; k.replies += t.replies; k.tokens += t.tokens;
        if (r.activation.examples.length < 8) r.activation.examples.push(t.prompt.replace(/\s+/g, ' ').slice(0, 90));
      } else if (usedSkill) r.activation.notFlaggedSkill++;
      if (t.calls.some((c) => ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(c.name) && F.isCodeFile(c.input.file_path || c.input.notebook_path))) {
        r.verify.turnsWithCodeEdits++;
        const files = F.unverifiedChanges(t.calls, t.cwd && F.projectRoot(t.cwd));
        if (files && (!t.cwd || !fs.existsSync(t.cwd) || F.testCommand(F.projectRoot(t.cwd)))) {
          r.verify.untested++;
          if (r.verify.examples.length < 5) r.verify.examples.push(`${files.slice(0, 3).join(', ')} after "${t.prompt.replace(/\s+/g, ' ').slice(0, 60)}"`);
        }
      }
    }
  }
  return r;
}

function emptyCost() { return { turns: 0, replies: 0, tokens: 0 }; }

// Tokens billed for one reply, with cache reads weighted at a tenth of an input token, as they are priced.
function usageTokens(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + Math.round((u.cache_read_input_tokens || 0) / 10) + (u.output_tokens || 0);
}

function costLine(name, k) {
  if (!k.turns) return `  ${name}: none`;
  return `  ${name}: ${k.turns} requests, ${Math.round(k.replies / k.turns)} replies and ${Math.round(k.tokens / k.turns).toLocaleString('en-US')} weighted tokens per request`;
}

function render(r) {
  const top = Object.entries(r.guards.byMatch).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    `Replay of ${r.sessions} transcripts, ${r.prompts} prompts, ${r.calls} tool calls.`,
    `guards: deny ${r.guards.deny}, ask ${r.guards.ask}.${top ? ` By match: ${top}.` : ''}`,
    ...r.guards.examples.map((e) => `  e.g. ${e}`),
    `activation: ${r.activation.flagged} prompts would get the long-task hint (${r.activation.flaggedThenSkill} used the skill anyway); ${r.activation.notFlaggedSkill} used it without being flagged.`,
    ...r.activation.examples.map((e) => `  e.g. ${e}`),
    'cost of multi-step requests (whole turn, main session only):',
    costLine('with long-task', r.cost.planned),
    costLine('without', r.cost.unplanned),
    `verify: ${r.verify.turnsWithCodeEdits} turns changed code; ${r.verify.untested} of them ran no test after the last change and would get one reminder.`,
    ...r.verify.examples.map((e) => `  e.g. ${e}`),
  ].join('\n');
}

module.exports = { replay, render, transcripts, usageTokens };
