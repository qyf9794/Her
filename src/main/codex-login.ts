import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config";

export type CodexLoginStatus = {
  configured: boolean;
  label: string;
  detail: string;
  command: string;
  checkedAt: string;
};

export type CodexDeviceAuthStatus = {
  running: boolean;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  output: string;
  command: string;
};

let activeDeviceAuth: {
  child: ChildProcess;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
  output: string;
} | undefined;

export const readCodexLoginStatus = async (): Promise<CodexLoginStatus> => {
  const result = await runCodex(["login", "status"], 5000);
  const output = normalizeOutput(result.output);
  const lower = output.toLowerCase();
  const configured = result.exitCode === 0 && /logged in|authenticated|using chatgpt|api key/.test(lower);
  return {
    configured,
    label: configured ? "Logged in" : "Missing",
    detail: output || (configured ? "Codex login is configured." : "Codex login is not configured."),
    command: `${config.codexCommand} login status`,
    checkedAt: new Date().toISOString(),
  };
};

export const startCodexDeviceAuth = (): CodexDeviceAuthStatus => {
  if (activeDeviceAuth && !activeDeviceAuth.completedAt) return toDeviceAuthStatus(activeDeviceAuth);

  const startedAt = new Date().toISOString();
  const child = spawn(config.codexCommand, ["login", "--device-auth"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeDeviceAuth = {
    child,
    startedAt,
    output: "",
  };

  const appendOutput = (chunk: Buffer) => {
    if (!activeDeviceAuth || activeDeviceAuth.child !== child) return;
    activeDeviceAuth.output = normalizeOutput(`${activeDeviceAuth.output}\n${chunk.toString("utf8")}`).slice(-8000);
  };

  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  child.on("error", (error) => {
    if (!activeDeviceAuth || activeDeviceAuth.child !== child) return;
    activeDeviceAuth.output = normalizeOutput(`${activeDeviceAuth.output}\n${error.message}`);
    activeDeviceAuth.completedAt = new Date().toISOString();
    activeDeviceAuth.exitCode = 1;
  });
  child.on("close", (code) => {
    if (!activeDeviceAuth || activeDeviceAuth.child !== child) return;
    activeDeviceAuth.completedAt = new Date().toISOString();
    activeDeviceAuth.exitCode = code;
  });

  return toDeviceAuthStatus(activeDeviceAuth);
};

export const readCodexDeviceAuth = (): CodexDeviceAuthStatus => {
  if (!activeDeviceAuth) {
    return {
      running: false,
      output: "",
      command: `${config.codexCommand} login --device-auth`,
    };
  }
  return toDeviceAuthStatus(activeDeviceAuth);
};

const toDeviceAuthStatus = (state: NonNullable<typeof activeDeviceAuth>): CodexDeviceAuthStatus => ({
  running: !state.completedAt,
  startedAt: state.startedAt,
  completedAt: state.completedAt,
  exitCode: state.exitCode,
  output: state.output,
  command: `${config.codexCommand} login --device-auth`,
});

const runCodex = (args: string[], timeoutMs: number) =>
  new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    const child = spawn(config.codexCommand, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const appendOutput = (chunk: Buffer) => {
      output = `${output}\n${chunk.toString("utf8")}`.slice(-8000);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exitCode: null, output: normalizeOutput(`${output}\nTimed out running ${config.codexCommand} ${args.join(" ")}`) });
    }, timeoutMs);
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, output: normalizeOutput(`${output}\n${error.message}`) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, output: normalizeOutput(output) });
    });
  });

const normalizeOutput = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n")
    .trim();
