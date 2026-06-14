import { spawn } from "node:child_process";
import { config } from "../config";

const forbiddenPatterns = [
  /\bsudo\b/,
  /\brm\s+-[^;&|]*r[^;&|]*f\b/,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bchown\s+-R\b/,
  /\bsecurity\s+find-generic-password\b/,
  /\b(open|curl|wget)\b.*\|\s*(sh|bash|zsh)\b/,
  /OPENAI_API_KEY|sk-proj-|sk-[A-Za-z0-9]/,
];

const protectedPaths = ["/System", "/Library", "/usr", "/bin", "/sbin", "/private/etc", "/etc", "/var/root"];

export class AdvancedShell {
  validate(command: string) {
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(command)) throw new Error(`Blocked unsafe shell command pattern: ${pattern}`);
    }
    for (const protectedPath of protectedPaths) {
      const escaped = protectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|\\s)(>|>>|mv|cp|touch|mkdir|rm|chmod|chown|tee)\\s+[^;&|]*${escaped}`).test(command)) {
        throw new Error(`Blocked modification of protected system path: ${protectedPath}`);
      }
    }
    for (const dir of config.allowedDirectories) {
      if (command.includes(dir)) return;
    }
    if (!/\b(ls|find|pwd|date|whoami|du|df|cat|head|tail|wc)\b/.test(command) && !/\bgit\s+(status|log|show|branch|diff)\b/.test(command)) {
      throw new Error("Shell command must reference an allowlisted directory unless it is clearly read-only.");
    }
  }

  async run(command: string, timeoutMs: number) {
    this.validate(command);
    return new Promise<{ command: string; exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn("zsh", ["-lc", command], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Shell command timed out after ${timeoutMs}ms.`));
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
        resolve({
          command,
          exitCode: code,
          stdout: stdout.slice(0, 3000),
          stderr: stderr.slice(0, 3000),
        });
      });
    });
  }
}
