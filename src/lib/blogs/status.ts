// Human-readable states derived only from what the database has saved. Nothing here guesses at progress the backend does not record.

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';
export type State = {
  label: string;
  tone: Tone;
  /** One more line of explanation: an error, a reason, or when the next step happens. */
  detail?: string;
  /** Work is actively happening right now (a worker holds it). */
  live?: boolean;
  /** Worth refreshing: the state can still change without anyone clicking. */
  active: boolean;
  /** When the next scheduled thing happens, for the page to format in the dashboard's timezone. */
  at?: Date;
};

export const STAGE_LABEL: Record<string, string> = {
  research: 'Research',
  planning: 'Outline',
  writing: 'Writing',
  seo: 'SEO',
  validation: 'Quality checks',
  image: 'Featured image',
  done: 'Complete',
};
export const stageLabel = (s: string) => STAGE_LABEL[s] ?? s;

/** Turns provider error dumps into one readable sentence. */
export function shortError(message?: string | null): string {
  if (!message) return 'No details were recorded.';
  if (/high demand|503|UNAVAILABLE/i.test(message)) return 'Google’s model is overloaded right now (503).';
  if (/quota|429/i.test(message)) return 'The provider’s quota or rate limit was hit (429).';
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

const WORKER_SILENT_MS = 3 * 60_000;

type JobLike = {
  status: string;
  stage: string;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  updatedAt: Date;
  error: unknown;
};
type JobError = { code?: string; message?: string; reviewOnly?: boolean };

export function jobState(j: JobLike, now: Date, opts: { imageFailed?: boolean } = {}): State {
  const err = (j.error ?? {}) as JobError;
  const stage = stageLabel(j.stage);
  switch (j.status) {
    case 'running':
      if (j.leaseExpiresAt && j.leaseExpiresAt < now) return { label: `Stalled at ${stage}`, tone: 'warn', detail: 'The worker stopped mid-step. The next worker run picks it up again.', active: true };
      return { label: `Running: ${stage}`, tone: 'warn', live: true, active: true };
    case 'queued': {
      const idle = now.getTime() - j.updatedAt.getTime() > WORKER_SILENT_MS ? ' No worker has picked it up yet: press Run now or check the scheduler.' : '';
      if (!j.startedAt) return { label: 'Queued', tone: 'neutral', detail: `Waiting to start.${idle}`, active: true };
      return { label: `Waiting: next is ${stage}`, tone: 'neutral', detail: `Paused between steps; it continues on the next worker run.${idle}`, active: true };
    }
    case 'retrying': {
      const due = j.nextRunAt && j.nextRunAt <= now;
      const late = j.nextRunAt && now.getTime() - j.nextRunAt.getTime() > 60_000;
      return {
        label: `Retrying ${stage}`,
        tone: 'warn',
        detail: `Attempt ${j.attempts} of ${j.maxAttempts} failed: ${shortError(err.message)}${late ? ' The retry is due but no worker has run it: press Run now.' : due ? ' Retrying on the next worker run.' : ''}`,
        at: due ? undefined : j.nextRunAt ?? undefined,
        active: true,
      };
    }
    case 'blocked':
      if (err.code === 'validation_blocked' && err.reviewOnly) return { label: 'Waiting for your review', tone: 'warn', detail: 'Checks finished with flags. Open the article to review and release it.', active: false };
      if (err.code === 'validation_blocked') return { label: 'Blocked by quality checks', tone: 'danger', detail: shortError(err.message), active: false };
      if (err.code === 'budget') return { label: 'Paused: budget limit', tone: 'warn', detail: shortError(err.message), active: false };
      return { label: 'Blocked', tone: 'danger', detail: shortError(err.message), active: false };
    case 'failed':
      return { label: `Failed at ${stage}`, tone: 'danger', detail: shortError(err.message), active: false };
    case 'completed':
      return opts.imageFailed
        ? { label: 'Complete, image failed', tone: 'warn', detail: 'The article is ready. Retry the image from the article page.', active: false }
        : { label: 'Complete', tone: 'ok', active: false };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', active: false };
    default:
      return { label: j.status, tone: 'neutral', active: false };
  }
}

type RunLike = { status: string; leaseExpiresAt: Date | null; updatedAt?: Date; createdAt: Date; result: unknown; error: unknown };
type RunProgress = { total?: number; done?: string[]; failed?: string[]; found?: number };
type RunResult = { created?: number; errors?: { domain: string; message: string }[]; progress?: RunProgress };

export function runState(r: RunLike, now: Date): State {
  const res = (r.result ?? {}) as RunResult;
  const p = res.progress;
  switch (r.status) {
    case 'queued': {
      const idle = now.getTime() - r.createdAt.getTime() > WORKER_SILENT_MS ? ' No worker has picked it up yet: check the scheduler.' : '';
      return { label: 'Queued', tone: 'neutral', detail: `Waiting to start.${idle}`, active: true };
    }
    case 'running': {
      if (r.leaseExpiresAt && r.leaseExpiresAt < now) return { label: 'Stalled', tone: 'warn', detail: 'The worker stopped; the next worker run retries it.', active: true };
      const detail = p?.total
        ? `${(p.done?.length ?? 0) + (p.failed?.length ?? 0)} of ${p.total} domains done · ${p.found ?? 0} topic${p.found === 1 ? '' : 's'} found so far${p.failed?.length ? ` · ${p.failed.length} failed` : ''}`
        : 'Researching sources and drafting topics.';
      return { label: 'Running', tone: 'warn', detail, live: true, active: true };
    }
    case 'completed':
      return {
        label: `Completed: ${res.created ?? 0} topic${res.created === 1 ? '' : 's'}`,
        tone: 'ok',
        detail: res.errors?.length ? `Some domains failed: ${res.errors.map((e) => `${e.domain} (${shortError(e.message)})`).join('; ')}` : undefined,
        active: false,
      };
    case 'failed':
      return { label: 'Failed', tone: 'danger', detail: shortError((r.error as { message?: string } | null)?.message), active: false };
    default:
      return { label: r.status, tone: 'neutral', active: false };
  }
}

type PostLike = { status: string; isMock: boolean; scheduledFor: Date | null; nextAttemptAt: Date | null; attempts: number; maxAttempts: number; lastError: unknown };

export function postState(p: PostLike, now: Date): State {
  const reason = shortError((p.lastError as { message?: string } | null)?.message);
  switch (p.status) {
    case 'scheduled':
      // Not worth polling for: it may be days away. The page refreshes once it is due and someone opens it.
      if (p.scheduledFor && p.scheduledFor > now) return { label: 'Waiting for its time', tone: 'neutral', at: p.scheduledFor, active: false };
      if (p.attempts > 0 && p.nextAttemptAt && p.nextAttemptAt > now) return { label: `Retry ${p.attempts} of ${p.maxAttempts}`, tone: 'warn', detail: `Last attempt failed: ${reason}`, at: p.nextAttemptAt, active: true };
      return { label: 'Due now', tone: 'warn', detail: 'Publishes on the next worker run.', active: true };
    case 'publishing':
      if (p.nextAttemptAt && p.nextAttemptAt < now) return { label: 'Publishing stalled', tone: 'warn', detail: 'The worker stopped; the next run retries it.', active: true };
      return { label: 'Publishing now', tone: 'warn', live: true, active: true };
    case 'delayed':
      return { label: 'Delayed', tone: 'warn', detail: reason, at: p.nextAttemptAt ?? undefined, active: true };
    case 'published':
      return p.isMock
        ? { label: 'Simulated (mock)', tone: 'neutral', detail: 'Mock mode: nothing was published to the site.', active: false }
        : { label: 'Published', tone: 'ok', active: false };
    case 'failed':
      return { label: 'Failed', tone: 'danger', detail: reason, active: false };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', active: false };
    default:
      return { label: p.status, tone: 'neutral', active: false };
  }
}
