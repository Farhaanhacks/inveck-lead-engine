// The parts of the content calendar the browser needs too: names, labels, formats and calendar dates.
// Nothing here touches the database, so the calendar screen can import it.

export const CONTENT_PLATFORMS = ['instagram', 'linkedin'] as const;
export type ContentPlatform = (typeof CONTENT_PLATFORMS)[number];
export const CONTENT_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled', 'waiting_dependency', 'posted'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const PLATFORM_LABEL: Record<ContentPlatform, string> = { instagram: 'Instagram', linkedin: 'LinkedIn' };
export const STATUS_LABEL: Record<ContentStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  scheduled: 'Scheduled',
  waiting_dependency: 'Waiting for dependency',
  posted: 'Posted',
};
/** The formats each platform has. */
export const FORMATS: Record<ContentPlatform, readonly string[]> = {
  instagram: ['post', 'carousel', 'reel', 'story', 'video'],
  linkedin: ['post', 'carousel', 'video', 'article'],
};
export const FORMAT_LABEL = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);

/** A post as the browser gets it (dates as text). */
export type PostView = {
  id: number;
  title: string;
  platform: ContentPlatform;
  format: string;
  caption: string;
  scheduledOn: string;
  status: ContentStatus;
  dependencyNote: string;
  postedAt: string | null;
  assigneeId: number | null;
  driveLink: string;
};

/** A person content can be assigned to, and a to-do, as the browser gets them. */
export type PersonView = { id: number; name: string };
export type TodoView = { id: number; text: string; scheduledOn: string; done: boolean };

// ─── Calendar dates (India days as YYYY-MM-DD) ───

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (day: string) => new Date(`${day}T00:00:00Z`);

/** The weeks (Sunday first) that cover a month, as seven days each. */
export function monthWeeks(year: number, month: number): string[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  return Array.from({ length: Math.ceil((first.getUTCDay() + days) / 7) }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + w * 7 + i);
      return iso(d);
    }),
  );
}

/** The seven days (Sunday first) of the week containing a day. */
export function weekOf(day: string): string[] {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d);
    x.setUTCDate(d.getUTCDate() + i);
    return iso(x);
  });
}

export const addDays = (day: string, n: number) => {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
