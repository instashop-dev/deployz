// §42 onboarding overview — data access. `GET /api/onboarding` returns the
// six step KEYS plus the 1-based current step; the labels come from
// ONBOARDING_STEPS (readiness.ts) so the copy has one home.

import { cookies } from 'next/headers';

import { serverApiUrl } from '@/lib/api-url';

interface OnboardingState {
  steps: { step: string; completed: boolean }[];
  currentStep: number;
}

export async function fetchOnboarding(): Promise<OnboardingState> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}/api/onboarding`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Onboarding request failed (${response.status})`);
  }
  return (await response.json()) as OnboardingState;
}
