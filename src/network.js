import { buildPrefixLists, buildRouteMaps } from './policy.js';
import { Router } from './router.js';

export class Network {
  constructor(config = {}) {
    this.prefixLists = buildPrefixLists(config.prefixLists ?? {});
    this.routeMaps = buildRouteMaps(config.routeMaps ?? {}, this.prefixLists);
    this.routers = new Map();
    this.events = [];
    this.eventsProcessed = 0;

    for (const routerConfig of config.routers ?? []) {
      this.addRouter(routerConfig.id, routerConfig.as);
    }
    for (const link of config.links ?? []) {
      this.addLink(link);
    }
  }

  addRouter(id, asNumber) {
    if (this.routers.has(id)) throw new Error(`路由器重复定义: ${id}`);
    this.routers.set(id, new Router(id, asNumber, this));
    return this.routers.get(id);
  }

  addLink(link) {
    const { a, b } = link;
    const routerA = this.routers.get(a);
    const routerB = this.routers.get(b);
    if (!routerA) throw new Error(`链路引用了不存在的路由器: ${a}`);
    if (!routerB) throw new Error(`链路引用了不存在的路由器: ${b}`);
    const importExport = (sideKey) => {
      const explicit = link[sideKey] ?? {};
      return {
        importPolicy: explicit.import ?? link.import ?? null,
        exportPolicy: explicit.export ?? link.export ?? null,
      };
    };
    const sideA = importExport('aPolicy');
    const sideB = importExport('bPolicy');
    routerA.addNeighbor(b, { remoteAs: routerB.asNumber, ...sideA });
    routerB.addNeighbor(a, { remoteAs: routerA.asNumber, ...sideB });
  }

  enqueueRoute(from, to, route) {
    this.events.push({ kind: 'route', from, to, route });
  }

  enqueueWithdraw(from, to, prefix) {
    this.events.push({ kind: 'withdraw', from, to, prefix });
  }

  originate(routerId, prefix, attributes) {
    const router = this.requireRouter(routerId);
    router.originate(prefix, attributes);
  }

  failNeighbor(a, b) {
    const routerA = this.routers.get(a);
    const routerB = this.routers.get(b);
    if (!routerA?.neighbors.has(b)) throw new Error(`邻居关系不存在: ${a} <-> ${b}`);
    routerA.tearDownNeighbor(b);
    routerB.tearDownNeighbor(a);
  }

  restoreNeighbor(a, b) {
    const routerA = this.requireRouter(a);
    const routerB = this.requireRouter(b);
    routerA.setNeighborState(b, true);
    routerB.setNeighborState(a, true);
    for (const [prefix, routeId] of routerA.best) {
      if (routeId === null) continue;
      routerA.recompute(prefix);
    }
    for (const [prefix, routeId] of routerB.best) {
      if (routeId === null) continue;
      routerB.recompute(prefix);
    }
  }

  converge({ maxEvents = 10000 } = {}) {
    let processed = 0;
    while (this.events.length > 0) {
      if (processed >= maxEvents) throw new Error('事件队列超过上限，可能存在路由振荡或环路');
      const event = this.events.shift();
      processed += 1;
      this.eventsProcessed += 1;
      const target = this.routers.get(event.to);
      if (!target) continue;
      if (event.kind === 'route') {
        target.receiveRoute(event.from, event.route);
      } else {
        target.receiveWithdraw(event.from, event.prefix);
      }
    }
    return processed;
  }

  requireRouter(id) {
    const router = this.routers.get(id);
    if (!router) throw new Error(`路由器不存在: ${id}`);
    return router;
  }

  snapshot() {
    const result = {};
    for (const [id, router] of this.routers) {
      const routes = {};
      for (const prefix of router.best.keys()) {
        const route = router.getBestRoute(prefix);
        if (route) routes[prefix] = router.summarizeRoute(route);
      }
      result[id] = {
        as: router.asNumber,
        routes,
      };
    }
    return result;
  }

  diff(before, after = this.snapshot()) {
    const changes = {};
    const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const id of ids) {
      const beforeRoutes = before[id]?.routes ?? {};
      const afterRoutes = after[id]?.routes ?? {};
      const prefixes = new Set([...Object.keys(beforeRoutes), ...Object.keys(afterRoutes)]);
      for (const prefix of prefixes) {
        const left = beforeRoutes[prefix] === undefined || beforeRoutes[prefix] === null ? null : this.signature(beforeRoutes[prefix]);
        const right = afterRoutes[prefix] === undefined || afterRoutes[prefix] === null ? null : this.signature(afterRoutes[prefix]);
        if (left === right) continue;
        changes[id] ??= {};
        changes[id][prefix] = {
          before: beforeRoutes[prefix] ?? null,
          after: afterRoutes[prefix] ?? null,
        };
      }
    }
    return changes;
  }

  signature(route) {
    return JSON.stringify({
      nextHop: route.nextHop,
      asPath: route.asPath,
      localPref: route.localPref,
      med: route.med,
      origin: route.origin,
      communities: route.communities,
      learnedType: route.learnedType,
    });
  }
}
