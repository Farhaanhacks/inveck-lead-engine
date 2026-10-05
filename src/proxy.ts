import { NextResponse, type NextRequest } from 'next/server';
import { isValidSession, SESSION_COOKIE } from '@/lib/auth';

// Every page and API route needs the shared-password session, except the login page
// and the two machine endpoints, which check their own secret.
const PUBLIC_PATHS = [/^\/login$/, /^\/api\/health$/, /^\/api\/cron(\/draw)?$/, /^\/api\/runs\/\d+\/continue$/];

export async function proxy(request: NextRequest) {
  if (PUBLIC_PATHS.some((p) => p.test(request.nextUrl.pathname))) return NextResponse.next();
  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
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
