import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { attendanceBetween } from '@/lib/attendance';
import { getCurrentUser, listBdas } from '@/lib/users';
import { istDay } from '@/lib/tasks';

/** Attendance for the admin dashboard: /api/attendance?from=2026-09-01&to=2026-09-30 (defaults to today). Administrators only. */
export async function GET(request: NextRequest) {
  const me = await getCurrentUser();
  if (me?.role !== 'admin') return NextResponse.json({ error: 'Administrators only' }, { status: 403 });
  const p = request.nextUrl.searchParams;
  const valid = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const from = valid(p.get('from')) ?? istDay();
  const to = valid(p.get('to')) ?? from;
  const db = await getDb();
  const [rows, team] = await Promise.all([attendanceBetween(db, from, to), listBdas(db)]);
  const names = new Map(team.map((b) => [b.id, b.name]));
  return NextResponse.json({
    from,
    to,
    rows: rows.map((r) => ({
      name: names.get(r.userId) ?? `User ${r.userId}`,
      day: r.day,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      clockInAt: r.clockInAt,
      clockOutAt: r.clockOutAt,
    })),
  });
}
