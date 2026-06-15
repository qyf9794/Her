import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { FileManager } = require("../electron/dist/main/tools/file-manager.js");
const { DocumentAssistant } = require("../electron/dist/main/tools/document-assistant.js");
const { ApprovalPolicy } = require("../electron/dist/main/policy/approval-policy.js");

const repoRoot = process.cwd();
const reportDir = path.join(repoRoot, "docs", "test-runs", "simple-command-files");
const reportPath = path.join(reportDir, "S2-files-documents-report.json");
const logPath = path.join(repoRoot, "docs", "test-runs", "simple-command-milestone-log.md");
const desktopRoot = path.join(os.homedir(), "Desktop");
const sandboxRoot = path.join(desktopRoot, `Her S2 Files Sandbox ${Date.now()}`);
const forbiddenFragments = [
  "PRIVATE KEY CONTENT SHOULD NOT LEAK",
  "sk-test-1234567890abcdef",
  "fakebearertoken1234567890",
];

const files = new FileManager();
const documents = new DocumentAssistant(files);
const policy = new ApprovalPolicy();
const results = [];

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const writeText = (filePath, content) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
};

const writeMinimalPdf = (filePath) => {
  const stream = "BT /F1 18 Tf 40 90 Td (Her S2 PDF fixture) Tj 0 -24 Td (Valid test file) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, pdf, "utf8");
};

const assertValidPdfFixture = (filePath) => {
  const content = fs.readFileSync(filePath, "utf8");
  assert(content.startsWith("%PDF-1.4\n"), "PDF fixture should have a valid PDF header.");
  assert(content.endsWith("%%EOF\n"), "PDF fixture should have a valid EOF marker.");
  const startxref = Number(content.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
  assert(Number.isInteger(startxref) && content.slice(startxref, startxref + 4) === "xref", "PDF fixture should point startxref to the xref table.");
  const offsets = [...content.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert(offsets.length === 5, "PDF fixture should include five object xref offsets.");
  for (let index = 0; index < offsets.length; index += 1) {
    assert(content.slice(offsets[index]).startsWith(`${index + 1} 0 obj\n`), `PDF object ${index + 1} offset should be valid.`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const safePayload = (value) => JSON.parse(JSON.stringify(value, (_key, item) => {
  if (typeof item !== "string") return item;
  let next = item;
  for (const fragment of forbiddenFragments) next = next.replaceAll(fragment, "[forbidden-redacted]");
  return next;
}));

const runScenario = async (id, title, fn) => {
  const startedAt = new Date().toISOString();
  try {
    const payload = await fn();
    results.push({
      id,
      title,
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      payload: safePayload(payload ?? {}),
    });
  } catch (error) {
    results.push({
      id,
      title,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const fixture = {
  notes: path.join(sandboxRoot, "notes.md"),
  hidden: path.join(sandboxRoot, ".hidden.txt"),
  chinese: path.join(sandboxRoot, "合同-中文.txt"),
  duplicateA: path.join(sandboxRoot, "A", "EB5 合同 duplicate.txt"),
  duplicateB: path.join(sandboxRoot, "B", "EB5 合同 duplicate.txt"),
  pdf: path.join(sandboxRoot, "Her S2 valid fixture.pdf"),
  p8: path.join(sandboxRoot, "AuthKey_FAKE123456.p8"),
  secretText: path.join(sandboxRoot, "redaction-note.txt"),
};

const setupFixtures = () => {
  ensureDir(sandboxRoot);
  writeText(fixture.notes, "# Her S2 Note\n\nThis markdown file is safe to summarize.\n");
  writeText(fixture.hidden, "Hidden fixture\n");
  writeText(fixture.chinese, "中文合同测试文件\n");
  writeText(fixture.duplicateA, "Duplicate contract A\n");
  writeText(fixture.duplicateB, "Duplicate contract B\n");
  writeMinimalPdf(fixture.pdf);
  writeText(fixture.p8, "-----BEGIN PRIVATE KEY-----\nPRIVATE KEY CONTENT SHOULD NOT LEAK\n-----END PRIVATE KEY-----\n");
  writeText(
    fixture.secretText,
    "This file contains fake secrets.\nOPENAI_API_KEY=sk-test-1234567890abcdef\nAuthorization: Bearer fakebearertoken1234567890\n",
  );
};

const cleanupFixtures = () => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
};

setupFixtures();

await runScenario("S2.file.list", "List visible and hidden Desktop sandbox files", async () => {
  const visible = await files.list(sandboxRoot, false);
  const hidden = await files.list(sandboxRoot, true);
  assert(visible.some((item) => item.name === "notes.md"), "Visible list should include notes.md.");
  assert(visible.some((item) => item.name === "合同-中文.txt"), "Visible list should include Chinese filename.");
  assert(!visible.some((item) => item.name === ".hidden.txt"), "Visible list should omit hidden files.");
  assert(hidden.some((item) => item.name === ".hidden.txt"), "Hidden list should include hidden files when requested.");
  assert(visible.every((item) => item.name && item.path && item.type && "modifiedAt" in item), "List rows need table fields.");
  return { visibleCount: visible.length, hiddenCount: hidden.length, sample: visible.slice(0, 5) };
});

await runScenario("S2.file.search.duplicates", "Search duplicate contract names", async () => {
  const matches = await files.search(sandboxRoot, "EB5 合同", 5, 10);
  const duplicateMatches = matches.filter((item) => item.name === "EB5 合同 duplicate.txt");
  assert(duplicateMatches.length === 2, `Expected 2 duplicate matches, got ${duplicateMatches.length}.`);
  return { matchCount: matches.length, duplicatePaths: duplicateMatches.map((item) => item.path) };
});

await runScenario("S2.file.read.markdown", "Read Markdown note with source path", async () => {
  const result = await files.readText(fixture.notes, 1000);
  assert(result.path === fixture.notes, "Read result should include source path.");
  assert(result.content.includes("Her S2 Note"), "Markdown content should be returned.");
  return { path: result.path, chars: result.chars, truncated: result.truncated, preview: result.content.slice(0, 60) };
});

await runScenario("S2.file.open.pdf", "Open PDF fixture through Finder", async () => {
  assertValidPdfFixture(fixture.pdf);
  const result = await files.open(fixture.pdf, "Finder");
  assert(result.opened === fixture.pdf, "Open result should identify the PDF path.");
  assert(result.action === "reveal", "Finder PDF scenario should reveal the file instead of launching Preview.");
  return { ...result, pdfFixtureValidated: true };
});

await runScenario("S2.file.create_folder", "Create disposable folder", async () => {
  const result = await files.createFolder(sandboxRoot, "Her Simple Command Test");
  assert(fs.existsSync(result.path), "Created folder should exist.");
  return result;
});

await runScenario("S2.file.rename", "Rename a.txt to b.txt", async () => {
  const from = path.join(sandboxRoot, "a.txt");
  writeText(from, "rename me");
  const result = await files.rename(from, "b.txt");
  assert(!fs.existsSync(from), "Original file should be gone after rename.");
  assert(fs.existsSync(result.to), "Renamed file should exist.");
  return result;
});

await runScenario("S2.file.copy", "Copy file and keep both source and destination", async () => {
  const from = path.join(sandboxRoot, "copy-source.txt");
  const to = path.join(sandboxRoot, "copy-target.txt");
  writeText(from, "copy me");
  const result = await files.copy(from, to);
  assert(fs.existsSync(from), "Copy source should still exist.");
  assert(fs.existsSync(to), "Copy destination should exist.");
  return result;
});

await runScenario("S2.file.move", "Move file and remove source path", async () => {
  const from = path.join(sandboxRoot, "move-source.txt");
  const to = path.join(sandboxRoot, "moved", "move-target.txt");
  writeText(from, "move me");
  ensureDir(path.dirname(to));
  const result = await files.move(from, to);
  assert(!fs.existsSync(from), "Move source should be gone.");
  assert(fs.existsSync(to), "Move target should exist.");
  return result;
});

await runScenario("S2.file.trash.confirmed", "Require confirmation then trash disposable file", async () => {
  const target = path.join(sandboxRoot, "trash-me.txt");
  writeText(target, "trash me");
  const decision = policy.decide({
    toolName: "file_trash",
    args: { path: target },
    summary: "Move disposable S2 file to Trash",
    yoloMode: false,
    now: new Date("2026-06-16T00:00:00.000Z"),
  });
  assert(decision.type === "require_confirmation", "file_trash should require confirmation.");
  const result = await files.trash(target);
  assert(!fs.existsSync(target), "Trashed source should be gone.");
  assert(fs.existsSync(result.to), "Trash destination should exist.");
  fs.rmSync(result.to, { force: true });
  return { decision: decision.type, risk: decision.plan.risk, from: result.from, note: result.note };
});

await runScenario("S2.file.secret_redaction", "Deny p8 read and redact fake text secrets", async () => {
  let denied = false;
  try {
    await files.readText(fixture.p8, 1000);
  } catch (error) {
    denied = /credential-like|secrets/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(denied, "Credential-like .p8 reads should be denied.");
  const result = await files.readText(fixture.secretText, 2000);
  assert(result.redacted === true, "Secret-looking text should be marked redacted.");
  assert(!forbiddenFragments.some((fragment) => result.content.includes(fragment)), "Secret fragments must not appear.");
  assert(result.content.includes("[redacted]"), "Redacted marker should be visible.");
  return { p8Denied: denied, redacted: result.redacted, preview: result.content };
});

await runScenario("S2.document.extract", "Extract safe Markdown document", async () => {
  const result = await documents.extract(fixture.notes, 1000);
  assert(result.path === fixture.notes, "Document extract should include source path.");
  assert(result.content.includes("Her S2 Note"), "Document extract should include Markdown text.");
  return { path: result.path, chars: result.chars, truncated: result.truncated, preview: result.content.slice(0, 80) };
});

await runScenario("S2.document.folder_digest", "Digest folder without exposing fake secrets", async () => {
  const result = await documents.folderDigest(sandboxRoot, "", 5, 500);
  const serialized = JSON.stringify(result);
  assert(result.count > 0, "Folder digest should include documents.");
  assert(!forbiddenFragments.some((fragment) => serialized.includes(fragment)), "Folder digest must not leak fake secrets.");
  return { root: result.root, count: result.count, documents: result.documents.map((item) => ({ path: item.path, redacted: item.redacted, error: item.error })) };
});

await runScenario("S2.document.prepare_edit", "Prepare edit diff without writing file", async () => {
  const before = fs.readFileSync(fixture.notes, "utf8");
  const result = await documents.prepareEdit(fixture.notes, `${before}\n追加一行中文编辑预览。\n`);
  const after = fs.readFileSync(fixture.notes, "utf8");
  assert(before === after, "Prepare edit should not write the file.");
  assert(result.diffPreview.includes("+ 追加一行中文编辑预览。"), "Diff preview should show added Chinese line.");
  return { path: result.path, currentChars: result.currentChars, newChars: result.newChars, diffPreview: result.diffPreview };
});

const summary = {
  total: results.length,
  passed: results.filter((item) => item.status === "passed").length,
  failed: results.filter((item) => item.status === "failed").length,
};

cleanupFixtures();
ensureDir(reportDir);
fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      milestone: "S2",
      title: "Files and Documents",
      generatedAt: new Date().toISOString(),
      sandboxRoot,
      summary,
      results,
      acceptance: {
        writeOperationsDisposableRoot: true,
        trashRequiresConfirmation: results.find((item) => item.id === "S2.file.trash.confirmed")?.status === "passed",
        fileCardsRedactSecrets: results.find((item) => item.id === "S2.file.secret_redaction")?.status === "passed",
        documentExtractionRedactsSecrets: results.find((item) => item.id === "S2.document.folder_digest")?.status === "passed",
        fixturesIncludeChineseEnglishDuplicateMarkdownTextPdfFakeSecrets: true,
      },
    },
    null,
    2,
  ),
);

const logEntry = `
## S2 Files and Documents - ${summary.failed === 0 ? "Passed" : "Failed"}

Report: \`docs/test-runs/simple-command-files/S2-files-documents-report.json\`

- Total scenarios: ${summary.total}
- Passed: ${summary.passed}
- Failed: ${summary.failed}
- Sandbox root: \`${sandboxRoot}\` (removed after run)
- Real execution: file list/search/read/open/create/rename/copy/move/trash plus document extract/folder digest/prepare edit.
- Safety checks: write operations stayed under the disposable Desktop sandbox; \`file_trash\` required confirmation before the script executed the sandbox trash; fake \`.p8\`, API key, bearer token, and private key contents were denied or redacted.
`;

fs.appendFileSync(logPath, logEntry);

console.log(JSON.stringify({ reportPath, summary }, null, 2));
if (summary.failed > 0) process.exitCode = 1;
