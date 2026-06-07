import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const run = (command: string, args: string[], timeoutMs = 30000) =>
  new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
    });
  });

export class ShortcutsControl {
  async list(limit: number) {
    const result = await run("shortcuts", ["list"], 10000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `shortcuts list exited with code ${result.exitCode}`);
    }
    const shortcuts = result.stdout
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, limit)
      .map((name) => ({ name }));
    return { shortcuts, truncated: shortcuts.length >= limit };
  }

  async runShortcut(name: string, input?: string, timeoutMs = 60000) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "her-shortcut-"));
    const args = ["run", name];
    const outputPath = path.join(tmpDir, "output.txt");
    let inputPath = "";
    try {
      if (typeof input === "string" && input.length > 0) {
        inputPath = path.join(tmpDir, "input.txt");
        await fs.writeFile(inputPath, input, "utf8");
        args.push("--input-path", inputPath);
      }
      args.push("--output-path", outputPath);

      const result = await run("shortcuts", args, timeoutMs);
      const output = await fs.readFile(outputPath, "utf8").catch(() => "");
      return {
        name,
        exitCode: result.exitCode,
        ok: result.exitCode === 0,
        stdout: compactText(result.stdout),
        stderr: compactText(result.stderr),
        output: compactText(output),
        note: result.exitCode === 0
          ? "Shortcut finished. Use media playback state tools to confirm media playback when relevant."
          : "Shortcut did not finish successfully.",
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

const compactText = (value: string, maxChars = 1000) => {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 3)}...`;
};
