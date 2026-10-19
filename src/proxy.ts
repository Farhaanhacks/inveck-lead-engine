import { NextResponse, type NextRequest } from 'next/server';
import { authDisabled, isValidSession, readSession, SESSION_COOKIE } from '@/lib/auth';

// Every page and API route needs the shared-password session, except the login page
// and the machine endpoints, which check their own secret (WhatsApp's: Meta's signature).
const PUBLIC_PATHS = [/^\/login$/, /^\/api\/health$/, /^\/api\/cron(\/draw)?$/, /^\/api\/runs\/\d+\/continue$/, /^\/api\/whatsapp\/webhook$/];

export async function proxy(request: NextRequest) {
  if (PUBLIC_PATHS.some((p) => p.test(request.nextUrl.pathname))) return NextResponse.next();
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (await isValidSession(cookie)) {
    // The session says whose it is: m<id> is the Marketing profile, u<id> a BDA, admin the administrator. Marketing
    // reaches only /marketing; a BDA never reaches /marketing. (Server actions and the pages check the role again.)
    const who = authDisabled() ? 'admin' : ((await readSession(cookie)) ?? '');
    const path = request.nextUrl.pathname;
    const inMarketing = path === '/marketing' || path.startsWith('/marketing/');
    if (who.startsWith('m') && !inMarketing) {
      return path.startsWith('/api/') ? NextResponse.json({ error: 'Not allowed' }, { status: 403 }) : NextResponse.redirect(new URL('/marketing/calendar', request.url));
    }
    if (who.startsWith('u') && inMarketing) return NextResponse.redirect(new URL('/today', request.url));
    return NextResponse.next();
  }
  // Connecting Outlook happens in the browser: log in, then back to the Account page to connect.
  if (request.nextUrl.pathname.startsWith('/api/auth/microsoft/')) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', '/account');
    return NextResponse.redirect(login);
  }
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
  }
  const login = new URL('/login', request.url);
  login.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
