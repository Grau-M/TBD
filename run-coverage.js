const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      CI: process.env.CI || 'true',
    },
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function pct(covered, total) {
  if (total === 0) {
    return 100;
  }
  return Number(((covered / total) * 100).toFixed(2));
}

function pad(value, width, align = 'left') {
  const text = String(value);
  if (text.length >= width) {
    return text;
  }
  const spaces = ' '.repeat(width - text.length);
  return align === 'right' ? `${spaces}${text}` : `${text}${spaces}`;
}

function scoreClass(score) {
  if (score >= 95) {
    return 'score-excellent';
  }
  if (score >= 80) {
    return 'score-good';
  }
  if (score >= 60) {
    return 'score-warning';
  }
  return 'score-danger';
}

function collectProgramSourceFiles(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') {
        continue;
      }
      files.push(...collectProgramSourceFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith('.ts')) {
      continue;
    }
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts')) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

const EXCLUDED_PROGRAM_FILES = new Set([
  'storageManager.ts',
  'types.ts',
]);

run('npm', ['run', 'compile-tests']);
run('npm', ['run', 'compile']);
run('npx', ['c8', '--clean', '--reporter=json-summary', 'node', './out/test/runTest.js']);

const summaryPath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error('Coverage summary was not generated at coverage/coverage-summary.json.');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const runtimeSourcePrefix = `${path.join(process.cwd(), 'dist', 'tbd-logger', 'src')}${path.sep}`;
const directSourcePrefix = `${path.join(process.cwd(), 'src')}${path.sep}`;

const sourceEntries = Object.entries(summary).filter(
  ([filePath]) => filePath.startsWith(runtimeSourcePrefix) || filePath.startsWith(directSourcePrefix)
);
if (sourceEntries.length === 0) {
  console.error('No extension source files were found in the coverage summary.');
  process.exit(1);
}

const programSourceRoot = path.join(process.cwd(), 'src');
const expectedProgramFiles = collectProgramSourceFiles(programSourceRoot)
  .map((filePath) => path.relative(programSourceRoot, filePath).replace(/\\/g, '/'))
  .filter((filePath) => !EXCLUDED_PROGRAM_FILES.has(filePath))
  .sort((a, b) => a.localeCompare(b));

const runtimeMetricsByFile = new Map();
for (const [filePath, metrics] of sourceEntries) {
  if (!filePath.startsWith(directSourcePrefix)) {
    continue;
  }
  const relativeFile = path.relative(directSourcePrefix, filePath).replace(/\\/g, '/');
  if (!runtimeMetricsByFile.has(relativeFile)) {
    runtimeMetricsByFile.set(relativeFile, metrics);
  }
}

for (const [filePath, metrics] of sourceEntries) {
  if (!filePath.startsWith(runtimeSourcePrefix)) {
    continue;
  }
  const relativeFile = path.relative(runtimeSourcePrefix, filePath).replace(/\\/g, '/');
  runtimeMetricsByFile.set(relativeFile, metrics);
}

const missingCoverageFiles = expectedProgramFiles.filter((filePath) => !runtimeMetricsByFile.has(filePath));

const detailRows = expectedProgramFiles
  .map((displayPath) => {
    const metrics = runtimeMetricsByFile.get(displayPath) || {
      lines: { total: 1, covered: 0 },
      functions: { total: 1, covered: 0 },
      branches: { total: 1, covered: 0 },
      statements: { total: 1, covered: 0 },
    };
    const stmtPct = pct(metrics.statements.covered, metrics.statements.total);
    const branchPct = pct(metrics.branches.covered, metrics.branches.total);
    const funcPct = pct(metrics.functions.covered, metrics.functions.total);
    const linePct = pct(metrics.lines.covered, metrics.lines.total);
    const rowScore = Math.min(stmtPct, branchPct, funcPct, linePct);
    return {
      file: displayPath,
      stmts: stmtPct,
      branch: branchPct,
      funcs: funcPct,
      lines: linePct,
      rowClass: scoreClass(rowScore),
      stmtClass: scoreClass(stmtPct),
      branchClass: scoreClass(branchPct),
      funcClass: scoreClass(funcPct),
      lineClass: scoreClass(linePct),
    };
  })
  .sort((a, b) => a.file.localeCompare(b.file));

const sum = (values) => values.reduce((acc, value) => acc + value, 0);
const linePct = Number((sum(detailRows.map((row) => row.lines)) / detailRows.length).toFixed(2));
const functionPct = Number((sum(detailRows.map((row) => row.funcs)) / detailRows.length).toFixed(2));
const branchPct = Number((sum(detailRows.map((row) => row.branch)) / detailRows.length).toFixed(2));
const statementPct = Number((sum(detailRows.map((row) => row.stmts)) / detailRows.length).toFixed(2));

console.log('\nExtension Runtime Coverage Summary');
console.log(`Lines: ${linePct}%`);
console.log(`Functions: ${functionPct}%`);
console.log(`Branches: ${branchPct}%`);
console.log(`Statements: ${statementPct}%`);

const headers = ['File', '% Stmts', '% Branch', '% Funcs', '% Lines'];
const widths = [52, 9, 10, 9, 9];
const divider = `${'-'.repeat(widths[0])} | ${'-'.repeat(widths[1])} | ${'-'.repeat(widths[2])} | ${'-'.repeat(widths[3])} | ${'-'.repeat(widths[4])}`;

console.log('\nRuntime File Coverage Table');
console.log(
  `${pad(headers[0], widths[0])} | ${pad(headers[1], widths[1], 'right')} | ${pad(headers[2], widths[2], 'right')} | ${pad(headers[3], widths[3], 'right')} | ${pad(headers[4], widths[4], 'right')}`
);
console.log(divider);

for (const row of detailRows) {
  console.log(
    `${pad(row.file, widths[0])} | ${pad(`${row.stmts.toFixed(2)}`, widths[1], 'right')} | ${pad(`${row.branch.toFixed(2)}`, widths[2], 'right')} | ${pad(`${row.funcs.toFixed(2)}`, widths[3], 'right')} | ${pad(`${row.lines.toFixed(2)}`, widths[4], 'right')}`
  );
}

const htmlRows = detailRows
  .map(
    (row) =>
      `<tr class="${row.rowClass}"><td>${row.file}</td><td><span class="score-pill ${row.stmtClass}">${row.stmts.toFixed(2)}%</span></td><td><span class="score-pill ${row.branchClass}">${row.branch.toFixed(2)}%</span></td><td><span class="score-pill ${row.funcClass}">${row.funcs.toFixed(2)}%</span></td><td><span class="score-pill ${row.lineClass}">${row.lines.toFixed(2)}%</span></td></tr>`
  )
  .join('');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Extension Runtime Coverage</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: Segoe UI, sans-serif; margin: 24px; }
    h1, h2 { margin: 0 0 12px; }
    .summary { margin-bottom: 18px; }
    .summary div { margin: 4px 0; }
    .legend { display: flex; gap: 10px; margin: 12px 0 18px; flex-wrap: wrap; }
    .legend .score-pill { font-size: 12px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #9995; padding: 8px 10px; text-align: left; }
    th { background: #8882; }
    tr:hover td { background: #8882; }
    td:nth-child(n+2), th:nth-child(n+2) { text-align: right; }
    .score-pill {
      display: inline-block;
      min-width: 74px;
      padding: 4px 8px;
      border-radius: 999px;
      font-weight: 700;
      text-align: right;
    }
    .score-excellent { background: #1b5e20; color: #e9ffe9; }
    .score-good { background: #2e7d32; color: #f0fff0; }
    .score-warning { background: #f9a825; color: #202020; }
    .score-danger { background: #c62828; color: #fff2f2; }
  </style>
</head>
<body>
  <h1>Extension Runtime Coverage</h1>
  <div class="summary">
    <div><strong>Lines:</strong> ${linePct}%</div>
    <div><strong>Functions:</strong> ${functionPct}%</div>
    <div><strong>Branches:</strong> ${branchPct}%</div>
    <div><strong>Statements:</strong> ${statementPct}%</div>
  </div>
  <h2>Per-file Coverage</h2>
  <div class="legend">
    <span class="score-pill score-excellent">95-100 Excellent</span>
    <span class="score-pill score-good">80-94 Good</span>
    <span class="score-pill score-warning">60-79 Needs Work</span>
    <span class="score-pill score-danger">0-59 High Risk</span>
  </div>
  <table>
    <thead>
      <tr><th>File</th><th>% Stmts</th><th>% Branch</th><th>% Funcs</th><th>% Lines</th></tr>
    </thead>
    <tbody>
      ${htmlRows}
    </tbody>
  </table>
</body>
</html>`;

const htmlReportPath = path.join(process.cwd(), 'coverage', 'extension-runtime-report.html');
fs.mkdirSync(path.dirname(htmlReportPath), { recursive: true });
fs.writeFileSync(htmlReportPath, html, 'utf8');
console.log(`\nWrote HTML coverage table: ${htmlReportPath}`);

const allPerfect =
  linePct === 100 &&
  functionPct === 100 &&
  branchPct === 100 &&
  statementPct === 100;

if (!allPerfect) {
  if (missingCoverageFiles.length > 0) {
    console.error('\nMissing coverage entries for program files:');
    for (const filePath of missingCoverageFiles) {
      console.error(`- ${filePath}`);
    }
  }
  console.error('\nCoverage check failed: extension runtime coverage must be 100% across all metrics.');
  process.exit(1);
}

console.log('\nCoverage check passed: extension runtime is at 100% for all metrics.');
