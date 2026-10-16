import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/users';
import { CALLBACK_PATH, connectMailbox, MailError, STATE_COOKIE } from '@/lib/mail/outlook';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Microsoft sends the person back here after they sign in: the connection is checked and saved. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (mail: string) => {
    const res = NextResponse.redirect(new URL(`/account?mail=${mail}`, request.url));
    res.cookies.set(STATE_COOKIE, '', { path: '/api/mail', maxAge: 0 });
    return res;
  };
  const me = await getCurrentUser();
  if (!me?.id) return back('needs-login');
  // Only the sign-in this person started, in this browser, in the last ten minutes.
  const [who, state] = ((await cookies()).get(STATE_COOKIE)?.value ?? '').split('.');
  const given = url.searchParams.get('state') ?? '';
  if (!state || who !== String(me.id) || !same(state, given)) return back('expired');
  if (url.searchParams.get('error')) return back('declined');
  const code = url.searchParams.get('code');
  if (!code) return back('declined');
  try {
    await connectMailbox(await getDb(), me.id, code, `${url.origin}${CALLBACK_PATH}`);
    return back('connected');
  } catch (e) {
    console.error('[mail] connecting Outlook failed:', e instanceof MailError ? e.message : e);
    return back('failed');
  }
}
