import { PrefixList } from './prefix.js';

function asPathMatches(route, regex) {
  if (regex === undefined || regex === null) return true;
  const pattern = regex instanceof RegExp ? regex : new RegExp(regex);
  return pattern.test(route.asPath.join(' '));
}

function communityMatches(route, communities) {
  if (communities === undefined) return true;
  const required = Array.isArray(communities) ? communities : [communities];
  return required.every((community) => route.communities.includes(String(community)));
}

function applySet(route, set) {
  const next = { ...route, communities: [...route.communities] };
  if (set.localPref !== undefined) next.localPref = Number(set.localPref);
  if (set.med !== undefined) next.med = Number(set.med);
  if (set.community !== undefined) next.communities = [String(set.community)];
  if (set.communityAdd !== undefined) {
    for (const community of set.communityAdd.map(String)) {
      if (!next.communities.includes(community)) next.communities.push(community);
    }
  }
  if (set.communityRemove !== undefined) {
    const removed = new Set(set.communityRemove.map(String));
    next.communities = next.communities.filter((community) => !removed.has(community));
  }
  if (set.asPathPrepend !== undefined) next.asPathPrepend = Number(set.asPathPrepend);
  return next;
}

export class RouteMap {
  constructor(name, clauses = [], prefixLists = {}) {
    this.name = name;
    this.prefixLists = prefixLists;
    this.clauses = clauses.map((clause, index) => {
      const action = clause.action ?? 'permit';
      if (action !== 'permit' && action !== 'deny') {
        throw new Error(`route-map ${name} 第 ${index + 1} 条 action 非法: ${action}`);
      }
      return {
        action,
        sequence: clause.sequence ?? index + 1,
        match: clause.match ?? {},
        set: clause.set ?? {},
      };
    }).sort((a, b) => a.sequence - b.sequence);
  }

  evaluate(route) {
    for (const clause of this.clauses) {
      const { match } = clause;
      if (match.prefixList !== undefined) {
        const list = this.prefixLists[match.prefixList];
        if (!list) throw new Error(`route-map ${this.name} 引用了不存在的 prefix-list: ${match.prefixList}`);
        const prefixDecision = list.match(route.prefix);
        if (prefixDecision === null) continue;
        if (prefixDecision === 'deny') return { permitted: false, route: null };
      }
      if (!asPathMatches(route, match.asPath)) continue;
      if (!communityMatches(route, match.community)) continue;
      if (clause.action === 'deny') return { permitted: false, route: null };
      return { permitted: true, route: applySet(route, clause.set) };
    }
    return { permitted: false, route: null };
  }
}

export function buildPrefixLists(config = {}) {
  const result = {};
  for (const [name, entries] of Object.entries(config)) {
    result[name] = new PrefixList(name, entries);
  }
  return result;
}

export function buildRouteMaps(config = {}, prefixLists = {}) {
  const result = {};
  for (const [name, clauses] of Object.entries(config)) {
    result[name] = new RouteMap(name, clauses, prefixLists);
  }
  return result;
}
