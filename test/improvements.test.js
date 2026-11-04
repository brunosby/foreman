'use strict';
// Several projects in one folder, the secrets guard's false positives, and the task folder setting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-impr-'));
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.FOREMAN_HOME = HOME;
delete process.env.FOREMAN_NOW;
const c = require(path.join(__dirname, '..', 'scripts', 'foreman.js'));

function tree(files) {
  const dir = fs.mkdtempSync(path.join(tmp, 'ws-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

test('CLAUDE.md paths and scripts of a subproject are found there, not reported as missing', () => {
  const dir = tree({
    'CLAUDE.md': '# Workspace\n\n- App code: `src/app.js`, run `npm run dev`\n- API: `api/server.py`\n- Gone: `src/old.js` and `npm run legacy`\n',
    'code/web/package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    'code/web/src/app.js': 'x',
    'code/api/.git/HEAD': 'ref',
    'code/api/api/server.py': 'x',
  });
  const stale = c.staleInstructions(dir).map((x) => x.item);
  assert.deepStrictEqual(stale.sort(), ['npm run legacy', 'src/old.js']);
});

test('the test command comes from the project that holds the edited file', () => {
  const dir = tree({
    'code/web/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    'code/web/src/a.ts': 'x',
    'code/svc/pyproject.toml': '[tool.pytest.ini_options]\n',
    'code/svc/app/b.py': 'x',
  });
  assert.deepStrictEqual(c.testCommandFor(dir, [path.join(dir, 'code/svc/app/b.py')]), { cmd: 'pytest', dir: path.join(dir, 'code/svc') });
  assert.deepStrictEqual(c.testCommandFor(dir, [path.join(dir, 'code/web/src/a.ts')]), { cmd: 'npm test', dir: path.join(dir, 'code/web') });
  assert.strictEqual(c.testCommandFor(dir, [path.join(dir, 'notes.js')]), null);
  const t = path.join(dir, 't.jsonl');
  fs.writeFileSync(t, [JSON.stringify({ type: 'user', message: { content: 'fix it' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Edit', input: { file_path: path.join(dir, 'code/svc/app/b.py'), old_string: 'a', new_string: 'b' } }] } })].join('\n') + '\n');
  const out = c.stopDecision({ session_id: 'v1', transcript_path: t, cwd: dir }, dir, { ...c.config(dir), grounding: false, claudeMd: false });
  assert.match(out.reason, /likely `cd code\/svc && pytest`/);
});

test('secrets: copying the example into .env and reading process.env are not blocked; reading .env still is', () => {
  const cfg = c.config(null);
  assert.strictEqual(c.secretInCommand('cp .env.example .env', cfg), null);
  assert.strictEqual(c.secretInCommand('Copy-Item .env.sample .env', cfg), null);
  assert.strictEqual(c.secretInCommand('node -e "console.log(Object.keys(process.env))"', cfg), null);
  assert.strictEqual(c.secretInCommand('cp .env backup.txt', cfg), '.env');
  assert.strictEqual(c.secretInCommand('node -e "require(\'fs\').readFileSync(\'.env\')"', cfg) !== null, true);
  assert.strictEqual(c.secretInCommand('cp .env.example .env', { ...cfg, secrets: 'block' }), '.env', 'with "block" writing .env is blocked too');
});

test('taskDir moves GOAL.md, PLAN.md and PROGRESS.md; outside the project it is ignored', () => {
  const root = tree({ '.git/HEAD': 'x', '.claude/task/GOAL.md': 'Task: x\n', '.claude/task/PROGRESS.md': '- [ ] step two\n' });
  const cfg = { ...c.config(root), taskDir: '.claude/task' };
  assert.strictEqual(c.taskDir(root, cfg), path.join(root, '.claude', 'task'));
  assert.strictEqual(c.taskDir(root, { taskDir: '../elsewhere' }), root);
  assert.match(c.compactContext(root, cfg), /--- GOAL\.md ---\nTask: x/);
  assert.strictEqual(c.compactContext(root, c.config(root)), null, 'the root holds no task files');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
