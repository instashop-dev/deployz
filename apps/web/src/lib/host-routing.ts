// One Next.js build serves two hostnames:
//
//   deployz.dev     -> marketing: "/" and "/pricing"
//   app.deployz.dev -> the product: sign-in, dashboard, install, invitations
//
// The routing table lives here rather than in middleware.ts so it can be
// tested without pulling in the Edge runtime. When either hostname is
// unconfigured — local dev, `next dev`, the Playwright suite — the split is
// disabled entirely and one origin serves every route, exactly as before.

/** Paths the marketing hostname owns. Everything else belongs to the app. */
const MARKETING_PATHS = new Set(['/', '/pricing']);

interface HostRouteInput {
  /** Lowercased, port-stripped Host header. */
  readonly host: string;
  readonly pathname: string;
  readonly marketingHost: string | undefined;
  readonly appHost: string | undefined;
}

interface HostRoute {
  readonly host: string;
  readonly pathname: string;
}

/**
 * Where a request should end up, or null to serve it where it landed.
 */
export function resolveHostRoute(input: HostRouteInput): HostRoute | null {
  const { host, pathname, marketingHost, appHost } = input;

  // Both hostnames must be configured for the split to mean anything.
  if (!marketingHost || !appHost) return null;

  const isMarketingPath = MARKETING_PATHS.has(pathname);

  // Anything that isn't marketing belongs on the app host.
  if (host === marketingHost && !isMarketingPath) {
    return { host: appHost, pathname };
  }

  if (host === appHost) {
    // Someone typing the bare app hostname wants the product, not the
    // brochure. This cannot loop: /dashboard without a session cookie falls
    // through to the gate below and lands on /sign-in, which the app owns.
    if (pathname === '/') return { host: appHost, pathname: '/dashboard' };
    if (isMarketingPath) return { host: marketingHost, pathname };
  }

  return null;
}
