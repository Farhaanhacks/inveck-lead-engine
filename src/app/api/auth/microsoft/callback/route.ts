import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/users';
import { connectMailbox, mailConfig, MailError, redirectUriFor, STATE_COOKIE, STATE_COOKIE_PATH } from '@/lib/mail/outlook';
import { safeEqual } from '@/lib/safe-equal';

/** Microsoft sends the person back here after they sign in: the connection is checked and saved. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // `why`: Microsoft's own reason, shown on the Account page (an administrator's approval needed, say).
  const back = (mail: string, why = '') => {
    const to = new URL('/account', request.url);
    to.searchParams.set('mail', mail);
    if (why) to.searchParams.set('why', why.split(/\r?\n/)[0].slice(0, 300));
    const res = NextResponse.redirect(to);
    res.cookies.set(STATE_COOKIE, '', { path: STATE_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  const me = await getCurrentUser();
  if (!me?.id) return back('needs-login');
  // Only the sign-in this person started, in this browser, in the last ten minutes.
  const [who, state] = ((await cookies()).get(STATE_COOKIE)?.value ?? '').split('.');
  const given = url.searchParams.get('state') ?? '';
  if (!state || who !== String(me.id) || !safeEqual(state, given)) return back('expired');
  if (url.searchParams.get('error')) return back('declined', url.searchParams.get('error_description') || url.searchParams.get('error') || '');
  const code = url.searchParams.get('code');
  if (!code) return back('declined');
  const config = mailConfig();
  if (!config) return back('not-set-up');
  try {
    await connectMailbox(await getDb(), me.id, code, redirectUriFor(config, url.origin));
    return back('connected');
  } catch (e) {
    console.error('[mail] connecting Outlook failed:', e instanceof MailError ? e.message : e);
    return back('failed', e instanceof MailError ? e.message : '');
  }
}
