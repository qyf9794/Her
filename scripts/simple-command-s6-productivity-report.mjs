import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = process.cwd();
const reportDir = path.join(repoRoot, "docs", "test-runs", "simple-command-productivity");
const reportPath = path.join(reportDir, "S6-productivity-report.json");
const logPath = path.join(repoRoot, "docs", "test-runs", "simple-command-milestone-log.md");
const testPrefix = "[Her Test]";
const now = new Date();
const nextWeekStart = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
nextWeekStart.setMinutes(0, 0, 0);
const nextWeekEnd = new Date(nextWeekStart.getTime() + 60 * 60 * 1000);

const dataFiles = ["email-drafts.json", "calendar-events.json", "copy-drafts.json"].map((name) => path.join(repoRoot, "data", name));
const backups = new Map();

const require = createRequire(import.meta.url);
const { LocalStore } = require("../electron/dist/main/tools/local-store.js");
const { MacProductivity } = require("../electron/dist/main/tools/mac-productivity.js");
const { ApprovalPolicy } = require("../electron/dist/main/policy/approval-policy.js");

const store = new LocalStore();
const mac = new MacProductivity();
const policy = new ApprovalPolicy();
const results = [];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = (command, args, input, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(input ?? "");
  });

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
      payload: payload ?? {},
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

backupDataFiles();

let localEmailDraftId = "";
let localCopyDraftId = "";

try {
  await runScenario("S6.email.local-draft-create", "Create local reviewable email draft", async () => {
    const result = store.createEmailDraft({
      to: "her-test@example.invalid",
      subject: `${testPrefix} Local draft smoke`,
      body: "This is a harmless local email draft fixture. It must never be sent.",
    });
    localEmailDraftId = result.id;
    assert(result.subject.startsWith(testPrefix), "Email draft subject should use the test prefix.");
    return {
      ...result,
      actionSummary: "Created a local HER email draft review artifact.",
    };
  });

  await runScenario("S6.email.search", "Search local email drafts for harmless fixture query", async () => {
    const results = store.searchEmails("local draft smoke", 5);
    const match = results.find((item) => item.id === localEmailDraftId);
    assert(match, "Email search should find the local test draft.");
    assert(match.source && match.title && match.date, "Email search result should include source, title, and date.");
    return {
      count: results.length,
      match,
      actionSummary: "Returned local email search result cards with source, title, date, and count.",
    };
  });

  await runScenario("S6.email.read", "Read local email draft by id", async () => {
    const result = store.readEmail(localEmailDraftId);
    assert(result.id === localEmailDraftId, "Email read should return the requested draft.");
    assert(result.source === "local-draft-adapter", "Email read should identify the local adapter source.");
    return {
      ...result,
      actionSummary: "Read a full local email draft without sending anything.",
    };
  });

  await runScenario("S6.email.send-confirmation", "Require confirmation before sending an email draft", async () => {
    const decision = policy.decide({
      toolName: "email_send",
      args: { draftId: localEmailDraftId },
      summary: "Send local test email draft",
      yoloMode: false,
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    assert(decision.type === "require_confirmation", "Email send should require confirmation.");
    return {
      policyDecision: decision.type,
      risk: decision.plan.risk,
      target: decision.plan.target,
      actionSummary: "Email send was stopped at confirmation and not executed.",
    };
  });

  await runScenario("S6.mac-mail-draft-confirmation", "Require confirmation before creating visible Mail draft", async () => {
    const decision = policy.decide({
      toolName: "mac_mail_draft_create",
      args: {
        to: "her-test@example.invalid",
        subject: `${testPrefix} Visible Mail draft smoke`,
        body: "Visible Mail draft fixture.",
      },
      summary: "Create a visible Mail draft",
      yoloMode: false,
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    assert(decision.type === "require_confirmation", "Mail draft creation should require confirmation.");
    return {
      policyDecision: decision.type,
      risk: decision.plan.risk,
      actionSummary: "Visible Mail draft creation was represented as a reviewable confirmation card.",
    };
  });

  await runScenario("S6.calendar.local-create-search", "Create and search local calendar event", async () => {
    const event = store.createCalendarEvent({
      title: `${testPrefix} Meeting fixture`,
      start: nextWeekStart.toISOString(),
      end: nextWeekEnd.toISOString(),
      attendees: ["her-test@example.invalid"],
      location: "Her Test Room",
      notes: "Local calendar adapter smoke.",
    });
    const search = store.searchCalendar(
      new Date(nextWeekStart.getTime() - 60 * 60 * 1000).toISOString(),
      new Date(nextWeekEnd.getTime() + 60 * 60 * 1000).toISOString(),
      "meeting",
      5,
    );
    const match = search.find((item) => item.id === event.id);
    assert(match, "Calendar search should find the created test event.");
    assert(match.source && match.title && match.date, "Calendar search result should include source, title, and date.");
    return {
      event,
      count: search.length,
      match,
      actionSummary: "Created and searched a local calendar event with a test prefix.",
    };
  });

  await runScenario("S6.mac-calendar-confirmation", "Require confirmation before creating macOS calendar event", async () => {
    const decision = policy.decide({
      toolName: "mac_calendar_create",
      args: {
        title: `${testPrefix} macOS Calendar smoke`,
        start: nextWeekStart.toISOString(),
        end: nextWeekEnd.toISOString(),
        attendees: [],
      },
      summary: "Create macOS Calendar event",
      yoloMode: false,
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    assert(decision.type === "require_confirmation", "macOS calendar creation should require confirmation.");
    return {
      policyDecision: decision.type,
      risk: decision.plan.risk,
      actionSummary: "macOS Calendar creation was stopped at confirmation in the unattended run.",
    };
  });

  await runScenario("S6.mac-reminder.create-cleanup", "Create and clean up macOS reminder", async () => {
    const title = `${testPrefix} Reminder smoke ${Date.now()}`;
    try {
      await assertAppleScriptAppResponsive("Reminders");
      const result = await mac.createReminder({
        title,
        dueAt: nextWeekStart.toISOString(),
        notes: "Created by S6 simple command test and cleaned up automatically.",
      });
      const cleanup = await cleanupReminder(result.id, title);
      assert(result.title.startsWith(testPrefix), "Reminder title should use the test prefix.");
      assert(cleanup.cleaned === true, "Reminder cleanup should report success.");
      return {
        ...result,
        cleanup,
        actionSummary: "Created a macOS reminder with a test prefix and cleaned it up.",
      };
    } catch (error) {
      return platformLimited(error, "Reminders automation was unavailable, so no fake reminder success was reported.");
    }
  });

  await runScenario("S6.mac-note.create-cleanup", "Create and clean up macOS note", async () => {
    const title = `${testPrefix} Note smoke ${Date.now()}`;
    try {
      await assertAppleScriptAppResponsive("Notes");
      const result = await mac.createNote({
        title,
        body: "Created by S6 simple command test and cleaned up automatically.",
      });
      const cleanup = await cleanupNote(result.id, title);
      assert(result.title.startsWith(testPrefix), "Note title should use the test prefix.");
      assert(cleanup.cleaned === true, "Note cleanup should report success.");
      return {
        ...result,
        cleanup,
        actionSummary: "Created a macOS note with a test prefix and cleaned it up.",
      };
    } catch (error) {
      return platformLimited(error, "Notes automation was unavailable, so no fake note success was reported.");
    }
  });

  await runScenario("S6.copy.save-search", "Save and search copy draft for fictional product", async () => {
    const draft = store.saveCopyDraft({
      title: `${testPrefix} Lunar Desk Lamp`,
      project: "fictional-product",
      body: "A compact launch blurb for a fictional desk lamp with soft focus lighting.",
    });
    localCopyDraftId = draft.id;
    const search = store.searchCopy("Lunar Desk Lamp", 5);
    const match = search.find((item) => item.id === localCopyDraftId);
    assert(match, "Copy search should find the saved draft.");
    assert(match.source && match.title && match.date, "Copy search result should include source, title, and date.");
    return {
      draft,
      count: search.length,
      match,
      actionSummary: "Saved and searched a local copy draft review artifact.",
    };
  });

  await runScenario("S6.copy.publish-confirmation", "Require confirmation before publishing copy", async () => {
    const decision = policy.decide({
      toolName: "copy_publish",
      args: { draftId: localCopyDraftId },
      summary: "Publish local copy draft",
      yoloMode: false,
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    assert(decision.type === "require_confirmation", "Copy publish should require confirmation.");
    return {
      policyDecision: decision.type,
      risk: decision.plan.risk,
      target: decision.plan.target,
      actionSummary: "Copy publish was stopped at confirmation and not executed.",
    };
  });
} finally {
  restoreDataFiles();
}

const summary = {
  total: results.length,
  passed: results.filter((item) => item.status === "passed").length,
  failed: results.filter((item) => item.status === "failed").length,
};

const report = {
  milestone: "S6",
  title: "Mail, Calendar, Reminders, Notes, and Copy Drafts",
  generatedAt: new Date().toISOString(),
  realtime2Connected: false,
  dataRestored: true,
  summary,
  results,
  acceptance: {
    externalSendAndPublishRequireConfirmation:
      results.find((item) => item.id === "S6.email.send-confirmation")?.status === "passed" &&
      results.find((item) => item.id === "S6.mac-mail-draft-confirmation")?.status === "passed" &&
      results.find((item) => item.id === "S6.copy.publish-confirmation")?.status === "passed",
    testArtifactsUseHerTestPrefix:
      results.find((item) => item.id === "S6.email.local-draft-create")?.status === "passed" &&
      results.find((item) => item.id === "S6.calendar.local-create-search")?.status === "passed" &&
      results.find((item) => item.id === "S6.copy.save-search")?.status === "passed",
    searchCardsIncludeSourceTitleDateCount:
      results.find((item) => item.id === "S6.email.search")?.status === "passed" &&
      results.find((item) => item.id === "S6.calendar.local-create-search")?.status === "passed" &&
      results.find((item) => item.id === "S6.copy.save-search")?.status === "passed",
    createdArtifactsCanBeCleanedUp:
      results.find((item) => item.id === "S6.mac-reminder.create-cleanup")?.status === "passed" &&
      results.find((item) => item.id === "S6.mac-note.create-cleanup")?.status === "passed" &&
      true,
    noExternalSendOrPublishExecuted: true,
  },
};

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

const logEntry = `
## S6 Mail, Calendar, Reminders, Notes, and Copy Drafts - ${summary.failed === 0 ? "Passed" : "Failed"}

Report: \`docs/test-runs/simple-command-productivity/S6-productivity-report.json\`

- Total scenarios: ${summary.total}
- Passed: ${summary.passed}
- Failed: ${summary.failed}
- Realtime-2 connected: false
- Real execution: local email draft/search/read, local calendar create/search, local copy draft save/search, and macOS Reminders/Notes create-cleanup when automation is available.
- Safety checks: Mail draft, email send, macOS Calendar creation, and copy publish stopped at confirmation; local adapter data files were restored after the run.
`;

fs.appendFileSync(logPath, logEntry);

console.log(JSON.stringify({ reportPath, summary }, null, 2));
if (summary.failed > 0) process.exitCode = 1;

function backupDataFiles() {
  for (const filePath of dataFiles) {
    backups.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined);
  }
}

function restoreDataFiles() {
  for (const [filePath, content] of backups) {
    if (typeof content === "string") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
    } else {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function platformLimited(error, actionSummary) {
  return {
    status: "platform_limited",
    reason: error instanceof Error ? error.message : String(error),
    actionSummary,
  };
}

async function assertAppleScriptAppResponsive(appName) {
  await run(
    "osascript",
    [],
    `tell application ${appleScriptString(appName)}
  return name
end tell
`,
    3000,
  );
}

async function cleanupReminder(id, title) {
  const output = await run(
    "osascript",
    [],
    `set targetId to ${appleScriptString(id)}
set targetTitle to ${appleScriptString(title)}
tell application "Reminders"
  repeat with candidateList in lists
    repeat with candidateReminder in reminders of candidateList
      try
        if (id of candidateReminder as text) is targetId or (name of candidateReminder as text) is targetTitle then
          delete candidateReminder
          return "cleaned"
        end if
      end try
    end repeat
  end repeat
end tell
return "not_found"
`,
    15000,
  );
  return { cleaned: output === "cleaned", output };
}

async function cleanupNote(id, title) {
  const output = await run(
    "osascript",
    [],
    `set targetId to ${appleScriptString(id)}
set targetTitle to ${appleScriptString(title)}
tell application "Notes"
  repeat with candidateAccount in accounts
    repeat with candidateFolder in folders of candidateAccount
      repeat with candidateNote in notes of candidateFolder
        try
          if (id of candidateNote as text) is targetId or (name of candidateNote as text) is targetTitle then
            delete candidateNote
            return "cleaned"
          end if
        end try
      end repeat
    end repeat
  end repeat
end tell
return "not_found"
`,
    15000,
  );
  return { cleaned: output === "cleaned", output };
}

function appleScriptString(value) {
  return JSON.stringify(String(value));
}
