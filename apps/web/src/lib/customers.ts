// Customer data access for the customers list page. The customers API
// endpoint arrives in a later todo; until then fetchCustomers falls back
// to realistic FIXTURE data on a 404 (same pattern as todos 19/25/26/30).

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface Customer {
  id: string;
  name: string;
  email: string;
  company: string;
  createdAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Customers request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(404)');
}

export async function fetchCustomers(): Promise<Customer[]> {
  try {
    const body = await getJson<{ customers?: Customer[] }>('/api/customers');
    return body.customers ?? [];
  } catch (error) {
    if (isNotFound(error)) return FIXTURE_CUSTOMERS;
    throw error;
  }
}

export const FIXTURE_CUSTOMERS: Customer[] = [
  {
    id: 'customer-acme',
    name: 'Alice Chen',
    email: 'alice@acme.com',
    company: 'Acme Corp',
    createdAt: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'customer-northwind',
    name: 'Bob Smith',
    email: 'bob@northwind.com',
    company: 'Northwind Retail',
    createdAt: '2026-08-05T14:30:00.000Z',
  },
  {
    id: 'customer-globex',
    name: 'Carol Jones',
    email: 'carol@globex.com',
    company: 'Globex Inc',
    createdAt: '2026-08-10T09:15:00.000Z',
  },
];

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
