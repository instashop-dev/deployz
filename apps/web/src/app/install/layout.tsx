import type { ReactNode } from 'react';

// Public install layout — deliberately distinct from the auth layout (a
// centered form card) and the dashboard shell (sidebar + user menu). The
// visitor is a CUSTOMER of a Deployz vendor holding a unique link; they have
// no Deployz account and never need one. No session fetch, no auth gate:
// the middleware matcher does not cover /install, and nothing here calls
// fetchMe().
export default function InstallLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between px-4">
          <span className="font-heading text-lg font-semibold tracking-tight">Deployz</span>
          <span className="text-xs text-muted-foreground">Private install link</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">{children}</main>
      <footer className="border-t">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 text-xs text-muted-foreground">
          This page is public by design: anyone holding this unique link can view it, and no
          Deployz account is needed. Don&apos;t share the link publicly.
        </div>
      </footer>
    </div>
  );
}
