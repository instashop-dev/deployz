import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchCustomers, formatDate } from '@/lib/customers';

export default async function CustomersPage() {
  const customers = await fetchCustomers();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add customers and generate their install links here.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/deployments/new">Add Customer</Link>
        </Button>
      </div>

      {customers.length === 0 ? (
        <section
          aria-labelledby="empty-customers"
          className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="empty-customers" className="text-lg font-semibold">
            No customers yet
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            When you add a customer and generate their install link, they appear here.
          </p>
          <Button asChild>
            <Link href="/dashboard/deployments/new">Add your first customer</Link>
          </Button>
        </section>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Customers</CardTitle>
            <CardDescription>
              {customers.length} {customers.length === 1 ? 'customer' : 'customers'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Company</th>
                  <th className="pb-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id} className="border-b last:border-0">
                    <td className="py-2.5 font-medium">{customer.name}</td>
                    <td className="py-2.5 text-muted-foreground">{customer.email}</td>
                    <td className="py-2.5 text-muted-foreground">{customer.company}</td>
                    <td className="py-2.5 text-muted-foreground">
                      {formatDate(customer.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
