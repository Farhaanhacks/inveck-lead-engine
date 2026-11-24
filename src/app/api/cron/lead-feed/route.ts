import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { publishKnown } from '@/lib/lead-feed';

export const maxDuration = 120;

/**
 * Every morning before Instinct's run (see vercel.json): writes the Known tab of the lead sheet, the companies the CRM already has, so
 * Instinct can skip them before it spends Zintlr credits. It changes nothing in the CRM. Secured like the other scheduled routes.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) return Response.json({ error: 'Forbidden' }, { status: 403 });
  try {
    return Response.json({ known: (await publishKnown(await getDb())).count });
  } catch (e) {
    console.error('[lead-feed] Known tab not updated:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'The Known tab could not be updated. See Settings → Instinct lead feed.' }, { status: 500 });
  }
}
