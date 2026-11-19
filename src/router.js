import { selectBestRoute } from './decision.js';

let routeCounter = 0;

export function nextRouteId() {
  routeCounter += 1;
  return `r${routeCounter}`;
}

export function resetRouteCounter() {
  routeCounter = 0;
}

export class Router {
  constructor(id, asNumber, network) {
    this.id = id;
    this.asNumber = asNumber;
    this.network = network;
    this.neighbors = new Map();
    this.rib = new Map();
    this.best = new Map();
    this.neighborRoutes = new Map();
    this.advertised = new Map();
    this.lastSent = new Map();
  }

  addNeighbor(remoteId, config) {
    const type = config.remoteAs === this.asNumber ? 'ibgp' : 'ebgp';
    this.neighbors.set(remoteId, {
      remoteAs: config.remoteAs,
      type,
      importPolicy: config.importPolicy ?? null,
      exportPolicy: config.exportPolicy ?? null,
      up: true,
    });
    this.neighborRoutes.set(remoteId, new Map());
    this.advertised.set(remoteId, new Map());
  }

  setNeighborState(remoteId, up) {
    const neighbor = this.neighbors.get(remoteId);
    if (neighbor) neighbor.up = up;
  }

  evaluatePolicy(policyName, route) {
    if (!policyName) return { permitted: true, route };
    const policy = this.network.routeMaps[policyName];
    if (!policy) throw new Error(`路由器 ${this.id} 引用了不存在的 route-map: ${policyName}`);
    return policy.evaluate(route);
  }

  originate(prefix, attributes = {}) {
    const route = {
      id: nextRouteId(),
      prefix,
      asPath: [],
      originAs: this.asNumber,
      origin: attributes.origin ?? 'igp',
      med: attributes.med ?? 0,
      localPref: attributes.localPref ?? 100,
      communities: attributes.communities ?? [],
      asPathPrepend: 0,
      nextHop: this.id,
      sourceRouter: null,
      learnedType: 'origin',
      ebgp: false,
    };
    this.storeRoute(route);
    this.recompute(prefix);
  }

  storeRoute(route) {
    if (!this.rib.has(route.prefix)) this.rib.set(route.prefix, new Map());
    this.rib.get(route.prefix).set(route.id, route);
  }

  receiveRoute(remoteId, incoming) {
    const neighbor = this.neighbors.get(remoteId);
    if (!neighbor || !neighbor.up) return;
    if (neighbor.type === 'ebgp' && incoming.asPath.includes(this.asNumber)) return;
    const decision = this.evaluatePolicy(neighbor.importPolicy, incoming);
    const peerRoutes = this.neighborRoutes.get(remoteId);
    const previousId = peerRoutes.get(incoming.prefix);
    if (previousId !== undefined) this.rib.get(incoming.prefix)?.delete(previousId);
    if (decision.permitted) {
      const stored = {
        ...decision.route,
        sourceRouter: remoteId,
        learnedType: neighbor.type,
        ebgp: neighbor.type === 'ebgp',
      };
      this.storeRoute(stored);
      peerRoutes.set(incoming.prefix, stored.id);
    } else {
      peerRoutes.delete(incoming.prefix);
    }
    this.recompute(incoming.prefix);
  }

  receiveWithdraw(remoteId, prefix) {
    const neighbor = this.neighbors.get(remoteId);
    if (!neighbor || !neighbor.up) return;
    const peerRoutes = this.neighborRoutes.get(remoteId);
    const routeId = peerRoutes.get(prefix);
    if (routeId !== undefined) {
      this.rib.get(prefix)?.delete(routeId);
      peerRoutes.delete(prefix);
      this.recompute(prefix);
    }
  }

  tearDownNeighbor(remoteId) {
    this.setNeighborState(remoteId, false);
    const peerRoutes = this.neighborRoutes.get(remoteId);
    const affectedPrefixes = [...peerRoutes.keys()];
    for (const prefix of affectedPrefixes) {
      const routeId = peerRoutes.get(prefix);
      this.rib.get(prefix)?.delete(routeId);
      peerRoutes.delete(prefix);
    }
    this.advertised.get(remoteId)?.clear();
    this.lastSent.get(remoteId)?.clear();
    for (const prefix of affectedPrefixes) this.recompute(prefix);
  }

  recompute(prefix) {
    const candidates = this.rib.has(prefix) ? [...this.rib.get(prefix).values()] : [];
    const newBest = selectBestRoute(candidates);
    this.best.set(prefix, newBest ? newBest.id : null);
    for (const [remoteId, neighbor] of this.neighbors) {
      if (!neighbor.up) continue;
      const advertised = this.advertised.get(remoteId);
      const lastAdvertisedId = advertised.get(prefix);
      const sentSignatures = this.lastSent.get(remoteId);
      const lastSignature = sentSignatures?.get(prefix);
      if (!newBest) {
        if (lastAdvertisedId !== undefined) {
          this.network.enqueueWithdraw(this.id, remoteId, prefix);
          advertised.delete(prefix);
          sentSignatures?.delete(prefix);
        }
        continue;
      }
      if (neighbor.type === 'ibgp' && newBest.learnedType === 'ibgp') {
        if (lastAdvertisedId !== undefined) {
          this.network.enqueueWithdraw(this.id, remoteId, prefix);
          advertised.delete(prefix);
          sentSignatures?.delete(prefix);
        }
        continue;
      }
      if (neighbor.type === 'ebgp' && newBest.asPath.includes(this.asNumber)) {
        if (lastAdvertisedId !== undefined) {
          this.network.enqueueWithdraw(this.id, remoteId, prefix);
          advertised.delete(prefix);
          sentSignatures?.delete(prefix);
        }
        continue;
      }
      const decision = this.evaluatePolicy(neighbor.exportPolicy, newBest);
      if (!decision.permitted) {
        if (lastAdvertisedId !== undefined) {
          this.network.enqueueWithdraw(this.id, remoteId, prefix);
          advertised.delete(prefix);
          sentSignatures?.delete(prefix);
        }
        continue;
      }
      const outbound = this.buildOutboundRoute(remoteId, neighbor, decision.route);
      const signature = this.outboundSignature(neighbor, decision.route);
      if (lastSignature !== undefined && lastSignature === signature) continue;
      this.network.enqueueRoute(this.id, remoteId, outbound);
      advertised.set(prefix, outbound.id);
      if (!this.lastSent.has(remoteId)) this.lastSent.set(remoteId, new Map());
      this.lastSent.get(remoteId).set(prefix, signature);
    }
  }

  outboundSignature(neighbor, route) {
    const asPath = neighbor.type === 'ebgp'
      ? [this.asNumber, ...Array(route.asPathPrepend ?? 0).fill(this.asNumber), ...route.asPath]
      : [...route.asPath];
    return JSON.stringify({
      prefix: route.prefix,
      asPath,
      localPref: route.localPref,
      med: route.med,
      origin: route.origin,
      communities: [...route.communities].sort(),
    });
  }

  buildOutboundRoute(remoteId, neighbor, route) {
    const prependCount = route.asPathPrepend ?? 0;
    const asPath = neighbor.type === 'ebgp'
      ? [this.asNumber, ...Array(prependCount).fill(this.asNumber), ...route.asPath]
      : [...route.asPath];
    return {
      ...route,
      id: nextRouteId(),
      asPath,
      nextHop: this.id,
      sourceRouter: this.id,
      learnedType: neighbor.type,
      ebgp: neighbor.type === 'ebgp',
      communities: [...route.communities],
      asPathPrepend: 0,
    };
  }

  getBestRoute(prefix) {
    const routeId = this.best.get(prefix);
    if (!routeId || !this.rib.has(prefix)) return null;
    return this.rib.get(prefix).get(routeId) ?? null;
  }

  summarizeRoute(route) {
    if (!route) return null;
    return {
      prefix: route.prefix,
      nextHop: route.nextHop,
      asPath: [...route.asPath],
      localPref: route.localPref,
      med: route.med,
      origin: route.origin,
      communities: [...route.communities],
      learnedType: route.learnedType,
    };
  }
}
