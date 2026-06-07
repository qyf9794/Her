import { spawn } from "node:child_process";

export type MacCalendarCreateInput = {
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  calendarName?: string;
  location?: string;
  notes?: string;
};

export type MacReminderCreateInput = {
  title: string;
  listName?: string;
  dueAt?: string;
  notes?: string;
};

export type MacNoteCreateInput = {
  title: string;
  body: string;
  folderName?: string;
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

export class MacProductivity {
  async createCalendarEvent(input: MacCalendarCreateInput) {
    const output = await runJxa(calendarScript(input));
    return {
      status: "created",
      app: "Calendar",
      title: input.title,
      start: input.start,
      end: input.end,
      calendarName: output || input.calendarName,
      attendeeCount: input.attendees?.length ?? 0,
    };
  }

  async createReminder(input: MacReminderCreateInput) {
    const output = await runJxa(reminderScript(input));
    return {
      status: "created",
      app: "Reminders",
      title: input.title,
      listName: output || input.listName,
      dueAt: input.dueAt,
    };
  }

  async createNote(input: MacNoteCreateInput) {
    const output = await runJxa(noteScript(input));
    return {
      status: "created",
      app: "Notes",
      title: input.title,
      folderName: output || input.folderName,
      bodyChars: input.body.length,
    };
  }
}

const calendarScript = (input: MacCalendarCreateInput) => `
  const app = Application("Calendar");
  app.includeStandardAdditions = true;
  const calendars = app.calendars();
  const targetName = ${JSON.stringify(input.calendarName ?? "")};
  const calendar = targetName ? calendars.find((item) => item.name() === targetName) : calendars[0];
  if (!calendar) throw new Error("No writable Calendar calendar found.");
  const event = app.Event({
    summary: ${JSON.stringify(input.title)},
    startDate: new Date(${JSON.stringify(input.start)}),
    endDate: new Date(${JSON.stringify(input.end)}),
    location: ${JSON.stringify(input.location ?? "")},
    description: ${JSON.stringify(input.notes ?? "")}
  });
  calendar.events.push(event);
  calendar.name();
`;

const reminderScript = (input: MacReminderCreateInput) => `
  const app = Application("Reminders");
  app.includeStandardAdditions = true;
  const lists = app.lists();
  const targetName = ${JSON.stringify(input.listName ?? "")};
  const list = targetName ? lists.find((item) => item.name() === targetName) : lists[0];
  if (!list) throw new Error("No writable Reminders list found.");
  const properties = {
    name: ${JSON.stringify(input.title)},
    body: ${JSON.stringify(input.notes ?? "")}
  };
  const dueAt = ${JSON.stringify(input.dueAt ?? "")};
  if (dueAt) properties.dueDate = new Date(dueAt);
  list.reminders.push(app.Reminder(properties));
  list.name();
`;

const noteScript = (input: MacNoteCreateInput) => `
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const folders = app.folders();
  const targetName = ${JSON.stringify(input.folderName ?? "")};
  const folder = targetName ? folders.find((item) => item.name() === targetName) : folders[0];
  if (!folder) throw new Error("No writable Notes folder found.");
  folder.notes.push(app.Note({
    name: ${JSON.stringify(input.title)},
    body: ${JSON.stringify(input.body)}
  }));
  folder.name();
`;
