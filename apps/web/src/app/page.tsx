import { cookies } from 'next/headers';

interface MeResponse {
  user: unknown;
  organization: unknown;
}

// Server-side proof of the shared session: the browser's localhost cookie is
// forwarded to the Fastify API (via `next/headers`) and the user JSON is
// rendered when the session resolves, otherwise auth links are offered.
export default async function Home() {
  const apiUrl = process.env.API_URL ?? 'http://localhost:3001';
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}/api/me`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });

  if (!response.ok) {
    return (
      <main>
        <h1>Deployz</h1>
        <p>Not signed in.</p>
        <p>
          <a href="/sign-up">Sign up</a> · <a href="/sign-in">Sign in</a>
        </p>
      </main>
    );
  }

  const data = (await response.json()) as MeResponse;
  return (
    <main>
      <h1>Deployz</h1>
      <p>Signed in — Fastify API honored the session:</p>
      <pre data-testid="me-json">{JSON.stringify(data, null, 2)}</pre>
    </main>
  );
}
