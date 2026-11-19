const ORIGIN_RANK = { igp: 0, egp: 1, incomplete: 2 };

function originRank(origin) {
  return ORIGIN_RANK[origin] ?? ORIGIN_RANK.incomplete;
}

export function compareRoutes(candidate, current) {
  if (candidate.localPref !== current.localPref) {
    return candidate.localPref > current.localPref ? candidate : current;
  }
  const candidateAsPathLength = candidate.asPath.length;
  const currentAsPathLength = current.asPath.length;
  if (candidateAsPathLength !== currentAsPathLength) {
    return candidateAsPathLength < currentAsPathLength ? candidate : current;
  }
  const candidateOrigin = originRank(candidate.origin);
  const currentOrigin = originRank(current.origin);
  if (candidateOrigin !== currentOrigin) {
    return candidateOrigin < currentOrigin ? candidate : current;
  }
  if (candidate.med !== current.med) {
    return candidate.med < current.med ? candidate : current;
  }
  if (candidate.ebgp !== current.ebgp) {
    return candidate.ebgp ? candidate : current;
  }
  if (candidate.nextHop !== current.nextHop) {
    return candidate.nextHop < current.nextHop ? candidate : current;
  }
  return candidate.id < current.id ? candidate : current;
}

export function selectBestRoute(routes) {
  const usable = routes.filter(Boolean);
  if (usable.length === 0) return null;
  return usable.reduce((best, route) => compareRoutes(route, best));
}
