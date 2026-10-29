// Local stand-in for the Blogs scheduler: calls the blog worker endpoint on an interval (discovery, article jobs, publishing).
// Usage: npm run dev (one terminal), CRON_SECRET=... npm run blogs:worker (another). Stop with Ctrl+C.
// In production Vercel calls /api/cron/blogs hourly (vercel.json, Hobby plan); for faster article jobs, point cron-job.org at it too.
const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const secret = process.env.CRON_SECRET;
const everyMs = Number(process.env.WORKER_INTERVAL_MS || 30_000);
if (!secret) {
  console.error('CRON_SECRET is not set (export it in this terminal; it must match the server).');
  process.exit(1);
}

async function tick() {
  try {
    const res = await fetch(`${base}/api/cron/blogs`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(330_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) console.error(`[${new Date().toISOString()}] blogs: HTTP ${res.status}`, body);
    else if (Object.values(body).some((v) => v && typeof v === 'object' && v.processed)) console.log(`[${new Date().toISOString()}] blogs:`, JSON.stringify(body));
  } catch (e) {
    console.error(`[${new Date().toISOString()}] blogs: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`Blogs worker started: ${base} every ${everyMs / 1000}s`);
for (;;) {
  await tick();
  await new Promise((r) => setTimeout(r, everyMs));
}
