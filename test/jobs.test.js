'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Jobs } = require('../server/lib/jobs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('higher priority runs first, and a waiting user jumps a queued background job', async () => {
  const jobs = new Jobs();
  const order = [];
  const g = gate();
  // fill both proxy slots
  for (let i = 0; i < 2; i++) jobs.add({ lane: 'proxy', title: 'busy' + i, run: async () => { await g.p; } });
  jobs.add({ lane: 'proxy', title: 'bg-a', dedupeKey: 'a', background: true, priority: 0, run: async () => { order.push('a'); } });
  jobs.add({ lane: 'proxy', title: 'bg-b', dedupeKey: 'b', background: true, priority: 0, run: async () => { order.push('b'); } });
  // the user opens clip b: same job, now urgent
  const same = jobs.add({ lane: 'proxy', title: 'wait-b', dedupeKey: 'b', priority: 10, run: async () => { order.push('NOT RUN: duplicate'); } });
  assert.equal(same.title, 'bg-b', 'no second job for the same clip');
  assert.equal(same.priority, 10);
  g.open();
  await wait(100);
  assert.deepEqual(order, ['b', 'a']);
});

test('background jobs that finish leave no trace; failures and user jobs do', async () => {
  const jobs = new Jobs();
  jobs.add({ lane: 'misc', title: 'quiet', background: true, run: async () => {} });
  jobs.add({ lane: 'misc', title: 'loud', run: async () => {} });
  jobs.add({ lane: 'misc', title: 'broken', background: true, run: async () => { throw new Error('nope'); } });
  await wait(50);
  assert.deepEqual(jobs.list.map((j) => j.title).sort(), ['broken', 'loud']);
  assert.equal(jobs.list.find((j) => j.title === 'broken').state, 'error');
});

test('turning preparation off cancels what is still queued in the background', async () => {
  const jobs = new Jobs();
  const g = gate();
  for (let i = 0; i < 2; i++) jobs.add({ lane: 'proxy', title: 'running' + i, run: async () => { await g.p; } });
  for (let i = 0; i < 5; i++) jobs.add({ lane: 'proxy', title: 'bg' + i, background: true, run: async () => {} });
  assert.equal(jobs.cancelBackground('proxy'), 5);
  g.open();
  await wait(50);
  assert.equal(jobs.list.filter((j) => j.title.startsWith('bg')).length, 0);
});
