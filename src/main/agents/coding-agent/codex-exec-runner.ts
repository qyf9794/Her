import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { config } from "../../config";
import { sanitizeCodexEnv } from "./env-sanitizer";
import { parseCodexJsonLine } from "./jsonl-parser";
import type { CodingAgentSandbox } from "../../../shared/agents/coding-agent";

export type CodexExecRunInput = {
  taskId: string;
  prompt: string;
  cwd: string;
  sandbox: CodingAgentSandbox;
  timeoutMs: number;
  onEvent: (event: { level: "info" | "warning" | "error"; message: string; kind?: string }) => void;
};

export type CodexExecRunResult = {
  exitCode: number | null;
  resultText: string;
};

export class CodexExecRunner {
  private active = new Map<string, ChildProcess>();

  constructor(private command = config.codexCommand) {}

  run(input: CodexExecRunInput): Promise<CodexExecRunResult> {
    const args = [
      "exec",
      "--json",
      "--sandbox",
      input.sandbox,
      "--ask-for-approval",
      "on-request",
      "--ephemeral",
      input.prompt,
    ];
    const child = spawn(this.command, args, {
      cwd: input.cwd,
      env: sanitizeCodexEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active.set(input.taskId, child);

    const finalText: string[] = [];
    let stderrTail = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      input.onEvent({ level: "warning", kind: "timeout", message: `Codex task timed out after ${input.timeoutMs}ms.` });
      child.kill("SIGTERM");
    }, input.timeoutMs);

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = parseCodexJsonLine(line);
        if (!event) return;
        finalText.push(event.message);
        input.onEvent({ level: "info", kind: event.type, message: event.message });
      } catch {
        input.onEvent({ level: "warning", kind: "parse_error", message: "Ignored malformed Codex JSONL event." });
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-4000);
      const trimmed = text.trim();
      if (trimmed) input.onEvent({ level: "warning", kind: "stderr", message: trimmed.slice(0, 500) });
    });

    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        this.active.delete(input.taskId);
        if (timedOut) {
          resolve({ exitCode: code, resultText: finalText.join("\n").trim() || "Codex task timed out." });
          return;
        }
        if (code === 0) {
          resolve({ exitCode: code, resultText: finalText.join("\n").trim() });
          return;
        }
        const detail = stderrTail.trim() || finalText.join("\n").trim() || `codex exec exited with code ${code}`;
        reject(new Error(detail));
      });
    });
  }

  cancel(taskId: string) {
    const child = this.active.get(taskId);
    if (!child) return false;
    child.kill("SIGTERM");
    return true;
  }

  isRunning(taskId: string) {
    return this.active.has(taskId);
  }
}
