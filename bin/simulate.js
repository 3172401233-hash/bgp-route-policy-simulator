#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Network } from '../src/network.js';

function printSnapshot(snapshot) {
  for (const [routerId, state] of Object.entries(snapshot)) {
    console.log(`Router ${routerId} (AS${state.as})`);
    const prefixes = Object.keys(state.routes).sort();
    if (prefixes.length === 0) {
      console.log('  (无路由)');
      continue;
    }
    for (const prefix of prefixes) {
      const route = state.routes[prefix];
      const asPath = route.asPath.length > 0 ? route.asPath.join(' ') : '本地';
      const communities = route.communities.length > 0 ? `, community=${route.communities.join(',')}` : '';
      console.log(`  ${prefix} via ${route.nextHop} [AS-PATH: ${asPath}, local-pref ${route.localPref}, med ${route.med}, origin ${route.origin}${communities}]`);
    }
  }
}

async function main() {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error('用法: bgp-sim <场景文件.json>');
    process.exitCode = 1;
    return;
  }
  const scenario = JSON.parse(await readFile(resolve(scenarioPath), 'utf8'));
  const network = new Network(scenario);

  for (const announcement of scenario.announce ?? []) {
    network.originate(announcement.router, announcement.prefix, announcement.attributes ?? {});
  }
  network.converge();
  console.log('=== 初始收敛 ===');
  printSnapshot(network.snapshot());

  for (const step of scenario.steps ?? []) {
    const before = network.snapshot();
    if (step.type === 'fail') {
      network.failNeighbor(step.a, step.b);
      network.converge();
      console.log(`\n=== 邻居故障: ${step.a} <-> ${step.b} ===`);
    } else if (step.type === 'restore') {
      network.restoreNeighbor(step.a, step.b);
      network.converge();
      console.log(`\n=== 邻居恢复: ${step.a} <-> ${step.b} ===`);
    } else if (step.type === 'announce') {
      network.originate(step.router, step.prefix, step.attributes ?? {});
      network.converge();
      console.log(`\n=== 新通告: ${step.router} 发布 ${step.prefix} ===`);
    } else {
      throw new Error(`不支持的场景步骤: ${step.type}`);
    }
    const changes = network.diff(before);
    if (Object.keys(changes).length === 0) {
      console.log('路由表无变化');
    } else {
      for (const [routerId, prefixChanges] of Object.entries(changes)) {
        for (const [prefix, change] of Object.entries(prefixChanges)) {
          const afterText = change.after ? `via ${change.after.nextHop}, AS-PATH [${change.after.asPath.join(' ')}]` : '路由撤销';
          const beforeText = change.before ? `via ${change.before.nextHop}, AS-PATH [${change.before.asPath.join(' ')}]` : '无';
          console.log(`  ${routerId} ${prefix}: ${beforeText} -> ${afterText}`);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
