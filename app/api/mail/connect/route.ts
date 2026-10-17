import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/users';
import { authorizeUrl, CALLBACK_PATH, mailConfig, STATE_COOKIE } from '@/lib/mail/outlook';

/** "Connect Outlook": sends the person to Microsoft's sign-in, remembering who asked (for ten minutes). */
export async function GET(request: Request) {
  const back = (mail: string) => NextResponse.redirect(new URL(`/account?mail=${mail}`, request.url));
  const me = await getCurrentUser();
  // The shared administrator login has no mailbox of its own.
  if (!me?.id) return back('needs-login');
  const config = mailConfig();
  if (!config) return back('not-set-up');
  const origin = new URL(request.url).origin;
  const state = randomBytes(24).toString('base64url');
  const res = NextResponse.redirect(authorizeUrl(config, `${origin}${CALLBACK_PATH}`, state));
  res.cookies.set(STATE_COOKIE, `${me.id}.${state}`, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: '/api/mail', maxAge: 600 });
  return res;
}
