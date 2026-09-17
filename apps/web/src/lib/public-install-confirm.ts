import { apiUrl } from '@/lib/api-url';

export interface PublicInstallConfirmBody {
  idempotencyKey: string;
  region: string;
  customer: { name: string; email: string };
  config: Array<{ key: string; value: string; isSecret: boolean }>;
}

export type PublicInstallConfirmResult =
  | { ok: true; installLinkId: string }
  | { ok: false; code: string };

/** POST /api/public-install/:linkId/confirm — idempotent customer acceptance. */
export async function confirmPublicInstall(
  linkId: string,
  body: PublicInstallConfirmBody,
): Promise<PublicInstallConfirmResult> {
  const response = await fetch(
    `${apiUrl}/api/public-install/${encodeURIComponent(linkId)}/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (response.status === 201 || response.status === 200) {
    const payload = (await response.json()) as { installLinkId: string };
    return { ok: true, installLinkId: payload.installLinkId };
  }
  const payload: unknown = await response.json().catch(() => null);
  const code = (payload as { error?: { code?: string } } | null)?.error?.code ?? 'UNKNOWN';
  return { ok: false, code };
}
