'use strict';
// node --test test/foreman.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'foreman.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-test-'));
const HOME = path.join(tmp, 'home');
const REPO = path.join(tmp, 'repo');
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: REPO });

process.env.FOREMAN_HOME = HOME;
delete process.env.FOREMAN_NOW;
// These tests cover the full block ("secrets": "block"); the default git-only mode has its own tests below.
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ secrets: 'block', hintMedium: true, planGate: true }));
const c = require(SCRIPT);
const preGit = c.preToolDecision;
c.preToolDecision = (tool, ti, cfg, cwd) => preGit(tool, ti, cfg || c.config(null), cwd);

function hook(kind, input, env = {}) {
  const out = execFileSync('node', [SCRIPT, 'hook', kind], {
    input: JSON.stringify({ cwd: REPO, session_id: 's1', ...input }), encoding: 'utf8', env: { ...process.env, ...env },
  });
  return out ? JSON.parse(out) : null;
}

const decision = (command) => {
  const d = c.preToolDecision('Bash', { command });
  return d ? d.permissionDecision : null;
};

test('secret file names are recognised, templates and public keys are not', () => {
  for (const f of ['.env', '.env.local', 'config/.env.production', 'app.env', 'server.pem', 'tls.key', 'id_rsa', '/home/u/.ssh/id_ed25519', 'credentials', 'credentials.json', 'secrets.yaml', '.netrc', '.npmrc', 'C:\\proj\\.env']) {
    assert.ok(c.isSecretPath(f), f);
  }
  for (const f of ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'credentials.ts', 'secrets.py', 'README.md', 'environment.ts', 'src/env.js', '.gitignore']) {
    assert.ok(!c.isSecretPath(f), f);
  }
});

test('file tools are denied on secret files and left alone elsewhere', () => {
  assert.strictEqual(c.preToolDecision('Read', { file_path: '/repo/.env' }).permissionDecision, 'deny');
  assert.strictEqual(c.preToolDecision('Edit', { file_path: 'C:\\repo\\.env.local' }).permissionDecision, 'deny');
  assert.strictEqual(c.preToolDecision('Grep', { pattern: 'KEY', path: '.env' }).permissionDecision, 'deny');
  assert.strictEqual(c.preToolDecision('Read', { file_path: '/repo/.env.example' }), null);
  assert.strictEqual(c.preToolDecision('Write', { file_path: '/repo/src/app.js' }), null);
});

test('shell commands that name a secret file are denied; echo into .gitignore is not', () => {
  for (const cmd of ['cat .env', 'grep -r KEY .env.local', 'type C:\\app\\.env', 'node -e "1" < .env', 'cp .env.example .env', 'source .env && npm start', 'cat ~/.ssh/id_rsa']) {
    assert.strictEqual(decision(cmd), 'deny', cmd);
  }
  for (const cmd of ['cat .env.example', 'echo .env >> .gitignore', 'printf ".env\\n" >> .gitignore', 'ls -la', 'node scripts/secrets.js', 'cat ~/.ssh/id_rsa.pub']) {
    assert.notStrictEqual(decision(cmd), 'deny', cmd);
  }
});

test('inline code that opens a secret file is denied; inline code that only names an example file is not', () => {
  for (const cmd of [`node -e "console.log(require('fs').readFileSync('.env','utf8'))"`, `py -c "print(open('.env').read())"`,
    `python3 -c "import os; print(open(os.path.join('config','.env.local')).read())"`]) {
    assert.strictEqual(decision(cmd), 'deny', cmd);
  }
  for (const cmd of [`node -e "console.log('.env.example')"`, `node -e "require('dotenv').config(); console.log(1)"`, 'npm test; node -p 1']) {
    assert.notStrictEqual(decision(cmd), 'deny', cmd);
  }
});

test('risky commands ask, by category', () => {
  const cat = (cmd) => c.riskyCommand(cmd).map((f) => f.category);
  assert.deepStrictEqual(cat('rm -rf src'), ['delete']);
  assert.deepStrictEqual(cat('Remove-Item -Recurse -Force src'), ['delete']);
  assert.deepStrictEqual(cat('git checkout -- .'), ['delete']);
  assert.deepStrictEqual(cat('git checkout -- src/app.js'), ['delete']);
  assert.deepStrictEqual(cat('git checkout -f main'), ['delete']);
  assert.deepStrictEqual(cat('git restore src && git status --short'), ['delete']);
  assert.deepStrictEqual(cat('git restore --staged --worktree a.py'), ['delete']);
  assert.deepStrictEqual(cat('git switch --discard-changes main'), ['delete']);
  assert.deepStrictEqual(cat('git reset --hard HEAD~1'), ['history']);
  assert.deepStrictEqual(cat('git rebase -i main'), ['history']);
  assert.deepStrictEqual(cat('git push --force origin main'), ['history']);
  assert.deepStrictEqual(cat('git push origin main'), ['external']);
  assert.deepStrictEqual(cat('curl -X POST https://api.example.com -d x=1'), ['external']);
  assert.deepStrictEqual(cat('npm publish'), ['external']);
  assert.deepStrictEqual(cat('gh pr create --fill'), ['external']);
  assert.deepStrictEqual(cat('git add . && git commit -m wip && git push'), ['external']);
  assert.deepStrictEqual(cat('rm -rf lib && git push --force'), ['delete', 'history']);
  assert.strictEqual(decision('rm -rf src'), 'ask');
});

test('ordinary commands and quoted text get no decision', () => {
  for (const cmd of ['git checkout main', 'git checkout -b feature', 'git restore --staged a.py', 'git restore -S a.py', 'npm test', 'git status', 'git diff HEAD~1', 'rm notes.txt', 'curl https://example.com', 'git commit -m "remove ssh setup and rm -rf docs"', 'gh pr view 12', 'python -m pytest -x', 'git log --oneline']) {
    assert.strictEqual(decision(cmd), null, cmd);
  }
});

test('commands run inside a shell or database client are still checked', () => {
  assert.strictEqual(decision('bash -c "rm -rf /tmp/x"'), 'ask');
  assert.strictEqual(decision('psql -c "DROP TABLE users"'), 'ask');
  assert.strictEqual(decision('sh -c \'git push --force\''), 'ask');
});

test('categories can be turned off and project patterns added', () => {
  const cfg = { ...c.config(null), risky: { delete: false, history: true, external: true }, riskyPatterns: ['terraform\\s+apply'] };
  assert.strictEqual(c.preToolDecision('Bash', { command: 'rm -rf src' }, cfg), null);
  assert.strictEqual(c.preToolDecision('Bash', { command: 'terraform apply -auto-approve' }, cfg).permissionDecision, 'ask');
  const off = { ...c.config(null), secrets: false };
  assert.notStrictEqual((c.preToolDecision('Bash', { command: 'cat .env' }, off) || {}).permissionDecision, 'deny');
});

test('the hook never returns allow', () => {
  for (const cmd of ['npm test', 'rm -rf x', 'cat .env', 'git push']) {
    const d = c.preToolDecision('Bash', { command: cmd });
    assert.ok(!d || d.permissionDecision !== 'allow', cmd);
  }
});

test('pre-tool hook end to end, with project settings', () => {
  assert.strictEqual(hook('pre-tool', { tool_name: 'Read', tool_input: { file_path: path.join(REPO, '.env') } }).hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(hook('pre-tool', { tool_name: 'Bash', tool_input: { command: 'git push' } }).hookSpecificOutput.permissionDecision, 'ask');
  assert.strictEqual(hook('pre-tool', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), null);
  fs.mkdirSync(path.join(REPO, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(REPO, '.claude', 'foreman.json'), JSON.stringify({ risky: { external: false }, secretAllow: ['.env.test'] }));
  assert.strictEqual(hook('pre-tool', { tool_name: 'Bash', tool_input: { command: 'git push' } }), null);
  assert.strictEqual(hook('pre-tool', { tool_name: 'Read', tool_input: { file_path: path.join(REPO, '.env.test') } }), null);
  fs.rmSync(path.join(REPO, '.claude'), { recursive: true });
});

test('a broken hook input does not break the session', () => {
  const out = execFileSync('node', [SCRIPT, 'hook', 'pre-tool'], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(out, '');
});

// The session that writes GOAL.md is the one its reminder belongs to.
const wroteGoal = (session_id) => hook('pre-tool', { session_id, tool_name: 'Write', tool_input: { file_path: path.join(REPO, 'GOAL.md'), content: 'x' } });

test('stop hook: nothing without GOAL.md or with a final status', () => {
  assert.strictEqual(hook('stop', {}), null);
  fs.writeFileSync(path.join(REPO, 'GOAL.md'), 'Task: fix export\n\nRequired evidence:\n- tests\n\nStatus: completed\n');
  assert.strictEqual(hook('stop', {}), null);
  fs.writeFileSync(path.join(REPO, 'GOAL.md'), 'Task: fix export\n\n- Status: blocked - need the API key from the user\n');
  assert.strictEqual(hook('stop', {}), null);
});

test('stop hook: open GOAL.md blocks up to the limit, then tells the user once and lets go', () => {
  fs.writeFileSync(path.join(REPO, 'GOAL.md'), 'Task: fix import\n\nRequired evidence:\n- tests\n');
  const s = { session_id: 'limit-1' };
  wroteGoal('limit-1');
  for (let i = 1; i <= 3; i++) {
    const out = hook('stop', { ...s, stop_hook_active: i > 1 });
    assert.strictEqual(out.decision, 'block');
    assert.match(out.reason, new RegExp(`reminder ${i} of 3`));
  }
  assert.match(hook('stop', { ...s, stop_hook_active: true }).systemMessage, /still open after 3/);
  assert.strictEqual(hook('stop', { ...s, stop_hook_active: true }), null);
  assert.strictEqual(hook('stop', s), null);
});

test('stop hook: the count is per session and per task, and evidence edits do not reset it', () => {
  fs.writeFileSync(path.join(REPO, 'GOAL.md'), 'Task: task A\n');
  const s = { session_id: 'per-task' };
  wroteGoal('per-task');
  hook('stop', s);
  fs.appendFileSync(path.join(REPO, 'GOAL.md'), '- evidence: npm test passed\n');
  assert.match(hook('stop', s).reason, /reminder 2 of 3/);
  fs.writeFileSync(path.join(REPO, 'GOAL.md'), 'Task: task B\n');
  assert.match(hook('stop', s).reason, /reminder 1 of 3/);
  // A session that never wrote GOAL.md is not reminded of it.
  assert.strictEqual(hook('stop', { session_id: 'other' }), null);
  wroteGoal('other');
  assert.match(hook('stop', { session_id: 'other' }).reason, /reminder 1 of 3/);
});

test('stop hook: GOAL.md written through the shell also makes the reminder belong to this session', () => {
  fs.writeFileSync(path.join(REPO, 'GOAL.md'), 'Task: shell goal\n');
  assert.strictEqual(hook('stop', { session_id: 'sh-goal' }), null);
  hook('pre-tool', { session_id: 'sh-goal', tool_name: 'Bash', tool_input: { command: 'echo "- evidence: ok" >> GOAL.md' } });
  assert.match(hook('stop', { session_id: 'sh-goal' }).reason, /reminder 1 of 3/);
  fs.rmSync(path.join(REPO, 'GOAL.md'));
});

test('stop hook: a stale GOAL.md is ignored, and the limit is configurable', () => {
  fs.writeFileSync(path.join(REPO, 'GOAL.md'), 'Task: old task\n');
  const later = new Date(Date.now() + 13 * 36e5).toISOString();
  for (const x of ['stale', 'off', 'one']) wroteGoal(x);
  assert.strictEqual(hook('stop', { session_id: 'stale' }, { FOREMAN_NOW: later }), null);
  fs.mkdirSync(path.join(REPO, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(REPO, '.claude', 'foreman.json'), JSON.stringify({ continuationLimit: 0 }));
  assert.strictEqual(hook('stop', { session_id: 'off' }), null);
  fs.writeFileSync(path.join(REPO, '.claude', 'foreman.json'), JSON.stringify({ continuationLimit: 1 }));
  assert.match(hook('stop', { session_id: 'one' }).reason, /reminder 1 of 1/);
  assert.match(hook('stop', { session_id: 'one' }).systemMessage, /after 1 reminders/);
  fs.rmSync(path.join(REPO, '.claude'), { recursive: true });
  fs.rmSync(path.join(REPO, 'GOAL.md'));
});

// Names of other plugins, kept as hashes so that this test does not name them either.
const OTHER_NAMES = new Set(['2703d31ad261', '81c91208cecb', '6ec090949f1b', 'aab04e0cf959', 'f74d2639df5a', 'c1a30243f15b', '60585c53f3e6', '51a4d27606d8', '1647b54d3c91', '007389a60631', 'c7b4c3dd9b99', '9d999baf12a8', '02e3041a0173', 'ed0d96b0c49e', '23675ff78c2f']);
const sha12 = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 12);
function namesOtherPlugin(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) || [];
  return words.some((w, i) => OTHER_NAMES.has(sha12(w)) || (words[i + 1] && (OTHER_NAMES.has(sha12(`${w}-${words[i + 1]}`)) || OTHER_NAMES.has(sha12(w + words[i + 1])))));
}

// ---------- package ----------

function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file} has frontmatter`);
  return Object.fromEntries(m[1].split('\n').filter((l) => /^\w[\w-]*:/.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
}

test('skills have the frontmatter Claude Code needs; the decision step lists only skills the model can call', () => {
  const skills = fs.readdirSync(path.join(ROOT, 'skills'));
  assert.deepStrictEqual(skills.sort(), ['claude-md', 'completion-criteria', 'create-skill', 'long-task', 'loop-design']);
  const manual = ['create-skill', 'loop-design'];
  for (const s of skills) {
    const fm = frontmatter(path.join(ROOT, 'skills', s, 'SKILL.md'));
    assert.strictEqual(fm.name, s);
    assert.ok(fm.description && fm.description.length < 1024, `${s} description`);
    assert.strictEqual(fm['disable-model-invocation'] === 'true', manual.includes(s), s);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'agents')), 'no agents: the diff review is /code-review');
  assert.match(c.LONG_TASK_HINT, /\(completion-criteria, long-task\)/);
});

test('a Grep over a folder with a secret file git does not ignore is denied; ignored or globbed out passes', () => {
  const { execSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-grep-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=abc\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'process.env.API_KEY\n');
  execSync('git init -q', { cwd: dir });
  const d = (ti) => (c.preToolDecision('Grep', ti, undefined, dir) || {}).permissionDecision || null;
  assert.strictEqual(d({ pattern: 'API_KEY', path: '.' }), 'deny');
  assert.strictEqual(d({ pattern: 'API_KEY' }), 'deny');
  assert.match(c.preToolDecision('Grep', { pattern: 'API_KEY' }, undefined, dir).permissionDecisionReason, /API_KEY/);
  assert.strictEqual(d({ pattern: 'API_KEY', path: 'src' }), null);
  assert.strictEqual(d({ pattern: 'API_KEY', glob: '*.{js,ts}' }), null);
  assert.strictEqual(d({ pattern: 'API_KEY', glob: '!.env' }), null);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  assert.strictEqual(d({ pattern: 'API_KEY', path: '.' }), null);
});

test('the plugin stays independent: no memory files, no other plugin named', () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (['.git', 'node_modules', 'test'].includes(e.name)) return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  });
  walk(ROOT);
  for (const f of fs.readdirSync(path.join(ROOT, 'test')).map((x) => path.join(ROOT, 'test', x)).filter((x) => fs.statSync(x).isFile())) {
    assert.ok(!namesOtherPlugin(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)} names another plugin`);
  }
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!namesOtherPlugin(text), `${path.relative(ROOT, f)} names another plugin`);
    if (f.endsWith('README.md')) continue;
    assert.ok(!/📌/.test(text), `${path.relative(ROOT, f)} uses another plugin's marker`);
    assert.ok(!/MEMORY\.md|LEARNINGS\.md|decisions\.md/.test(text), `${path.relative(ROOT, f)} mentions a memory file`);
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepStrictEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'UserPromptSubmit']);
});

test('a blocked env file names its variables, never the values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-names-'));
  fs.writeFileSync(path.join(dir, '.env'), '# comment\nexport LEDGER_API_KEY=sk-live-abc123\nLEDGER_DB_URL = postgres://u:p@h/db\nnot a pair\n');
  const read = c.preToolDecision('Read', { file_path: path.join(dir, '.env') }, c.config(null));
  assert.strictEqual(read.permissionDecision, 'deny');
  assert.match(read.permissionDecisionReason, /LEDGER_API_KEY, LEDGER_DB_URL/);
  assert.doesNotMatch(read.permissionDecisionReason, /sk-live|postgres:/);
  const bash = c.preToolDecision('Bash', { command: 'cat .env' }, c.config(null), dir);
  assert.match(bash.permissionDecisionReason, /LEDGER_API_KEY/);
  const off = c.preToolDecision('Read', { file_path: path.join(dir, '.env') }, { ...c.config(null), secretNames: false });
  assert.doesNotMatch(off.permissionDecisionReason, /LEDGER_API_KEY/);
  fs.writeFileSync(path.join(dir, 'server.key'), 'NAME=value\n');
  assert.deepStrictEqual(c.secretNames(path.join(dir, 'server.key')), []);
});

test('a recursive search over a folder with a secret file is denied unless it excludes the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-search-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=x\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'KEY = 1\n');
  const cfg = c.config(null);
  for (const cmd of ['grep -rniE "apikey|api_key" . --exclude-dir=.git | head', 'grep -R KEY', 'ls && grep -rn KEY .', 'rg --hidden KEY', 'rg -uu KEY .']) {
    const d = c.preToolDecision('Bash', { command: cmd }, cfg, dir);
    assert.strictEqual(d && d.permissionDecision, 'deny', cmd);
    assert.match(d.permissionDecisionReason, /--exclude=\.env/);
  }
  assert.match(c.preToolDecision('Bash', { command: 'grep -R KEY' }, cfg, dir).permissionDecisionReason, /API_KEY/);
  for (const cmd of ['grep -rn KEY src', 'grep -rn KEY . --exclude=.env', 'cat README.md; grep -rIni "key\\|token" src . --exclude=.env | head -30', 'rg KEY', 'grep -n KEY src/a.py', 'git grep KEY']) {
    assert.strictEqual(c.preToolDecision('Bash', { command: cmd }, cfg, dir), null, cmd);
  }
});

test('a requirement list written inline after a colon counts like a bulleted one', () => {
  assert.ok(c.isLargeTask('Adicione exportação do histórico para CSV: um botão na página History, filtro por período, nome do arquivo com a data, e trate o caso de histórico vazio.'));
  assert.ok(!c.isLargeTask('Corrija o título: está desalinhado à esquerda na página History.'));
});

test('fail-closed: when the pre-tool check throws, the call is denied with a clear reason; other hooks stay silent', () => {
  const out = hook('pre-tool', { tool_name: 'Read', tool_input: { file_path: 'src/a.js' } }, { FOREMAN_TEST_THROW: 'pre-tool' });
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /could not check this call for secret files/);
  assert.strictEqual(hook('stop', {}, { FOREMAN_TEST_THROW: 'stop' }), null);
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.strictEqual(hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'Stop']) assert.strictEqual(hooks[ev][0].hooks[0].onFailure, undefined, ev);
});

test('wildcards that would match a secret file in the folder are denied; others pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wild-'));
  fs.mkdirSync(path.join(dir, 'cfg'));
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=abc\n');
  fs.writeFileSync(path.join(dir, 'cfg', 'server.key'), 'x');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  const d = (command) => (c.preToolDecision('Bash', { command }, undefined, dir) || {}).permissionDecision || null;
  for (const cmd of ['cat .e*', 'cat .en?', 'type .e[n]v', 'head -1 ./.e*', 'cat cfg/*.k*', 'ls && cat .e*']) assert.strictEqual(d(cmd), 'deny', cmd);
  for (const cmd of ['cat *.md', 'ls -la', 'cat src/*.js', 'echo .e*']) assert.strictEqual(d(cmd), null, cmd);
  assert.strictEqual(d('git add *'), null); // bash: * skips dot files
  assert.strictEqual((c.preToolDecision('PowerShell', { command: 'Get-Content *' }, undefined, dir) || {}).permissionDecision, 'deny'); // PowerShell: it does not
  assert.match(c.preToolDecision('Bash', { command: 'cat .e*' }, undefined, dir).permissionDecisionReason, /"\.env"/);
});

test('the Grep type parameter counts as a filter: a known type that leaves the secret file out passes', () => {
  const { execSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-gtype-'));
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=abc\n');
  fs.writeFileSync(path.join(dir, 'secrets.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a.js'), 'process.env.API_KEY\n');
  execSync('git init -q', { cwd: dir });
  const d = (ti) => (c.preToolDecision('Grep', ti, undefined, dir) || {}).permissionDecision || null;
  assert.strictEqual(d({ pattern: 'API_KEY', type: 'js' }), null);
  assert.strictEqual(d({ pattern: 'API_KEY', type: 'py' }), null);
  assert.strictEqual(d({ pattern: 'API_KEY', type: 'json' }), 'deny'); // secrets.json is a json file
  assert.strictEqual(d({ pattern: 'API_KEY', type: 'dotenv' }), 'deny'); // unknown type: no filter assumed
  assert.strictEqual(d({ pattern: 'API_KEY' }), 'deny');
});

test('deletes inside generated folders (dist, build, coverage, logs…) do not ask; anything else still does', () => {
  const cat = (cmd) => c.riskyCommand(cmd).map((f) => f.category);
  for (const cmd of ['rm -rf dist', 'rm -rf build/ coverage/', 'rm -rf ./dist/*', 'rm -f logs/app.log', 'Remove-Item -Recurse -Force dist', 'rmdir /s /q build', 'rm -rf .next && npm run build'])
    assert.deepStrictEqual(cat(cmd), [], cmd);
  for (const cmd of ['rm -rf dist src', 'rm -rf ../dist', 'rm -rf /dist', 'rm -rf *', 'rm -rf src/build', 'rm -rf ~/build', 'rm -rf C:\\build', 'rm -rf dist/../src'])
    assert.deepStrictEqual(cat(cmd), ['delete'], cmd);
  assert.deepStrictEqual(c.riskyCommand('rm -rf dist', { ...c.config(REPO), generatedDirs: [] }).map((f) => f.category), ['delete']);
});

test('default: a secrets file can be written but not read, and no git add or commit puts it into the repository', () => {
  const dir = path.join(tmp, 'gitmode');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.env'), 'DB_PASS=x\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), '1\n');
  const cfg = { ...c.config(null), secrets: true };
  const d = (tool, ti) => (preGit(tool, ti, cfg, dir) || {}).permissionDecision || null;
  const sh = (command) => d('Bash', { command });
  // writing puts nothing secret into the context; reading would
  assert.strictEqual(d('Edit', { file_path: path.join(dir, '.env') }), null);
  assert.strictEqual(d('Write', { file_path: path.join(dir, '.env.local') }), null);
  assert.strictEqual(sh('echo NEW_KEY= >> .env'), null);
  assert.strictEqual(d('Read', { file_path: path.join(dir, '.env') }), 'deny');
  assert.strictEqual(sh('cat .env'), 'deny');
  assert.strictEqual(d('Edit', { file_path: path.join(dir, '.env') }) === null && (preGit('Edit', { file_path: path.join(dir, '.env') }, { ...cfg, secrets: 'block' }, dir) || {}).permissionDecision, 'deny');
  // .env not ignored: every way of staging it is denied, with the fix in the reason
  for (const cmd of ['git add .env', 'git add .', 'git add -A', 'git add --all', 'git add src .env', 'git -C . add .', 'npm test && git add . && git commit -m x']) assert.strictEqual(sh(cmd), 'deny', cmd);
  assert.match(preGit('Bash', { command: 'git add .' }, cfg, dir).permissionDecisionReason, /put "\.env", a secrets file.*\.gitignore/);
  assert.strictEqual(sh('git add src'), null);
  assert.strictEqual(sh('git add src/a.js'), null);
  assert.strictEqual(sh("git commit -m 'never add .env'"), null);
  // ignored: a normal add passes, a forced one does not
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  assert.strictEqual(sh('git add .'), null);
  assert.strictEqual(sh('git add -A'), null);
  assert.strictEqual(sh('git add -f .env'), 'deny');
  // already staged, or tracked and changed: the commit is denied
  execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
  assert.strictEqual(sh('git commit -m x'), 'deny');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.env'), 'DB_PASS=y\n');
  assert.strictEqual(sh('git commit -am x'), 'deny');
  assert.strictEqual(sh('git add -u'), 'deny');
  assert.strictEqual(sh('git commit -m x'), null);
  // off
  assert.strictEqual((preGit('Bash', { command: 'git add -f .env' }, { ...cfg, secrets: false }, dir) || {}).permissionDecision, undefined);
});
