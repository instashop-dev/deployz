/**
 * What an amd64 program shows when QEMU fails under it: QEMU's own crash
 * lines (PHP's built-in server), and the Go runtime's crashes on a
 * non-canonical address or its lock-free stack, which a real x86_64 CPU
 * cannot produce (F5 crashed so in about 3 of 4 starts).
 */
export const QEMU_CRASH =
  /qemu-x86_64: QEMU internal SIGSEGV|qemu: uncaught target signal|fatal error: lfstack\.push|sigcode=\d+ addr=0xffff[0-9a-f]{8,}/;
