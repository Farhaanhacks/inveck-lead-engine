import 'server-only';
import { getDb } from './db/client';
import { auditLogs } from './db/schema';

/** Records who did what. Failures are logged loudly but never block the action being audited. */
export async function audit(actor: string, action: string, entityType: string, entityId?: string, details: Record<string, unknown> = {}) {
  try {
    await (await getDb()).insert(auditLogs).values({ actor, action, entityType, entityId, details });
  } catch (e) {
    console.error('audit log write failed', { action, entityType, entityId, error: e instanceof Error ? e.message : e });
  }
}
