import { spawn } from "node:child_process";

export type MacCalendarCreateInput = {
  title: string;
  start: string;
  end: string;
  calendarName?: string;
  location?: string;
  notes?: string;
  attendees?: string[];
};

export type MacReminderCreateInput = {
  title: string;
  dueAt?: string;
  listName?: string;
  notes?: string;
};

export type MacNoteCreateInput = {
  title: string;
  body: string;
  folderName?: string;
};

export class MacProductivity {
  async createCalendarEvent(input: MacCalendarCreateInput) {
    const start = parseDateInput(input.start, "start");
    const end = parseDateInput(input.end, "end");
    const script = `
      ${dateScript("startDate", start)}
      ${dateScript("endDate", end)}
      set eventTitle to ${asString(input.title)}
      set eventLocation to ${asString(input.location ?? "")}
      set eventNotes to ${asString(input.notes ?? "")}
      set preferredCalendarName to ${asString(input.calendarName ?? "")}
      tell application "Calendar"
        activate
        if preferredCalendarName is not "" then
          set targetCalendar to missing value
          repeat with candidateCalendar in calendars
            if name of candidateCalendar is preferredCalendarName then
              set targetCalendar to candidateCalendar
              exit repeat
            end if
          end repeat
          if targetCalendar is missing value then error "Calendar not found: " & preferredCalendarName
        else
          set targetCalendar to first calendar
        end if
        tell targetCalendar
          set newEvent to make new event at end with properties {summary:eventTitle, start date:startDate, end date:endDate, location:eventLocation, description:eventNotes}
        end tell
        return (uid of newEvent as text) & "|" & (summary of newEvent as text)
      end tell
    `;
    const output = await runAppleScript(script);
    const [id, title] = splitAppleScriptResult(output);
    return {
      created: true,
      app: "Calendar",
      id,
      title: title || input.title,
      start: start.toISOString(),
      end: end.toISOString(),
      calendarName: input.calendarName,
      location: input.location,
      notes: input.notes,
      attendees: input.attendees ?? [],
    };
  }

  async createReminder(input: MacReminderCreateInput) {
    const dueAt = input.dueAt ? parseDateInput(input.dueAt, "dueAt") : undefined;
    const script = `
      ${dueAt ? dateScript("dueDate", dueAt) : ""}
      set reminderTitle to ${asString(input.title)}
      set reminderNotes to ${asString(input.notes ?? "")}
      set preferredListName to ${asString(input.listName ?? "")}
      tell application "Reminders"
        activate
        if preferredListName is not "" then
          set targetList to missing value
          repeat with candidateList in lists
            if name of candidateList is preferredListName then
              set targetList to candidateList
              exit repeat
            end if
          end repeat
          if targetList is missing value then error "Reminder list not found: " & preferredListName
        else
          set targetList to default list
        end if
        tell targetList
          set newReminder to make new reminder with properties {name:reminderTitle, body:reminderNotes}
          ${dueAt ? "set remind me date of newReminder to dueDate" : ""}
        end tell
        return (id of newReminder as text) & "|" & (name of newReminder as text)
      end tell
    `;
    const output = await runAppleScript(script);
    const [id, title] = splitAppleScriptResult(output);
    return {
      created: true,
      app: "Reminders",
      id,
      title: title || input.title,
      dueAt: dueAt?.toISOString(),
      listName: input.listName,
      notes: input.notes,
    };
  }

  async createNote(input: MacNoteCreateInput) {
    const bodyHtml = `<div>${escapeHtml(input.body).replace(/\n/g, "<br />")}</div>`;
    const script = `
      set noteTitle to ${asString(input.title)}
      set noteBody to ${asString(bodyHtml)}
      set preferredFolderName to ${asString(input.folderName ?? "")}
      tell application "Notes"
        activate
        if preferredFolderName is not "" then
          set targetFolder to missing value
          repeat with candidateAccount in accounts
            repeat with candidateFolder in folders of candidateAccount
              if name of candidateFolder is preferredFolderName then
                set targetFolder to candidateFolder
                exit repeat
              end if
            end repeat
            if targetFolder is not missing value then exit repeat
          end repeat
          if targetFolder is missing value then error "Notes folder not found: " & preferredFolderName
        else
          if (count of accounts) is 0 then error "No Notes account is available"
          set targetAccount to first account
          if (count of folders of targetAccount) is 0 then error "No Notes folder is available"
          set targetFolder to first folder of targetAccount
        end if
        set newNote to make new note at targetFolder with properties {name:noteTitle, body:noteBody}
        return (id of newNote as text) & "|" & (name of newNote as text)
      end tell
    `;
    const output = await runAppleScript(script);
    const [id, title] = splitAppleScriptResult(output);
    return {
      created: true,
      app: "Notes",
      id,
      title: title || input.title,
      folderName: input.folderName,
      bodyLength: input.body.length,
    };
  }
}

const runAppleScript = (script: string, timeoutMs = 15000) =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
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

const parseDateInput = (value: string, fieldName: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO date/time.`);
  }
  return date;
};

const dateScript = (variableName: string, date: Date) => {
  const month = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][date.getMonth()];
  return `
    set ${variableName} to current date
    set year of ${variableName} to ${date.getFullYear()}
    set month of ${variableName} to ${month}
    set day of ${variableName} to ${date.getDate()}
    set time of ${variableName} to (${date.getHours()} * hours + ${date.getMinutes()} * minutes + ${date.getSeconds()})
  `;
};

const asString = (value: string) => JSON.stringify(value);

const splitAppleScriptResult = (output: string) => {
  const separator = output.indexOf("|");
  if (separator === -1) return [output, ""] as const;
  return [output.slice(0, separator), output.slice(separator + 1)] as const;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
