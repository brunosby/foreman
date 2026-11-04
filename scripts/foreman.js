#!/usr/bin/env node
// foreman: how Claude works. Guard hooks block secret files and ask before risky shell commands;
// a prompt hook points multi-step requests to the long-task skill; the Stop hook asks for a test
// run after code changes and keeps an open GOAL.md from being silently abandoned, with a bounded
// number of reminders.
// Hooks:  node foreman.js hook <pre-tool|prompt|session-start|subagent|stop>   (hook JSON on stdin)
// Manual: node foreman.js <check "<command>" | path <file> | task "<prompt>" | ask "<prompt>" | stale | config | replay [dir]>
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const HOUR = 36e5;
const DEFAULTS = {
  secrets: true,               // true: a secrets file (.env, keys) cannot be read by the agent and never goes into a commit, but can be written; 'block': not written either; false: off
  secretPatterns: [],          // extra globs on the file name, e.g. "*.p12"
  secretAllow: [],             // file names never treated as secrets, e.g. ".env.test"
  secretNames: true,           // a blocked env-style file still tells the agent which variable names it defines (never values)
  risky: { delete: true, history: true, external: true },
  riskyPatterns: [],           // extra regexes (strings) that always ask
  generatedDirs: ['dist', 'build', 'coverage', 'logs', 'out', '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.pytest_cache'], // rm -rf inside these does not ask
  continuationLimit: 3,        // reminders per task (GOAL.md) and per request (tests); 0 turns the Stop hook off
  goalMaxAgeHours: 12,         // a GOAL.md untouched for longer is treated as left over
  activation: 'detect',        // 'detect': point multi-step requests to long-task; 'always': remind of the skills at session start; 'off'
  verify: true,                // Stop: ask for a test run when code changed and no test ran after it
  headless: false,             // no one to answer: risky commands are denied with an alternative instead of asked
  subagent: true,              // pass the working rules to subagents when they start
  compact: true,               // after /compact, put GOAL.md, PLAN.md and PROGRESS.md of the current task back in the context
  planGate: false,             // true: a multi-step request has its code edits held until PLAN.md exists or plan mode was used (off: no measured gain)
  hintMedium: false,           // true: medium requests (score 4 to 6) also get the long-task hint, not only clearly multi-step ones
  planGateHolds: 2,            // model responses whose code edits are held before the gate lets go, so a session never gets stuck
  planReminderEvery: 20,       // every N tool calls while PROGRESS.md is current, one line with its current step; 0 turns it off
  grounding: true,             // questions about the project and research requests: a statement on the prompt, and a Stop check that the answer read files / cites only links it saw; 'hint': statement only; false: off
  researchDomains: [],         // e.g. ["docs.example.org"]: named in the research statement as the preferred sources
  claudeMd: true,              // Stop: when a turn renamed or removed things, say which commands or paths named in CLAUDE.md no longer exist; the claude-md skill applies a changed line and asks before removing one; 'ask': it asks before every change; false: off
  shadow: [],                  // rules that only record what they would do: activation, verify, secrets, risky, goal, plan, grounding, claudemd
  taskDir: '',                 // folder for GOAL.md, PLAN.md and PROGRESS.md, relative to the project root (e.g. ".claude/task"); '' = the root
};
const TERMINAL = /^\s*[-*]?\s*status\s*:\s*(completed|blocked|budget exhausted)\b/im;

// ---------- project and settings ----------

function foremanHome() {
  return process.env.FOREMAN_HOME || path.join(os.homedir(), '.claude', 'foreman');
}

function now() { return process.env.FOREMAN_NOW ? Date.parse(process.env.FOREMAN_NOW) : Date.now(); }

// Git root, so subfolders count as the same project. Found by walking up to a .git entry
// (a folder, or a file in worktrees and submodules) instead of starting a git process on
// every tool call.
function projectRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  const start = dir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const up = path.dirname(dir);
    if (up === dir) { dir = start; break; }
    dir = up;
  }
  return IS_WIN ? dir.replace(/\//g, '\\') : dir;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// Project settings win over user settings, which win over the defaults.
function config(root) {
  const user = readJson(path.join(foremanHome(), 'config.json')) || {};
  const project = (root && readJson(path.join(root, '.claude', 'foreman.json'))) || {};
  const cfg = { ...DEFAULTS, ...user, ...project };
  cfg.risky = { ...DEFAULTS.risky, ...(user.risky || {}), ...(project.risky || {}) };
  if (/^(1|on|true|yes)$/i.test(process.env.FOREMAN_HEADLESS || '')) cfg.headless = true;
  if (!Array.isArray(cfg.shadow)) cfg.shadow = [];
  return cfg;
}

const inShadow = (cfg, rule) => (cfg.shadow || []).includes(rule);

// Where the task files live: taskDir inside the project, or the project root when it is unset or points outside.
function taskDir(root, cfg = DEFAULTS) {
  const rel = String((cfg && cfg.taskDir) || '').trim();
  if (!rel || path.isAbsolute(rel)) return root;
  const dir = path.resolve(root, rel);
  return path.relative(root, dir).startsWith('..') ? root : dir;
}
const taskFile = (root, cfg, name) => path.join(taskDir(root, cfg), name);

// What a shadow-mode rule would have done, so its false positives can be counted before it acts.
function recordShadow(rule, session, detail) {
  try {
    const file = path.join(foremanHome(), 'shadow.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ t: now(), s: session || null, rule, ...detail }) + '\n');
  } catch (_) { /* recording never gets in the way */ }
}

// ---------- secret files ----------

const SECRET_GLOBS = [
  '.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  'credentials', 'secrets', ...['credentials', 'secrets'].flatMap((b) => ['json', 'yaml', 'yml', 'toml', 'ini', 'txt', 'xml', 'env', 'csv'].map((e) => `${b}.${e}`)),
  '.netrc', '_netrc', '.pgpass', '.npmrc', '.pypirc',
];
// Templates that hold no real values.
const SAFE_NAMES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', 'example.env', 'sample.env'];
// Public keys and similar names that look like secrets but are not.
const SAFE_SUFFIX = /\.(pub|example|sample|template|md)$/i;

function globToRegex(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

function isSecretPath(file, cfg = DEFAULTS) {
  if (!file || typeof file !== 'string') return false;
  const name = file.replace(/["'`]/g, '').split(/[\\/]/).pop();
  if (!name) return false;
  const allow = [...SAFE_NAMES, ...(cfg.secretAllow || [])].map((n) => n.toLowerCase());
  if (allow.includes(name.toLowerCase()) || SAFE_SUFFIX.test(name)) return false;
  return [...SECRET_GLOBS, ...(cfg.secretPatterns || [])].some((g) => globToRegex(g).test(name));
}

// Splits a shell line into simple commands. Quotes are kept inside words, not interpreted.
function segments(command) {
  return String(command || '').split(/&&|\|\||[;|\n]|\$\(|`/).map((s) => s.trim()).filter(Boolean);
}

function words(segment) {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

// A word with * ? or [..] is expanded by the shell before the command runs: `cat .e*` reads .env without naming it.
// Returns the first existing secret file the pattern matches, looking in the folder the pattern points to.
const WILDCARD = /[*?[]/;
function secretByWildcard(token, cfg, cwd, dotMatch) {
  if (!WILDCARD.test(token)) return null;
  const clean = token.replace(/^~(?=[\\/])/, os.homedir());
  const dirPart = path.dirname(clean);
  const namePart = path.basename(clean);
  if (WILDCARD.test(dirPart) || !namePart) return null; // patterns across folders are not expanded here
  const dir = path.resolve(cwd || process.cwd(), dirPart);
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const re = globToRegex(namePart.replace(/\[[^\]]*\]/g, '?'));
  // In bash a pattern that does not start with a dot skips dot files (`cat *` leaves .env out); PowerShell does not.
  const hit = names.find((n) => re.test(n) && isSecretPath(n, cfg) && (dotMatch || !n.startsWith('.') || namePart.startsWith('.')));
  return hit ? (dirPart === '.' ? hit : path.join(dirPart, hit)) : null;
}

// The first secret file a shell command names, ignoring echo/printf (writing ".env" into .gitignore is fine).
// With cwd, wildcards are expanded against the folder so a pattern that would match a secret file counts as naming it.
function secretInCommand(command, cfg = DEFAULTS, cwd, dotMatch = false) {
  for (const seg of segments(command)) {
    const ws = words(seg);
    if (/^(echo|printf|write-host|write-output)$/i.test(ws[0] || '')) continue;
    if (pathOnly(ws, cfg) &&!/\bxargs\b/.test(command)) continue; // ls .env | xargs cat reads it
    // cp .env.example .env: the last path of a copy is written, not read (the source is still checked).
    const dest = cfg.secrets !== 'block' && COPY.test(path.basename(String(ws[0] || '').replace(/^["']|["']$/g, ''))) ? lastPathIndex(ws) : -1;
    for (const [i, w] of ws.entries()) {
      if (i === dest) continue;
      // A commit or tag message is not a path: git commit -m "add .env to .gitignore".
      if (i > 0 && /^(-[a-zA-Z]*m|--message)$/.test(ws[i - 1]) && /^git(\.exe)?$/i.test(path.basename(ws[0] || ''))) continue;
      // The target of > or >> is written, not read: cat >> .env <<EOF.
      if (cfg.secrets !== 'block' && (/^\d?>>?$/.test(i > 0 ? ws[i - 1] : '') || /^\d?>>?[^>&]/.test(w))) continue;
      const token = w.replace(/^[<>]+|^\d?>+/, '').replace(/["'`,;)]+$/g, '').replace(/^["'`(]+/, '');
      if (token.startsWith('-') && !token.includes('=')) continue;
      if (/^--(?:exclude|exclude-dir|ignore|glob|iglob)=/i.test(token)) continue; // leaving a file out is not reading it
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
      if (ENV_ACCESS.test(value)) continue; // node -e "console.log(process.env)": the runtime's variables, not a file
      if (isSecretPath(value, cfg)) return value;
      const expanded = cwd ? secretByWildcard(value, cfg, cwd, dotMatch) : null;
      if (expanded) return expanded;
    }
  }
  // Inline code names the file inside a string: node -e "fs.readFileSync('.env')", py -c "open('.env')".
  // Split with quotes kept, so a ; inside the code does not cut it off from its interpreter.
  for (const seg of quotedSegments(command)) {
    const ws = words(seg.trim());
    if (!INLINE.test(path.basename(ws[0] || ''))) continue;
    for (const [i, w] of ws.entries()) {
      if (i === 0 || (cfg.secrets !== 'block' && (/^\d?>>?$/.test(ws[i - 1]) || /^\d?>>?[^>&]/.test(w)))) continue;
      const hit = w.split(/[\s'"`(),;+]+/).find((piece) => piece && !ENV_OBJECT.test(piece) && isSecretPath(piece, cfg));
      if (hit) return hit;
    }
  }
  return null;
}

// Commands that take a secret file as a path without putting its contents in the output: checking whether it
// exists or is ignored, untracking it, changing its mode, deleting it (risky commands still ask for that).
// Copy and move stay blocked: a copy under another name could then be read.
// With "secrets": "block" the ones that change the file stay blocked too.
const PATH_ONLY = /^(?:ls|dir|test|\[\[?|stat|test-path|get-item|get-childitem|gci)(?:\.exe)?$/i;
const PATH_CHANGE = /^(?:touch|chmod|chown|rm|del|erase|remove-item)(?:\.exe)?$/i;

function pathOnly(ws, cfg) {
  const cmd = path.basename(String(ws[0] || '').replace(/^["']|["']$/g, ''));
  const block = cfg.secrets === 'block';
  if (PATH_ONLY.test(cmd) || (!block && PATH_CHANGE.test(cmd))) return true;
  if (!/^git(\.exe)?$/i.test(cmd)) return false;
  let i = 1;
  while (i < ws.length && /^-[Cc]$/.test(ws[i])) i += 2;
  return /^(?:check-ignore|ls-files|status)$/.test(ws[i] || '') || (!block && ws[i] === 'rm');
}

const INLINE = /^(?:node|nodejs|bun|deno|python[\d.]*|py|ruby|perl|php|sh|bash|zsh|pwsh|powershell)(?:\.exe)?$/i;
// The environment object of a runtime, not a file: process.env, import.meta.env, Deno.env, Bun.env.
const ENV_OBJECT = /^(?:process|import\.meta|deno|bun)\.env$/i;
const ENV_ACCESS = /(?:^|[^\w/\\.-])(?:process|import\.meta|deno|bun)\.env$|^(?:process|import\.meta|deno|bun)\.env$/i;
const COPY = /^(?:cp|copy|copy-item|cpi|xcopy|robocopy)(?:\.exe)?$/i;

// Index of the last word that is not an option (the destination of cp/copy), or -1.
function lastPathIndex(ws) {
  for (let i = ws.length - 1; i > 0; i--) if (!/^-/.test(ws[i]) && !/^\/[a-z]$/i.test(ws[i])) return i;
  return -1;
}

// A recursive content search reads every file under its folders, secret files included, without naming them.
// grep -r/-R and ag do; rg and git grep skip hidden or ignored files unless told otherwise.
const RECURSIVE = /^(?:e?grep|zgrep)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.cache']);
const WALK_LIMIT = 3000;

// The first secret file under dir, or null. With `all`, every one found is pushed there and the walk goes on.
function findSecretUnder(dir, cfg, depth = 0, seen = { n: 0 }, all = null) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    if (++seen.n > WALK_LIMIT) return null;
    if (e.isFile() && isSecretPath(e.name, cfg)) {
      if (!all) return path.join(dir, e.name);
      all.push(path.join(dir, e.name));
    }
  }
  if (depth >= 4) return null;
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
      const hit = findSecretUnder(path.join(dir, e.name), cfg, depth + 1, seen, all);
      if (hit) return hit;
    }
  }
  return null;
}

// The Grep tool searches hidden files (ripgrep --hidden) but skips what git ignores. A secret file under its
// path that git does not ignore and its glob does not leave out would have its lines returned.
function gitIgnored(file, cwd) {
  try {
    const r = require('child_process').spawnSync('git', ['check-ignore', '-q', file], { cwd: path.dirname(file), timeout: 3000, windowsHide: true });
    return r.status === 0;
  } catch (_) { return false; }
}

// A glob with a slash matches the path from the search folder, where * stays inside one folder and ** crosses
// folders (as in ripgrep); one without a slash matches the file name anywhere.
function pathGlobRegex(glob) {
  const body = glob.replace(/^\.?\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}

// `rel` is the file's path from the search folder, with forward slashes.
function globKeeps(glob, rel) {
  if (!glob) return true;
  const alts = String(glob).split(/\s+/).filter(Boolean).flatMap((g) => {
    const m = /^(.*)\{([^}]*)\}(.*)$/.exec(g);
    return m ? m[2].split(',').map((x) => m[1] + x + m[3]) : [g];
  });
  const name = rel.split('/').pop();
  // "!node_modules/**" leaves out what is under node_modules, not a .env next to it.
  const test = (g) => (g.replace(/\/+$/, '').includes('/') ? pathGlobRegex(g).test(rel) : globToRegex(g).test(name));
  if (alts.some((g) => g.startsWith('!') && test(g.slice(1)))) return false;
  const inc = alts.filter((g) => !g.startsWith('!'));
  return !inc.length || inc.some(test);
}

// The Grep tool's `type` (ripgrep --type) limits the search to files of that kind. For the common kinds the
// file names are known; an unknown kind is treated as no filter, so a secret file still counts.
const GREP_TYPES = {
  js: '*.{js,jsx,mjs,cjs,vue}', ts: '*.{ts,tsx,cts,mts}', py: '*.{py,pyi}', go: '*.go', rust: '*.rs', java: '*.{java,jsp}',
  kotlin: '*.{kt,kts}', ruby: '*.{rb,gemspec}', php: '*.{php,phtml}', cs: '*.cs', c: '*.{c,h}', cpp: '*.{cpp,cc,cxx,hpp,hh,h}',
  swift: '*.swift', css: '*.{css,scss}', html: '*.{html,htm}', md: '*.{md,markdown}', sh: '*.{sh,bash,zsh}', sql: '*.sql',
  json: '*.json', yaml: '*.{yaml,yml}', xml: '*.xml', toml: '*.toml', txt: '*.txt', csv: '*.csv',
};

function secretInGrep(toolInput, cfg, cwd) {
  const ti = toolInput || {};
  const base = path.resolve(cwd || process.cwd(), String(ti.path || '.'));
  let stat;
  try { stat = fs.statSync(base); } catch (_) { return null; }
  if (!stat.isDirectory()) return null;
  const hits = [];
  findSecretUnder(base, cfg, 0, { n: 0 }, hits);
  const typeGlob = ti.type ? GREP_TYPES[String(ti.type).toLowerCase()] : null;
  const rel = (f) => path.relative(base, f).split(path.sep).join('/');
  return hits.find((f) => globKeeps(ti.glob, rel(f)) && globKeeps(typeGlob, rel(f)) && !gitIgnored(f, cwd)) || null;
}

// The secret file a recursive search would read, or null. An --exclude naming the file counts as handled.
// Like segments(), but a | or ; inside quotes (as in grep "a\\|b") stays part of the word.
function quotedSegments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(command || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function secretInSearch(command, cfg = DEFAULTS, cwd) {
  for (const seg of quotedSegments(command)) {
    const ws = words(seg).map((w) => w.replace(/^["']|["']$/g, ''));
    const tool = (ws[0] || '').split(/[\\/]/).pop();
    const flags = ws.filter((w) => w.startsWith('-'));
    const shortFlags = flags.filter((f) => !f.startsWith('--')).join('');
    let recursive = false;
    if (RECURSIVE.test(tool)) recursive = /[rR]/.test(shortFlags) || flags.some((f) => /^--(?:recursive|dereference-recursive)$/.test(f));
    else if (/^(?:rg|ripgrep)$/i.test(tool)) recursive = flags.some((f) => /^--(?:hidden|no-ignore)/.test(f) || /^-u+$/.test(f) || /^-[a-zA-Z]*u/.test(f) && !f.startsWith('--'));
    else if (/^ag$/i.test(tool)) recursive = true;
    if (!recursive) continue;
    const targets = ws.slice(1).filter((w) => !w.startsWith('-'));
    // grep's first free word is the pattern (unless -e/-f gave it); what follows are the folders.
    const patternGiven = flags.some((f) => /^-[a-zA-Z]*[ef]$|^--(?:regexp|file)=?/.test(f));
    const dirs = (patternGiven ? targets : targets.slice(1));
    for (const d of (dirs.length ? dirs : ['.'])) {
      const full = path.resolve(cwd || process.cwd(), d);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (!stat.isDirectory()) continue;
      const hit = findSecretUnder(full, cfg);
      if (!hit) continue;
      const name = path.basename(hit);
      if (flags.some((f) => /^--exclude(?:-dir)?=/.test(f) && f.includes(name.replace(/^\./, ''))) || ws.some((w) => w.includes(`!${name}`))) continue;
      return hit;
    }
  }
  return null;
}

// Variable names an env-style file defines, so code can be pointed at the right name without seeing a value.
const ENV_STYLE = /^(?:\.env(?:\..*)?|.*\.env|.*\.(?:ini|properties|toml))$/i;
const MAX_NAMES = 40;

function secretNames(file, cwd) {
  const name = String(file).replace(/["'`]/g, '').split(/[\\/]/).pop();
  if (!ENV_STYLE.test(name)) return [];
  try {
    const full = path.resolve(cwd || process.cwd(), String(file).replace(/["'`]/g, ''));
    if (fs.statSync(full).size > 256 * 1024) return [];
    const names = [];
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/.exec(line);
      if (m && !names.includes(m[1])) names.push(m[1]);
      if (names.length >= MAX_NAMES) break;
    }
    return names;
  } catch (_) { return []; }
}

function secretReason(file, cfg, cwd) {
  const shown = path.basename(String(file).replace(/["'`]/g, ''));
  let reason = `foreman: "${shown}" looks like a secrets file. ${cfg.secrets === 'block' ? 'It is blocked' : 'Reading it is blocked'} for the agent; ask the user for the specific value you need, or use a template such as .env.example.`;
  const names = cfg.secretNames === false ? [] : secretNames(file, cwd);
  if (names.length) reason += ` It defines these names (values hidden): ${names.join(', ')}. Code can refer to them by name without the values.`;
  return reason;
}

// ---------- secrets into git ----------

// A secrets file that reaches a commit is exposed for good, even after it is removed. Returns the secret file
// a git add/commit in this command would put into the repository, or null.
function git(args, cwd) {
  try {
    const r = require('child_process').spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
    return r.status === 0 ? r.stdout : null;
  } catch (_) { return null; }
}

function secretIntoGit(command, cfg, cwd) {
  const base = cwd || process.cwd();
  // Lines of `git add --dry-run` read "add 'path'"; other git lists are bare paths.
  const secretIn = (list) => (list || '').split(/\r?\n/).map((f) => f.trim().replace(/^add '(.*)'$/, '$1')).find((f) => f && isSecretPath(f, cfg)) || null;
  for (const seg of quotedSegments(command)) {
    const ws = words(seg).map((w) => w.replace(/^["']|["']$/g, ''));
    const at = ws.findIndex((w) => /^git(\.exe)?$/i.test(path.basename(w)));
    if (at < 0) continue;
    let i = at + 1;
    while (i < ws.length && /^-[Cc]$/.test(ws[i])) i += 2; // git -C dir / -c key=value
    const sub = ws[i];
    const rest = ws.slice(i + 1);
    if (sub === 'add' || sub === 'stage') {
      const force = rest.some((w) => /^(-f|--force)$/.test(w) || /^-[a-zA-Z]*f/.test(w));
      const flags = rest.filter((w) => /^(-A|--all|-u|--update)$/.test(w));
      const paths = rest.filter((w) => !w.startsWith('-'));
      // What git would stage: a dry run lists it exactly, ignored files included only with -f.
      const hit = secretIn(git(['add', '--dry-run', ...(force ? ['-f'] : []), ...flags, '--', ...(paths.length ? paths : ['.'])], base));
      if (hit) return hit;
      const named = paths.find((p) => isSecretPath(p, cfg) && (force || !gitIgnored(path.resolve(base, p), base)));
      if (named) return named;
    } else if (sub === 'commit') {
      const staged = secretIn(git(['diff', '--cached', '--name-only'], base));
      if (staged) return staged;
      if (rest.some((w) => /^(-a|--all)$/.test(w) || /^-[a-zA-Z]*a/.test(w))) {
        const tracked = secretIn(git(['diff', '--name-only'], base));
        if (tracked) return tracked;
      }
    }
  }
  return null;
}

function gitSecretReason(file) {
  const name = path.basename(String(file));
  return `foreman: this command would put "${file}", a secrets file, into the git repository, so it was not run. ` +
    `Add ${name} to .gitignore (and \`git rm --cached ${file}\` if it is already tracked), then run the command again; ` +
    'commit a template such as .env.example instead of the real file.';
}

// ---------- risky commands ----------

// Effect categories: deleting data or history, and talking to an external destination.
// Reading local files and editing allowed project files go through the normal permission flow.
const RISKY = {
  delete: [
    [/\brm\s+(?:-\S*\s+)*-\S*[rRf]/, 'rm -r/-f'],
    [/\brm\s+(?:\S+\s+)*--(?:recursive|force)\b/, 'rm --recursive/--force'],
    [/\b(?:rmdir|rd)\s+\/s\b/i, 'rmdir /s'],
    [/\bdel\s+(?:\S+\s+)*\/[sq]\b/i, 'del /s'],
    [/\bremove-item\b.*-recurse/i, 'Remove-Item -Recurse'],
    [/\bfind\b.*\s-delete\b/, 'find -delete'],
    // -n/--dry-run only lists what would go.
    [/\bgit\s+clean\b(?!.*\s(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)(?:\s|$))\s+(?:-\S*\s+)*-\S*f/, 'git clean -f'],
    [/\b(?:shred|truncate)\s/, 'shred/truncate'],
    [/\bdrop\s+(?:table|database|schema)\b/i, 'DROP'],
    [/\bgit\s+(?:checkout|restore)\s+(?:\S+\s+)*(?:--\s+)?\.(?:\s|$)/, 'git checkout/restore . (discards changes)'],
    // Paths after "--", --force and a restore of the working tree throw away uncommitted edits. "restore --staged" only unstages.
    [/\bgit\s+checkout\s+(?:\S+\s+)*(?:--|-f|--force)(?:\s|$)/, 'git checkout -- <path>/-f (discards changes)'],
    [/\bgit\s+restore\s+(?!(?:\S+\s+)*(?:-S|--staged)\b)|\bgit\s+restore\s+(?:\S+\s+)*(?:-W|--worktree)\b/, 'git restore (discards changes)'],
    [/\bgit\s+(?:switch|checkout)\s+(?:\S+\s+)*--discard-changes\b/, 'git switch --discard-changes'],
  ],
  history: [
    [/\bgit\s+push\b.*\s(?:-f|--force(?:-with-lease)?)\b/, 'git push --force'],
    [/\bgit\s+push\b.*\s\+\S+/, 'git push +ref'],
    [/\bgit\s+reset\s+(?:\S+\s+)*--hard\b/, 'git reset --hard'],
    [/\bgit\s+rebase\b/, 'git rebase'],
    [/\bgit\s+commit\b.*--amend\b/, 'git commit --amend'],
    [/\bgit\s+(?:filter-branch|filter-repo)\b/, 'git filter-branch'],
    [/\bgit\s+branch\s+(?:\S+\s+)*-D\b/, 'git branch -D'],
    [/\bgit\s+tag\s+(?:\S+\s+)*-d\b/, 'git tag -d'],
    [/\bgit\s+stash\s+(?:drop|clear)\b/, 'git stash drop'],
  ],
  external: [
    [/\bgit\s+push\b/, 'git push'],
    [/\bcurl\b.*\s(?:-d|--data\S*|-F|--form\S*|-T|--upload-file|-X\s*(?:POST|PUT|PATCH|DELETE))\b/i, 'curl sending data'],
    [/\bwget\b.*--(?:post-data|post-file|method|body-data|body-file)\b/, 'wget sending data'],
    [/\b(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b.*-method\s+(?:post|put|patch|delete)\b/i, 'web request sending data'],
    [/\b(?:ssh|scp|sftp|ftp)\s/, 'ssh/scp'],
    [/\brsync\b.*\s\S+:\S*/, 'rsync to host'],
    [/\b(?:npm|pnpm|yarn)\s+publish\b/, 'package publish'],
    [/\b(?:twine\s+upload|cargo\s+publish|gem\s+push|dotnet\s+nuget\s+push)\b/, 'package publish'],
    [/\bdocker\s+push\b/, 'docker push'],
    [/\bgh\s+(?:pr|issue|release|repo|gist)\s+(?:create|merge|close|comment|edit|delete|review|upload)\b/, 'gh write'],
    [/\bgh\s+api\b.*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|-f|-F|--field|--raw-field|--input)\b/i, 'gh api write'],
  ],
};

// Quoted text is not a command ("git commit -m 'drop ssh'" is safe), except what a shell or database client runs.
const RUNS_QUOTED = /^(?:sudo\s+)?(?:bash|sh|zsh|dash|pwsh|powershell|cmd|eval|psql|mysql|sqlite3|sqlcmd|ssh)\b/i;

function commandText(command) {
  const out = [];
  for (const seg of segments(command)) {
    out.push(seg.replace(/"[^"]*"|'[^']*'/g, '""'));
    if (RUNS_QUOTED.test(seg)) for (const q of seg.match(/"[^"]*"|'[^']*'/g) || []) out.push(...commandText(q.slice(1, -1)));
  }
  return out;
}

// A delete whose every target sits inside a folder the build or the tests regenerate (dist/, coverage/…)
// loses nothing that cannot be rebuilt, so it does not ask. A target outside the project, with "..", or a bare
// wildcard keeps the question.
const DELETE_CMD = /^(?:sudo\s+)?(?:rm|rmdir|rd|del|remove-item|ri)\b/i;
function generatedOnly(seg, cfg) {
  if (!DELETE_CMD.test(seg)) return false;
  const dirs = new Set((cfg.generatedDirs || DEFAULTS.generatedDirs).map((d) => d.toLowerCase()));
  const targets = words(seg).slice(1).map((w) => w.replace(/^["']|["']$/g, ''))
    .filter((w) => !/^-/.test(w) && !/^\/[a-z]$/i.test(w));
  if (!targets.length) return false;
  return targets.every((t) => {
    const parts = t.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
    if (!parts.length || path.isAbsolute(t) || /^[a-z]:/i.test(t) || parts.includes('..') || t.startsWith('~')) return false;
    // A log or temp file (a run's own output, such as .verify-test.log) is not work to lose.
    return dirs.has(parts[0].toLowerCase()) || /\.(?:log|tmp|temp)$/i.test(parts[parts.length - 1]);
  });
}

// Every category a command falls into, with what matched. Commands are checked one simple command at a time.
function riskyCommand(command, cfg = DEFAULTS) {
  const found = [];
  const segs = commandText(command);
  for (const [category, rules] of Object.entries(RISKY)) {
    if (!cfg.risky || cfg.risky[category] === false) continue;
    for (const seg of segs) {
      if (category === 'delete' && generatedOnly(seg, cfg)) continue;
      const hit = rules.find(([re]) => re.test(seg));
      if (hit) { found.push({ category, match: hit[1] }); break; }
    }
  }
  for (const src of cfg.riskyPatterns || []) {
    let re;
    try { re = new RegExp(src, 'i'); } catch (_) { continue; }
    if (re.test(String(command || ''))) { found.push({ category: 'custom', match: src }); break; }
  }
  // A forced push is a history change; asking twice for the same push adds nothing.
  if (found.some((f) => f.category === 'history' && /push/.test(f.match))) {
    return found.filter((f) => !(f.category === 'external' && f.match === 'git push'));
  }
  return found;
}

const ALTERNATIVES = {
  delete: 'Remove only the specific files the task needs, without -r or -f, or leave the cleanup to the user.',
  history: 'Add a new commit instead of rewriting history.',
  external: 'Write what would be sent to a file in the project instead of sending it.',
  custom: 'Find another way that the project rules allow.',
};

const LABELS = {
  delete: 'deletes data',
  history: 'changes repository history',
  external: 'communicates with an external destination',
  custom: 'matches a project rule',
};

// ---------- PreToolUse ----------

function filePaths(toolName, input) {
  const ti = input || {};
  // A glob starting with ! leaves files out; it does not read them.
  const glob = typeof ti.glob === 'string' && ti.glob.startsWith('!') ? null : ti.glob;
  if (toolName === 'Grep' || toolName === 'Glob') return [ti.path, glob, ti.pattern && toolName === 'Glob' ? ti.pattern : null];
  return [ti.file_path, ti.notebook_path, ti.path];
}

// Returns the hookSpecificOutput for a tool call, or null to leave the decision to the normal permission flow.
// Never returns "allow": skipping a prompt is not this plugin's call.
function preToolDecision(toolName, toolInput, cfg = DEFAULTS, cwd) {
  const out = (decision, reason) => ({ hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason });
  if (cfg.secrets !== false && (toolName === 'Bash' || toolName === 'PowerShell')) {
    const hit = secretIntoGit(toolInput && toolInput.command, cfg, cwd);
    if (hit) return out('deny', gitSecretReason(hit));
  }
  if (cfg.secrets !== false) {
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      const hit = secretInCommand(toolInput && toolInput.command, cfg, cwd || process.cwd(), toolName === 'PowerShell');
      if (hit) return out('deny', secretReason(hit, cfg, cwd));
      const under = secretInSearch(toolInput && toolInput.command, cfg, cwd);
      if (under) {
        const name = path.basename(under);
        const names = cfg.secretNames === false ? [] : secretNames(under, cwd);
        return out('deny', `foreman: this recursive search would also read "${path.relative(cwd || process.cwd(), under) || name}", a blocked secrets file. ` +
          `Run it again with --exclude=${name} (grep) or without the hidden/ignored flags (rg), or search only the source folders.` +
          (names.length ? ` That file defines these names (values hidden): ${names.join(', ')}.` : ''));
      }
    } else {
      // Writing puts nothing secret into the context; reading would. Only "block" also stops writes.
      const writes = EDIT_TOOLS.has(toolName) && cfg.secrets !== 'block';
      const hit = !writes && filePaths(toolName, toolInput).find((p) => isSecretPath(p, cfg));
      if (hit) return out('deny', secretReason(hit, cfg, cwd));
      const under = toolName === 'Grep' ? secretInGrep(toolInput, cfg, cwd) : null;
      if (under) {
        const name = path.basename(under);
        const names = cfg.secretNames === false ? [] : secretNames(under, cwd);
        return out('deny', `foreman: this Grep would also search "${path.relative(cwd || process.cwd(), under) || name}", a blocked secrets file that git does not ignore. ` +
          `Run it again with glob "!${name}" or a glob for the source files (e.g. "*.{js,ts}"), or with path set to a source folder.` +
          (names.length ? ` That file defines these names (values hidden): ${names.join(', ')}.` : ''));
      }
    }
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const found = riskyCommand(toolInput && toolInput.command, cfg);
    if (found.length) {
      const what = found.map((f) => `${LABELS[f.category]} (${f.match})`).join('; ');
      // With nobody to answer, an ask cannot be confirmed; a denial that says what to do instead keeps the run going.
      if (cfg.headless) {
        const alt = [...new Set(found.map((f) => ALTERNATIVES[f.category]))].join(' ');
        return out('deny', `foreman: this command ${what}, and this run has no one to confirm it, so it was not run. ${alt} Mention it in your final report so the user can run it.`);
      }
      return out('ask', `foreman: this command ${what}. Confirm it is intended.`);
    }
  }
  return null;
}

// ---------- activation (UserPromptSubmit) ----------

// A request that will take several steps is where the long-task skill pays off, and where it is
// most often skipped. This is a heuristic on the prompt text, with no model call: action verbs,
// scope words, a list of requirements and length count for it; questions and small fixes against.
const ACTION = /\b(implement\w*|build|create|develop|add|refactor\w*|migrat\w*|rewrite|port|integrat\w*|set\s+up|convert|redesign|implement[ae]r?|implemente|cri[ea]r?|desenvolv\w+|constru\w+|adicion\w+|refator\w+|migr[ae]r?|reescrev\w+|integr[ae]r?|configur[ae]r?|mont[ae]r?|fa[cç]a|fazer|transform\w+)\b/i;
const SCOPE = /\b(feature|module|system|api|endpoints?|crud|app|application|service|pipeline|tests?|end[- ]to[- ]end|whole|entire|several|multiple|all the|funcionalidade|m[oó]dulo|sistema|aplica[cç][aã]o|servi[cç]o|testes?|todo o|toda a|todos os|todas as|v[aá]rios|v[aá]rias|completo|completa|tela|telas|banco de dados|database|backend|frontend|autentica\w+|authentication)\b/gi;
const SMALL = /\b(typo|rename|one[- ]line|quick|small|tiny|just|only|simple|s[oó]|apenas|r[aá]pid[oa]|pequen[oa]|simples|uma linha|renomei\w*)\b/i;
const QUESTION = /^(what|how|why|where|when|which|who|is|are|does|do|can|could|should|o que|como|por ?que|onde|quando|qual|quais|quem|existe|tem|pode|posso|devo|seria)\b/i;

function taskScore(prompt) {
  const p = String(prompt || '').trim();
  if (!p || p.startsWith('/') || p.length < 40) return 0;
  const action = ACTION.test(p);
  if (!action && (QUESTION.test(p) || /\?\s*$/.test(p))) return 0;
  let score = action ? 2 : 0;
  score += Math.min(3, new Set((p.match(SCOPE) || []).map((x) => x.toLowerCase())).size);
  if ((p.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) || []).length >= 3) score += 2;
  // The same list written inline: "Add X: a, b, c and d".
  else if (p.includes(':') && p.slice(p.indexOf(':') + 1).split(/[,;]/).filter((x) => x.trim().split(/\s+/).length >= 2).length >= 3) score += 2;
  if (p.length > 300) score += 1;
  if (p.length > 800) score += 1;
  if ((p.match(/[\w./-]+\.[a-z]{1,5}\b/gi) || []).length >= 3) score += 1;
  if (SMALL.test(p)) score -= 2;
  return score;
}

const TASK_THRESHOLD = 4;
// From this score the request is clearly long (a list of requirements plus scope words, or a long spec):
// the decision step is skipped and long-task is asked for directly.
const DIRECT_THRESHOLD = 7;
const isLargeTask = (prompt) => taskScore(prompt) >= TASK_THRESHOLD;

// Text added by a hook is written as a statement about the request and the project, not as a numbered
// order: injected orders can be taken for prompt injection and shown to the user instead of used.
// What must hold every time is not left to this text; the plan gate below enforces it.
function skillNames() {
  try {
    return fs.readdirSync(path.join(__dirname, '..', 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(__dirname, '..', 'skills', d.name, 'SKILL.md')))
      // A skill only the user can run cannot be the answer to "call the Skill tool".
      .filter((d) => !/^disable-model-invocation:\s*true\s*$/m.test(fs.readFileSync(path.join(__dirname, '..', 'skills', d.name, 'SKILL.md'), 'utf8').split(/^---\s*$/m)[1] || ''))
      // claude-md is pointed to by its own Stop check; it is not a way to start a task.
      .filter((d) => d.name !== 'claude-md')
      .map((d) => d.name).sort();
  } catch (_) { return ['long-task']; }
}

const GATE_NOTE = ' Code edits of such a request are held until PLAN.md exists or plan mode was used; PLAN.md, GOAL.md and PROGRESS.md can always be written.';

// The decision step (one YES/NO line per skill, then the Skill call for each YES) is kept: it is what made
// the skill run in the measured sessions. It is described as how this project works, not given as an order.
function longTaskHint(score = TASK_THRESHOLD, gate = false) {
  return `foreman: this request scored ${score} on the multi-step check (threshold ${TASK_THRESHOLD}). ` +
    `Skills this project has for such requests: (${skillNames().join(', ')}). ` +
    'In this project a request like this is answered first with one line per skill, "<name> - YES or NO - <reason>", ' +
    'and each YES is loaded with the Skill tool before files are read or changed. ' +
    'long-task writes PLAN.md and goes on with the work, which pays off when the steps are still open; a request that already lists its steps is usually done directly. ' +
    'completion-criteria writes GOAL.md when the result needs proof.' + (gate ? GATE_NOTE : '');
}

function longTaskDirect(score = DIRECT_THRESHOLD, gate = false) {
  return `foreman: this request has several steps (score ${score}, threshold ${DIRECT_THRESHOLD} for clearly multi-step work). ` +
    'In this project, tasks like this start with the long-task skill, loaded with the Skill tool before other tools; it writes PLAN.md, ' +
    'shows its stages to the user and goes on without waiting for approval, and calls completion-criteria when there is no GOAL.md. ' +
    'When the user asked to skip planning, the plan is skipped and the user is told in one line.' + (gate ? GATE_NOTE : '');
}

// A request that asks for done criteria by name is what the completion-criteria skill is for.
const CRITERIA = /\b(?:crit[eé]rios?\s+de\s+(?:conclus[aã]o|aceita[cç][aã]o|pronto|sucesso)|defini[cç][aã]o\s+de\s+(?:pronto|conclu[ií]do)|done\s+criteria|definition\s+of\s+done|acceptance\s+criteria|completion\s+criteria|success\s+criteria)\b/i;
const CRITERIA_HINT = 'foreman: this request asks for completion criteria. In this project they are written by the completion-criteria skill, ' +
  'loaded with the Skill tool before other tools; it writes GOAL.md with the evidence each criterion needs, and the work follows it.';

const LONG_TASK_HINT = longTaskHint();
const LONG_TASK_DIRECT = longTaskDirect();
const SKILLS_HINT = 'foreman: this project has skills for how work is done: long-task for multi-step work (plan first, PLAN.md) ' +
  'and completion-criteria for results that need proof (GOAL.md).';

// ---------- grounding (UserPromptSubmit + Stop) ----------

// A question about the project is answered from the files, and a research request from pages actually opened.
// Measured without the plugin (Haiku, 03/11): 3 of 6 project questions were answered without reading the code
// (two were taken as questions about Claude Code itself), 0 of 2 re-read a file that changed after it was read,
// and 2 of 4 research answers cited a link that was in no search or fetch result. The statement below names the
// project; the Stop check is what holds every time. Rules on the text, no model call; precision before coverage.
const SYSTEM_PROMPT = /^\s*<[a-z][\w-]*[\s>]/i;   // <task-notification>, <scheduled-task>…: turns Claude Code starts on its own
const ASK = /^(?:what|how|why|where|when|which|who|whose|is|are|does|do|did|can|could|should|will|o\s+que|como|por\s*que|porque|onde|quando|qual|quais|quem|existe|existem|tem|h[aá]|esse|essa|este|esta|isso|isto)\b/i;
const CONCEPT = /^(?:o\s+que\s+(?:[eé]|s[aã]o|significa)\s+(?:um|uma|o|a|os|as)?\s*\S|what\s+(?:is|are|does)\s+(?:an?|the)?\s*\S+(?:\s+\S+)?\s*\??$|what(?:'s|\s+is)\s+the\s+difference|qual\s+(?:[eé]\s+)?a\s+diferen[cç]a|explique\s+o\s+(?:que\s+[eé]|conceito))/i;
const ABOUT_TOOL = /\b(?:claude(?:\s+code)?|anthropic|plugins?|skills?|mcp|hooks?\s+do\s+claude|subagent\w*|modelo\s+de\s+linguagem|llm|chatgpt|gpt)\b/i;
// Strong anchor: the prompt names this project, a `span` or a path. Weak: a bare name.ext, which is also how products are written (Node.js, Vue.js).
const STRONG_ANCHOR = /\b(?:(?:neste|nesse|deste|desse|no|do|este|esse|nosso|nossa)\s+(?:projeto|repo|reposit[oó]rio|c[oó]digo|app|aplicativo|sistema|m[oó]dulo)|(?:this|our|the)\s+(?:project|repo|repository|codebase|code|app)|in\s+the\s+code)\b|`[^`]+`|[\w-]+\/[\w./-]+/i;
const FILE_ANCHOR = /\b[\w-]+\.(?:js|jsx|ts|tsx|py|go|rs|java|cs|rb|php|json|md|css|html|yml|yaml|toml|sql|vue|svelte)\b/i;
const PROJECT_ANCHOR = { test: (p) => STRONG_ANCHOR.test(p) || FILE_ANCHOR.test(p) };
const SEARCH_VERB = /\b(?:pesquis\w*|procur[ae]\w*|busqu\w*|busca[rs]?\b|investigu\w*|research\w*|look\s+up|search(?:\s+for|\s+the\s+web)?)\b/i;
const IN_CODE = /\b(?:no\s+c[oó]digo|no\s+projeto|no\s+repo\w*|nos\s+arquivos|in\s+the\s+(?:code|repo\w*|project|codebase))\b/i;
const EXTERNAL = /\b(?:internet|web|online|google|fontes?|refer[eê]ncias?|documenta[cç][aã]o\s+oficial|docs?\s+oficia\w+|official\s+docs?|papers?|artigos?|estudos?|sources?|articles?|studies)\b/i;
const FRESH = /\b(?:vers[aã]o\s+(?:mais\s+)?(?:recente|atual|nova|est[aá]vel)|latest\s+(?:stable\s+)?version|latest\s+release|current\s+version|pre[cç]o|price|pricing|quanto\s+custa|how\s+much\s+(?:does|is)|lan[cç]ad\w+|released|ainda\s+(?:[eé]|existe|funciona|suporta)|still\s+(?:supported|exists|works)|deprecated|descontinuad\w+)\b/i;

// 'project', 'research' or null.
function questionClass(prompt, root) {
  const p = String(prompt || '').trim();
  if (p.length < 12 || p.startsWith('/') || SYSTEM_PROMPT.test(p) || taskScore(p) >= TASK_THRESHOLD) return null;
  const words = p.split(/\s+/).length;
  if (SEARCH_VERB.test(p)) {
    if (IN_CODE.test(p)) return 'project';
    if (EXTERNAL.test(p) || !STRONG_ANCHOR.test(p)) return 'research';
    return 'project';
  }
  // A question mark anywhere: follow-ups such as "e agora, qual é o valor? responda com o número" end in an instruction.
  const asks = ASK.test(p) || (/\?/.test(p) && words >= 4);
  if (!asks) return null;
  const anchored = PROJECT_ANCHOR.test(p);
  if (FRESH.test(p) && !STRONG_ANCHOR.test(p)) return 'research';
  if (ABOUT_TOOL.test(p) && !anchored) return null;
  if (CONCEPT.test(p) && !anchored) return null;
  if (anchored) return 'project';
  // No subject named: in a project folder, a question about "the timer" or "the history" is about this project.
  return root && isProjectFolder(root) ? 'project' : null;
}

function isProjectFolder(root) {
  return ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile']
    .some((f) => fs.existsSync(path.join(root, f)));
}

function groundingText(cls, root, cfg) {
  if (cls === 'project') {
    return `foreman: this is a question about the project in this folder (${path.basename(root)}); questions that name no other subject refer to it. ` +
      'In this project, answers about the code come from files read for this answer and quote file:line; a file read earlier may have changed since, and is read again. ' +
      'When the code does not show the answer, the answer says so.';
  }
  const domains = (cfg.researchDomains || []).filter(Boolean);
  return 'foreman: this is a research request. In this project, research answers cite only pages opened or returned by WebSearch/WebFetch in this session, ' +
    'prefer primary sources (official documentation, papers, the project\'s own repository)' + (domains.length ? `, here ${domains.join(', ')}` : '') +
    ', and say when a source could not be found or opened.';
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const normUrl = (u) => u.replace(/[.,;:!?*_]+$/, '').split('#')[0].replace(/\/+$/, '').replace(/^http:\/\//i, 'https://').replace(/^https:\/\/www\./i, 'https://').toLowerCase();
const MENTION_RE = /(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[a-zA-Z]{1,5}\b/g;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LSP', 'Task', 'Agent']);
const READ_CMD = /^(?:cat|head|tail|less|more|grep|egrep|rg|ag|sed|awk|ls|dir|find|tree|wc|type|get-content|gc|select-string|git)$/i;

// What the whole session saw: the text of every tool result and prompt (links count as seen), the last read of each file, and the last answer.
function sessionFacts(transcriptPath) {
  const text = transcriptPath && readTail(transcriptPath);
  if (!text) return null;
  const facts = { seen: '', reads: {}, mentions: {}, answer: '' };
  const pending = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || o.isSidechain || !o.message) continue;
    const t = Date.parse(o.timestamp || '') || 0;
    const c = o.message.content;
    if (o.type === 'user') {
      if (typeof c === 'string') facts.seen += '\n' + c;
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text') facts.seen += '\n' + b.text;
          if (b.type === 'tool_result') {
            facts.seen += '\n' + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''));
            const f = pending[b.tool_use_id];
            if (typeof f === 'string') facts.reads[f] = Math.max(facts.reads[f] || 0, t);
            else if (f) {
              // Grep, Glob and shell reads show file contents too: every relative path in their output counts as read then.
              const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
              for (const m of out.slice(0, 20000).match(MENTION_RE) || []) facts.mentions[m] = Math.max(facts.mentions[m] || 0, t);
            }
          }
        }
      }
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'tool_use' && b.name === 'Read' && b.input && b.input.file_path) pending[b.id] = path.resolve(String(b.input.file_path));
        else if (b.type === 'tool_use' && (READ_TOOLS.has(b.name) || b.name === 'Bash' || b.name === 'PowerShell')) pending[b.id] = { tool: b.name };
        // A page fetched by URL, also with curl or wget, was opened.
        if (b.type === 'tool_use' && b.input && (b.name === 'WebFetch' || b.name === 'Bash' || b.name === 'PowerShell')) facts.seen += '\n' + String(b.input.url || b.input.command || '');
        if (b.type === 'text' && b.text) facts.answer = b.text;
        if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') facts.seen += '\n' + JSON.stringify(b.content || '');
      }
    }
  }
  return facts;
}

function readThisTurn(calls) {
  return calls.some((c) => READ_TOOLS.has(c.name) ||
    ((c.name === 'Bash' || c.name === 'PowerShell') && segments(c.input.command).some((seg) => READ_CMD.test((words(seg)[0] || '').split(/[\\/]/).pop()))));
}

// Paths the answer names (with a folder and an extension) that are not in the project.
function missingPaths(answer, root, seen) {
  const out = new Set();
  const text = String(answer || '').replace(URL_RE, ' ');
  for (const m of text.matchAll(/(?:^|[\s`'"(\[])((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[a-z0-9]{1,6})(?::\d+(?:[-–]\d+)?)?(?=$|[\s`'"),.;:\]])/gim)) {
    const f = m[1];
    if (/node_modules|^~|^\/(?:home|users|tmp|etc|usr|var)\//i.test(f) || seen.includes(f)) continue;
    const abs = path.isAbsolute(f) ? f : path.join(root, f);
    if (!fs.existsSync(abs)) out.add(f);
  }
  return [...out];
}

function unseenLinks(answer, seen) {
  const have = new Set((seen.match(URL_RE) || []).map(normUrl));
  const out = [];
  for (const u of new Set((String(answer || '').match(URL_RE) || []).map(normUrl))) {
    if (have.has(u)) continue;
    if ([...have].some((h) => h.startsWith(u + '/') || u.startsWith(h + '/'))) continue;
    out.push(u);
  }
  return out;
}

// Asked at most once per request, never while already continuing because of a Stop hook.
function groundingReason(input, root, cfg, state) {
  if (cfg.grounding !== true || input.stop_hook_active) return null;
  const q = state.question;
  const calls = turnCalls(input.transcript_path);
  if (!calls) return null;
  const webTurn = calls.some((c) => /^Web(?:Search|Fetch)$/.test(c.name));
  const cls = q && q.prompt === hashText(calls.prompt) ? q.cls : null;
  if (!cls && !webTurn) return null;
  const facts = sessionFacts(input.transcript_path);
  if (!facts) return null;
  const answer = input.last_assistant_message || facts.answer;
  const problems = [];
  if (cls === 'project') {
    if (!readThisTurn(calls)) {
      const seenAt = { ...facts.reads };
      for (const [m, t] of Object.entries(facts.mentions)) {
        const f = path.resolve(root, m);
        if (!path.relative(root, f).startsWith('..') && fs.existsSync(f)) seenAt[f] = Math.max(seenAt[f] || 0, t);
      }
      const changed = Object.entries(seenAt).filter(([f, t]) => { try { return fs.statSync(f).mtimeMs > t + 1000; } catch (_) { return false; } }).map(([f]) => path.basename(f));
      if (!Object.keys(seenAt).length) problems.push('the answer above about this project was written without reading any of its files');
      else if (changed.length) problems.push(`the answer above was written without reading files in this turn, and ${changed.slice(0, 3).join(', ')} changed after it was last read`);
    }
    const missing = missingPaths(answer, root, facts.seen);
    if (missing.length) problems.push(`${missing.slice(0, 5).join(', ')} ${missing.length > 1 ? 'do' : 'does'} not exist in this project`);
  }
  if (cls === 'research' || webTurn) {
    const links = unseenLinks(answer, facts.seen);
    if (links.length) problems.push(`these links are in no search or fetch result of this session: ${links.slice(0, 5).join(', ')}`);
  }
  if (!problems.length) return null;
  if (inShadow(cfg, 'grounding')) { recordShadow('grounding', input.session_id, { problems }); return null; }
  if (bumpCount(input.session_id, 'ground:' + hashText(calls.prompt)) > 1) return null;
  return `foreman: ${problems.join('; ')}. Check against the files or open the pages, then send the corrected answer in one short message, ` +
    'saying what changed; when a source cannot be found, say so instead of citing it.';
}

const hashText = (t) => crypto.createHash('sha1').update(String(t || '').trim()).digest('hex').slice(0, 12);

// ---------- CLAUDE.md that names what no longer exists (Stop) ----------

// CLAUDE.md is read in every session, so a command or path it names that a turn renamed or removed misleads every later
// session. Checked only after a turn that could have caused it: package.json or a config edited, or files moved or removed.
const STRUCTURE_CMD = /^(?:mv|git|rm|rmdir|del|rd|move|ren|rename|remove-item|move-item|rename-item)$/i;
const RUNNER = /\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g;
const RUNNER_BUILTIN = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'init', 'create', 'exec', 'dlx', 'x', 'publish', 'pack', 'link', 'audit', 'outdated', 'why', 'list', 'ls', 'config', 'cache', 'run', 'start', 'test', 't', 'version', 'help', 'login', 'logout', 'whoami', 'info', 'view', 'global', 'workspace', 'workspaces', 'dedupe', 'prune', 'rebuild', 'set', 'npx', 'patch', 'store']);

function instructionFiles(root) {
  const out = ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
  try { for (const f of fs.readdirSync(path.join(root, '.claude', 'rules'))) if (/\.md$/i.test(f)) out.push(path.join(root, '.claude', 'rules', f)); } catch (_) { /* none */ }
  if (!out.length && fs.existsSync(path.join(root, 'AGENTS.md'))) out.push(path.join(root, 'AGENTS.md'));
  return out;
}

function touchedStructure(calls) {
  return calls.some((c) => {
    const f = path.basename(String(c.input.file_path || '')).toLowerCase();
    if (EDIT_TOOLS.has(c.name) && (f === 'package.json' || /^(?:tsconfig|vite|webpack|jest|vitest|eslint|babel|next|nuxt|rollup|turbo)\b.*\.(?:json|js|cjs|mjs|ts)$|^\.eslintrc|^makefile$|^pyproject\.toml$/.test(f))) return true;
    if (c.name === 'Bash' || c.name === 'PowerShell') {
      return segments(c.input.command).some((seg) => {
        const ws = words(seg);
        const cmd = (ws[0] || '').split(/[\\/]/).pop();
        return STRUCTURE_CMD.test(cmd) && (cmd.toLowerCase() !== 'git' || /^(?:mv|rm)$/i.test(ws[1] || ''));
      }) || shellEdits(c.input.command).some((x) => path.basename(x).toLowerCase() === 'package.json');
    }
    return false;
  });
}

// Folders below the root that are projects of their own (a repository or a package), up to two levels down:
// in a folder of several projects, CLAUDE.md names paths and scripts relative to them.
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'deno.json'];
function nestedProjects(root, depth = 0, out = []) {
  if (depth >= 2) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);
    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) out.push(dir);
    nestedProjects(dir, depth + 1, out);
    if (out.length > 50) break;
  }
  return out;
}

// Commands and paths the instruction files name that do not exist now: [{file, item}].
// A path counts as existing when it is found from the root, from the instruction file's folder or from any
// project folder below the root; a script, when any of their package.json files defines it.
function staleInstructions(root) {
  const nested = nestedProjects(root);
  let scripts = null;
  for (const dir of [root, ...nested]) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg && pkg.scripts) { scripts = scripts || new Set(); for (const k of Object.keys(pkg.scripts)) scripts.add(k); }
  }
  const out = [];
  for (const file of instructionFiles(root)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const name = path.relative(root, file) || path.basename(file);
    for (const span of text.match(/`[^`\n]+`/g) || []) {
      const inner = span.slice(1, -1).trim();
      if (scripts) {
        for (const m of inner.matchAll(RUNNER)) {
          const [whole, , script] = m;
          if (!RUNNER_BUILTIN.has(script) && !scripts.has(script) && !/^npx\b/.test(whole)) out.push({ file: name, item: whole.trim() });
        }
      }
      if (/^[\w@.-]*(?:\/[\w@.-]+)+\/?$|^[\w@-]+\.(?:js|jsx|ts|tsx|py|go|rs|json|md|toml|ya?ml|sh|ps1|css|html|sql)$/.test(inner) && !/[*<>{}$]/.test(inner) && !/^https?:/.test(inner)) {
        const bases = [root, path.dirname(file), ...nested];
        if (!bases.some((b) => fs.existsSync(path.join(b, inner)))) out.push({ file: name, item: inner });
      }
    }
  }
  const seenItems = new Set();
  return out.filter((x) => !seenItems.has(x.file + x.item) && seenItems.add(x.file + x.item));
}

function claudeMdReason(input, root, cfg) {
  if (cfg.claudeMd === false || input.stop_hook_active) return null;
  const calls = turnCalls(input.transcript_path);
  if (!calls || !touchedStructure(calls)) return null;
  const stale = staleInstructions(root);
  if (!stale.length) return null;
  if (inShadow(cfg, 'claudemd')) { recordShadow('claudemd', input.session_id, { stale }); return null; }
  if (bumpCount(input.session_id, 'claudemd:' + hashText(calls.prompt)) > 1) return null;
  const list = stale.slice(0, 5).map((x) => `${x.file} names \`${x.item}\``).join('; ');
  return `foreman: after this turn, ${list}, which no longer exists. The claude-md skill updates such a line (one line changed, nothing else rewritten).`;
}

// ---------- plan gate (UserPromptSubmit + PreToolUse) ----------

// A rule that must hold every time belongs in a hook, not in a hint. When a request scores as multi-step,
// its code edits are denied, with the reason, until PLAN.md is written after the request or the session used
// plan mode. The task files are never held. The denial offers no way around it (one that did was used as one);
// the user saying to skip the plan turns it off for that request, and after planGateHolds model responses
// with held edits the gate lets go, so a request flagged by mistake never gets stuck.
const SKIP_PLAN = /\b(?:skip(?:ping)?\s+(?:the\s+)?plan(?:ning)?|no\s+plan(?:ning)?|without\s+(?:a\s+)?plan(?:ning)?|sem\s+plan[oe]j?\w*|pul[ae]r?\s+o\s+plan\w*|n[aã]o\s+(?:precisa\s+(?:de\s+)?)?plane?j?\w*)/i;
const PLAN_FREE = new Set(['plan.md', 'goal.md', 'progress.md']);

function readState(session) { return readJson(statePath(session)) || {}; }

function writeState(session, state) {
  const file = statePath(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

// Code files this call would write, or [] for any other call.
function editedCode(toolName, toolInput) {
  const ti = toolInput || {};
  if (toolName === 'Bash' || toolName === 'PowerShell') return shellEdits(ti.command).filter((f) => !PLAN_FREE.has(path.basename(f).toLowerCase()));
  if (!EDIT_TOOLS.has(toolName)) return [];
  const f = String(ti.file_path || ti.notebook_path || '');
  return isCodeFile(f) && !PLAN_FREE.has(path.basename(f).toLowerCase()) ? [f] : [];
}

function planWrittenSince(root, t, cfg = DEFAULTS) {
  try { return fs.statSync(taskFile(root, cfg, 'PLAN.md')).mtimeMs >= t - 1000; } catch (_) { return false; }
}

// Edits sent together in one model response arrive as separate calls within moments of each other; they count as one hold.
const HOLD_WINDOW = 15000;

// Returns the deny for a code edit of a gated request, or null.
function planGateDecision(input, root, cfg, state) {
  const gate = state.gate;
  if (cfg.planGate === false || !gate) return null;
  if (state.planMode || planWrittenSince(root, gate.t, cfg) || now() - gate.t > Number(cfg.goalMaxAgeHours || DEFAULTS.goalMaxAgeHours) * HOUR) {
    delete state.gate;
    return null;
  }
  const files = editedCode(input.tool_name, input.tool_input);
  if (!files.length) return null;
  const limit = Math.max(1, Number(cfg.planGateHolds) || DEFAULTS.planGateHolds);
  if (!gate.last || now() - gate.last > HOLD_WINDOW) {
    if ((gate.holds || 0) >= limit) { delete state.gate; return null; }
    gate.holds = (gate.holds || 0) + 1;
  }
  gate.last = now();
  return { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    `foreman: ${path.basename(files[0])} was not changed. This request was scored as multi-step, and code edits for it are held until there is a plan: ` +
    'PLAN.md written for this request (the long-task skill writes it and goes on) or plan mode used in this session. ' +
    'PLAN.md, GOAL.md and PROGRESS.md are not held. The user can turn this off with "planGate": false in .claude/foreman.json.' };
}

// ---------- plan reminder (PreToolUse) ----------

// The current step of PROGRESS.md: the first open checkbox, else a "next/left" line, else the last line.
function currentStep(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /^[-*]\s*\[\s\]/.test(l)) || lines.find((l) => /^(?:[-*]\s*)?(?:next|left|todo|falta|pr[oó]xim\w*|pendente)\b/i.test(l)) || lines[lines.length - 1];
  return pick ? pick.slice(0, 200) : null;
}

// One line every N calls while the current task has a recent PROGRESS.md, so long runs keep to the plan.
function planReminder(root, cfg, state) {
  const every = Number(cfg.planReminderEvery);
  if (!every || every < 1) return null;
  let text;
  try {
    const file = taskFile(root, cfg, 'PROGRESS.md');
    if (now() - fs.statSync(file).mtimeMs > Number(cfg.goalMaxAgeHours || DEFAULTS.goalMaxAgeHours) * HOUR) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch (_) { return null; }
  const goal = goalFile(root, cfg);
  if (goal && TERMINAL.test(goal.text)) return null;
  state.calls = (state.calls || 0) + 1;
  if (state.calls % every) return null;
  const step = currentStep(text);
  return step ? `foreman: current step in PROGRESS.md: ${step}` : null;
}

// ---------- subagents (SubagentStart) ----------

const SUBAGENT_RULES = 'Working rules from the main session: secret files (.env, keys, credentials) cannot be read and are never committed, so ask the caller for the value you need. ' +
  'If you change code, run the relevant test command before reporting, and report the command and its result. Do not run commands that delete data, rewrite git history or send data out.';

// ---------- verification (Stop) ----------

const CODE_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'rb', 'php', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp',
  'scala', 'sh', 'ps1', 'vue', 'svelte', 'sql', 'dart', 'ex', 'exs', 'lua', 'r', 'm', 'fs', 'clj', 'erl', 'hs', 'ml', 'zig']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const TEST_CMD = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|check|typecheck|verify|ci)\b|npx\s+(?:jest|vitest|mocha|tsc|eslint|playwright|ava|tap)\b|node\s+--test\b|(?:jest|vitest|mocha|pytest|tox|nox|rspec|phpunit|eslint|tsc|ruff|flake8|mypy|pylint|black\s+--check|golangci-lint|rubocop|shellcheck|ctest)\b|python3?\s+-m\s+(?:pytest|unittest|mypy|ruff)\b|go\s+(?:test|vet|build)\b|cargo\s+(?:test|check|clippy|build)\b|(?:mvn|mvnw|\.\/mvnw)\s+\S*\s*(?:test|verify)\b|(?:gradle|gradlew|\.\/gradlew)\s+\S*\s*(?:test|check)\b|dotnet\s+(?:test|build)\b|make\s+(?:test|check|lint)\b|deno\s+(?:test|lint|check)\b|swift\s+test\b|mix\s+test\b|bundle\s+exec\s+rspec\b|composer\s+test\b|Invoke-Pester\b)/i;

// Quoted text and echo/commit messages are not commands: "git commit -m 'fix tests'" ran no test.
function ranTest(command) {
  for (const seg of segments(command)) {
    const ws = words(seg);
    if (/^(echo|printf|write-host|write-output)$/i.test(ws[0] || '') || /^git$/i.test(ws[0] || '')) continue;
    if (TEST_CMD.test(seg.replace(/"[^"]*"|'[^']*'/g, '""'))) return true;
  }
  return false;
}

// The build is the only check some projects have; it counts as a check there, and only there.
const BUILD_CMD = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|npx\s+(?:vite|next|webpack|rollup|esbuild)\s+build)\b/i;

function ranBuild(command) {
  return segments(command).some((seg) => !/^(echo|printf|git)\b/i.test(seg) && BUILD_CMD.test(seg.replace(/"[^"]*"|'[^']*'/g, '""')));
}

// Code files a shell command writes: redirection (> file, >> file), tee, sed -i / perl -i, and cp/mv onto a file.
function shellEdits(command, keep = isCodeFile) {
  const out = [];
  for (const seg of segments(command)) {
    const ws = words(seg).map((w) => w.replace(/^["']|["']$/g, ''));
    for (let i = 0; i < ws.length; i++) {
      const m = /^\d?>>?(.*)$/.exec(ws[i]);
      if (m) { const target = m[1] || ws[i + 1]; if (target && keep(target)) out.push(target); }
    }
    const cmd = (ws[0] || '').split(/[\\/]/).pop();
    const args = ws.slice(1).filter((w) => !w.startsWith('-'));
    if (cmd === 'tee') out.push(...args.filter(keep));
    if ((cmd === 'sed' && ws.some((w) => /^-[a-zA-Z]*i/.test(w) || w === '--in-place' || w.startsWith('--in-place='))) ||
        (cmd === 'perl' && ws.some((w) => /^-[a-zA-Z]*i/.test(w)))) out.push(...args.filter(keep));
    if ((cmd === 'cp' || cmd === 'mv') && args.length >= 2 && keep(args[args.length - 1])) out.push(args[args.length - 1]);
  }
  return out;
}

function isCodeFile(file) {
  const f = String(file || '').replace(/\\/g, '/');
  if (/(^|\/)(docs?|documentation)\//i.test(f)) return false;
  const ext = (f.split('/').pop().match(/\.([^.]+)$/) || [])[1];
  return Boolean(ext && CODE_EXT.has(ext.toLowerCase()));
}

// The project's test command, if one can be found from its files; null exempts the project.
// The test command of the nearest project above the first edited file that has one, up to the root: {cmd, dir}.
function testCommandFor(root, paths = []) {
  for (const p of paths) {
    let dir = path.dirname(path.resolve(root, p));
    while (!path.relative(root, dir).startsWith('..')) {
      const cmd = testCommand(dir);
      if (cmd) return { cmd, dir };
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  const cmd = testCommand(root);
  return cmd ? { cmd, dir: root } : null;
}

function testCommand(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg && pkg.scripts) {
    if (pkg.scripts.test && !/no test specified/.test(pkg.scripts.test)) return 'npm test';
    for (const k of ['lint', 'check', 'typecheck']) if (pkg.scripts[k]) return `npm run ${k}`;
  }
  const buildOnly = pkg && pkg.scripts && pkg.scripts.build ? 'npm run build' : null;
  if (has('pytest.ini') || has('conftest.py') || has('tox.ini')) return 'pytest';
  try { if (/\[tool\.pytest/.test(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'))) return 'pytest'; } catch (_) { /* none */ }
  try { if (fs.readdirSync(path.join(root, 'tests')).some((f) => /^test_.*\.py$|_test\.py$/.test(f))) return 'pytest'; } catch (_) { /* none */ }
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('pom.xml')) return 'mvn test';
  if (has('build.gradle') || has('build.gradle.kts')) return 'gradle test';
  if (has('deno.json') || has('deno.jsonc')) return 'deno test';
  try { if (/^test\s*:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) return 'make test'; } catch (_) { /* none */ }
  try { if (fs.readdirSync(root).some((f) => /\.(csproj|sln)$/.test(f))) return 'dotnet test'; } catch (_) { /* none */ }
  try { if (fs.readdirSync(path.join(root, 'test')).some((f) => /\.test\.[cm]?js$/.test(f))) return 'node --test'; } catch (_) { /* none */ }
  return buildOnly;
}

const TAIL = 4 * 1024 * 1024;

function readTail(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// Tool calls of the current turn: everything after the user's last prompt (tool results do not count as prompts).
const DENIED = /^(?:PreToolUse:\w+ hook error|foreman: )|Confirm it is intended|has been denied|requires (?:manual )?approval|denied by your permission settings/;

function turnCalls(transcriptPath) {
  const text = transcriptPath && readTail(transcriptPath);
  if (!text) return null;
  let calls = [];
  for (const line of text.split('\n')) {
    if (!line || (line.indexOf('"user"') < 0 && line.indexOf('"tool_use"') < 0)) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || o.isSidechain || !o.message) continue;
    const c = o.message.content;
    if (o.type === 'user' && !o.isMeta) {
      const prompt = typeof c === 'string' || (Array.isArray(c) && c.some((b) => b && b.type === 'text') && !c.some((b) => b && b.type === 'tool_result'));
      if (prompt) {
        calls = [];
        calls.prompt = typeof c === 'string' ? c : c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
      } else if (Array.isArray(c)) {
        // A call that was denied never ran: measured, a refused `rm -f` still drew the stale CLAUDE.md reminder.
        for (const b of c) {
          if (!b || b.type !== 'tool_result' || !b.is_error) continue;
          const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          const call = calls.find((x) => x.id === b.tool_use_id);
          if (call && DENIED.test(t)) call.denied = true;
        }
      }
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) if (b && b.type === 'tool_use') calls.push({ id: b.id, name: b.name, input: b.input || {} });
    }
  }
  const ran = calls.filter((x) => !x.denied);
  ran.prompt = calls.prompt;
  return ran;
}

// Code files changed in this turn since the last test or lint run, or null when there are none.
// Files outside the project root (throwaway helper scripts in a temp folder) are not counted.
// Edits made through the shell (sed -i, > file, tee) count too. Where the build is the project's only check
// (testCommand returns "npm run build"), running it counts as a check.
function unverifiedChanges(calls, root, buildCounts = false) {
  const inside = (f) => !root || !path.isAbsolute(f) || !path.relative(root, f).startsWith('..');
  let files = new Map(); // base name -> full path
  for (const c of calls) {
    const f = String(c.input.file_path || c.input.notebook_path || '');
    if (c.name === 'Bash' || c.name === 'PowerShell') {
      const cmd = c.input.command;
      const edited = shellEdits(cmd).filter((x) => inside(path.resolve(root || '.', x)));
      // "sed -i ... && npm test": the edit comes first in the line, the check after it.
      for (const x of edited) files.set(path.basename(x), path.resolve(root || '.', x));
      if (ranTest(cmd) || (buildCounts && ranBuild(cmd))) files = new Map();
    } else if (EDIT_TOOLS.has(c.name) && isCodeFile(f) && inside(f) && !commentOnly(c.name, c.input)) files.set(path.basename(f), path.resolve(root || '.', f));
  }
  if (!files.size) return null;
  return Object.defineProperty([...files.keys()], 'paths', { value: [...files.values()] }); // names, with the full paths alongside
}

// An Edit that only adds or changes comments cannot break a test: measured, a JSDoc line drew a test and lint run.
// # starts a comment only in some languages (in CSS it is a color, in JS a private field).
const HASH_COMMENTS = /\.(?:py|pyi|sh|bash|zsh|rb|pl|r|ps1|ya?ml|toml)$/i;
const stripComments = (s, hash) => String(s || '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(hash ? /(^|\s)#.*$/gm : /(^|\s)\/\/.*$/gm, '$1').replace(/\s+/g, '');
function commentOnly(tool, input) {
  const edits = tool === 'MultiEdit' ? input.edits : tool === 'Edit' ? [input] : null;
  const hash = HASH_COMMENTS.test(String(input.file_path || ''));
  return Array.isArray(edits) && edits.length > 0 && edits.every((e) => e && typeof e.old_string === 'string' && typeof e.new_string === 'string' && stripComments(e.old_string, hash) === stripComments(e.new_string, hash));
}

// ---------- Stop ----------

function goalFile(root, cfg = DEFAULTS) {
  const file = taskFile(root, cfg, 'GOAL.md');
  try { return { file, text: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs }; } catch (_) { return null; }
}

// One task = the "Task:" line of GOAL.md, so evidence added along the way does not reset the count.
function taskKey(text) {
  const m = text.match(/^\s*task\s*:\s*(.+)$/im);
  return crypto.createHash('sha1').update((m ? m[1] : text).trim().toLowerCase()).digest('hex').slice(0, 12);
}

function statePath(session) {
  const safe = String(session || 'no-session').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(foremanHome(), 'state', `${safe}.json`);
}

function bumpCount(session, key) {
  const file = statePath(session);
  const state = readJson(file) || {};
  state[key] = (state[key] || 0) + 1;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
  return state[key];
}

// GOAL.md written by this tool call (edit tools, or a shell edit such as echo >> GOAL.md).
function writesGoal(toolName, toolInput, root, cfg = DEFAULTS) {
  const ti = toolInput || {};
  const dir = taskDir(root, cfg);
  const isGoal = (f) => /^goal\.md$/i.test(path.basename(String(f || ''))) && path.relative(dir, path.dirname(path.resolve(root, String(f)))) === '';
  if (EDIT_TOOLS.has(toolName)) return isGoal(ti.file_path);
  if (toolName === 'Bash' || toolName === 'PowerShell') return shellEdits(ti.command, isGoal).length > 0;
  return false;
}

function goalReason(input, root, cfg, limit, state = readState(input.session_id)) {
  if (inShadow(cfg, 'goal')) return null;
  if (!(state.goalRoots || []).includes(root)) return null;
  const goal = goalFile(root, cfg);
  if (!goal || TERMINAL.test(goal.text)) return null;
  if (now() - goal.mtime > Number(cfg.goalMaxAgeHours || DEFAULTS.goalMaxAgeHours) * HOUR) return null;
  // stop_hook_active (already continuing because of a Stop hook) counts as one more attempt, like any other.
  const n = bumpCount(input.session_id, taskKey(goal.text));
  if (n > limit + 1) return null;
  if (n === limit + 1) return { notice: `foreman: GOAL.md is still open after ${limit} reminders. Stopping; set its Status line when you decide.` };
  return {
    reason: `foreman: GOAL.md has no final status (reminder ${n} of ${limit}). Check each required evidence item against what this session actually produced. ` +
      'Then add one line to GOAL.md and finish: "Status: completed" if all evidence is recorded, ' +
      '"Status: blocked - <what you need from the user>" if you cannot go on without them, ' +
      'or "Status: budget exhausted" if the attempt or spending limit is reached. Do not start new work to satisfy this reminder.',
  };
}

// Asked at most once per turn (never while already continuing because of a Stop hook) and at most `limit` times per session.
function verifyReason(input, root, cfg, limit) {
  if (cfg.verify === false || input.stop_hook_active) return null;
  const calls = turnCalls(input.transcript_path);
  if (!calls) return null;
  const edited = unverifiedChanges(calls, root, false);
  if (!edited) return null;
  // In a folder of several projects the tests are those of the project that holds the edited file.
  const found = testCommandFor(root, edited.paths);
  if (!found) return null; // no test setup to run: asking would be noise
  const files = found.cmd === 'npm run build' ? unverifiedChanges(calls, root, true) : edited;
  if (!files) return null;
  const cmd = found.dir === root ? found.cmd : `cd ${path.relative(root, found.dir).split(path.sep).join('/')} && ${found.cmd}`;
  if (inShadow(cfg, 'verify')) { recordShadow('verify', input.session_id, { files }); return null; }
  // The limit counts per request (the user's prompt), not per session: a new request may need the reminder again.
  const key = 'verify:' + crypto.createHash('sha1').update(String(calls.prompt || '')).digest('hex').slice(0, 12);
  if (bumpCount(input.session_id, key) > limit) return null;
  const list = files.slice(0, 5).join(', ') + (files.length > 5 ? ', …' : '');
  return `foreman: this turn changed code (${list}) and no test or lint command ran after the last change. ` +
    `Run the project's ${found.cmd === 'npm run build' ? 'build' : 'tests'} (likely \`${cmd}\`) and report the command and its result before saying the work is done. ` +
    'If they cannot run here, say why in one line instead.';
}

const LAST_MESSAGE = 'The next message is the last one the user reads, in the language the user writes in: it gives the result of the ' +
  'request itself (what was done, how it was checked) and then, in one line, what this check changed.';

// Returns the Stop hook output, or null to let Claude stop. Both reminders share one block and one limit.
function stopDecision(input, root, cfg = DEFAULTS) {
  const limit = Number(cfg.continuationLimit);
  if (!limit || limit < 1) return null;
  const state = readState(input.session_id);
  const verify = verifyReason(input, root, cfg, limit);
  const ground = groundingReason(input, root, cfg, state);
  const claudeMd = claudeMdReason(input, root, cfg);
  const goal = goalReason(input, root, cfg, limit, state);
  const reasons = [ground, verify, claudeMd, goal && goal.reason].filter(Boolean);
  // Measured: after a reminder, the last message was about the reminder only and the task's own summary was left above it.
  if (reasons.length) return { decision: 'block', reason: `${reasons.join('\n')}\n${LAST_MESSAGE}` };
  return goal && goal.notice ? { systemMessage: goal.notice } : null;
}

// ---------- hooks ----------

// ---------- after /compact (SessionStart, source "compact") ----------

// The summary that replaces the conversation keeps the gist, not the task files the long-task flow relies on.
// GOAL.md, PLAN.md and PROGRESS.md of the current task are put back, each capped, when they are recent.
// A plan approved in plan mode is already put back by Claude Code after compacting, so PLAN.md is then skipped.
const TASK_FILES = ['GOAL.md', 'PLAN.md', 'PROGRESS.md'];
const TASK_FILE_CAP = 3000;

function compactContext(root, cfg = DEFAULTS, skip = []) {
  const maxAge = Number(cfg.goalMaxAgeHours || DEFAULTS.goalMaxAgeHours) * HOUR;
  const parts = [];
  for (const name of TASK_FILES) {
    if (skip.includes(name)) continue;
    const file = taskFile(root, cfg, name);
    let text;
    try {
      if (now() - fs.statSync(file).mtimeMs > maxAge) continue;
      text = fs.readFileSync(file, 'utf8').trim();
    } catch (_) { continue; }
    if (!text) continue;
    if (name === 'GOAL.md' && TERMINAL.test(text)) continue; // a finished task is not carried on
    parts.push(`--- ${name} ---\n${text.length > TASK_FILE_CAP ? `${text.slice(0, TASK_FILE_CAP)}\n[… cut; read ${name} for the rest]` : text}`);
  }
  if (!parts.length) return null;
  return 'foreman: the conversation was compacted. These task files hold the current state of the work ' +
    '(PROGRESS.md says what is done and what is left):\n' + parts.join('\n');
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) { return {}; }
}

function emitContext(event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

function runHook(kind) {
  if (process.env.FOREMAN_TEST_THROW === kind) throw new Error('forced failure for tests');
  const input = readStdin();
  const root = projectRoot(input.cwd);
  const cfg = config(root);
  if (kind === 'pre-tool') {
    const decision = preToolDecision(input.tool_name, input.tool_input, cfg, input.cwd);
    if (decision) {
      const rule = /secrets file/.test(decision.permissionDecisionReason) ? 'secrets' : 'risky';
      if (inShadow(cfg, rule)) { recordShadow(rule, input.session_id, { tool: input.tool_name, decision: decision.permissionDecision }); return; }
      process.stdout.write(JSON.stringify({ hookSpecificOutput: decision }));
      return;
    }
    const state = readState(input.session_id);
    const before = JSON.stringify(state);
    if (input.permission_mode === 'plan') state.planMode = true;
    // The open-goal reminder belongs to the session that wrote GOAL.md, not to every session in the project.
    if (writesGoal(input.tool_name, input.tool_input, root, cfg)) state.goalRoots = [...new Set([...(state.goalRoots || []), root])];
    let out = planGateDecision(input, root, cfg, state);
    if (out && inShadow(cfg, 'plan')) { recordShadow('plan', input.session_id, { tool: input.tool_name }); out = null; }
    const reminder = out ? null : planReminder(root, cfg, state);
    if (JSON.stringify(state) !== before) writeState(input.session_id, state);
    if (out) process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
    else if (reminder) emitContext('PreToolUse', reminder);
  } else if (kind === 'prompt') {
    const score = taskScore(input.prompt);
    // A medium request (score 4 to 6) gets the hint only with "hintMedium": true. In a measured session the hint sent such a
    // request to long-task, which stopped for plan approval and cost more than doing it directly, with the same result.
    const large = score >= (cfg.hintMedium === true ? TASK_THRESHOLD : DIRECT_THRESHOLD);
    // Only a clearly multi-step request is held: in a measured session a medium one that already listed its steps
    // stopped for plan approval and cost more than the same request done directly, with the same result.
    const gate = score >= DIRECT_THRESHOLD && cfg.planGate !== false && !SKIP_PLAN.test(String(input.prompt || ''));
    const state = readState(input.session_id);
    const before = JSON.stringify(state);
    if (input.permission_mode === 'plan') state.planMode = true;
    if (gate && !state.planMode) state.gate = { t: now(), denied: false };
    const cls = cfg.grounding === false ? null : questionClass(input.prompt, root);
    if (cls) state.question = { cls, prompt: hashText(input.prompt) };
    else delete state.question;
    if (JSON.stringify(state) !== before) writeState(input.session_id, state);
    if (cls) {
      if (inShadow(cfg, 'grounding')) recordShadow('grounding', input.session_id, { cls });
      else emitContext('UserPromptSubmit', groundingText(cls, root, cfg));
      return;
    }
    if (cfg.activation !== 'detect') return;
    // Measured: "Antes de começar, escreva os critérios de conclusão" was answered without the skill 2 of 2 times.
    const criteria = !large && CRITERIA.test(String(input.prompt || '')) && skillNames().includes('completion-criteria');
    if (!large && !criteria) return;
    if (inShadow(cfg, 'activation')) { recordShadow('activation', input.session_id, { score, criteria }); return; }
    if (criteria) { emitContext('UserPromptSubmit', CRITERIA_HINT); return; }
    const held = Boolean(state.gate) && !inShadow(cfg, 'plan');
    emitContext('UserPromptSubmit', score >= DIRECT_THRESHOLD && skillNames().includes('long-task') ? longTaskDirect(score, held) : longTaskHint(score, held));
  } else if (kind === 'session-start') {
    const parts = [];
    if (input.source === 'compact' && cfg.compact !== false) parts.push(compactContext(root, cfg, readState(input.session_id).planMode ? ['PLAN.md'] : []));
    if (cfg.activation === 'always' && input.source !== 'resume') parts.push(SKILLS_HINT);
    if (parts.filter(Boolean).length) emitContext('SessionStart', parts.filter(Boolean).join('\n'));
  } else if (kind === 'subagent') {
    if (cfg.subagent !== false) emitContext('SubagentStart', SUBAGENT_RULES);
  } else if (kind === 'stop') {
    const out = stopDecision(input, root, cfg);
    if (out) process.stdout.write(JSON.stringify(out));
  }
}

// ---------- CLI ----------

function cli(args) {
  const cmd = args[0];
  const root = projectRoot(process.cwd());
  const cfg = config(root);
  if (cmd === 'check') {
    const command = args.slice(1).join(' ');
    const d = preToolDecision('Bash', { command }, cfg);
    console.log(d ? `${d.permissionDecision}: ${d.permissionDecisionReason}` : 'no decision (normal permission flow)');
  } else if (cmd === 'task') {
    const prompt = args.slice(1).join(' ');
    const sc = taskScore(prompt);
    console.log(`score ${sc} (thresholds ${TASK_THRESHOLD} hint, ${DIRECT_THRESHOLD} clearly multi-step): ${sc >= DIRECT_THRESHOLD ? 'clearly multi-step' : sc >= TASK_THRESHOLD ? 'hint' : 'no hint'}${sc >= DIRECT_THRESHOLD && cfg.planGate !== false && !SKIP_PLAN.test(prompt) ? '; first code edit held until PLAN.md' : ''}`);
  } else if (cmd === 'ask') {
    const prompt = args.slice(1).join(' ');
    const cls = questionClass(prompt, root);
    console.log(cls ? `${cls}: ${groundingText(cls, root, cfg)}` : 'no grounding statement');
  } else if (cmd === 'stale') {
    const stale = staleInstructions(root);
    console.log(stale.length ? stale.map((x) => `${x.file}: ${x.item}`).join('\n') : 'nothing stale in CLAUDE.md');
  } else if (cmd === 'replay') {
    console.log(require('./replay.js').render(require('./replay.js').replay(args[1], Number(args[2]) || 90)));
  } else if (cmd === 'shadow') {
    // What the rules in shadow mode would have done, by rule, so one can be turned on (or left off) on evidence.
    const days = Number(args[1]) || 30;
    const since = now() - days * 24 * HOUR;
    let rows = [];
    try { rows = fs.readFileSync(path.join(foremanHome(), 'shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.t >= since); } catch (_) { /* none */ }
    if (!rows.length) { console.log(`Nothing recorded in shadow mode in the last ${days} days (shadow now: ${cfg.shadow.join(', ') || 'none'}).`); return; }
    const by = {};
    for (const x of rows) { const b = (by[x.rule] = by[x.rule] || { n: 0, sessions: new Set() }); b.n++; b.sessions.add(x.s); }
    console.log(`Shadow mode, last ${days} days (in shadow now: ${cfg.shadow.join(', ') || 'none'}):`);
    for (const [rule, b] of Object.entries(by)) console.log(`  ${rule}: would have acted ${b.n}x in ${b.sessions.size} sessions`);
  } else if (cmd === 'path') {
    console.log(isSecretPath(args[1], cfg) ? 'secret: blocked' : 'not a secret');
  } else if (cmd === 'config') {
    console.log(`project: ${root}\nuser settings: ${path.join(foremanHome(), 'config.json')}\nproject settings: ${path.join(root, '.claude', 'foreman.json')}\neffective: ${JSON.stringify(cfg, null, 2)}`);
  } else {
    console.log('usage: foreman.js <check "<command>" | path <file> | task "<prompt>" | ask "<prompt>" | stale | config | shadow [days] | replay [transcripts-dir] [days]>');
  }
}

module.exports = {
  isSecretPath, secretInCommand, secretIntoGit, secretInSearch, secretInGrep, secretNames, riskyCommand, preToolDecision, stopDecision, taskKey, config, projectRoot, segments,
  compactContext, questionClass, groundingText, groundingReason, sessionFacts, missingPaths, unseenLinks, staleInstructions, touchedStructure, claudeMdReason, hashText, taskScore, isLargeTask, longTaskHint, longTaskDirect, planGateDecision, editedCode, currentStep, planReminder, SKIP_PLAN, ranTest, ranBuild, shellEdits, isCodeFile, testCommand, testCommandFor, nestedProjects, taskDir, turnCalls, unverifiedChanges, LONG_TASK_HINT, LONG_TASK_DIRECT, DIRECT_THRESHOLD, SKILLS_HINT, SUBAGENT_RULES,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === 'hook') runHook(args[1]);
    else cli(args);
  } catch (err) {
    if (args[0] !== 'hook') throw err;
    process.stderr.write(`foreman: ${err.message}\n`);
    // The secrets check is a gate: if it cannot run, the tool call is denied instead of let through.
    // Other hooks only advise, so their failure must never break the session.
    if (args[1] === 'pre-tool') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: `foreman could not check this call for secret files (${err.message}), so it was blocked. Try again; if it keeps failing, tell the user that the foreman hook is failing.` } }));
    }
  }
}
