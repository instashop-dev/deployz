'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Diagnostics is folded into the deployment page (ux-guidelines §2): the
// recovery panel and the infrastructure check are sections of that page, not
// a second destination. This route stays only as a deep link — old links and
// bookmarks land on the right section instead of a 404. `#startup-evidence`
// (the pre-fold anchor into the failure's evidence) maps to the recovery
// panel; everything else lands on the infrastructure check under Technical
// details.
export default function DiagnosticsRedirectPage() {
  const params = useParams();
  const router = useRouter();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');

  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const target = hash === '#startup-evidence' ? 'recovery' : 'infrastructure-check';
    router.replace(`/dashboard/deployments/${id}#${target}`);
  }, [id, router]);

  return null;
}
