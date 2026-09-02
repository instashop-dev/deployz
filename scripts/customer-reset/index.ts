/**
 * Entry point for the customer-cleanup admin CLI — an operator tool that
 * wipes every CUSTOMER deployment (AWS resources + DB rows) while preserving
 * control-plane data. See safety.ts for the invariants this never crosses.
 *
 *   pnpm admin:customer-cleanup inventory
 *   pnpm admin:customer-cleanup execute --confirm FULL-CUSTOMER-RESET
 *   pnpm admin:customer-cleanup verify
 */

import { runCleanup } from './cleanup.js';
import { runInventory } from './inventory.js';
import { runVerify } from './verify.js';

function usage(): void {
  console.error('Usage: admin:customer-cleanup <inventory|execute --confirm FULL-CUSTOMER-RESET|verify>');
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case 'inventory':
      await runInventory();
      return;
    case 'execute':
      await runCleanup(rest);
      return;
    case 'verify':
      await runVerify();
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
