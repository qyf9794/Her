import { describe, expect, it } from "vitest";

describe("simple command intent-card report", () => {
  it("generates S0 intent cards without Realtime-2 or side effects", async () => {
    const { buildIntentCardReport, validateReport } = await import("../scripts/simple-command-intent-report.mjs");
    const { report, validation } = buildIntentCardReport();

    expect(validation.errors).toEqual([]);
    expect(validateReport(report).ok).toBe(true);
    expect(report.milestone).toBe("S0");
    expect(report.realtime2Connected).toBe(false);
    expect(report.executedRealTools).toBe(false);
    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.byCardType.executable).toBeGreaterThan(0);
    expect(report.summary.byCardType.clarification).toBeGreaterThan(0);
    expect(report.summary.byCardType.denial).toBeGreaterThan(0);
  });
});
