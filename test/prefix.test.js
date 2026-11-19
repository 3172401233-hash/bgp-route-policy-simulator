import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrefixList, isPrefixContained, parseCidr } from '../src/prefix.js';

describe('parseCidr', () => {
  it('解析合法 CIDR', () => {
    const result = parseCidr('10.0.0.0/8');
    assert.equal(result.length, 8);
    assert.equal(result.int, 0x0a000000);
  });

  it('拒绝非法地址与掩码', () => {
    assert.throws(() => parseCidr('256.0.0.0/8'));
    assert.throws(() => parseCidr('10.0.0.0/33'));
    assert.throws(() => parseCidr('10.0.0/8'));
  });
});

describe('isPrefixContained', () => {
  it('精确匹配', () => {
    assert.equal(isPrefixContained('192.168.1.0/24', { prefix: '192.168.1.0/24' }), true);
    assert.equal(isPrefixContained('192.168.2.0/24', { prefix: '192.168.1.0/24' }), false);
  });

  it('按 ge/le 范围匹配更具体前缀', () => {
    const entry = { prefix: '10.0.0.0/8', ge: 24, le: 26 };
    assert.equal(isPrefixContained('10.1.2.0/24', entry), true);
    assert.equal(isPrefixContained('10.1.2.0/26', entry), true);
    assert.equal(isPrefixContained('10.1.2.0/23', entry), false);
    assert.equal(isPrefixContained('10.1.2.0/27', entry), false);
  });

  it('前缀不在同一网段时不匹配', () => {
    assert.equal(isPrefixContained('11.0.0.0/24', { prefix: '10.0.0.0/8', ge: 24 }), false);
  });
});

describe('PrefixList', () => {
  it('按 sequence 顺序匹配并支持 deny', () => {
    const list = new PrefixList('PL', [
      { sequence: 10, prefix: '10.0.0.0/8', action: 'deny', ge: 24 },
      { sequence: 20, prefix: '0.0.0.0/0', action: 'permit', le: 32 },
    ]);
    assert.equal(list.evaluate('10.1.1.0/24'), 'deny');
    assert.equal(list.evaluate('192.168.1.0/24'), 'permit');
  });

  it('末尾隐式 deny', () => {
    const list = new PrefixList('PL', [{ prefix: '10.0.0.0/8' }]);
    assert.equal(list.evaluate('10.0.0.0/8'), 'permit');
    assert.equal(list.evaluate('172.16.0.0/16'), 'deny');
  });
});
