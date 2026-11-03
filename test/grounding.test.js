'use strict';
// node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'foreman.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ground-'));
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.FOREMAN_HOME = HOME;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({}));
delete process.env.FOREMAN_NOW;
delete process.env.FOREMAN_HEADLESS;
const c = require(SCRIPT);
const CFG = c.config(null);

let n = 0;
function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

// A transcript with timestamps. Each entry: ['prompt', text] | ['tool', name, input, result] | ['say', text].
function transcript(dir, entries, t0 = Date.now() - 60000) {
  const file = path.join(dir, `t${n++}.jsonl`);
  let t = t0;
  const ts = () => new Date((t += 1000)).toISOString();
  const lines = [];
  entries.forEach((e, i) => {
    if (e[0] === 'prompt') lines.push({ type: 'user', timestamp: ts(), message: { content: e[1] } });
    if (e[0] === 'tool') {
      lines.push({ type: 'assistant', timestamp: ts(), message: { content: [{ type: 'tool_use', id: `u${i}`, name: e[1], input: e[2] }] } });
      lines.push({ type: 'user', timestamp: ts(), message: { content: [{ type: 'tool_result', tool_use_id: `u${i}`, content: e[3] || 'ok' }] } });
    }
    if (e[0] === 'say') lines.push({ type: 'assistant', timestamp: ts(), message: { content: [{ type: 'text', text: e[1] }] } });
  });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function stopFor(dir, prompt, entries, answer, session) {
  const state = { question: { cls: c.questionClass(prompt, dir), prompt: c.hashText ? c.hashText(prompt) : undefined } };
  return { input: { session_id: session, cwd: dir, transcript_path: transcript(dir, [['prompt', prompt], ...entries, ['say', answer]]), last_assistant_message: answer, stop_hook_active: false }, state };
}

const hook = (kind, input) => {
  const out = execFileSync('node', [SCRIPT, 'hook', kind], { input: JSON.stringify(input), encoding: 'utf8', env: process.env });
  return out ? JSON.parse(out) : null;
};

test('held-out prompts: project questions, research requests and quiet prompts are told apart', () => {
  const q = require('./fixtures/questions.json');
  const dir = repo({ 'package.json': '{}' });
  const expect = { project: 'project', research: 'research', quiet: null, pesquise_no_codigo: 'project' };
  for (const [k, list] of Object.entries(q)) for (const p of list) assert.strictEqual(c.questionClass(p, dir), expect[k], `${k}: ${p}`);
});

test('outside a project folder, a question that names no project is left alone', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'plain-'));
  assert.strictEqual(c.questionClass('how does the timer end the cycle?', dir), null);
  assert.strictEqual(c.questionClass('o que faz o taskReducer.ts?', dir), 'project');
  assert.strictEqual(c.questionClass('look up the latest stable version of Node.js', dir), 'research');
});

test('the prompt hook states the fact and remembers the question; a task gets no statement', () => {
  const dir = repo({ 'package.json': '{}' });
  const out = hook('prompt', { session_id: 'g-prompt', cwd: dir, prompt: 'como o timer termina quando o ciclo acaba?' });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /question about the project/);
  assert.match(ctx, /read again/);
  const state = JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'g-prompt.json'), 'utf8'));
  assert.strictEqual(state.question.cls, 'project');
  const r = hook('prompt', { session_id: 'g-prompt', cwd: dir, prompt: 'pesquise as boas práticas de hooks no Claude Code' });
  assert.match(r.hookSpecificOutput.additionalContext, /research request/);
  assert.strictEqual(hook('prompt', { session_id: 'g-prompt', cwd: dir, prompt: 'obrigado, ficou ótimo' }), null);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'g-prompt.json'), 'utf8')).question, undefined);
});

test('a project answer written without reading any file is sent back once', () => {
  const dir = repo({ 'src/timer.ts': 'export {}' });
  const { input, state } = stopFor(dir, 'como o timer termina quando o ciclo acaba?', [], 'O timer para em zero e toca o beep.', 'g-noread');
  const r = c.groundingReason(input, dir, CFG, state);
  assert.match(r, /without reading any of its files/);
  assert.strictEqual(c.groundingReason(input, dir, CFG, state), null, 'only once per prompt');
  assert.strictEqual(c.groundingReason({ ...input, stop_hook_active: true }, dir, CFG, state), null);
});

test('an answer that reads the file in the turn passes; one that relies on a read made before the file changed does not', () => {
  const dir = repo({ 'src/timer.ts': 'export const end = 0;' });
  const file = path.join(dir, 'src', 'timer.ts');
  const ok = stopFor(dir, 'como o timer termina?', [['tool', 'Read', { file_path: file }, 'export const end = 0;']], 'Em `src/timer.ts:1` o fim é 0.', 'g-read');
  assert.strictEqual(c.groundingReason(ok.input, dir, CFG, ok.state), null);
  // Earlier turn read the file; then it changed; this turn answers from memory.
  const t0 = Date.now() - 120000;
  const tp = transcript(dir, [['prompt', 'leia o timer'], ['tool', 'Read', { file_path: file }, 'old'], ['say', 'lido'],
    ['prompt', 'como o timer termina?'], ['say', 'Termina em 0.']], t0);
  fs.utimesSync(file, new Date(), new Date());
  const r = c.groundingReason({ session_id: 'g-stale', transcript_path: tp, last_assistant_message: 'Termina em 0.' }, dir, CFG,
    { question: { cls: 'project', prompt: c.hashText('como o timer termina?') } });
  assert.match(r, /timer\.ts changed after it was last read/);
});

test('a path the answer names that does not exist is reported; one that exists is not', () => {
  const dir = repo({ 'src/timer.ts': 'x' });
  const file = path.join(dir, 'src', 'timer.ts');
  const bad = stopFor(dir, 'onde fica o timer?', [['tool', 'Read', { file_path: file }, 'x']], 'Fica em `src/timer.ts` e em `src/hooks/useBeep.ts`.', 'g-path');
  const r = c.groundingReason(bad.input, dir, CFG, bad.state);
  assert.match(r, /src\/hooks\/useBeep\.ts does not exist/);
  assert.doesNotMatch(r, /src\/timer\.ts/);
});

test('research: a link in no search or fetch result is reported; a link that was returned passes', () => {
  const dir = repo();
  const prompt = 'pesquise as boas práticas de hooks no Claude Code';
  const result = 'Links: [{"title":"Hooks","url":"https://code.claude.com/docs/en/hooks"}]';
  const good = stopFor(dir, prompt, [['tool', 'WebSearch', { query: 'claude code hooks' }, result]], 'Veja https://code.claude.com/docs/en/hooks.', 'g-url1');
  assert.strictEqual(c.groundingReason(good.input, dir, CFG, good.state), null);
  const bad = stopFor(dir, prompt, [['tool', 'WebSearch', { query: 'claude code hooks' }, result]],
    'Veja https://code.claude.com/docs/en/hooks e https://example.org/hooks-guide.', 'g-url2');
  const r = c.groundingReason(bad.input, dir, CFG, bad.state);
  assert.match(r, /example\.org\/hooks-guide/);
  assert.doesNotMatch(r, /docs\/en\/hooks[,;. ]/);
});

test('"grounding": "hint" or false keeps the Stop check off', () => {
  const dir = repo({ 'src/timer.ts': 'x' });
  const { input, state } = stopFor(dir, 'como o timer termina?', [], 'Termina em 0.', 'g-hint');
  assert.strictEqual(c.groundingReason(input, dir, { ...CFG, grounding: 'hint' }, state), null);
  assert.strictEqual(c.groundingReason(input, dir, { ...CFG, grounding: false }, state), null);
});

test('CLAUDE.md: a script renamed in this turn and a deleted folder are named; nothing is said without such a turn', () => {
  const dir = repo({
    'package.json': JSON.stringify({ scripts: { 'test:unit': 'vitest' } }),
    'CLAUDE.md': '# Rules\n- Run `npm run test:all` before committing.\n- Components live in `src/widgets/`.\n- Use `npm install` and `npm test`.\n',
  });
  const stale = c.staleInstructions(dir).map((x) => x.item);
  assert.deepStrictEqual(stale.sort(), ['npm run test:all', 'src/widgets/'].sort());
  const edited = transcript(dir, [['prompt', 'renomeie o script de teste'], ['tool', 'Edit', { file_path: path.join(dir, 'package.json'), old_string: 'a', new_string: 'b' }]]);
  const r = c.claudeMdReason({ session_id: 'g-md', transcript_path: edited }, dir, CFG);
  assert.match(r, /CLAUDE\.md names `npm run test:all`/);
  assert.match(r, /claude-md skill/);
  assert.strictEqual(c.claudeMdReason({ session_id: 'g-md', transcript_path: edited }, dir, CFG), null, 'once per prompt');
  const quiet = transcript(dir, [['prompt', 'explique o reducer'], ['tool', 'Read', { file_path: path.join(dir, 'package.json') }]]);
  assert.strictEqual(c.claudeMdReason({ session_id: 'g-md2', transcript_path: quiet }, dir, CFG), null);
  assert.strictEqual(c.claudeMdReason({ session_id: 'g-md3', transcript_path: edited }, dir, { ...CFG, claudeMd: false }), null);
});

test('a file move counts as a structure change; AGENTS.md is checked only when there is no CLAUDE.md', () => {
  const dir = repo({ 'AGENTS.md': 'Entry point: `src/main.ts`\n' });
  const moved = transcript(dir, [['prompt', 'mova o main'], ['tool', 'Bash', { command: 'git mv src/main.ts src/index.ts' }]]);
  assert.match(c.claudeMdReason({ session_id: 'g-ag', transcript_path: moved }, dir, CFG), /AGENTS\.md names `src\/main\.ts`/);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Nothing here.\n');
  assert.deepStrictEqual(c.staleInstructions(dir), []);
});

test('a follow-up that ends in an instruction is still a question; a file seen only through Grep counts as read', () => {
  const dir = repo({ 'src/cycle.ts': 'if (n % 8 === 0) return "long";' });
  const q = 'e agora, a cada quantos ciclos vem a pausa longa? responda com o número';
  assert.strictEqual(c.questionClass(q, dir), 'project');
  const tp = transcript(dir, [['prompt', 'a cada quantos ciclos vem a pausa longa?'],
    ['tool', 'Grep', { pattern: '% 8' }, 'src/cycle.ts:1:if (n % 8 === 0) return "long";'], ['say', 'A cada 8.'],
    ['prompt', q], ['say', '8']], Date.now() - 120000);
  fs.utimesSync(path.join(dir, 'src', 'cycle.ts'), new Date(), new Date());
  const r = c.groundingReason({ session_id: 'g-grep', transcript_path: tp, last_assistant_message: '8' }, dir, CFG,
    { question: { cls: 'project', prompt: c.hashText(q) } });
  assert.match(r, /cycle\.ts changed after it was last read/);
});

test('a page downloaded with curl or opened with WebFetch counts as seen', () => {
  const dir = repo();
  const prompt = 'pesquise o changelog do Vite';
  const url = 'https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/CHANGELOG.md';
  const s = stopFor(dir, prompt, [['tool', 'WebSearch', { query: 'vite changelog' }, 'no links'], ['tool', 'Bash', { command: `curl -s ${url} | head -50` }, '## 8.0.0']],
    `Fonte: ${url}`, 'g-curl');
  assert.strictEqual(c.groundingReason(s.input, dir, CFG, s.state), null);
});
