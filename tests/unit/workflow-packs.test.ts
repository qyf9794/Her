import { describe, expect, it } from "vitest";
import { builtInWorkflowPacks } from "../../src/main/workflows/workflow-packs";
import { WorkflowRuntime } from "../../src/main/workflows/workflow-runtime";
import { toolRequiresConfirmation } from "../../src/main/tools/manifest";

const runtime = new WorkflowRuntime({
  executeTool: async (name) => ({ ok: true, name, result: {} }),
  readTask: () => undefined,
  cancelTask: () => undefined,
  rejectConfirmation: async () => undefined,
});

describe("built-in workflow packs", () => {
  it("ships the five M8 signature packs with metadata and rollback notes", () => {
    expect(builtInWorkflowPacks.map((pack) => pack.id)).toEqual([
      "focus_writing",
      "meeting_prep",
      "research_desk",
      "coding_session",
      "file_cleanup",
    ]);

    for (const pack of builtInWorkflowPacks) {
      expect(pack.title).toBeTruthy();
      expect(pack.description).toBeTruthy();
      expect(pack.triggers.length).toBeGreaterThan(0);
      expect(pack.requiredCapabilities.length).toBeGreaterThan(0);
      expect(pack.risks.length).toBeGreaterThan(0);
      expect(pack.steps.length).toBeGreaterThan(0);
      expect(pack.rollbackNotes.length).toBeGreaterThan(0);
      expect(pack.steps.every((step) => step.id && step.title && step.toolName && step.rollbackNote)).toBe(true);
    }
  });

  it("previews each scenario with expected step families and confirmation metadata", () => {
    const focus = runtime.previewPack("focus_writing").preview;
    expect(focus.steps.map((step) => step.toolName)).toEqual(expect.arrayContaining(["file_search", "mac_note_create", "window_minimize_unrelated"]));

    const meeting = runtime.previewPack("meeting_prep").preview;
    expect(meeting.steps.map((step) => step.toolName)).toEqual(expect.arrayContaining(["calendar_search", "app_open", "mac_note_create"]));

    const research = runtime.previewPack("research_desk").preview;
    expect(research.steps.map((step) => step.toolName)).toEqual(expect.arrayContaining(["browser_search_open", "document_folder_digest"]));

    const coding = runtime.previewPack("coding_session").preview;
    expect(coding.steps.map((step) => step.toolName)).toEqual(expect.arrayContaining(["file_search", "coding_agent_start"]));

    const cleanup = runtime.previewPack("file_cleanup").preview;
    expect(cleanup.steps.map((step) => step.toolName)).toEqual(expect.arrayContaining(["file_search", "file_trash"]));
    expect(cleanup.steps.find((step) => step.toolName === "file_trash")).toMatchObject({
      requiresConfirmation: true,
      risk: "local_write",
    });
  });

  it("keeps high-risk workflow steps aligned with tool policy", () => {
    const previews = builtInWorkflowPacks.flatMap((pack) => runtime.previewPack(pack.id).preview.steps);
    for (const step of previews) {
      expect(step.requiresConfirmation).toBe(toolRequiresConfirmation(step.toolName as never));
    }
  });
});
