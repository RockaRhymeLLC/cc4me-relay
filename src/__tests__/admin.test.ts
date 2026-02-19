/**
 * Tests for admin broadcast system (t-062).
 *
 * t-062: Admin broadcast: sign, fan-out, verify, reject forged
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import {
  createBroadcast,
  listBroadcasts,
  listAdminKeys,
  verifyBroadcastSignature,
} from '../routes/admin.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-admin-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
  };
}

/** Sign a payload string with an Ed25519 private key. */
function signPayload(payload: string, privateKey: ReturnType<typeof genKeypair>['privateKey']): string {
  const sig = cryptoSign(null, Buffer.from(payload), privateKey);
  return Buffer.from(sig).toString('base64');
}

/** Seed admin entries. */
function seedAdmins(db: ReturnType<typeof initializeDatabase>, admins: Array<{ name: string; publicKeyBase64: string }>) {
  for (const a of admins) {
    db.prepare(
      "INSERT OR IGNORE INTO agents (name, public_key, status) VALUES (?, ?, 'active')"
    ).run(a.name, a.publicKeyBase64);
    db.prepare(
      'INSERT OR IGNORE INTO admins (agent, admin_public_key) VALUES (?, ?)'
    ).run(a.name, a.publicKeyBase64);
  }
}

/** Create a non-admin active agent. */
function createActiveAgent(db: ReturnType<typeof initializeDatabase>, name: string, publicKeyBase64: string) {
  db.prepare(
    "INSERT INTO agents (name, public_key, email_verified, status, approved_by) VALUES (?, ?, 1, 'active', 'test-admin')"
  ).run(name, publicKeyBase64);
}

// ================================================================
// t-062: Admin broadcast: sign, fan-out, verify, reject forged
// ================================================================

describe('t-062: Admin broadcast: sign, fan-out, verify, reject forged', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  // Step 1: Seed database with admin entry for 'bmo'
  it('step 1: seed admin entry for bmo', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const admins = listAdminKeys(db);
    assert.equal(admins.length, 1);
    assert.equal(admins[0]!.agent, 'bmo');

    db.close();
  });

  // Step 2: POST /admin/broadcast signed with bmo's admin key
  it('step 2: create signed broadcast → stored', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const payload = JSON.stringify({ message: 'Upgrade in 1 hour' });
    const signature = signPayload(payload, bmo.privateKey);

    const result = createBroadcast(db, 'bmo', 'maintenance', payload, signature);
    assert.equal(result.ok, true);
    assert.ok(result.broadcastId);

    db.close();
  });

  // Step 3: Verify broadcast in broadcasts table
  it('step 3: broadcast stored with correct type, payload, signature', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const payload = JSON.stringify({ message: 'Upgrade in 1 hour' });
    const signature = signPayload(payload, bmo.privateKey);
    createBroadcast(db, 'bmo', 'maintenance', payload, signature);

    const broadcasts = listBroadcasts(db, 'maintenance');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]!.type, 'maintenance');
    assert.equal(broadcasts[0]!.sender, 'bmo');
    assert.equal(broadcasts[0]!.payload, payload);
    assert.equal(broadcasts[0]!.signature, signature);

    db.close();
  });

  // Step 4: GET /admin/broadcasts returns the stored broadcast
  it('step 4: listBroadcasts returns stored broadcast', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const payload = JSON.stringify({ message: 'Upgrade in 1 hour' });
    const signature = signPayload(payload, bmo.privateKey);
    createBroadcast(db, 'bmo', 'maintenance', payload, signature);

    const all = listBroadcasts(db);
    assert.ok(all.length >= 1);
    assert.ok(all.some((b) => b.type === 'maintenance' && b.sender === 'bmo'));

    db.close();
  });

  // Step 5: Verify broadcast signature using bmo's admin public key
  it('step 5: broadcast signature verifiable against admin public key', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const payload = JSON.stringify({ message: 'Upgrade in 1 hour' });
    const signature = signPayload(payload, bmo.privateKey);
    createBroadcast(db, 'bmo', 'maintenance', payload, signature);

    // Get admin key
    const admins = listAdminKeys(db);
    const bmoAdmin = admins.find((a) => a.agent === 'bmo');
    assert.ok(bmoAdmin);

    // Get the stored broadcast
    const broadcasts = listBroadcasts(db, 'maintenance');
    const broadcast = broadcasts[0]!;

    // Verify signature independently
    const verified = verifyBroadcastSignature(
      broadcast.payload,
      broadcast.signature,
      bmoAdmin.adminPublicKey,
    );
    assert.equal(verified, true);

    db.close();
  });

  // Step 6: Non-admin agent → 403
  it('step 6: non-admin agent cannot create broadcast → 403', () => {
    const db = withDb();
    const bmo = genKeypair();
    const notAdmin = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);
    createActiveAgent(db, 'notadmin', notAdmin.publicKeyBase64);

    const payload = JSON.stringify({ message: 'I am not admin' });
    const signature = signPayload(payload, notAdmin.privateKey);

    const result = createBroadcast(db, 'notadmin', 'maintenance', payload, signature);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);

    db.close();
  });

  // Step 7: Tampered payload after signing → signature verification fails
  it('step 7: tampered payload fails signature verification', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const originalPayload = JSON.stringify({ message: 'Upgrade in 1 hour' });
    const signature = signPayload(originalPayload, bmo.privateKey);

    // Tamper the payload
    const tamperedPayload = JSON.stringify({ message: 'HACKED' });

    const result = createBroadcast(db, 'bmo', 'maintenance', tamperedPayload, signature);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error!, /[Ii]nvalid.*signature/);

    db.close();
  });

  // Step 8: security-alert type accepted
  it('step 8: security-alert broadcast type accepted', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const payload = JSON.stringify({ severity: 'high', message: 'Vulnerability found' });
    const signature = signPayload(payload, bmo.privateKey);

    const result = createBroadcast(db, 'bmo', 'security-alert', payload, signature);
    assert.equal(result.ok, true);

    const broadcasts = listBroadcasts(db, 'security-alert');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]!.type, 'security-alert');

    db.close();
  });
});

// ================================================================
// Additional admin broadcast coverage
// ================================================================

describe('Admin broadcast: edge cases', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  it('invalid broadcast type rejected', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const payload = JSON.stringify({ message: 'test' });
    const signature = signPayload(payload, bmo.privateKey);

    const result = createBroadcast(db, 'bmo', 'invalid-type', payload, signature);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);

    db.close();
  });

  it('all valid broadcast types accepted', () => {
    const db = withDb();
    const bmo = genKeypair();
    seedAdmins(db, [{ name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 }]);

    const types = ['security-alert', 'maintenance', 'update', 'announcement', 'revocation'];
    for (const type of types) {
      const payload = JSON.stringify({ type, message: `test ${type}` });
      const signature = signPayload(payload, bmo.privateKey);
      const result = createBroadcast(db, 'bmo', type, payload, signature);
      assert.equal(result.ok, true, `Type '${type}' should be accepted`);
    }

    const all = listBroadcasts(db);
    assert.equal(all.length, 5);

    db.close();
  });

  it('multiple admins can create broadcasts', () => {
    const db = withDb();
    const bmo = genKeypair();
    const r2 = genKeypair();
    seedAdmins(db, [
      { name: 'bmo', publicKeyBase64: bmo.publicKeyBase64 },
      { name: 'r2d2', publicKeyBase64: r2.publicKeyBase64 },
    ]);

    const p1 = JSON.stringify({ from: 'bmo' });
    const s1 = signPayload(p1, bmo.privateKey);
    assert.equal(createBroadcast(db, 'bmo', 'announcement', p1, s1).ok, true);

    const p2 = JSON.stringify({ from: 'r2d2' });
    const s2 = signPayload(p2, r2.privateKey);
    assert.equal(createBroadcast(db, 'r2d2', 'announcement', p2, s2).ok, true);

    const all = listBroadcasts(db);
    assert.equal(all.length, 2);

    db.close();
  });
});
