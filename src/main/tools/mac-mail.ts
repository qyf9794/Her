import { spawn } from "node:child_process";

type MailDraftInput = {
  to: string;
  subject: string;
  body: string;
};

const runJxa = (script: string, timeoutMs = 10000) =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("osascript", ["-l", "JavaScript", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`osascript timed out after ${timeoutMs}ms.`));
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
      else reject(new Error(stderr.trim() || `osascript exited with code ${code}`));
    });
  });

export class MacMail {
  async createDraft(input: MailDraftInput) {
    const output = await runJxa(mailDraftScript(input));
    return {
      status: "created",
      app: "Mail",
      to: input.to,
      subject: input.subject,
      draftId: output || undefined,
      bodyChars: input.body.length,
      note: "Created a visible Mail draft. Sending still requires explicit user action or a separate confirmed tool.",
    };
  }
}

const mailDraftScript = (input: MailDraftInput) => `
  const app = Application("Mail");
  app.includeStandardAdditions = true;
  const message = app.OutgoingMessage({
    subject: ${JSON.stringify(input.subject)},
    content: ${JSON.stringify(input.body)},
    visible: true
  });
  message.toRecipients.push(app.Recipient({ address: ${JSON.stringify(input.to)} }));
  app.outgoingMessages.push(message);
  app.activate();
  message.id();
`;
