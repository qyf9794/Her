import fs from "node:fs";
import path from "node:path";

export type EmailDraft = {
  id: string;
  to: string;
  subject: string;
  body: string;
  createdAt: string;
  sentAt?: string;
};

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location?: string;
  notes?: string;
  createdAt: string;
};

export type CopyDraft = {
  id: string;
  title: string;
  body: string;
  project?: string;
  createdAt: string;
  publishedAt?: string;
};

const dataFile = (name: string) => path.join(process.cwd(), "data", name);

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const writeJson = <T>(file: string, value: T) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export class LocalStore {
  private emailDraftsPath = dataFile("email-drafts.json");
  private calendarPath = dataFile("calendar-events.json");
  private copyDraftsPath = dataFile("copy-drafts.json");

  searchEmails(query: string, limit: number) {
    const drafts = readJson<EmailDraft[]>(this.emailDraftsPath, []);
    const q = query.toLowerCase();
    return drafts
      .filter((draft) => [draft.to, draft.subject, draft.body].join(" ").toLowerCase().includes(q))
      .slice(0, limit)
      .map(({ body, ...draft }) => ({
        ...draft,
        preview: body.slice(0, 240),
      }));
  }

  readEmail(emailId: string) {
    const drafts = readJson<EmailDraft[]>(this.emailDraftsPath, []);
    const draft = drafts.find((item) => item.id === emailId);
    if (!draft) throw new Error(`Email not found: ${emailId}`);
    return {
      ...draft,
      source: "local-draft-adapter",
      note: "This MVP reads local email draft data. Connect Gmail or Microsoft Graph for real inbox messages.",
    };
  }

  createEmailDraft(input: Pick<EmailDraft, "to" | "subject" | "body">) {
    const drafts = readJson<EmailDraft[]>(this.emailDraftsPath, []);
    const draft: EmailDraft = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    drafts.unshift(draft);
    writeJson(this.emailDraftsPath, drafts);
    return { ...draft, bodyPreview: draft.body.slice(0, 240) };
  }

  markEmailSent(draftId: string) {
    const drafts = readJson<EmailDraft[]>(this.emailDraftsPath, []);
    const draft = drafts.find((item) => item.id === draftId);
    if (!draft) throw new Error(`Email draft not found: ${draftId}`);
    draft.sentAt = new Date().toISOString();
    writeJson(this.emailDraftsPath, drafts);
    return { draftId, sentAt: draft.sentAt, note: "Local adapter marked the draft as sent. Configure Gmail or Microsoft Graph for real delivery." };
  }

  searchCalendar(from: string, to: string, query?: string) {
    const events = readJson<CalendarEvent[]>(this.calendarPath, []);
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    const q = query?.toLowerCase();
    return events.filter((event) => {
      const eventStart = new Date(event.start).getTime();
      const text = [event.title, event.location, event.notes, ...event.attendees].join(" ").toLowerCase();
      return eventStart >= start && eventStart <= end && (!q || text.includes(q));
    });
  }

  createCalendarEvent(input: Omit<CalendarEvent, "id" | "createdAt">) {
    const events = readJson<CalendarEvent[]>(this.calendarPath, []);
    const event: CalendarEvent = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    events.push(event);
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    writeJson(this.calendarPath, events);
    return { ...event, note: "Local adapter created the event. Configure Google Calendar or Microsoft Graph for real calendar sync." };
  }

  searchCopy(query: string, limit: number) {
    const drafts = readJson<CopyDraft[]>(this.copyDraftsPath, []);
    const q = query.toLowerCase();
    return drafts
      .filter((draft) => [draft.title, draft.body, draft.project].join(" ").toLowerCase().includes(q))
      .slice(0, limit)
      .map(({ body, ...draft }) => ({
        ...draft,
        preview: body.slice(0, 300),
      }));
  }

  saveCopyDraft(input: Pick<CopyDraft, "title" | "body" | "project">) {
    const drafts = readJson<CopyDraft[]>(this.copyDraftsPath, []);
    const draft: CopyDraft = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    drafts.unshift(draft);
    writeJson(this.copyDraftsPath, drafts);
    return { ...draft, preview: draft.body.slice(0, 300) };
  }

  publishCopyDraft(draftId: string) {
    const drafts = readJson<CopyDraft[]>(this.copyDraftsPath, []);
    const draft = drafts.find((item) => item.id === draftId);
    if (!draft) throw new Error(`Copy draft not found: ${draftId}`);
    draft.publishedAt = new Date().toISOString();
    writeJson(this.copyDraftsPath, drafts);
    return { draftId, publishedAt: draft.publishedAt, note: "Local adapter marked the draft as published. Connect your CMS API for real publishing." };
  }
}
