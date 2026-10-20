#!/usr/bin/env node
// End-to-end smoke test against the LOCAL `transit-demo` database.
//
//   cd demo-app && node scripts/e2e-smoke.mjs
//
// Uses the real `spacetimedb` TS SDK and the generated bindings in
// src/module_bindings. The bindings are TypeScript with extensionless imports,
// so they are bundled on the fly with esbuild (already a dev dependency via
// @angular/build) into a temporary ESM file, then imported.
//
// Scenario: a supervisor and two drivers connect with distinct fresh identities,
// driver A claims a bus, driver B fails to claim the same bus, driver A reports
// an incident, the supervisor takes it in charge, the supervisor messages both
// drivers, each driver sees only its own message, positions keep updating.
// Everything created is cleaned up at the end (incident resolved, buses released).

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.STDB_DB ?? 'transit-demo';
const SUPERVISOR_CODE = 'PCC2026';
const TIMEOUT_MS = 10_000;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'transville-e2e-'));
const outFile = join(outDir, 'bindings.mjs');
await build({
  entryPoints: [join(here, '..', 'src', 'module_bindings', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: outFile,
  logLevel: 'error',
});
const { DbConnection, tables } = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------- helpers
let passed = 0;
let failed = 0;
const ok = (msg) => { passed++; console.log(`  PASS  ${msg}`); };
const ko = (msg) => { failed++; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : ko(msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => String(e?.message ?? e);

async function waitFor(desc, fn, timeout = TIMEOUT_MS) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${desc}`);
    await sleep(50);
  }
}

async function expectReject(promise, includes, msg) {
  try {
    await promise;
    ko(`${msg} (call succeeded, expected rejection)`);
  } catch (e) {
    const m = errMsg(e);
    check(m.includes(includes), `${msg} -> "${m}"`);
  }
}

/** Opens a connection with a FRESH identity (no token) and subscribes. */
function connect(label, queries) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: connect timeout`)), TIMEOUT_MS);
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect((c, identity) => {
        c.subscriptionBuilder()
          .onApplied(() => { clearTimeout(timer); resolve({ label, conn: c, identity }); })
          .onError((_ctx, err) => { clearTimeout(timer); reject(new Error(`${label}: subscription error ${errMsg(err)}`)); })
          .subscribe(queries);
      })
      .onConnectError((_c, err) => { clearTimeout(timer); reject(new Error(`${label}: connect error ${errMsg(err)}`)); })
      .build();
    void conn;
  });
}

const hex = (id) => id.toHexString();
const rows = (handle) => [...handle.iter()];

// ---------------------------------------------------------------- scenario
const clients = [];
let exitCode = 0;
let incidentId;

try {
  console.log(`Connecting to ${URI} / ${DB}`);
  const sup = await connect('supervisor', [
    tables.appUser, tables.vehicle, tables.simConfig, tables.vehiclePosition,
    tables.driverAssignment, tables.incident, tables.supervisorMessages, tables.auditTrail,
  ]);
  const drvA = await connect('driverA', [
    tables.appUser, tables.vehicle, tables.driverAssignment, tables.incident, tables.myMessages,
  ]);
  const drvB = await connect('driverB', [
    tables.appUser, tables.vehicle, tables.driverAssignment, tables.incident, tables.myMessages,
  ]);
  clients.push(sup, drvA, drvB);
  const ids = new Set(clients.map((c) => hex(c.identity)));
  check(ids.size === 3, 'three clients have distinct identities');

  // --- registration
  console.log('Registration');
  await expectReject(
    sup.conn.reducers.registerUser({ name: 'Marie Smoke', role: { tag: 'Supervisor' }, accessCode: 'WRONG' }),
    "Code d'accès PCC invalide", 'supervisor with wrong code is rejected');
  await sup.conn.reducers.registerUser({ name: 'Marie Smoke', role: { tag: 'Supervisor' }, accessCode: SUPERVISOR_CODE });
  await drvA.conn.reducers.registerUser({ name: 'Alain Smoke', role: { tag: 'Driver' }, accessCode: '' });
  await drvB.conn.reducers.registerUser({ name: 'Béa Smoke', role: { tag: 'Driver' }, accessCode: '' });
  const meSup = await waitFor('supervisor AppUser row', () => sup.conn.db.appUser.identity.find(sup.identity));
  check(meSup.role.tag === 'Supervisor', 'supervisor registered with role Supervisor');
  const meA = await waitFor('driver A AppUser row', () => drvA.conn.db.appUser.identity.find(drvA.identity));
  check(meA.role.tag === 'Driver', 'driver A registered with role Driver');
  await expectReject(drvA.conn.reducers.takeIncident({ incidentId: 0n }), 'Accès refusé', 'driver cannot call a supervisor reducer');

  // --- claim
  console.log('Vehicle claim');
  const taken = new Set(rows(sup.conn.db.driverAssignment).map((a) => a.vehicleId));
  const free = rows(sup.conn.db.vehicle).map((v) => v.id).filter((id) => !taken.has(id)).sort((a, b) => a - b);
  if (free.length < 2) throw new Error(`need 2 free vehicles, found ${free.length} (other drivers connected?)`);
  const [busA, busB] = free;
  await drvA.conn.reducers.claimVehicle({ vehicleId: busA });
  const asgA = await waitFor('assignment A visible to supervisor',
    () => sup.conn.db.driverAssignment.vehicleId.find(busA));
  check(asgA.driverIdentity.isEqual(drvA.identity) && asgA.driverName === 'Alain Smoke', `driver A holds Bus ${busA}`);
  await expectReject(drvB.conn.reducers.claimVehicle({ vehicleId: busA }), 'déjà pris par Alain Smoke',
    `driver B cannot claim Bus ${busA}`);
  check(sup.conn.db.driverAssignment.vehicleId.find(busA).driverIdentity.isEqual(drvA.identity),
    `Bus ${busA} still assigned to driver A after the failed claim`);
  await drvB.conn.reducers.claimVehicle({ vehicleId: busB });
  await waitFor('assignment B', () => drvB.conn.db.driverAssignment.vehicleId.find(busB));
  ok(`driver B claims another bus (Bus ${busB})`);

  // --- positions update (before the incident immobilises bus A)
  console.log('Positions');
  const cfg = rows(sup.conn.db.simConfig)[0];
  let unpaused = false;
  if (cfg?.paused) {
    await sup.conn.reducers.setSimPaused({ paused: false });
    unpaused = true;
  }
  const before = new Map(rows(sup.conn.db.vehiclePosition).map((p) => [p.vehicleId, p]));
  check(before.size > 0, `supervisor sees ${before.size} vehicle positions`);
  const tick0 = rows(sup.conn.db.simConfig)[0]?.tickCount ?? 0n;
  await sleep(3500);
  const after = rows(sup.conn.db.vehiclePosition);
  const tick1 = rows(sup.conn.db.simConfig)[0]?.tickCount ?? 0n;
  check(tick1 > tick0, `simulation ticks advance (${tick0} -> ${tick1})`);
  const refreshed = after.filter((p) => {
    const b = before.get(p.vehicleId);
    return b && p.updatedAt.microsSinceUnixEpoch > b.updatedAt.microsSinceUnixEpoch;
  });
  check(refreshed.length === after.length, `all positions refreshed (${refreshed.length}/${after.length})`);
  const moved = after.filter((p) => {
    const b = before.get(p.vehicleId);
    return b && (p.lat !== b.lat || p.lon !== b.lon);
  });
  check(moved.length > 0, `some vehicles moved (${moved.length}/${after.length})`);
  for (const p of after) {
    if (p.lat < 46.7 || p.lat > 46.9 || p.lon < 7.05 || p.lon > 7.25) ko(`Bus ${p.vehicleId} out of Fribourg bbox (${p.lat}, ${p.lon})`);
  }

  // --- incident
  console.log('Incident');
  await expectReject(drvA.conn.reducers.reportIncident({ kind: { tag: 'Breakdown' }, description: 'x'.repeat(281) }),
    '', 'description > 280 chars is rejected');
  const desc = `Smoke test ${Date.now()}`;
  await drvA.conn.reducers.reportIncident({ kind: { tag: 'Breakdown' }, description: desc });
  const inc = await waitFor('incident visible to supervisor',
    () => rows(sup.conn.db.incident).find((i) => i.description === desc));
  incidentId = inc.id;
  check(inc.status.tag === 'Open' && inc.vehicleId === busA && inc.reportedBy.isEqual(drvA.identity)
    && inc.reporterName === 'Alain Smoke' && inc.severity.tag === 'Medium',
    `incident #${inc.id} Open, Medium, Bus ${busA}, reported by driver A`);
  const posA = sup.conn.db.vehiclePosition.vehicleId.find(busA);
  check(Math.abs(inc.lat - posA.lat) < 0.01 && Math.abs(inc.lon - posA.lon) < 0.01, 'incident located at the bus position');
  await waitFor('bus A immobilised', () => sup.conn.db.vehiclePosition.vehicleId.find(busA)?.status.tag === 'Immobilized', 5000)
    .then(() => ok(`Bus ${busA} becomes Immobilized`), () => ko(`Bus ${busA} not Immobilized after Breakdown`));

  await sup.conn.reducers.takeIncident({ incidentId });
  const taken1 = await waitFor('incident in progress (driver view)', () => {
    const i = drvA.conn.db.incident.id.find(incidentId);
    return i?.status.tag === 'InProgress' ? i : undefined;
  });
  check(taken1.assigneeName === 'Marie Smoke' && taken1.assignedTo?.isEqual(sup.identity),
    'driver A sees "Pris en charge par Marie Smoke"');
  await expectReject(sup.conn.reducers.takeIncident({ incidentId }), 'déjà pris en charge', 'taking it twice is rejected');

  // --- messages
  console.log('Messages');
  const bodyA = `Message pour A ${Date.now()}`;
  const bodyB = `Message pour B ${Date.now()}`;
  await sup.conn.reducers.sendDriverMessage({ vehicleId: busA, body: bodyA });
  await sup.conn.reducers.sendDriverMessage({ vehicleId: busB, body: bodyB });
  const msgA = await waitFor('driver A receives its message', () => rows(drvA.conn.db.myMessages).find((m) => m.body === bodyA));
  await waitFor('driver B receives its message', () => rows(drvB.conn.db.myMessages).find((m) => m.body === bodyB));
  await sleep(300);
  const aMsgs = rows(drvA.conn.db.myMessages);
  const bMsgs = rows(drvB.conn.db.myMessages);
  check(aMsgs.every((m) => m.toDriver.isEqual(drvA.identity)) && !aMsgs.some((m) => m.body === bodyB),
    `driver A only receives its own messages (${aMsgs.length} row)`);
  check(bMsgs.every((m) => m.toDriver.isEqual(drvB.identity)) && !bMsgs.some((m) => m.body === bodyA),
    `driver B only receives its own messages (${bMsgs.length} row)`);
  check(msgA.fromName === 'Marie Smoke' && msgA.vehicleId === busA && !msgA.acknowledged, 'message metadata correct, unread');
  check(rows(drvA.conn.db.myMessages).length === 1, 'driver A has exactly one message (fresh identity)');
  await waitFor('supervisor sees both messages', () => {
    const s = rows(sup.conn.db.supervisorMessages);
    return s.some((m) => m.body === bodyA) && s.some((m) => m.body === bodyB);
  }).then(() => ok('supervisor message log contains both messages'), () => ko('supervisor message log incomplete'));
  await expectReject(drvB.conn.reducers.acknowledgeMessage({ messageId: msgA.id }), 'Message introuvable',
    "driver B cannot acknowledge driver A's message");
  await drvA.conn.reducers.acknowledgeMessage({ messageId: msgA.id });
  await waitFor('ack visible to supervisor', () =>
    rows(sup.conn.db.supervisorMessages).find((m) => m.id === msgA.id && m.acknowledged))
    .then(() => ok('acknowledgement visible to supervisor'), () => ko('acknowledgement not visible to supervisor'));

  // --- ghost driver (closed tab) -> supervisor force release
  console.log('Ghost driver');
  {
    const ghost = await connect('ghost', [tables.appUser, tables.vehicle, tables.driverAssignment]);
    await ghost.conn.reducers.registerUser({ name: 'Ghost Smoke', role: { tag: 'Driver' }, accessCode: '' });
    const held = new Set(rows(sup.conn.db.driverAssignment).map((a) => a.vehicleId));
    const free = rows(sup.conn.db.vehicle).map((v) => v.id).find((id) => !held.has(id));
    if (free === undefined) {
      ko('no free bus left for the ghost driver test');
    } else {
      await ghost.conn.reducers.claimVehicle({ vehicleId: free });
      ghost.conn.disconnect(); // tab closed: this identity never comes back
      await waitFor('ghost assignment visible', () => rows(sup.conn.db.driverAssignment).find((a) => a.vehicleId === free));
      await expectReject(drvB.conn.reducers.forceReleaseVehicle({ vehicleId: free }), 'Accès refusé', 'driver cannot force-release a bus');
      await sup.conn.reducers.forceReleaseVehicle({ vehicleId: free });
      await waitFor('ghost bus freed', () => !rows(sup.conn.db.driverAssignment).some((a) => a.vehicleId === free))
        .then(() => ok(`supervisor force-releases the ghost's bus (${free})`), () => ko('ghost bus still held after force release'));
      await expectReject(sup.conn.reducers.forceReleaseVehicle({ vehicleId: free }), "n'a pas de chauffeur",
        'force-releasing a bus without driver is rejected');
    }
  }

  // --- audit
  const audit = rows(sup.conn.db.auditTrail).map((a) => a.action);
  check(['VEHICLE_CLAIMED', 'INCIDENT_REPORTED', 'INCIDENT_TAKEN', 'MESSAGE_SENT', 'MESSAGE_ACK'].every((a) => audit.includes(a)),
    'supervisor audit trail contains the scenario actions');

  if (unpaused) await sup.conn.reducers.setSimPaused({ paused: true });
} catch (e) {
  ko(`unexpected error: ${errMsg(e)}`);
} finally {
  // --- cleanup (best effort)
  const [sup, drvA, drvB] = clients;
  try {
    if (sup && incidentId !== undefined) await sup.conn.reducers.resolveIncident({ incidentId, note: 'Fin du smoke test' });
  } catch (e) { console.log(`  (cleanup) resolve: ${errMsg(e)}`); }
  for (const d of [drvA, drvB]) {
    try { if (d) await d.conn.reducers.releaseVehicle({}); } catch (e) { console.log(`  (cleanup) release: ${errMsg(e)}`); }
  }
  for (const c of clients) c.conn.disconnect();
  rmSync(outDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(exitCode), 200);
}
