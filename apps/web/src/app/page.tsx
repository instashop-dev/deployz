import { redirect } from 'next/navigation';

// The dashboard is the product entry point (marketing pages are descoped per
// §41); unauthenticated visitors are bounced to /sign-in by the middleware.
export default function Home() {
  redirect('/dashboard');
}
