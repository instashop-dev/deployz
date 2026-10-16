const IGNORED_FOLDERS = ['/tmp', '/var/tmp', '/run', '/var/run', '/proc', '/dev', '/root/.cache', '/var/log', '/var/cache'];

function stripKind(line: string): string {
  return line.replace(/^[ACD] /, '');
}

function isIgnored(path: string): boolean {
  if (IGNORED_FOLDERS.some((folder) => path === folder || path.startsWith(`${folder}/`))) return true;
  if (/\.(pid|log)$/.test(path)) return true;
  if (/^\/home\/[^/]+\/\.cache(\/|$)/.test(path)) return true;
  return /(^|\/)(node_modules\/\.cache|__pycache__)(\/|$)/.test(path);
}

/** `docker diff` paths that are real local state: not temp, log, cache or pid files. */
export function filterLocalDiskWrites(lines: readonly string[]): string[] {
  return [...new Set(lines.map(stripKind).filter((path) => !isIgnored(path)))].sort();
}

export function sqliteFileWritten(lines: readonly string[]): boolean {
  return lines.some((line) => /\.(sqlite3?|db)$/.test(stripKind(line)));
}
