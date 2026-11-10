/** Complete MVP backend demo with local test fixtures, never live wallets or real inference. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, type Hex } from 'viem';
import { AccountStats, ChatCompletionResponse, LedgerEventsResponse, MeResponse, ModelsResponse, NetworkResponse, PayoutsResponse, PoolStateResponse, Receipt, REQUEST_ID_HEADER, Usage, WorldVerifyResponse, type DirectoryNode, type DirectoryPool } from '@ramx/shared';
import { openDb } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createX402, httpFacilitator } from '../src/x402.ts';
import { registerMessage } from '../src/nodes.ts';
import { flushOnce } from '../src/ledger-chain.ts';
import { verifyEvent } from '../src/events.ts';
import { accountStatsSnapshot } from '../src/account-stats.ts';
import { createSettlement } from '../src/settlement.ts';
import { verifyPayoutProof, type Hash } from '../src/merkle.ts';
import { fakeLedgerChain, signer, TEST_JWT_SECRET } from './helpers.ts';
import { FakeChain } from './fake-settlement.ts';

const MODEL = 'Qwen/Qwen3-14B-FP8';
const POOL = 'pool-mvp-demo';
const keys = [1,2,3].map((i) => privateKeyToAccount(`0x${String(i).repeat(64)}` as Hex));
const layers: [number, number][] = [[0,20],[20,29],[29,40]];
const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));

for (const run of [1,2]) test(`MVP backend demo local run ${run}: identity → three nodes → credit/x402 inference → ledger/stats → epoch/provider claims`, async () => {
  const pool = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const usage = { prompt_tokens: 40, completion_tokens: 100, total_tokens: 140 };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from the test pool. '.repeat(13) } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
    } else {
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({ id: 'test-pool', object: 'chat.completion', created: Math.floor(Date.now()/1000), model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the test pool. '.repeat(13) }, finish_reason: 'stop' }], usage }));
    }
  });
  const facilitator = createServer(async (req, res) => {
    req.resume();
    res.setHeader('content-type','application/json');
    const payer = 'agent-1.ramx.testnet';
    if (req.url === '/supported') res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'near:testnet' }], extensions: [], signers: {} }));
    else if (req.url === '/verify') res.end(JSON.stringify({ isValid: true, payer }));
    else if (req.url === '/settle') res.end(JSON.stringify({ success: true, payer, transaction: `7YbSYkffq1Bk5nVVB1UL77C5Qv7SuhaQ59KmuRw6RJr${run}`, network: 'near:testnet' }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  const poolPort = await listen(pool), facPort = await listen(facilitator);
  const db = openDb(':memory:');
  try {
    const cfg = loadConfig({ DATABASE_PATH: ':memory:', POOL_COORDINATOR_URL: `http://127.0.0.1:${poolPort}`, JWT_SECRET: TEST_JWT_SECRET,
      WORLD_APP_ID: 'app_0123abcd', WORLD_RP_ID: 'rp_0123abcd', WORLD_RP_SIGNING_KEY: 'ab'.repeat(32), WORLD_ACTION: 'ramx-account', WORLD_ENVIRONMENT: 'staging', GATEWAY_SIGNING_KEY: '11'.repeat(32) });
    let directoryNow = Date.now();
    const pools: { value: DirectoryPool; expires: number }[] = [];
    const nodes: { value: DirectoryNode; expires: number }[] = [];
    const directory = {
      models: async () => cfg.net.models.map((m) => ({ ...m, type: 'ramx.model' as const })),
      pools: async () => pools.filter((p) => p.expires > directoryNow).map((p) => p.value),
      nodes: async () => nodes.filter((n) => n.expires > directoryNow).map((n) => n.value),
      readyPools: async (model: string) => pools.filter((p) => p.expires > directoryNow && p.value.status === 'ready' && p.value.models.includes(model)).map((p) => p.value),
    };
    const x402 = createX402({ cfg: cfg.net, facilitator: httpFacilitator(`http://127.0.0.1:${facPort}`), payTo: 'treasury.ramx.testnet' });
    const app = createApp({ cfg, db, signer, directory, x402, onComplete: () => {}, worldFetch: async (_url, init) => {
      const input = JSON.parse(String(init.body));
      const nullifier = input.responses[0].nullifier;
      return Response.json({ success: true, nullifier, environment: 'staging', results: [{ identifier: 'selfie', success: true, nullifier }] });
    } });
    const send = (path: string, body: unknown, headers: Record<string,string> = {}) => app.request(path, { method:'POST', headers: { 'content-type':'application/json', ...headers }, body: JSON.stringify(body) });
    const login = async (i: number) => {
      const res = await send('/auth/world/verify', { protocol_version:'4.0', action:'ramx-account', environment:'staging', nonce:'0x01', responses:[{identifier:'selfie',nullifier:`0x${i.toString(16).padStart(64,'0')}`,proof:['0x1']}] });
      assert.equal(res.status,200,await res.clone().text());
      const result = WorldVerifyResponse.parse(await res.json());
      return { ...result, auth: { authorization: `Bearer ${result.token}` } };
    };
    const providers = await Promise.all([login(1),login(2),login(3)]);
    const requester = await login(4);
    const duplicate = await login(4);
    assert.equal(duplicate.new_account,false); assert.equal(duplicate.starter_granted_mc,0);
    for (let i=0;i<3;i++) {
      const key = keys[i]!, node_id = key.address.toLowerCase(), ts=Date.now();
      const registration = await send('/nodes/register', { node_id,pool_id:POOL,gpu:i?'Apple test node':'NVIDIA test node',mem_gb:16,ts,
        payout_address:`provider-${i+1}.testnet`,node_sig:await key.signMessage({message:registerMessage(node_id,POOL,ts)}) },providers[i]!.auth);
      assert.equal(registration.status,200);
      const raw=JSON.stringify({node_id,pool_id:POOL,ts:Date.now(),online:true,model:MODEL,layers:layers[i],tok_s:5});
      const signature=await key.signMessage({message:{raw:toBytes(raw)}});
      const heartbeat=await app.request('/nodes/heartbeat',{method:'POST',headers:{'x-ramx-node-signature':signature},body:raw});
      assert.equal(heartbeat.status,200);
      const hb=await heartbeat.json();
      nodes.push({expires:directoryNow+120_000,value:{type:'ramx.node',node_id,owner_account:providers[i]!.account_id,pool_id:POOL,gpu:'test fixture',mem_gb:16,status:'online',layers:layers[i]!,tok_s:5,reliability:hb.reliability}});
    }
    const state=PoolStateResponse.parse(await (await app.request(`/pools/${POOL}`)).json());
    assert.equal(state.status,'ready'); assert.equal(state.members.length,3);
    pools.push({expires:directoryNow+120_000,value:{type:'ramx.pool',pool_id:POOL,models:[MODEL],members:state.members,status:'ready',layer_map:state.layer_map,reliability:state.reliability,coordinator_url_hash:keccak256(toBytes(cfg.env.POOL_COORDINATOR_URL))}});
    assert.equal(ModelsResponse.parse(await (await app.request('/v1/models')).json()).data[0]!.source,'gateway');
    assert.equal(NetworkResponse.parse(await (await app.request('/network')).json()).nodes.length,3);
    const receipts: Receipt[]=[];
    for (const stream of [false,true]) {
      const r=await send('/v1/chat/completions',{model:MODEL,messages:[{role:'user',content:'Hello'}],max_tokens:200,stream},requester.auth);
      assert.equal(r.status,200);
      if(stream) {
        const text=await r.text();
        const chunks=text.split('\n').filter((s)=>s.startsWith('data: {')).map((s)=>JSON.parse(s.slice(6)));
        assert.ok(chunks.some((c)=>Usage.safeParse(c.usage).success));
      } else ChatCompletionResponse.parse(await r.json());
      const receipt=Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
      assert.equal(receipt.status,'ok'); assert.equal(receipt.route!.length,3); assert.equal(receipt.cost_mc,189_000);
      receipts.push(receipt);
    }
    const providerBefore=MeResponse.parse(await (await app.request('/me',{headers:providers[0]!.auth})).json()).balance.earned_mc;
    const body={model:MODEL,messages:[{role:'user',content:'Paid hello'}],max_tokens:200};
    const challenge=await send('/v1/chat/completions',body);
    assert.equal(challenge.status,402);
    const requirements=JSON.parse(Buffer.from(challenge.headers.get('PAYMENT-REQUIRED')!,'base64').toString());
    const payload={x402Version:2,resource:requirements.resource,accepted:requirements.accepts[0],payload:{transaction:'AAAA'}};
    const paid=await send('/v1/chat/completions',body,{'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(payload)).toString('base64')});
    assert.equal(paid.status,200);
    assert.ok(paid.headers.get('PAYMENT-RESPONSE'));
    assert.equal(MeResponse.parse(await (await app.request('/me',{headers:providers[0]!.auth})).json()).balance.earned_mc,providerBefore);
    const ledgerChain=fakeLedgerChain((message)=>assert.ok(verifyEvent(JSON.parse(message),signer.publicKeyHex)));
    await flushOnce(db,ledgerChain,1000);
    const ledger=LedgerEventsResponse.parse(await (await app.request('/ledger/events?limit=100')).json());
    assert.ok(ledger.events.some((e)=>e.event.type==='x402_payment'&&e.ledger_seq!==null));
    assert.ok(ledger.events.every((e)=>verifyEvent(e.event,signer.publicKeyHex)));
    const stats=new Map(accountStatsSnapshot(db,cfg).map((row)=>[row.account_id,AccountStats.parse(row)]));
    assert.equal(stats.size,4);
    assert.ok(stats.get(providers[0]!.account_id)!.earned_mc>0);
    assert.equal(stats.get(requester.account_id)!.spent_mc,378_000);
    const chain=new FakeChain();
    chain.postedAtMs=Date.now()-60_000; // controlled local claim-delay clock
    const settlement=createSettlement(db,cfg,signer,chain);
    const afterEpoch=(Math.floor(Date.now()/600_000)+1)*600_000;
    await settlement.runOnce(afterEpoch);
    assert.equal(chain.posts,0); // ledger epoch commitment not appended yet
    await flushOnce(db,ledgerChain,1000);
    await settlement.runOnce(afterEpoch);
    assert.equal(chain.posts,1); assert.equal(chain.funded,3_200n); // 80% of one 0.004 USDC x402 request
    const expected=[1_600n,720n,880n]; // layers 20/40, 9/40, 11/40 of 3200
    for(let i=0;i<3;i++) {
      const account=`provider-${i+1}.testnet`;
      const payout=PayoutsResponse.parse(await (await app.request(`/payouts/${account}`)).json()).payouts[0]!;
      assert.equal(BigInt(payout.amount_units),expected[i]);
      assert.ok(verifyPayoutProof(account,expected[i]!,payout.proof as Hash[],payout.merkle_root as Hash));
      chain.claim(payout.epoch,account,expected[i]!);
    }
    await settlement.runOnce(afterEpoch);
    await flushOnce(db,ledgerChain,1000);
    for(let i=1;i<=3;i++) assert.equal(PayoutsResponse.parse(await (await app.request(`/payouts/provider-${i}.testnet`)).json()).payouts[0]!.claimed,true);
    const finalLedger=LedgerEventsResponse.parse(await (await app.request('/ledger/events?limit=100')).json());
    assert.equal(finalLedger.events.filter((e)=>e.event.type==='payout_claimed'&&e.ledger_seq!==null).length,3);
    directoryNow+=121_000; // simulate listing expiry, not an actual two-minute wait
    assert.deepEqual(ModelsResponse.parse(await (await app.request('/v1/models')).json()).data,[]);
    assert.deepEqual(NetworkResponse.parse(await (await app.request('/network')).json()).nodes,[]);
    assert.equal((await send('/v1/chat/completions',body,requester.auth)).status,503);
  } finally { db.close(); await Promise.all([close(pool),close(facilitator)]); }
});
