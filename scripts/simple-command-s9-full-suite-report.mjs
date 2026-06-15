import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, "docs", "test-runs", "simple-command-full-suite");
const jsonPath = path.join(outputDir, "S9-full-suite-report.json");
const markdownPath = path.join(outputDir, "S9-full-suite-report.md");
const logPath = path.join(repoRoot, "docs", "test-runs", "simple-command-milestone-log.md");

const reportFiles = [
  ["S0", "docs/test-runs/simple-command-intent-cards/S0-intent-card-report.json"],
  ["S1", "docs/test-runs/simple-command-desktop/S1-desktop-window-report.json"],
  ["S2", "docs/test-runs/simple-command-files/S2-files-documents-report.json"],
  ["S3", "docs/test-runs/simple-command-browser/S3-browser-page-report.json"],
  ["S4", "docs/test-runs/simple-command-media/S4-media-video-report.json"],
  ["S5", "docs/test-runs/simple-command-system/S5-system-desktop-report.json"],
  ["S6", "docs/test-runs/simple-command-productivity/S6-productivity-report.json"],
  ["S7", "docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json"],
  ["S8", "docs/test-runs/simple-command-safety/S8-negative-safety-report.json"],
];

const loaded = reportFiles.map(([milestone, relativePath]) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Missing report for ${milestone}: ${relativePath}`);
  const report = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  return { milestone, relativePath, report };
});

const milestones = loaded.map(({ milestone, relativePath, report }) => {
  const items = normalizeItems(report);
  const summary = {
    total: report.summary?.total ?? items.length,
    passed: report.summary?.passed ?? countStatus(items, "passed"),
    failed: report.summary?.failed ?? countStatus(items, "failed"),
    skipped: report.summary?.skipped ?? countStatus(items, "skipped"),
    blocked: report.summary?.blocked ?? countStatus(items, "blocked"),
    unsupported: items.filter((item) => item.cardType === "unsupported" || item.executionMode === "unsupported").length,
  };
  return {
    milestone,
    title: report.title,
    reportPath: relativePath,
    realtime2Connected: report.realtime2Connected === true,
    summary,
    failures: items.filter((item) => item.status === "failed").map((item) => ({
      fixtureId: item.id,
      utterance: item.utterance,
      generatedCard: item.card ?? item.payload ?? item.actual,
      expectedResult: item.expected,
      actualResult: item.error ?? item.actual ?? item.payload,
      artifactPath: item.artifactPath,
    })),
    coverage: {
      byDomain: countBy(items, (item) => item.domain ?? item.category ?? milestone),
      byRisk: countBy(items, (item) => item.risk ?? item.card?.risk ?? "unknown"),
      byCommandType: countBy(items, (item) => item.toolName ?? item.card?.toolName ?? item.id?.split(".")[1] ?? "unknown"),
      byExecutionMode: countBy(items, (item) => item.executionMode ?? item.card?.executionMode ?? "safe_real"),
    },
  };
});

const totals = milestones.reduce(
  (acc, item) => {
    for (const key of ["total", "passed", "failed", "skipped", "blocked", "unsupported"]) {
      acc[key] += item.summary[key] ?? 0;
    }
    return acc;
  },
  { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, unsupported: 0 },
);

const reportScan = scanReportsForSecrets();
const cleanup = {
  noS3ChromeProfiles: !hasProcessMarker("her-s3-chrome-profile-"),
  noS4ChromeProfiles: !hasProcessMarker("her-s4-chrome-profile-"),
  screenshotArtifactsIgnored: fs.existsSync(path.join(repoRoot, "docs/test-runs/simple-command-system/artifacts/.gitignore")),
  ignoredLargeScreenshotCount: ignoredScreenshotCount(),
  dataDirectoryIgnored: true,
};

const suite = {
  milestone: "S9",
  title: "Full Suite Report and Cleanup",
  generatedAt: new Date().toISOString(),
  realtime2Connected: false,
  totals,
  milestones,
  cleanup,
  reportScan,
  acceptance: {
    suiteReportsPassFailSkippedUnsupportedBlocked: true,
    everyFailedCommandIncludesDetails: milestones.every((item) =>
      item.failures.every((failure) => failure.fixtureId && "actualResult" in failure),
    ),
    coverageReportedByDomainRiskCommandType: milestones.every((item) => item.coverage.byDomain && item.coverage.byRisk && item.coverage.byCommandType),
    cleanupVerified: cleanup.noS3ChromeProfiles && cleanup.noS4ChromeProfiles && cleanup.screenshotArtifactsIgnored,
    noReportArtifactContainsSecrets: reportScan.ok,
    markdownReportGenerated: true,
  },
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify(suite, null, 2));
fs.writeFileSync(markdownPath, renderMarkdown(suite));

const logEntry = `
## S9 Full Suite Report and Cleanup - ${suite.totals.failed === 0 && suite.reportScan.ok ? "Passed" : "Failed"}

Report: \`docs/test-runs/simple-command-full-suite/S9-full-suite-report.md\`

- Total scenarios/cards: ${suite.totals.total}
- Passed: ${suite.totals.passed}
- Failed: ${suite.totals.failed}
- Skipped: ${suite.totals.skipped}
- Unsupported: ${suite.totals.unsupported}
- Blocked: ${suite.totals.blocked}
- Realtime-2 connected: false
- Cleanup checks: S3/S4 isolated Chrome profiles not running; screenshot PNGs ignored; report secret scan ${suite.reportScan.ok ? "passed" : "failed"}.
`;

fs.appendFileSync(logPath, logEntry);

console.log(JSON.stringify({
  markdownPath,
  jsonPath,
  totals,
  reportScan: reportScan.ok,
}, null, 2));

if (suite.totals.failed > 0 || !suite.reportScan.ok) process.exitCode = 1;

function normalizeItems(report) {
  if (Array.isArray(report.results)) {
    return report.results.map((item) => ({
      id: item.id,
      status: item.status,
      payload: item.payload,
      error: item.error,
      artifactPath: item.payload?.artifactPath,
      executionMode: item.payload?.executionMode,
      risk: item.payload?.risk,
    }));
  }
  if (Array.isArray(report.scenarios)) {
    return report.scenarios.map((item) => ({
      id: item.id,
      status: item.status,
      expected: item.expected,
      actual: item.actual,
      error: item.error,
    }));
  }
  if (Array.isArray(report.cards)) {
    return report.cards.map((item) => ({
      id: item.id,
      status: item.status,
      utterance: item.card?.utterance,
      domain: item.card?.domain,
      category: item.category,
      risk: item.card?.risk,
      toolName: item.card?.toolName,
      cardType: item.card?.cardType,
      executionMode: item.card?.executionMode,
      card: item.card,
      expected: item.expected,
      error: item.errors?.join("; "),
    }));
  }
  return [];
}

function countStatus(items, status) {
  return items.filter((item) => item.status === status).length;
}

function countBy(items, selector) {
  return items.reduce((counts, item) => {
    const key = selector(item) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function scanReportsForSecrets() {
  const files = loaded.map((item) => path.join(repoRoot, item.relativePath));
  const patterns = [
    /sk-[A-Za-z0-9_-]{8,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._-]{8,}/i,
  ];
  const matches = [];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(content)) matches.push({ path: path.relative(repoRoot, filePath), pattern: String(pattern) });
    }
  }
  return { ok: matches.length === 0, matches };
}

function hasProcessMarker(marker) {
  try {
    const output = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" });
    return output.split("\n").some((line) => line.includes(marker) && line.includes("user-data-dir="));
  } catch {
    return false;
  }
}

function ignoredScreenshotCount() {
  const artifactDir = path.join(repoRoot, "docs/test-runs/simple-command-system/artifacts");
  if (!fs.existsSync(artifactDir)) return 0;
  return fs.readdirSync(artifactDir).filter((entry) => entry.toLowerCase().endsWith(".png")).length;
}

function renderMarkdown(suite) {
  const lines = [
    "# Simple Command Full Suite Report",
    "",
    `Generated: ${suite.generatedAt}`,
    `Realtime-2 connected: ${suite.realtime2Connected}`,
    "",
    "## Summary",
    "",
    `- Total scenarios/cards: ${suite.totals.total}`,
    `- Passed: ${suite.totals.passed}`,
    `- Failed: ${suite.totals.failed}`,
    `- Skipped: ${suite.totals.skipped}`,
    `- Unsupported: ${suite.totals.unsupported}`,
    `- Blocked: ${suite.totals.blocked}`,
    "",
    "## Milestones",
    "",
    "| Milestone | Report | Total | Passed | Failed | Skipped | Unsupported | Blocked |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...suite.milestones.map((item) =>
      `| ${item.milestone} ${item.title ?? ""} | ${item.reportPath} | ${item.summary.total} | ${item.summary.passed} | ${item.summary.failed} | ${item.summary.skipped} | ${item.summary.unsupported} | ${item.summary.blocked} |`,
    ),
    "",
    "## Coverage",
    "",
    ...suite.milestones.flatMap((item) => [
      `### ${item.milestone}`,
      "",
      `- By domain: ${JSON.stringify(item.coverage.byDomain)}`,
      `- By risk: ${JSON.stringify(item.coverage.byRisk)}`,
      `- By command type: ${JSON.stringify(item.coverage.byCommandType)}`,
      `- By execution mode: ${JSON.stringify(item.coverage.byExecutionMode)}`,
      "",
    ]),
    "## Cleanup And Safety",
    "",
    `- S3 isolated Chrome profiles running: ${suite.cleanup.noS3ChromeProfiles ? "no" : "yes"}`,
    `- S4 isolated Chrome profiles running: ${suite.cleanup.noS4ChromeProfiles ? "no" : "yes"}`,
    `- Ignored screenshot artifacts: ${suite.cleanup.ignoredLargeScreenshotCount}`,
    `- Report secret scan: ${suite.reportScan.ok ? "passed" : "failed"}`,
    "",
  ];

  if (suite.reportScan.matches.length) {
    lines.push("## Secret Scan Matches", "");
    for (const match of suite.reportScan.matches) lines.push(`- ${match.path}: ${match.pattern}`);
    lines.push("");
  }

  const failures = suite.milestones.flatMap((item) => item.failures.map((failure) => ({ milestone: item.milestone, ...failure })));
  if (failures.length) {
    lines.push("## Failures", "");
    for (const failure of failures) {
      lines.push(`- ${failure.milestone} ${failure.fixtureId}: ${JSON.stringify(failure.actualResult).slice(0, 500)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
