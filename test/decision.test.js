import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectBestRoute } from '../src/decision.js';

const route = (id, overrides = {}) => ({
  id,
  prefix: '10.0.0.0/24',
  asPath: [],
  originAs: 65000,
  origin: 'igp',
  med: 0,
  localPref: 100,
  communities: [],
  nextHop: id,
  sourceRouter: id,
  learnedType: 'ebgp',
  ebgp: true,
  asPathPrepend: 0,
  ...overrides,
});

describe('selectBestRoute', () => {
  it('local-pref 优先于 AS-PATH 长度', () => {
    const best = selectBestRoute([
      route('r1', { localPref: 100, asPath: [65001] }),
      route('r2', { localPref: 200, asPath: [65001, 65002, 65003] }),
    ]);
    assert.equal(best.id, 'r2');
  });

  it('local-pref 相同时 AS-PATH 短者优先', () => {
    const best = selectBestRoute([
      route('r1', { asPath: [65001, 65002] }),
      route('r2', { asPath: [65001] }),
    ]);
    assert.equal(best.id, 'r2');
  });

  it('AS-PATH 相同时按 origin、med、eBGP 依次比较', () => {
    const igp = selectBestRoute([
      route('r1', { origin: 'incomplete' }),
      route('r2', { origin: 'igp' }),
    ]);
    assert.equal(igp.id, 'r2');

    const med = selectBestRoute([
      route('r1', { med: 20 }),
      route('r2', { med: 10 }),
    ]);
    assert.equal(med.id, 'r2');

    const ebgp = selectBestRoute([
      route('r1', { ebgp: false, learnedType: 'ibgp' }),
      route('r2', { ebgp: true, learnedType: 'ebgp' }),
    ]);
    assert.equal(ebgp.id, 'r2');
  });

  it('全部相同时以路由 ID 确定性打破平局', () => {
    const best = selectBestRoute([route('r9'), route('r1')]);
    assert.equal(best.id, 'r1');
  });

  it('空列表返回 null', () => {
    assert.equal(selectBestRoute([]), null);
  });
});
