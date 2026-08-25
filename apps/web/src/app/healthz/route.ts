// Health-check target for the container platform's public endpoint. Kept
// separate from the landing page so a health check is a few bytes rather than
// a full server render, and so a styling failure on "/" cannot take the
// deployment down.
export const dynamic = 'force-static';

export function GET() {
  return new Response('ok', {
    status: 200,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
}
