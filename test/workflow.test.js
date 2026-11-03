'use strict';
// node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'foreman.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-flow-'));
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.FOREMAN_HOME = HOME;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ secrets: 'block', hintMedium: true, planGate: true })); // the full block and the medium hint, as these tests expect
delete process.env.FOREMAN_NOW;
delete process.env.FOREMAN_HEADLESS;
const c = require(SCRIPT);

function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

function hook(kind, input, env = {}) {
  const out = execFileSync('node', [SCRIPT, 'hook', kind], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  return out ? JSON.parse(out) : null;
}

// A transcript: one prompt, then the given tool calls.
function transcript(dir, calls, prompt = 'do it') {
  const file = path.join(dir, 't.jsonl');
  const lines = [JSON.stringify({ type: 'user', message: { content: prompt } })];
  calls.forEach((x, i) => {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: x[0], input: x[1] }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } }));
  });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const NODE_PROJECT = { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) };

test('project root is found by walking up to .git, without starting git', () => {
  const dir = repo({ 'src/a/x.js': '' });
  assert.strictEqual(c.projectRoot(path.join(dir, 'src', 'a')), dir);
  const wt = fs.mkdtempSync(path.join(tmp, 'wt-'));
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere');
  assert.strictEqual(c.projectRoot(wt), wt);
});

test('long-task hint: multi-step requests get it, questions and small fixes do not', () => {
  const large = [
    'Implemente um CRUD de funcionários com API REST, testes e tela de listagem',
    'Refactor the authentication module to use JWT and update all the tests',
    'Implement the following:\n- endpoint GET /users\n- endpoint POST /users\n- validation\n- tests',
    'Migre o projeto de JavaScript para TypeScript, incluindo todos os módulos e os testes',
  ];
  const small = ['fix the typo in README', 'como funciona o hook de stop?', 'What does this function do in the payment service module?',
    'rename foo to bar in utils.js', 'Rode os testes e me diga o que falhou', 'just add a log line in the export service', '/foreman:create-skill relatório'];
  for (const p of large) assert.ok(c.isLargeTask(p), p);
  for (const p of small) assert.ok(!c.isLargeTask(p), p);
  const dir = repo();
  const out = hook('prompt', { cwd: dir, session_id: 'p1', prompt: large[0] });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /multi-step check/);
  assert.doesNotMatch(ctx, /Before any other tool call|Step \d/); // a statement, not a numbered order
  assert.match(ctx, /YES or NO/);
  assert.doesNotMatch(ctx, /Code edits of such a request are held/); // only a clearly multi-step request is held
  assert.match(ctx, /already lists its steps is usually done directly/);
  for (const name of ['completion-criteria', 'long-task']) assert.ok(ctx.includes(name), name); // every model-invoked skill is weighed
  for (const name of ['create-skill', 'loop-design']) assert.ok(!ctx.includes(name), name); // manual skills are not
  assert.ok(ctx.length < 700, `${ctx.length} chars`);
  assert.strictEqual(hook('prompt', { cwd: dir, session_id: 'p1', prompt: small[0] }), null);
});

test('activation can be "always" (session start) or "off", and in shadow mode only records', () => {
  const dir = repo({ '.claude/foreman.json': JSON.stringify({ activation: 'always' }) });
  assert.match(hook('session-start', { cwd: dir, source: 'startup' }).hookSpecificOutput.additionalContext, /this project has skills for how work is done/);
  assert.strictEqual(hook('prompt', { cwd: dir, prompt: 'Implemente um CRUD completo com API REST e testes' }), null);
  assert.strictEqual(hook('session-start', { cwd: repo(), source: 'startup' }), null);
  const sh = repo({ '.claude/foreman.json': JSON.stringify({ shadow: ['activation'] }) });
  assert.strictEqual(hook('prompt', { cwd: sh, session_id: 'sh', prompt: 'Implemente um CRUD completo com API REST e testes' }), null);
  assert.match(fs.readFileSync(path.join(HOME, 'shadow.jsonl'), 'utf8'), /"rule":"activation"/);
});

test('a test command is recognised; echo, commit messages and quoted text are not test runs', () => {
  for (const x of ['npm test', 'npm run lint', 'npx vitest run', 'pytest -q tests/', 'python -m pytest', 'go test ./...', 'cargo test', 'node --test test/', 'cd app && make test', './gradlew test']) assert.ok(c.ranTest(x), x);
  for (const x of ['echo "run npm test"', "git commit -m 'fix tests and pytest config'", 'cat test/a.test.js', 'ls tests', 'npm install']) assert.ok(!c.ranTest(x), x);
});

test('stop: code changed and no test after the last edit asks once per turn; docs-only and tested turns pass', () => {
  const dir = repo(NODE_PROJECT);
  const untested = transcript(dir, [['Edit', { file_path: path.join(dir, 'src/a.js') }], ['Bash', { command: 'npm test' }], ['Edit', { file_path: path.join(dir, 'src/b.ts') }]]);
  const out = hook('stop', { cwd: dir, session_id: 'v1', transcript_path: untested });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /changed code \(b\.ts\)/);
  assert.match(out.reason, /npm test/);
  assert.strictEqual(hook('stop', { cwd: dir, session_id: 'v1', transcript_path: untested, stop_hook_active: true }), null);
  const tested = transcript(dir, [['Edit', { file_path: path.join(dir, 'src/a.js') }], ['Bash', { command: 'npm test 2>&1 | tail -20' }]]);
  assert.strictEqual(hook('stop', { cwd: dir, session_id: 'v2', transcript_path: tested }), null);
  const docs = transcript(dir, [['Edit', { file_path: path.join(dir, 'README.md') }], ['Write', { file_path: path.join(dir, 'docs/guide.js') }]]);
  assert.strictEqual(hook('stop', { cwd: dir, session_id: 'v3', transcript_path: docs }), null);
  const old = path.join(dir, 'old.jsonl');
  fs.writeFileSync(old, fs.readFileSync(untested, 'utf8') + JSON.stringify({ type: 'user', message: { content: 'thanks, now explain it' } }) + '\n');
  assert.strictEqual(hook('stop', { cwd: dir, session_id: 'v4', transcript_path: old }), null, 'an earlier turn does not count');
});

test('stop: a project with no test setup is exempt; verify can be turned off', () => {
  const bare = repo();
  const t = transcript(bare, [['Edit', { file_path: path.join(bare, 'x.py') }]]);
  assert.strictEqual(hook('stop', { cwd: bare, session_id: 'n1', transcript_path: t }), null);
  const off = repo({ ...NODE_PROJECT, '.claude/foreman.json': JSON.stringify({ verify: false }) });
  assert.strictEqual(hook('stop', { cwd: off, session_id: 'n2', transcript_path: transcript(off, [['Edit', { file_path: path.join(off, 'x.js') }]]) }), null);
  assert.strictEqual(c.testCommand(repo({ 'go.mod': 'module x' })), 'go test ./...');
  assert.strictEqual(c.testCommand(repo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), null);
  assert.strictEqual(c.testCommand(repo({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })), 'pytest');
});

test('stop: the test reminder and an open GOAL.md go in one block and share the limit', () => {
  const dir = repo({ ...NODE_PROJECT, 'GOAL.md': 'Task: fix login\n' });
  const t = transcript(dir, [['Edit', { file_path: path.join(dir, 'src/login.js') }]]);
  hook('pre-tool', { cwd: dir, session_id: 'both', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'GOAL.md'), content: 'x' } });
  const out = hook('stop', { cwd: dir, session_id: 'both', transcript_path: t });
  assert.match(out.reason, /changed code/);
  assert.match(out.reason, /GOAL\.md has no final status \(reminder 1 of 3\)/);
  const lim = repo({ ...NODE_PROJECT, '.claude/foreman.json': JSON.stringify({ continuationLimit: 1 }) });
  const t2 = transcript(lim, [['Edit', { file_path: path.join(lim, 'a.js') }]]);
  assert.ok(hook('stop', { cwd: lim, session_id: 'lim', transcript_path: t2 }));
  assert.strictEqual(hook('stop', { cwd: lim, session_id: 'lim', transcript_path: t2 }), null);
});

test('headless: risky commands are denied with an alternative instead of asked; secrets stay denied', () => {
  const dir = repo({ '.claude/foreman.json': JSON.stringify({ headless: true }) });
  const d = hook('pre-tool', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }).hookSpecificOutput;
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no one to confirm/);
  assert.match(d.permissionDecisionReason, /new commit instead of rewriting history/);
  const env = hook('pre-tool', { cwd: repo(), tool_name: 'Bash', tool_input: { command: 'rm -rf src' } }, { FOREMAN_HEADLESS: '1' }).hookSpecificOutput;
  assert.strictEqual(env.permissionDecision, 'deny');
  assert.strictEqual(hook('pre-tool', { cwd: repo(), tool_name: 'Bash', tool_input: { command: 'rm -rf src' } }).hookSpecificOutput.permissionDecision, 'ask');
  assert.strictEqual(hook('pre-tool', { cwd: dir, tool_name: 'Read', tool_input: { file_path: '.env' } }).hookSpecificOutput.permissionDecision, 'deny');
});

test('guards in shadow mode only record what they would do', () => {
  const dir = repo({ '.claude/foreman.json': JSON.stringify({ shadow: ['risky'] }) });
  assert.strictEqual(hook('pre-tool', { cwd: dir, session_id: 'g', tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }), null);
  assert.match(fs.readFileSync(path.join(HOME, 'shadow.jsonl'), 'utf8'), /"rule":"risky"/);
  assert.strictEqual(hook('pre-tool', { cwd: dir, tool_name: 'Read', tool_input: { file_path: '.env' } }).hookSpecificOutput.permissionDecision, 'deny');
});

test('subagents get the working rules, unless turned off', () => {
  const out = hook('subagent', { cwd: repo(), agent_type: 'general-purpose' });
  assert.match(out.hookSpecificOutput.additionalContext, /run the relevant test command/);
  assert.strictEqual(hook('subagent', { cwd: repo({ '.claude/foreman.json': JSON.stringify({ subagent: false }) }) }), null);
});

test('replay counts guards, hints and untested turns over transcripts', () => {
  const R = require(path.join(__dirname, '..', 'scripts', 'replay.js'));
  const dir = fs.mkdtempSync(path.join(tmp, 'tr-'));
  const proj = repo(NODE_PROJECT);
  const lines = [
    { type: 'user', cwd: proj, message: { content: 'Implemente um CRUD de funcionários com API REST, testes e tela de listagem' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: path.join(proj, 'src/x.js') } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'rm -rf src' } }] } },
    { type: 'user', cwd: proj, message: { content: 'obrigado' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'Read', input: { file_path: '.env' } }] } },
  ];
  fs.writeFileSync(path.join(dir, 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const r = R.replay(dir, 1);
  assert.strictEqual(r.activation.flagged, 1);
  assert.strictEqual(r.guards.ask, 1);
  assert.strictEqual(r.guards.deny, 1);
  assert.strictEqual(r.verify.untested, 1);
});

test('contract: every injected text fits the hook output limit, and every hook event is handled', () => {
  for (const t of [c.LONG_TASK_HINT, c.SKILLS_HINT, c.SUBAGENT_RULES]) assert.ok(t.length < 10000);
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const kinds = { SessionStart: 'session-start', UserPromptSubmit: 'prompt', PreToolUse: 'pre-tool', SubagentStart: 'subagent', Stop: 'stop' };
  for (const [event, groups] of Object.entries(hooks)) {
    assert.ok(kinds[event], event);
    for (const g of groups) for (const h of g.hooks) assert.ok(h.command.endsWith(`hook ${kinds[event]}`), h.command);
  }
});

test('verify: helper scripts outside the project root do not count as changes', () => {
  const root = path.join(os.tmpdir(), 'proj-x');
  const calls = [
    { name: 'Write', input: { file_path: '/tmp/aud/chk.py' } },
    { name: 'Edit', input: { file_path: path.join(root, 'src', 'a.py') } },
  ];
  assert.deepStrictEqual(c.unverifiedChanges(calls, root), ['a.py']);
  assert.strictEqual(c.unverifiedChanges(calls.slice(0, 1), root), null);
});

test('verify: shell edits count as changes; the build counts as the check only where it is the only one', () => {
  for (const [cmd, want] of [["sed -i 's/a/b/' src/a.ts", ['src/a.ts']], ['cat > src/new.js <<EOF', ['src/new.js']], ['echo x >> lib/x.py', ['lib/x.py']],
    ['npm test 2>&1 | tee out.log', []], ['cp tmp/a.js src/a.js', ['src/a.js']], ['cat src/a.js > /dev/null', []], ['perl -pi -e s/a/b/ main.go', ['main.go']]])
    assert.deepStrictEqual(c.shellEdits(cmd), want, cmd);
  assert.ok(c.ranBuild('npm run build') && c.ranBuild('cd web && pnpm build') && !c.ranBuild('echo "npm run build"') && !c.ranBuild('npm install'));
  const dir = repo(NODE_PROJECT);
  const shell = transcript(dir, [['Bash', { command: "sed -i 's/x/y/' src/a.js" }]]);
  assert.match(hook('stop', { cwd: dir, session_id: 'sh1', transcript_path: shell }).reason, /changed code \(a\.js\)/);
  assert.strictEqual(hook('stop', { cwd: dir, session_id: 'sh2', transcript_path: transcript(dir, [['Bash', { command: "sed -i 's/x/y/' src/a.js && npm test" }]]) }), null);
  const build = repo({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) });
  assert.strictEqual(c.testCommand(build), 'npm run build');
  assert.strictEqual(hook('stop', { cwd: build, session_id: 'b1', transcript_path: transcript(build, [['Edit', { file_path: path.join(build, 'src/a.ts') }], ['Bash', { command: 'npm run build' }]]) }), null);
  const out = hook('stop', { cwd: build, session_id: 'b2', transcript_path: transcript(build, [['Edit', { file_path: path.join(build, 'src/a.ts') }]]) });
  assert.match(out.reason, /Run the project's build \(likely `npm run build`\)/);
  // with real tests, a build alone is not a check
  const both = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest', build: 'vite build' } }) });
  assert.ok(hook('stop', { cwd: both, session_id: 'b3', transcript_path: transcript(both, [['Edit', { file_path: path.join(both, 'src/a.ts') }], ['Bash', { command: 'npm run build' }]]) }));
});

test('verify: the reminder limit counts per request, so a new request can be reminded again', () => {
  const dir = repo({ ...NODE_PROJECT, '.claude/foreman.json': JSON.stringify({ continuationLimit: 1 }) });
  const edit = [['Edit', { file_path: path.join(dir, 'a.js') }]];
  assert.ok(hook('stop', { cwd: dir, session_id: 'pr', transcript_path: transcript(dir, edit, 'first request') }));
  assert.strictEqual(hook('stop', { cwd: dir, session_id: 'pr', transcript_path: transcript(dir, edit, 'first request') }), null);
  assert.ok(hook('stop', { cwd: dir, session_id: 'pr', transcript_path: transcript(dir, edit, 'second request') }));
});

test('long-task hint: a clearly long request asks for long-task directly; a borderline one gets the decision step', () => {
  const long = 'Implemente o módulo de relatórios completo:\n- endpoint GET /reports com filtros\n- exportação CSV e PDF\n- tela de listagem com paginação\n- testes de API e de tela\n' +
    'Use o banco de dados atual, siga o padrão dos outros módulos do sistema (src/modules/users.ts, src/modules/tasks.ts, src/api/router.ts) e atualize a documentação da API.';
  assert.ok(c.taskScore(long) >= c.DIRECT_THRESHOLD, String(c.taskScore(long)));
  const dir = repo();
  const direct = hook('prompt', { cwd: dir, session_id: 'd1', prompt: long }).hookSpecificOutput.additionalContext;
  assert.strictEqual(direct, c.longTaskDirect(c.taskScore(long), true));
  const border = 'Refactor the authentication module to use JWT and update all the tests';
  assert.ok(c.taskScore(border) < c.DIRECT_THRESHOLD);
  assert.match(hook('prompt', { cwd: dir, session_id: 'd2', prompt: border }).hookSpecificOutput.additionalContext, /multi-step check/);
});

test('plan gate: code edits of a clearly multi-step request are held per model response, up to planGateHolds; task files, PLAN.md and plan mode pass', () => {
  const large = 'Implemente o módulo de relatórios: crie a API de exportação CSV, adicione filtros por data e departamento, escreva os testes e atualize o README';
  const dir = repo();
  // a medium request (score 4 to 6) gets the hint but no hold
  hook('prompt', { cwd: dir, session_id: 'g0', prompt: 'Implemente um CRUD de funcionários com API REST, testes e tela de listagem' });
  assert.strictEqual(hook('pre-tool', { cwd: dir, session_id: 'g0', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.js') } }), null);
  const at = (sec) => ({ FOREMAN_NOW: new Date(Date.UTC(2026, 10, 2, 12, 0, sec)).toISOString() });
  const edit = (s, file, sec = 0) => hook('pre-tool', { cwd: dir, session_id: s, tool_name: 'Edit', tool_input: { file_path: path.join(dir, file) } }, at(sec));
  hook('prompt', { cwd: dir, session_id: 'g1', prompt: large }, at(0));
  for (const f of ['PLAN.md', 'GOAL.md', 'PROGRESS.md', 'README.md']) assert.strictEqual(edit('g1', f), null, f);
  const denied = edit('g1', 'src/a.js', 1);
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /held until there is a plan/);
  assert.doesNotMatch(denied.hookSpecificOutput.permissionDecisionReason, /tried again|small/); // no way around it is offered
  assert.ok(edit('g1', 'src/b.js', 2)); // same response: same hold
  assert.ok(edit('g1', 'src/a.js', 30)); // second response: second hold
  assert.strictEqual(edit('g1', 'src/a.js', 60), null); // the gate lets go after planGateHolds (2)
  // PLAN.md written after the request lifts the gate.
  hook('prompt', { cwd: dir, session_id: 'g2', prompt: large });
  fs.writeFileSync(path.join(dir, 'PLAN.md'), '1. api\n');
  assert.strictEqual(edit('g2', 'src/a.js'), null);
  // Plan mode seen in the session lifts it too.
  const d2 = repo();
  hook('prompt', { cwd: d2, session_id: 'g3', prompt: large, permission_mode: 'plan' });
  assert.strictEqual(hook('pre-tool', { cwd: d2, session_id: 'g3', tool_name: 'Write', tool_input: { file_path: path.join(d2, 'b.ts') } }), null);
  // Skipping the plan, a shell edit, planGate: false.
  hook('prompt', { cwd: d2, session_id: 'g4', prompt: large + ', sem plano' });
  assert.strictEqual(hook('pre-tool', { cwd: d2, session_id: 'g4', tool_name: 'Write', tool_input: { file_path: path.join(d2, 'b.ts') } }), null);
  hook('prompt', { cwd: d2, session_id: 'g5', prompt: large });
  assert.strictEqual(hook('pre-tool', { cwd: d2, session_id: 'g5', tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' src/x.py" } }).hookSpecificOutput.permissionDecision, 'deny');
  const off = repo({ '.claude/foreman.json': JSON.stringify({ planGate: false }) });
  const ctx = hook('prompt', { cwd: off, session_id: 'g6', prompt: large }).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /are held/);
  assert.strictEqual(hook('pre-tool', { cwd: off, session_id: 'g6', tool_name: 'Write', tool_input: { file_path: path.join(off, 'b.ts') } }), null);
});

test('plan reminder: every N calls while PROGRESS.md is current, one line with its open step', () => {
  const dir = repo({ '.claude/foreman.json': JSON.stringify({ planReminderEvery: 3 }), 'PROGRESS.md': '- [x] api\n- [ ] tela de listagem\n' });
  const read = () => hook('pre-tool', { cwd: dir, session_id: 'r1', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'x.js') } });
  assert.strictEqual(read(), null);
  assert.strictEqual(read(), null);
  assert.strictEqual(read().hookSpecificOutput.additionalContext, 'foreman: current step in PROGRESS.md: - [ ] tela de listagem');
  fs.writeFileSync(path.join(dir, 'GOAL.md'), 'Task: x\nStatus: completed\n');
  for (let i = 0; i < 3; i++) assert.strictEqual(read(), null);
});

test('after /compact, PLAN.md is left to Claude Code when the session used plan mode', () => {
  const dir = repo({ 'PLAN.md': '1. util\n', 'PROGRESS.md': 'Left: 1.\n' });
  hook('prompt', { cwd: dir, session_id: 'pm', prompt: 'oi', permission_mode: 'plan' });
  const ctx = hook('session-start', { cwd: dir, session_id: 'pm', source: 'compact' }).hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes('--- PLAN.md ---'));
  assert.ok(ctx.includes('--- PROGRESS.md ---'));
});

test('after /compact, the current task files come back; a finished or old task, or compact: false, does not', () => {
  const dir = repo({ 'GOAL.md': 'Task: export CSV\nEvidence: tests pass\n', 'PLAN.md': '1. util\n2. button\n', 'PROGRESS.md': 'Done: 1. Left: 2.\n' });
  const ctx = hook('session-start', { cwd: dir, source: 'compact' }).hookSpecificOutput.additionalContext;
  for (const x of ['--- GOAL.md ---', 'Task: export CSV', '--- PLAN.md ---', '2. button', '--- PROGRESS.md ---', 'Left: 2.']) assert.ok(ctx.includes(x), x);
  assert.strictEqual(hook('session-start', { cwd: dir, source: 'startup' }), null);
  const done = repo({ 'GOAL.md': 'Task: x\nStatus: completed\n' });
  assert.strictEqual(hook('session-start', { cwd: done, source: 'compact' }), null);
  assert.strictEqual(hook('session-start', { cwd: dir, source: 'compact' }, { FOREMAN_NOW: new Date(Date.now() + 13 * 3600e3).toISOString() }), null);
  const off = repo({ 'PLAN.md': 'p', '.claude/foreman.json': JSON.stringify({ compact: false }) });
  assert.strictEqual(hook('session-start', { cwd: off, source: 'compact' }), null);
  const big = repo({ 'PLAN.md': 'x'.repeat(5000) });
  assert.match(hook('session-start', { cwd: big, source: 'compact' }).hookSpecificOutput.additionalContext, /\[… cut; read PLAN\.md for the rest\]/);
});

test('by default a medium request (score 4 to 6) gets no hint; a clearly multi-step one gets the hint, and no edit is held (planGate is off)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-default-'));
  const dir = repo();
  const env = { FOREMAN_HOME: home };
  const medium = 'Implemente um CRUD de funcionários com API REST, testes e tela de listagem';
  const large = 'Implemente o módulo de relatórios: crie a API de exportação CSV, adicione filtros por data e departamento, escreva os testes e atualize o README';
  assert.strictEqual(hook('prompt', { cwd: dir, session_id: 'd1', prompt: medium }, env), null);
  assert.strictEqual(hook('pre-tool', { cwd: dir, session_id: 'd1', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.js') } }, env), null);
  assert.match(hook('prompt', { cwd: dir, session_id: 'd2', prompt: large }, env).hookSpecificOutput.additionalContext, /long-task/);
  assert.strictEqual(hook('pre-tool', { cwd: dir, session_id: 'd2', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.js') } }, env), null);
});
