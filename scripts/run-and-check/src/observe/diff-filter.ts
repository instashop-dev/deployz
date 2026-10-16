import { CA_DIR } from '../services/index.js';

/** The harness mounts the CA volume at CA_DIR; Docker creates that folder and its parents. */
const MOUNT_POINTS = CA_DIR.split('/').slice(1).map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`);

const IGNORED_FOLDERS = ['/tmp', '/var/tmp', '/run', '/var/run', '/proc', '/dev', '/root/.cache', '/var/log', '/var/cache'];

function stripKind(line: string): string {
  return line.replace(/^[ACD] /, '');
}

function isIgnored(path: string): boolean {
  if (MOUNT_POINTS.includes(path)) return true;
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
