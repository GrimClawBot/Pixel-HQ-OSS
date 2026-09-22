import { openSync, closeSync, fsyncSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
const MAX = 18446744073709551615n;
const unavailable = () => new Error('FRESHNESS_STATE_UNAVAILABLE');
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function readEpoch(path) {
  const value = readFileSync(path, 'utf8');
  if (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX) throw unavailable();
  return BigInt(value);
}

// Any existing lock fails closed. Unlink-and-recreate recovery has a race where
// two starters can both publish the same epoch; an operator must clear residue.
function acquireLock(lockFile) {
  const fd = openSync(lockFile, 'wx', 0o600);
  try {
    writeFileSync(fd, String(process.pid));
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

// A newly created directory is the only automatic provisioning path. An existing
// directory with missing/corrupt state fails closed. Never delete it to recover.
export function openFreshnessState(directory) {
  let lock;
  const file = join(directory, 'epoch');
  const lockFile = join(directory, 'advance.lock');
  const temporary = join(directory, 'epoch.next');
  try {
    mkdirSync(dirname(directory), { recursive: true });
    let created = false;
    try { mkdirSync(directory, { mode: 0o700 }); created = true; syncDirectory(dirname(directory)); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    lock = acquireLock(lockFile);
    const prior = created ? 0n : readEpoch(file);
    if (prior === MAX) throw unavailable();
    const epoch = prior + 1n;
    // The lock serializes writers, so truncating a crashed writer's leftover
    // temporary is safe; publication is still the atomic rename below.
    try {
      const fd = openSync(temporary, 'w', 0o600);
      try { writeFileSync(fd, String(epoch)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Nothing left to remove. */ }
      throw error;
    }
    syncDirectory(directory);
    let sequence = 0n;
    let failed = false;
    return Object.freeze({ next() {
      try {
        if (failed || readEpoch(file) !== epoch || sequence === MAX) throw unavailable();
        sequence += 1n;
        return { epoch: String(epoch), sequence: String(sequence) };
      } catch { failed = true; throw unavailable(); }
    } });
  } catch { throw unavailable(); }
  finally {
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(lockFile);
      syncDirectory(directory);
    }
  }
}
