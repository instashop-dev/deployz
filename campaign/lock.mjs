// Coordinator lock for the fresh-100 campaign.
// Usage: node campaign/lock.mjs acquire --role <routine|manual> --desktop-session <id> [--note <text>]
//        node campaign/lock.mjs status
//        node campaign/lock.mjs release --token <token>
//        node campaign/lock.mjs recover --token <owner token> --evidence <text>
// acquire recovers a lock by itself only when the owner process is proven gone. An idle Desktop
// session keeps its process alive, so recover takes outside evidence (the owner's Desktop session
// is no longer running) and only moves the lock aside; run acquire again afterwards.
// Exit codes: 0 ok, 3 held by a live or unproven owner, 4 token mismatch or no lock, 1 error.
// CAMPAIGN_LOCK_PATH overrides the lock path (isolated tests only).
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const campaignDir = path.dirname(fileURLToPath(import.meta.url));
const lockPath = process.env.CAMPAIGN_LOCK_PATH ?? path.join(campaignDir, 'coordinator.lock');
const recoveredDir = path.join(path.dirname(lockPath), 'logs', 'locks');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function out(value, code) {
  console.log(JSON.stringify(value, null, 2));
  process.exit(code);
}

function readLock(file = lockPath) {
  try {
    return { lock: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { lock: null };
    return { lock: null, unreadable: String(error.message) };
  }
}

// Returns { pid, name, createdAt } for a live process, null when it does not exist, undefined when unknown.
function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return error.code === 'ESRCH' ? null : undefined;
    }
    return { pid, name: null, createdAt: null };
  }
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { @{ pid = $p.ProcessId; name = $p.Name; createdAt = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress } else { 'null' }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return undefined;
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return undefined;
  }
}

// true: owner process is running. false: proven gone (absent, or the PID was reused). null: no proof.
function ownerAlive(lock) {
  const owner = lock?.ownerProcess;
  if (!owner?.pid || !owner.createdAt) return null;
  const now = processInfo(owner.pid);
  if (now === undefined) return null;
  if (now === null) return false;
  if (now.createdAt && now.createdAt !== owner.createdAt) return false;
  return true;
}

function writeLockAtomically(record) {
  const tmp = `${lockPath}.${record.token}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  try {
    fs.linkSync(tmp, lockPath);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.unlinkSync(tmp);
  }
}

// Moves the lock aside if it still belongs to the token judged abandoned; returns the new path or null.
function moveAside(deadToken) {
  fs.mkdirSync(recoveredDir, { recursive: true });
  const moved = path.join(recoveredDir, `recovered-${new Date().toISOString().replace(/[:.]/g, '-')}-${deadToken}.json`);
  try {
    fs.renameSync(lockPath, moved);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const { lock: movedLock } = readLock(moved);
  if (movedLock?.token !== deadToken) {
    // Another contender replaced the lock between the check and the rename: put it back.
    try {
      fs.linkSync(moved, lockPath);
      fs.unlinkSync(moved);
    } catch {
      out({ acquired: false, error: 'lock changed during recovery', moved }, 1);
    }
    return null;
  }
  return moved;
}

function acquire() {
  const role = arg('role');
  if (role !== 'routine' && role !== 'manual') out({ acquired: false, error: '--role routine|manual is required' }, 1);
  const desktopSessionId = arg('desktop-session');
  if (!desktopSessionId) out({ acquired: false, error: '--desktop-session <id> is required (get_session "self")' }, 1);
  const pid = Number(process.env.CLAUDE_PID);
  const owner = processInfo(pid);
  if (!owner) out({ acquired: false, error: 'CLAUDE_PID is not set or its process cannot be inspected; owner liveness could not be recorded' }, 1);
  const record = {
    token: randomUUID(),
    role,
    note: arg('note') ?? null,
    acquiredAt: new Date().toISOString(),
    host: os.hostname(),
    user: os.userInfo().username,
    cwd: process.cwd(),
    desktopSessionId,
    claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
    ownerProcess: owner,
    recoveredFrom: null,
  };
  if (writeLockAtomically(record)) out({ acquired: true, lockPath, ...record }, 0);

  const { lock, unreadable } = readLock();
  if (!lock) out({ acquired: false, lockPath, reason: unreadable ? 'lock file unreadable; do not recover without investigation' : 'lock released during check; run acquire again', unreadable }, 3);
  const alive = ownerAlive(lock);
  if (alive !== false) out({ acquired: false, lockPath, ownerAlive: alive, owner: lock }, 3);

  const moved = moveAside(lock.token);
  if (!moved) out({ acquired: false, lockPath, reason: 'another contender changed the lock; exit' }, 3);
  record.recoveredFrom = { token: lock.token, ownerProcess: lock.ownerProcess, acquiredAt: lock.acquiredAt, evidence: 'owner process absent or PID reused (creation time differs)', movedTo: moved };
  if (writeLockAtomically(record)) out({ acquired: true, lockPath, ...record }, 0);
  out({ acquired: false, lockPath, reason: 'another contender acquired the lock after recovery', owner: readLock().lock }, 3);
}

function status() {
  const { lock, unreadable } = readLock();
  if (!lock) out({ held: Boolean(unreadable), lockPath, unreadable }, 0);
  out({ held: true, lockPath, ownerAlive: ownerAlive(lock), owner: lock }, 0);
}

function release() {
  const token = arg('token');
  const { lock } = readLock();
  if (!lock || !token || lock.token !== token) out({ released: false, lockPath, reason: lock ? 'token does not match the owner' : 'no lock' }, 4);
  fs.unlinkSync(lockPath);
  out({ released: true, lockPath, token }, 0);
}

function recover() {
  const token = arg('token');
  const evidence = arg('evidence');
  if (!token || !evidence) out({ recovered: false, error: '--token and --evidence are required' }, 1);
  const { lock } = readLock();
  if (!lock || lock.token !== token) out({ recovered: false, lockPath, reason: lock ? 'the lock has another owner now' : 'no lock' }, 4);
  const moved = moveAside(token);
  if (!moved) out({ recovered: false, lockPath, reason: 'the lock changed during recovery' }, 3);
  fs.writeFileSync(`${moved}.evidence.txt`, `${new Date().toISOString()} recovered by CLAUDE_PID ${process.env.CLAUDE_PID ?? '?'}: ${evidence}\n`);
  out({ recovered: true, lockPath, movedTo: moved, evidence }, 0);
}

const commands = { acquire, status, release, recover };
const command = commands[process.argv[2]];
if (!command) out({ error: 'usage: acquire --role <routine|manual> --desktop-session <id> [--note <text>] | status | release --token <token> | recover --token <token> --evidence <text>' }, 1);
command();
