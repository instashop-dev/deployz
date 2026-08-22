// Customer data access for the customers list page. A 404 from the API now
// means the caller's organization genuinely has no such resource — it is
// surfaced, never swallowed into look-alike placeholder data.

import { cookies } from 'next/headers';

// Server-side data access: the API URL is the server env (not the public
// one), and the incoming request's session cookie is forwarded so the
// auth-gated endpoint resolves the caller's organization.
const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface Customer {
  id: string;
  name: string;
  email: string;
  company: string;
  createdAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Customers request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchCustomers(): Promise<Customer[]> {
  const body = await getJson<{ customers?: Customer[] }>('/api/customers');
  return body.customers ?? [];
}


export function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
