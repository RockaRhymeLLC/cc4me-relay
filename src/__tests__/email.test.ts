/**
 * Tests for email verification (t-056).
 *
 * t-056: Send code, confirm, expiry, rate limit.
 *
 * Uses mock email sender and injectable time for testing.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import {
  sendVerificationCode,
  confirmVerificationCode,
  hashCode,
} from '../email.js';
import type { EmailSender } from '../email.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-email-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

/** Mock email sender that captures sent emails. */
function mockSender(): { sender: EmailSender; sent: Array<{ to: string; subject: string; body: string }> } {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const sender: EmailSender = async (to, subject, body) => {
    sent.push({ to, subject, body });
    return true;
  };
  return { sender, sent };
}

/** Extract the 6-digit code from a sent email body. */
function extractCode(body: string): string {
  const match = body.match(/(\d{6})/);
  if (!match) throw new Error(`No code found in: ${body}`);
  return match[1]!;
}

describe('t-056: Email verification: send code, confirm, expiry, rate limit', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  // Step 1: POST /verify/send sends code (mock SES)
  it('step 1: sendVerificationCode sends code via mock sender', async () => {
    const db = withDb();
    const { sender, sent } = mockSender();

    const result = await sendVerificationCode(db, 'test-agent', 'test@example.com', sender, '1.2.3.4');
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'test@example.com');
    assert.match(sent[0]!.body, /\d{6}/);

    db.close();
  });

  // Step 2: Verify code is stored as SHA-256 hash
  it('step 2: code stored as SHA-256 hash in database', async () => {
    const db = withDb();
    const { sender, sent } = mockSender();

    await sendVerificationCode(db, 'test-agent', 'test@example.com', sender, '1.2.3.4');

    const entry = db.prepare('SELECT * FROM email_verifications WHERE agent_name = ?')
      .get('test-agent') as any;

    assert.ok(entry, 'Verification entry should exist');
    assert.equal(entry.email, 'test@example.com');
    assert.equal(entry.attempts, 0);
    assert.equal(entry.verified, 0);

    // Code should be hashed (64 hex chars = SHA-256)
    assert.equal(entry.code_hash.length, 64, 'Code hash should be 64 hex chars (SHA-256)');

    // Verify the hash matches the sent code
    const sentCode = extractCode(sent[0]!.body);
    assert.equal(entry.code_hash, hashCode(sentCode), 'Stored hash should match hash of sent code');

    db.close();
  });

  // Step 3: Confirm with correct code
  it('step 3: confirmVerificationCode with correct code succeeds', async () => {
    const db = withDb();
    const { sender, sent } = mockSender();

    await sendVerificationCode(db, 'test-agent', 'test@example.com', sender, '1.2.3.4');
    const code = extractCode(sent[0]!.body);

    const result = confirmVerificationCode(db, 'test-agent', code);
    assert.equal(result.ok, true);

    // Verify the entry is marked verified
    const entry = db.prepare('SELECT verified FROM email_verifications WHERE agent_name = ?')
      .get('test-agent') as any;
    assert.equal(entry.verified, 1);

    db.close();
  });

  // Step 4: Re-send generates new code (overwrites old)
  it('step 4: re-send overwrites previous code', async () => {
    const db = withDb();
    const { sender, sent } = mockSender();

    await sendVerificationCode(db, 'test-agent', 'test@example.com', sender, '1.2.3.4');
    const code1 = extractCode(sent[0]!.body);

    await sendVerificationCode(db, 'test-agent', 'new@example.com', sender, '1.2.3.5');
    const code2 = extractCode(sent[1]!.body);

    // Old code should no longer work
    const result1 = confirmVerificationCode(db, 'test-agent', code1);
    if (code1 !== code2) {
      assert.equal(result1.ok, false, 'Old code should not work after re-send');
    }

    // New code should work
    const result2 = confirmVerificationCode(db, 'test-agent', code2);
    assert.equal(result2.ok, true);

    db.close();
  });

  // Steps 5-6: Code expiry
  it('steps 5-6: expired code is rejected', async () => {
    const db = withDb();
    const { sender, sent } = mockSender();

    const now = Date.now();
    await sendVerificationCode(db, 'test-agent', 'test@example.com', sender, '1.2.3.4', now);
    const code = extractCode(sent[0]!.body);

    // Try to confirm 11 minutes later (code expires after 10)
    const later = now + 11 * 60 * 1000;
    const result = confirmVerificationCode(db, 'test-agent', code, later);
    assert.equal(result.ok, false);
    assert.match(result.error!, /expired/i);

    db.close();
  });

  // Step 7: Max 3 attempts
  it('step 7: max 3 wrong attempts then lockout', async () => {
    const db = withDb();
    const { sender } = mockSender();

    await sendVerificationCode(db, 'test-agent', 'test@example.com', sender, '1.2.3.4');

    // 3 wrong attempts
    for (let i = 0; i < 3; i++) {
      const r = confirmVerificationCode(db, 'test-agent', '000000');
      assert.equal(r.ok, false);
    }

    // 4th attempt — should be max attempts exceeded even with correct code
    const entry = db.prepare('SELECT attempts FROM email_verifications WHERE agent_name = ?')
      .get('test-agent') as any;
    assert.ok(entry.attempts >= 3, `Attempts should be >= 3, got ${entry.attempts}`);

    const r4 = confirmVerificationCode(db, 'test-agent', '000000');
    assert.equal(r4.ok, false);
    assert.match(r4.error!, /Max attempts/i);

    db.close();
  });

  // Step 8: Rate limit — 4th send from same IP within 1 hour
  it('step 8: rate limit on 4th send from same IP', async () => {
    const db = withDb();
    const { sender } = mockSender();
    const now = Date.now();

    // 3 sends should succeed
    for (let i = 0; i < 3; i++) {
      const r = await sendVerificationCode(db, `agent-${i}`, `test${i}@example.com`, sender, '10.0.0.1', now);
      assert.equal(r.ok, true, `Send ${i + 1} should succeed`);
    }

    // 4th send from same IP — rate limited
    const r4 = await sendVerificationCode(db, 'agent-3', 'test3@example.com', sender, '10.0.0.1', now);
    assert.equal(r4.ok, false);
    assert.equal(r4.status, 429);
    assert.match(r4.error!, /Rate limit/i);

    db.close();
  });
});

// ================================================================
// Additional email verification coverage
// ================================================================

describe('Email verification: edge cases', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  it('confirm with no pending verification', () => {
    const db = withDb();
    const result = confirmVerificationCode(db, 'nonexistent', '123456');
    assert.equal(result.ok, false);
    assert.match(result.error!, /No verification/i);
    db.close();
  });

  it('already verified returns ok', async () => {
    const db = withDb();
    const { sender, sent } = mockSender();

    await sendVerificationCode(db, 'agent', 'test@example.com', sender, '1.1.1.1');
    const code = extractCode(sent[0]!.body);
    confirmVerificationCode(db, 'agent', code);

    // Second confirm should still return ok
    const result = confirmVerificationCode(db, 'agent', code);
    assert.equal(result.ok, true);

    db.close();
  });

  it('rate limit resets after 1 hour', async () => {
    const db = withDb();
    const { sender } = mockSender();
    const now = Date.now();

    // Use up rate limit
    for (let i = 0; i < 3; i++) {
      await sendVerificationCode(db, `agent-${i}`, `t${i}@example.com`, sender, '10.0.0.1', now);
    }

    // 4th is blocked
    const blocked = await sendVerificationCode(db, 'agent-3', 't3@example.com', sender, '10.0.0.1', now);
    assert.equal(blocked.status, 429);

    // After 1 hour, should work again
    const later = now + 61 * 60 * 1000;
    const result = await sendVerificationCode(db, 'agent-4', 't4@example.com', sender, '10.0.0.1', later);
    assert.equal(result.ok, true);

    db.close();
  });

  it('email send failure returns 500', async () => {
    const db = withDb();
    const failSender: EmailSender = async () => false;

    const result = await sendVerificationCode(db, 'agent', 'test@example.com', failSender, '1.1.1.1');
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);

    db.close();
  });
});
