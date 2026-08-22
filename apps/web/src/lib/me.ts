import { cookies } from 'next/headers';

export interface Me {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string } | null;
}

// Server-side session resolution: forward the incoming request's cookies to
// the control-plane API. Returns null when the session is absent or invalid.
export async function fetchMe(): Promise<Me | null> {
  const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}/api/me`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as Me;
}
