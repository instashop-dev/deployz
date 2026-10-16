import { OBSERVATION_FACTS, type ObservationRun } from '../contract.js';

/** What QEMU prints when it crashes while it runs an amd64 program (PHP's built-in server does so). */
export const QEMU_CRASH = /qemu-x86_64: QEMU internal SIGSEGV|qemu: uncaught target signal/;

/** The first QEMU crash line in the run's application evidence, or null. The build fact is not read: its crashes are build failures. */
export function emulationCrash(run: ObservationRun): string | null {
  for (const name of OBSERVATION_FACTS) {
    if (name === 'build') continue;
    for (const item of run[name].evidence) {
      const line = item.text.split('\n').find((text) => QEMU_CRASH.test(text));
      if (line !== undefined) return line.trim();
    }
  }
  return null;
}
