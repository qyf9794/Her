import { spawn } from "node:child_process";

const run = (command: string, args: string[], input?: string, timeoutMs = 15000) =>
  new Promise<string>((resolve, reject) => {
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
    child.stdin.end(input);
  });

export class MacMail {
  async createDraft(input: { to: string; subject: string; body: string }) {
    const messageId = await run(
      "osascript",
      [],
      `tell application "Mail"
  activate
  set newMessage to make new outgoing message with properties {subject:${appleScriptString(input.subject)}, content:${appleScriptString(input.body)}, visible:true}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:${appleScriptString(input.to)}}
  end tell
  save newMessage
  return id of newMessage
end tell
`,
      15000,
    );
    return {
      visible: true,
      app: "Mail",
      messageId,
      to: input.to,
      subject: input.subject,
      note: "Created and saved a visible Mail.app outgoing draft. HER did not send the email.",
    };
  }
}

const appleScriptString = (value: string) => {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
  return `"${escaped}"`;
};
