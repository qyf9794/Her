import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodingAgentWorktree = {
  taskRoot: string;
  worktreePath: string;
  branch: string;
};

export class CodingAgentWorktreeManager {
  constructor(private rootDir = path.join(os.homedir(), ".her", "agent-runs")) {}

  async create(taskId: string, repoPath: string): Promise<CodingAgentWorktree> {
    const repo = path.resolve(repoPath);
    await assertGitRepository(repo);
    const taskRoot = path.join(this.rootDir, taskId);
    const worktreePath = path.join(taskRoot, "repo");
    const branch = `her/codex/${taskId}`;
    fs.mkdirSync(taskRoot, { recursive: true });
    if (fs.existsSync(worktreePath)) {
      throw new Error(`Coding agent worktree already exists: ${worktreePath}`);
    }
    await runGit(repo, ["worktree", "add", "-b", branch, worktreePath]);
    return { taskRoot, worktreePath, branch };
  }
}

export const assertGitRepository = async (repoPath: string) => {
  const output = await runGit(path.resolve(repoPath), ["rev-parse", "--show-toplevel"]);
  if (!output.trim()) throw new Error(`Not a git repository: ${repoPath}`);
};

const runGit = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `git ${args.join(" ")} exited with code ${code}`).trim()));
    });
  });
