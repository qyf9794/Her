import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBetaFeedbackExport,
  buildDiagnosticsExport,
  redactDiagnosticValue,
  writeLocalExport,
} from "../../src/main/diagnostics";

describe("diagnostics and beta feedback exports", () => {
  it("redacts secret-like keys and values", () => {
    const redacted = redactDiagnosticValue({
      OPENAI_API_KEY: "sk-secretsecret",
      nested: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        message: "cookie=session-secret and sk-anothersecret",
      },
    });

    const text = JSON.stringify(redacted);
    expect(text).not.toContain("sk-secretsecret");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("session-secret");
    expect(text).toContain("[REDACTED]");
  });

  it("builds diagnostics and feedback without leaking fake secrets", () => {
    const diagnostics = buildDiagnosticsExport({
      appVersion: "0.1.0",
      isPackaged: false,
      userDataDir: "/tmp/her-userdata",
      serverPort: 3939,
      openaiConfigured: true,
      realtimeVoice: "marin",
      updateStatus: { enabled: false },
      settings: { apiKey: "sk-diagnosticsecret" },
      memoryStatus: { total: 0 },
      recentTasks: [{ summary: "Bearer tasksecretvalue" }],
      recentArtifacts: [{ title: "cookie=sessionvalue" }],
    });
    const feedback = buildBetaFeedbackExport({
      message: "I saw sk-feedbacksecret and cookie=sessionvalue",
      diagnostics,
    });

    const text = JSON.stringify(feedback);
    expect(text).not.toContain("sk-diagnosticsecret");
    expect(text).not.toContain("sk-feedbacksecret");
    expect(text).not.toContain("sessionvalue");
    expect(text).toContain("her_beta_feedback");
  });

  it("writes local export files with private permissions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "her-diagnostics-test-"));
    try {
      const result = writeLocalExport(dir, "her-test", { ok: true });
      expect(fs.existsSync(result.path)).toBe(true);
      expect(result.filename).toMatch(/^her-test-/);
      expect(result.bytes).toBeGreaterThan(0);
      expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
