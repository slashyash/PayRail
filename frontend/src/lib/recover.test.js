import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from './api.js';
import { decideAndRecover } from './recover.js';
const post = api.post, get = api.get;
test('finance recovery distinguishes committed, pending, unreadable and rejected outcomes', async () => {
 try {
  let reads = 0;
  api.post = async () => { throw new ApiError(0,'network','lost'); };
  api.get = async () => { reads++; return {status:'processed', refund_id:'7'}; };
  assert.equal((await decideAndRecover('/approve',undefined,'/refunds/7','processed')).refund_id,'7');
  assert.equal(reads,1);
  api.get = async () => ({status:'requested'});
  await assert.rejects(decideAndRecover('/approve',undefined,'/refunds/7','processed'), e => e.code === 'outcome_unknown');
  api.get = async () => {throw new Error('offline');};
  await assert.rejects(decideAndRecover('/approve',undefined,'/refunds/7','processed'), e => e.code === 'outcome_unknown');
  api.post = async () => {throw new ApiError(409,'invalid_transition','rejected');};
  await assert.rejects(decideAndRecover('/approve',undefined,'/refunds/7','processed'), e => e.status === 409);
  api.post = async () => {throw new ApiError(0,'network','lost');};
  api.get = async () => ({status:'paid', bank_utr:'DIFFERENT'});
  await assert.rejects(decideAndRecover('/complete',{},'/payouts/7','paid', x => x.bank_utr === 'EXPECTED'), e => e.code === 'outcome_unknown');
 } finally {api.post=post;api.get=get;}
});
