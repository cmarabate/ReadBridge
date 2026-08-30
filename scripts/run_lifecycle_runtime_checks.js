/*
 * Companion lifecycle runtime checks.
 *
 * Deterministic Windows runtime cases against the built companion. Every case is observed
 * against real OS process state - no case is decided by reasoning about the source.
 *
 *   node scripts/run_lifecycle_runtime_checks.js [--out <path>]
 *
 * Requires Windows and a built companion (`yarn verify:build`). Writes a machine-readable
 * record; docs/evidence/companion-lifecycle-runtime.json is a committed run of this script.
 *
 * The decisive case is the C9/C10 A/B pair. Both trials hold the companion's stdin open from
 * this process and kill the host with `taskkill /F` WITHOUT `/T`, so neither stdin EOF nor
 * process-tree teardown can end the companion: only the --parent-pid watchdog can. C10 is the
 * control and is EXPECTED to leave a genuine orphan, which the harness then reaps.
 */
const { spawn, spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXE = path.join(REPO_ROOT, 'native/ReadBridge.Companion/bin/Debug/net10.0-windows/ReadBridge.Companion.exe');

const outFlag = process.argv.indexOf('--out');
const OUT_PATH = outFlag >= 0 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1]) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function waitForExit(pid, timeoutMs) {
  const step = 50;
  for (let waited = step; waited <= timeoutMs; waited += step) {
    await sleep(step);
    if (!isAlive(pid)) return waited;
  }
  return null;
}

/** Every live companion process on this machine, so each case can assert zero orphans. */
function companionCensus() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
        "(Get-Process -Name ReadBridge.Companion -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
      { encoding: 'utf8' }
    ).trim();
    return out ? out.split(',').map(Number) : [];
  } catch {
    return [];
  }
}

function forceKill(pid) {
  spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
}

/** Minimal stdio JSON-RPC client over a spawned companion. */
function attach(child) {
  let buffer = '';
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const idx = waiters.findIndex((w) => w.id === msg.id);
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
    }
  });
  let n = 0;
  return function call(method, params = {}, timeoutMs = 20000) {
    const id = 'r' + ++n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), timeoutMs);
      waiters.push({ id, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
}

const cases = [];
function record(o) {
  cases.push(o);
  console.error(`[case] ${o.id} -> ${o.outcome}`);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('these checks are Windows-only');
  if (!fs.existsSync(EXE)) throw new Error(`companion binary not found: ${EXE} (run \`yarn verify:build\`)`);

  const censusStart = companionCensus();

  // C1-C5: request path, overlay lifecycle, cancellation, graceful shutdown.
  {
    const child = spawn(EXE, ['ipc', '--parent-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const call = attach(child);
    const pid = child.pid;

    const t0 = Date.now();
    const pong = await call('ping');
    record({ id: 'C1-normal-start-and-request-response', outcome: pong.result === 'pong' ? 'PASS' : 'FAIL',
      companionPid: pid, pingResult: pong.result ?? null, pingLatencyMs: Date.now() - t0 });

    const rects = [{ x: 400, y: 300, width: 120, height: 24 }, { x: 524, y: 300, width: 80, height: 24 }];
    const show = await call('showHighlight', { wordRects: rects });
    await sleep(400);
    const aliveAfterShow = isAlive(pid);
    record({ id: 'C2-overlay-show', outcome: show.result === 'ok' && aliveAfterShow ? 'PASS' : 'FAIL',
      rectsSent: rects.length, response: show.result ?? null, companionAliveAfter: aliveAfterShow });

    const clear = await call('clearHighlight');
    const stillServing = await call('ping');
    record({ id: 'C3-overlay-clear-then-still-serving', outcome: clear.result === 'ok' && stillServing.result === 'pong' ? 'PASS' : 'FAIL',
      clearResponse: clear.result ?? null, subsequentPing: stillServing.result ?? null });

    await call('showHighlight', { wordRects: rects });
    const cancel = await call('clearHighlight');
    const afterCancel = await call('ping');
    record({ id: 'C4-cancellation-mid-job', outcome: cancel.result === 'ok' && afterCancel.result === 'pong' ? 'PASS' : 'FAIL',
      cancelResponse: cancel.result ?? null, subsequentPing: afterCancel.result ?? null });

    child.stdin.end(); // stdin EOF -> Console.ReadLine returns null -> main loop unwinds
    const exitMs = await waitForExit(pid, 10000);
    record({ id: 'C5-graceful-shutdown-stdin-eof', outcome: exitMs !== null ? 'PASS' : 'FAIL',
      companionPid: pid, exitObservedWithinMs: exitMs });
    if (exitMs === null) forceKill(pid);
  }

  const censusAfterGraceful = companionCensus();
  record({ id: 'C6-orphan-census-after-graceful', outcome: censusAfterGraceful.length === censusStart.length ? 'PASS' : 'FAIL',
    companionPidsBefore: censusStart, companionPidsAfter: censusAfterGraceful });

  // C7: repeated start/stop cycles.
  {
    const cycles = [];
    for (let i = 0; i < 5; i++) {
      const child = spawn(EXE, ['ipc', '--parent-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const call = attach(child);
      const pid = child.pid;
      const pong = await call('ping');
      child.stdin.end();
      const exitMs = await waitForExit(pid, 10000);
      if (exitMs === null) forceKill(pid);
      cycles.push({ cycle: i + 1, pid, ping: pong.result ?? null, exitObservedWithinMs: exitMs });
    }
    const ok = cycles.every((c) => c.ping === 'pong' && c.exitObservedWithinMs !== null);
    record({ id: 'C7-repeated-start-stop-x5', outcome: ok ? 'PASS' : 'FAIL', cycles });
  }

  const censusAfterCycles = companionCensus();
  record({ id: 'C8-orphan-census-after-cycles', outcome: censusAfterCycles.length === censusStart.length ? 'PASS' : 'FAIL',
    companionPidsBefore: censusStart, companionPidsAfter: censusAfterCycles });

  // C9 / C10: watchdog A/B under host force-kill, with stdin deliberately held open.
  async function forceKillTrial(useParentPid, observeMs) {
    const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    host.unref();
    const hostPid = host.pid;

    const args = useParentPid ? ['ipc', '--parent-pid', String(hostPid)] : ['ipc'];
    const child = spawn(EXE, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const call = attach(child);
    const pid = child.pid;

    const pong = await call('ping');
    forceKill(hostPid); // no /T: the companion is never a taskkill target
    await waitForExit(hostPid, 5000);

    const exitMs = await waitForExit(pid, observeMs);
    const stdinStillOpen = !child.stdin.destroyed;

    let survived = false;
    if (exitMs === null) {
      survived = true;
      forceKill(pid); // reap the orphan the control case deliberately produced
    }
    try { child.stdin.end(); } catch { /* already closed */ }
    if (isAlive(hostPid)) forceKill(hostPid);

    return { hostPid, companionPid: pid, ping: pong.result ?? null, stdinHeldOpenByHarness: stdinStillOpen,
      companionExitedWithinMs: exitMs, observationWindowMs: observeMs, survived };
  }

  const withFlag = await forceKillTrial(true, 10000);
  record(Object.assign({ id: 'C9-host-force-kill-WITH-parent-pid',
    outcome: withFlag.companionExitedWithinMs !== null ? 'PASS' : 'FAIL' }, withFlag));

  const withoutFlag = await forceKillTrial(false, 8000);
  record(Object.assign({ id: 'C10-control-host-force-kill-WITHOUT-parent-pid',
    outcome: withoutFlag.survived ? 'PASS (orphan reproduced as expected)' : 'FAIL (control did not reproduce the orphan)' }, withoutFlag));

  await sleep(500);
  const censusEnd = companionCensus();
  record({ id: 'C11-orphan-census-final', outcome: censusEnd.length === censusStart.length ? 'PASS' : 'FAIL',
    companionPidsBefore: censusStart, companionPidsAfter: censusEnd });

  const failureCount = cases.filter((c) => String(c.outcome).startsWith('FAIL')).length;
  const report = {
    harness: 'scripts/run_lifecycle_runtime_checks.js',
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    cases,
    failureCount,
  };

  const serialized = JSON.stringify(report, null, 2);
  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, serialized + '\n');
    console.error(`[out] ${OUT_PATH}`);
  } else {
    console.log(serialized);
  }
  process.exit(failureCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR: ' + err.stack);
  process.exit(2);
});
