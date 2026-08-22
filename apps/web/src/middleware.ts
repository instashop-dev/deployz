import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

// Optimistic gating only for /dashboard: the mere presence of the session
// cookie is enough to let the request through to the server layout, which
// re-validates the session against the API on every render. The auth pages
// (/sign-in, /sign-up) are intentionally NOT redirected when a cookie is
// present — the cookie cannot be validated in the edge runtime, so redirecting
// to /dashboard on a stale-but-present cookie would loop forever against the
// layout's redirect-to-/sign-in on an invalid session.
export function middleware(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/dashboard')) {
    if (!sessionCookie) {
      return NextResponse.redirect(new URL('/sign-in', request.url));
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
