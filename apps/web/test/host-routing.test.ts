import { describe, expect, it } from 'vitest';

import { resolveHostRoute } from '../src/lib/host-routing';

const MARKETING = 'deployz.dev';
const APP = 'app.deployz.dev';

const route = (host: string, pathname: string) =>
  resolveHostRoute({ host, pathname, marketingHost: MARKETING, appHost: APP });

describe('resolveHostRoute', () => {
  // The guarantee local dev and the Playwright suite rely on: with the
  // hostnames unconfigured, one origin serves every route and nothing is
  // redirected anywhere.
  describe('when the hostnames are not configured', () => {
    it.each([
      ['/', undefined, undefined],
      ['/dashboard', MARKETING, undefined],
      ['/pricing', undefined, APP],
    ])('serves %s in place', (pathname, marketingHost, appHost) => {
      expect(
        resolveHostRoute({ host: 'localhost', pathname, marketingHost, appHost }),
      ).toBeNull();
    });
  });

  describe('on the marketing host', () => {
    it.each(['/', '/pricing'])('serves %s in place', (pathname) => {
      expect(route(MARKETING, pathname)).toBeNull();
    });

    it.each([
      '/sign-in',
      '/sign-up',
      '/dashboard',
      '/dashboard/deployments',
      '/organizations/new',
      '/install/abc-123',
      '/accept-invitation/xyz',
    ])('sends %s to the app host on the same path', (pathname) => {
      expect(route(MARKETING, pathname)).toEqual({ host: APP, pathname });
    });
  });

  describe('on the app host', () => {
    // A bare app hostname means "take me to the product", not "show me the
    // brochure". No loop: /dashboard without a cookie falls through to the
    // session gate and lands on /sign-in, which the app host owns.
    it('sends the root to the dashboard rather than to marketing', () => {
      expect(route(APP, '/')).toEqual({ host: APP, pathname: '/dashboard' });
    });

    it('sends /pricing back to the marketing host', () => {
      expect(route(APP, '/pricing')).toEqual({ host: MARKETING, pathname: '/pricing' });
    });

    it.each([
      '/sign-in',
      '/dashboard',
      '/dashboard/settings/billing',
      '/install/abc-123',
      '/accept-invitation/xyz',
    ])('serves %s in place', (pathname) => {
      expect(route(APP, pathname)).toBeNull();
    });
  });

  it('leaves an unrecognised host alone', () => {
    expect(route('deployz-web.abc.us-east-1.cs.amazonlightsail.com', '/dashboard')).toBeNull();
  });
});
