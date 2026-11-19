import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, '../bin/simulate.js');
const scenarioPath = resolve(here, '../examples/scenario.json');

describe('CLI', () => {
  it('输出初始收敛、故障、恢复与新通告', () => {
    const result = spawnSync(process.execPath, [cliPath, scenarioPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /=== 初始收敛 ===/);
    assert.match(result.stdout, /R4 \(AS65004\)/);
    assert.match(result.stdout, /192\.168\.1\.0\/24 via R3/);
    assert.match(result.stdout, /=== 邻居故障: R3 <-> R4 ===/);
    assert.match(result.stdout, /=== 邻居恢复: R3 <-> R4 ===/);
    assert.match(result.stdout, /=== 新通告: R4 发布 172\.16\.0\.0\/16 ===/);
  });

  it('过滤的 10.0.0.0/24 不会出现在 R4，未过滤的 192.168 前缀正常传播', () => {
    const result = spawnSync(process.execPath, [cliPath, scenarioPath], { encoding: 'utf8' });
    const section = result.stdout.split('=== 初始收敛 ===')[1].split('===')[0];
    const r4Section = section.split('R4 (AS65004)')[1];
    assert.doesNotMatch(r4Section, /10\.0\.0\.0\/24/);
    assert.match(r4Section, /192\.168\.1\.0\/24/);
  });

  it('缺少参数时返回非零退出码', () => {
    const result = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  });
});
