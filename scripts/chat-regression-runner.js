#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const runsRoot = path.join(repoRoot, '.tmp', 'regression-runs');

const CASES = [
  {
    id: 'case-1-table',
    title: 'Markdown table should stay intact',
    prompt: [
      'Please output exactly this markdown and nothing else:',
      '',
      '| col_a | col_b |',
      '|---|---|',
      '| foo | bar |',
      '| left | right |',
    ].join('\n'),
    expected: [
      'A valid rendered table is shown.',
      'First column is not shifted.',
      'No leading pipe is lost.',
      'No random escaping artifacts.',
    ],
  },
  {
    id: 'case-2-underscore',
    title: 'Underscore text should not become subscript',
    prompt: [
      'Please output exactly these lines and nothing else:',
      '',
      'snake_case_identifier',
      'file_name_with_underscores.ts',
      'cost_is_$5_not_math',
      'path_like /tmp/a_b/c_d.ts',
      '',
      'Then output one explicit math block:',
      '',
      '$$E=mc^2$$',
    ].join('\n'),
    expected: [
      'Plain underscore text stays plain text.',
      'No accidental subscript rendering on normal lines.',
      'Explicit math block still renders as math.',
    ],
  },
  {
    id: 'case-3-path-link',
    title: 'File path links should be clickable',
    prompt: [
      'Please output exactly these two paths on separate lines:',
      '',
      'src/chatPanel.ts:100',
      '/Users/bytedance/self-dev/jump/src/extension.ts:20',
    ].join('\n'),
    expected: [
      'Both paths render as clickable links.',
      'Click opens target file near the specified line.',
      'No malformed or partial link text.',
    ],
  },
  {
    id: 'case-4-tool-output',
    title: 'Tool output should be clean (no decorative prefixes)',
    prompt: [
      'Run execute_command with:',
      'ls -la /Users/bytedance/self-dev/jump/src',
      'Then show the command output.',
    ].join('\n'),
    expected: [
      'No repeated decorative leading bars from stream wrappers.',
      'Command output is readable line by line.',
      'Status badges may appear, but output text itself is clean.',
    ],
  },
  {
    id: 'case-5-mixed',
    title: 'Mixed content should not cross-corrupt',
    prompt: [
      'Output in this order:',
      '',
      '1) A markdown table.',
      '2) A plain text line with snake_case_value.',
      '3) A file path src/historyProvider.ts:30.',
      '4) A code block with bash command: ls -la',
    ].join('\n'),
    expected: [
      'Table remains valid.',
      'snake_case line is not treated as math.',
      'Path is clickable.',
      'Code block highlighting and copy button still work.',
    ],
  },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (!cur.startsWith('--')) {
      continue;
    }
    const key = cur.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function timestampRunId() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  return [
    d.getFullYear(),
    p2(d.getMonth() + 1),
    p2(d.getDate()),
    '-',
    p2(d.getHours()),
    p2(d.getMinutes()),
    p2(d.getSeconds()),
    '-',
    p3(d.getMilliseconds()),
  ].join('');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function safeExec(command) {
  try {
    return cp.execSync(command, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    return '';
  }
}

function rel(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function toList(input) {
  if (!input) {
    return [];
  }
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function copyIfExists(src, destDir) {
  if (!src) {
    return null;
  }
  const abs = path.isAbsolute(src) ? src : path.join(repoRoot, src);
  if (!fs.existsSync(abs)) {
    return null;
  }
  ensureDir(destDir);
  const fileName = path.basename(abs);
  const target = path.join(destDir, fileName);
  fs.copyFileSync(abs, target);
  return target;
}

function collectDbgLogs(logDir) {
  const dbgDir = path.join(repoRoot, '.dbg');
  if (!fs.existsSync(dbgDir)) {
    return [];
  }
  const files = fs.readdirSync(dbgDir)
    .filter((name) => name.endsWith('.log') || name.endsWith('.ndjson') || name.endsWith('.txt'))
    .map((name) => path.join(dbgDir, name));
  const copied = [];
  for (const file of files) {
    const out = copyIfExists(file, logDir);
    if (out) {
      copied.push(out);
    }
  }
  return copied;
}

function renderPromptsMd(runId) {
  const lines = [];
  lines.push('# Chat Regression Prompts');
  lines.push('');
  lines.push('Run ID: ' + runId);
  lines.push('');
  for (const c of CASES) {
    lines.push('## ' + c.id + ' - ' + c.title);
    lines.push('');
    lines.push('Prompt:');
    lines.push('');
    lines.push('```text');
    lines.push(c.prompt);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function renderChecklistMd(runId) {
  const lines = [];
  lines.push('# Chat Regression Result Sheet');
  lines.push('');
  lines.push('Run ID: ' + runId);
  lines.push('');
  lines.push('Mark pass/fail and add notes:');
  lines.push('');
  for (const c of CASES) {
    lines.push('## ' + c.id + ' - ' + c.title);
    lines.push('');
    lines.push('- [ ] pass');
    lines.push('- [ ] fail');
    lines.push('- Notes:');
    lines.push('');
    lines.push('Expected:');
    for (const e of c.expected) {
      lines.push('- ' + e);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderResultsJson(runId) {
  const payload = {
    runId,
    createdAt: new Date().toISOString(),
    gitHead: safeExec('git rev-parse --short HEAD'),
    gitBranch: safeExec('git rev-parse --abbrev-ref HEAD'),
    cases: CASES.map((c) => ({
      id: c.id,
      title: c.title,
      status: 'pending',
      notes: '',
      screenshots: [],
    })),
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

function help() {
  console.log('Usage:');
  console.log('  node scripts/chat-regression-runner.js prepare [--run <id>]');
  console.log('  node scripts/chat-regression-runner.js collect --run <id> [--screenshots <a,b>] [--logs <a,b>] [--notes "text"]');
}

function prepare(args) {
  const runId = args.run || timestampRunId();
  const runDir = path.join(runsRoot, runId);

  ensureDir(path.join(runDir, 'artifacts', 'screenshots'));
  ensureDir(path.join(runDir, 'artifacts', 'logs'));

  writeText(path.join(runDir, 'prompts.md'), renderPromptsMd(runId));
  writeText(path.join(runDir, 'results.md'), renderChecklistMd(runId));
  writeText(path.join(runDir, 'results.json'), renderResultsJson(runId));

  const checklistSrc = path.join(repoRoot, 'docs', 'chat-render-regression-checklist.md');
  const checklistText = readText(checklistSrc);
  if (checklistText) {
    writeText(path.join(runDir, 'manual-checklist.md'), checklistText);
  }

  const meta = {
    runId,
    createdAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    cwd: repoRoot,
    gitHead: safeExec('git rev-parse --short HEAD'),
    gitBranch: safeExec('git rev-parse --abbrev-ref HEAD'),
    gitStatusShort: safeExec('git status --short'),
  };
  writeText(path.join(runDir, 'run-meta.json'), JSON.stringify(meta, null, 2) + '\n');

  console.log('Prepared regression run: ' + runId);
  console.log('Run directory: ' + rel(runDir));
  console.log('Prompts file: ' + rel(path.join(runDir, 'prompts.md')));
  console.log('Result sheet: ' + rel(path.join(runDir, 'results.md')));
}

function collect(args) {
  const runId = args.run;
  if (!runId) {
    throw new Error('collect requires --run <id>');
  }

  const runDir = path.join(runsRoot, runId);
  if (!fs.existsSync(runDir)) {
    throw new Error('run directory not found: ' + rel(runDir));
  }

  const screenshotsDir = path.join(runDir, 'artifacts', 'screenshots');
  const logsDir = path.join(runDir, 'artifacts', 'logs');
  ensureDir(screenshotsDir);
  ensureDir(logsDir);

  const copiedScreenshots = [];
  for (const src of toList(args.screenshots)) {
    const out = copyIfExists(src, screenshotsDir);
    if (out) {
      copiedScreenshots.push(out);
    }
  }

  const copiedLogs = [];
  for (const src of toList(args.logs)) {
    const out = copyIfExists(src, logsDir);
    if (out) {
      copiedLogs.push(out);
    }
  }

  copiedLogs.push(...collectDbgLogs(logsDir));

  const summaryLines = [];
  summaryLines.push('# Regression Artifact Summary');
  summaryLines.push('');
  summaryLines.push('Run ID: ' + runId);
  summaryLines.push('Collected At: ' + new Date().toISOString());
  summaryLines.push('');

  summaryLines.push('## Screenshots');
  if (copiedScreenshots.length === 0) {
    summaryLines.push('- none');
  } else {
    for (const p of copiedScreenshots) {
      summaryLines.push('- ' + rel(p));
    }
  }
  summaryLines.push('');

  summaryLines.push('## Logs');
  if (copiedLogs.length === 0) {
    summaryLines.push('- none');
  } else {
    for (const p of copiedLogs) {
      summaryLines.push('- ' + rel(p));
    }
  }
  summaryLines.push('');

  if (args.notes) {
    summaryLines.push('## Notes');
    summaryLines.push(args.notes);
    summaryLines.push('');
  }

  writeText(path.join(runDir, 'artifact-summary.md'), summaryLines.join('\n'));

  console.log('Collected artifacts for run: ' + runId);
  console.log('Summary file: ' + rel(path.join(runDir, 'artifact-summary.md')));
  console.log('Screenshots copied: ' + copiedScreenshots.length);
  console.log('Logs copied: ' + copiedLogs.length);
}

function main() {
  const command = process.argv[2] || 'help';
  const args = parseArgs(process.argv.slice(3));

  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }
  if (command === 'prepare') {
    prepare(args);
    return;
  }
  if (command === 'collect') {
    collect(args);
    return;
  }

  throw new Error('Unknown command: ' + command);
}

try {
  main();
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  console.error('chat-regression-runner error: ' + message);
  process.exitCode = 1;
}
