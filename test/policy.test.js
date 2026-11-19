import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouteMap } from '../src/policy.js';
import { PrefixList } from '../src/prefix.js';

const baseRoute = (overrides = {}) => ({
  id: 'r1',
  prefix: '192.168.1.0/24',
  asPath: [65001],
  originAs: 65001,
  origin: 'igp',
  med: 0,
  localPref: 100,
  communities: [],
  nextHop: 'R1',
  sourceRouter: 'R1',
  learnedType: 'ebgp',
  ebgp: true,
  ...overrides,
});

describe('RouteMap 前缀过滤', () => {
  const prefixLists = {
    'PL-BLOCK': new PrefixList('PL-BLOCK', [
      { prefix: '192.168.0.0/16', action: 'deny', le: 32 },
    ]),
    'PL-ALLOW': new PrefixList('PL-ALLOW', [
      { prefix: '0.0.0.0/0', action: 'permit', le: 32 },
    ]),
  };

  it('deny 子句拒绝路由，末尾隐式 deny 兜底', () => {
    const routeMap = new RouteMap('RM', [
      { action: 'deny', match: { prefixList: 'PL-BLOCK' } },
      { action: 'permit', match: { prefixList: 'PL-ALLOW' } },
    ], prefixLists);
    assert.equal(routeMap.evaluate(baseRoute()).permitted, false);
    assert.equal(routeMap.evaluate(baseRoute({ prefix: '10.10.10.0/24' })).permitted, true);
  });

  it('未命中任何子句时隐式拒绝', () => {
    const routeMap = new RouteMap('RM', [
      { action: 'permit', match: { prefixList: 'PL-BLOCK' } },
    ], prefixLists);
    assert.equal(routeMap.evaluate(baseRoute({ prefix: '10.0.0.0/24' })).permitted, false);
  });
});

describe('RouteMap set 修改属性', () => {
  it('修改 local-pref、med 并添加/移除 community', () => {
    const routeMap = new RouteMap('RM', [{
      action: 'permit',
      set: {
        localPref: 200,
        med: 50,
        communityAdd: ['65000:100', '65000:200'],
      },
    }]);
    const result = routeMap.evaluate(baseRoute({ communities: ['65000:9'] }));
    assert.equal(result.permitted, true);
    assert.equal(result.route.localPref, 200);
    assert.equal(result.route.med, 50);
    assert.deepEqual(result.route.communities, ['65000:9', '65000:100', '65000:200']);

    const remover = new RouteMap('RM2', [{
      action: 'permit',
      set: { communityRemove: ['65000:100'] },
    }]);
    const removed = remover.evaluate(result.route);
    assert.deepEqual(removed.route.communities, ['65000:9', '65000:200']);
  });

  it('支持 AS-PATH 正则匹配与 as-path prepend', () => {
    const routeMap = new RouteMap('RM', [
      { action: 'deny', match: { asPath: '65002' } },
      { action: 'permit', set: { asPathPrepend: 2 } },
    ]);
    assert.equal(routeMap.evaluate(baseRoute({ asPath: [65002, 65003] })).permitted, false);
    const permitted = routeMap.evaluate(baseRoute({ asPath: [65001], originAs: 65010 }));
    assert.equal(permitted.route.asPathPrepend, 2);
    assert.deepEqual(permitted.route.asPath, [65001]);
  });

  it('community 匹配', () => {
    const routeMap = new RouteMap('RM', [
      { action: 'permit', match: { community: '65000:100' }, set: { localPref: 300 } },
      { action: 'permit' },
    ]);
    const matched = routeMap.evaluate(baseRoute({ communities: ['65000:100'] }));
    assert.equal(matched.route.localPref, 300);
    const unmatched = routeMap.evaluate(baseRoute());
    assert.equal(unmatched.route.localPref, 100);
  });
});
