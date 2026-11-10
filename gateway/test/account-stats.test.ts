import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStats } from '@ramx/shared';
import { accountStatsSnapshot } from '../src/account-stats.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { testAccount, testDirectory, TEST_JWT_SECRET, TEST_NODE } from './helpers.ts';
import { recordHeartbeat, countRouted } from '../src/reliability.ts';
const cfg = loadConfig({ DATABASE_PATH: ':memory:', POOL_COORDINATOR_URL: 'http://127.0.0.1:3001', JWT_SECRET: TEST_JWT_SECRET });

test('account stats show cumulative earned/spent, contribution ratio and minimum score; omit all private fields', async () => {
  const db = openDb(':memory:');
  try {
    testDirectory(cfg, db);
    const account = await testAccount(db, cfg);
    db.prepare('UPDATE balances SET earned_total_mc = 5000, spent_total_mc = 2000, earned_mc = 3000 WHERE account_id = ?').run(account.accountId);
    db.prepare('INSERT INTO node_reliability (node_id, score, updated_at) VALUES (?, 0.8, ?)').run(TEST_NODE, Date.now());
    recordHeartbeat(db, cfg, TEST_NODE, true);
    countRouted(db, cfg, [{ node_id: TEST_NODE, layers: [0,40] }], false);
    const stats = accountStatsSnapshot(db, cfg);
    const human = stats.find((s) => s.account_id === account.accountId)!;
    assert.equal(human.earned_mc, 5000); assert.equal(human.spent_mc, 2000); assert.equal(human.ratio, 2.5);
    assert.equal(human.reliability, null);
    assert.equal(stats.find((s) => s.account_id === 'acc_router')!.reliability, 0.3);
    for (const row of stats) {
      AccountStats.parse(row);
      assert.deepEqual(Object.keys(row).sort(), ['account_id','earned_mc','ratio','reliability','spent_mc','type']);
    }
    assert.ok(!JSON.stringify(stats).includes('nullifier'));
  } finally { db.close(); }
});
