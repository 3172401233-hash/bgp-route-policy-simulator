import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/network.js';
import { resetRouteCounter } from '../src/router.js';

const linearConfig = () => ({
  routers: [
    { id: 'R1', as: 65001 },
    { id: 'R2', as: 65002 },
    { id: 'R3', as: 65003 },
    { id: 'R4', as: 65004 },
  ],
  links: [
    { a: 'R1', b: 'R2' },
    { a: 'R2', b: 'R3' },
    { a: 'R3', b: 'R4' },
  ],
});

describe('BGP 收敛', () => {
  beforeEach(() => resetRouteCounter());

  it('eBGP 逐跳传播并追加 AS-PATH', () => {
    const network = new Network(linearConfig());
    network.originate('R1', '10.0.0.0/24');
    network.converge();

    const snapshot = network.snapshot();
    assert.deepEqual(snapshot.R2.routes['10.0.0.0/24'].asPath, [65001]);
    assert.deepEqual(snapshot.R3.routes['10.0.0.0/24'].asPath, [65002, 65001]);
    assert.deepEqual(snapshot.R4.routes['10.0.0.0/24'].asPath, [65003, 65002, 65001]);
    assert.equal(snapshot.R4.routes['10.0.0.0/24'].nextHop, 'R3');
  });

  it('出口路由策略可阻止前缀继续传播', () => {
    const config = linearConfig();
    config.prefixLists = {
      'PL-BLOCK': [{ prefix: '10.0.0.0/8', action: 'deny', le: 32 }],
    };
    config.routeMaps = {
      'RM-BLOCK': [{ action: 'deny', match: { prefixList: 'PL-BLOCK' } }],
    };
    config.links[1] = { a: 'R2', b: 'R3', aPolicy: { export: 'RM-BLOCK' } };
    const network = new Network(config);
    network.originate('R1', '10.0.0.0/24');
    network.converge();

    const snapshot = network.snapshot();
    assert.ok(snapshot.R2.routes['10.0.0.0/24']);
    assert.equal(snapshot.R3.routes['10.0.0.0/24'], undefined);
    assert.equal(snapshot.R4.routes['10.0.0.0/24'], undefined);
  });

  it('邻居故障后撤销路由，全网络收敛为无路由', () => {
    const network = new Network(linearConfig());
    network.originate('R1', '10.0.0.0/24');
    network.converge();

    const before = network.snapshot();
    network.failNeighbor('R1', 'R2');
    network.converge();

    const changes = network.diff(before);
    for (const routerId of ['R2', 'R3', 'R4']) {
      assert.equal(changes[routerId]['10.0.0.0/24'].after, null);
    }
    const snapshot = network.snapshot();
    for (const routerId of ['R2', 'R3', 'R4']) {
      assert.equal(snapshot[routerId].routes['10.0.0.0/24'], undefined);
    }
  });

  it('故障恢复后重新收敛回原始路径', () => {
    const network = new Network(linearConfig());
    network.originate('R1', '10.0.0.0/24');
    network.converge();
    network.failNeighbor('R2', 'R3');
    network.converge();
    assert.equal(network.snapshot().R4.routes['10.0.0.0/24'], undefined);

    network.restoreNeighbor('R2', 'R3');
    network.converge();
    const snapshot = network.snapshot();
    assert.deepEqual(snapshot.R4.routes['10.0.0.0/24'].asPath, [65003, 65002, 65001]);
  });

  it('eBGP 通过 AS-PATH 环路检测拒绝本 AS 始发的路由', () => {
    const config = linearConfig();
    config.links.push({ a: 'R4', b: 'R1' });
    const network = new Network(config);
    network.originate('R1', '10.0.0.0/24');
    network.converge();

    const snapshot = network.snapshot();
    assert.deepEqual(snapshot.R1.routes['10.0.0.0/24'].asPath, []);
    assert.equal(snapshot.R1.routes['10.0.0.0/24'].learnedType, 'origin');
  });

  it('出口策略 as-path prepend 拉长下游看到的 AS-PATH', () => {
    const config = linearConfig();
    config.routeMaps = {
      'RM-PREPEND': [{ action: 'permit', set: { asPathPrepend: 2 } }],
    };
    config.links[0] = { a: 'R1', b: 'R2', aPolicy: { export: 'RM-PREPEND' } };
    const network = new Network(config);
    network.originate('R1', '10.0.0.0/24');
    network.converge();

    const snapshot = network.snapshot();
    assert.deepEqual(snapshot.R2.routes['10.0.0.0/24'].asPath, [65001, 65001, 65001]);
    assert.deepEqual(snapshot.R4.routes['10.0.0.0/24'].asPath, [65003, 65002, 65001, 65001, 65001]);
  });
});

describe('iBGP 行为', () => {
  beforeEach(() => resetRouteCounter());

  it('同一 AS 内不修改 AS-PATH 且 iBGP 学到的路由不再转发给其他 iBGP 邻居', () => {
    const config = {
      routers: [
        { id: 'E', as: 65001 },
        { id: 'R1', as: 65000 },
        { id: 'R2', as: 65000 },
        { id: 'R3', as: 65000 },
      ],
      links: [
        { a: 'E', b: 'R1' },
        { a: 'R1', b: 'R2' },
        { a: 'R2', b: 'R3' },
      ],
    };
    const network = new Network(config);
    network.originate('E', '172.16.0.0/16');
    network.converge();

    const snapshot = network.snapshot();
    assert.deepEqual(snapshot.R1.routes['172.16.0.0/16'].asPath, [65001]);
    assert.deepEqual(snapshot.R2.routes['172.16.0.0/16'].asPath, [65001]);
    assert.equal(snapshot.R3.routes['172.16.0.0/16'], undefined);
  });
});

describe('多路径优选与故障切换', () => {
  beforeEach(() => resetRouteCounter());

  it('主路径故障后切换到备选邻居', () => {
    const config = {
      routers: [
        { id: 'SRC', as: 65010 },
        { id: 'PRIMARY', as: 65020 },
        { id: 'BACKUP', as: 65030 },
        { id: 'DST', as: 65040 },
      ],
      links: [
        { a: 'SRC', b: 'PRIMARY' },
        { a: 'SRC', b: 'BACKUP' },
        { a: 'PRIMARY', b: 'DST' },
        { a: 'BACKUP', b: 'DST' },
      ],
      routeMaps: {
        'RM-HIGH': [{ action: 'permit', set: { localPref: 200 } }],
      },
    };
    config.links[2] = { a: 'PRIMARY', b: 'DST', bPolicy: { import: 'RM-HIGH' } };
    const network = new Network(config);
    network.originate('SRC', '10.9.0.0/24');
    network.converge();

    let snapshot = network.snapshot();
    assert.equal(snapshot.DST.routes['10.9.0.0/24'].nextHop, 'PRIMARY');

    network.failNeighbor('PRIMARY', 'DST');
    network.converge();
    snapshot = network.snapshot();
    const backupRoute = snapshot.DST.routes['10.9.0.0/24'];
    assert.ok(backupRoute);
    assert.equal(backupRoute.nextHop, 'BACKUP');
    assert.deepEqual(backupRoute.asPath, [65030, 65010]);
  });
});
