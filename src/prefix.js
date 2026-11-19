const IPV4_BITS = 32;

export function parseCidr(cidr) {
  const [address, lengthText] = String(cidr).split('/');
  const length = Number(lengthText);
  if (!isValidIpv4(address) || !Number.isInteger(length) || length < 0 || length > IPV4_BITS) {
    throw new Error(`非法 CIDR: ${cidr}`);
  }
  return { address, length, int: ipv4ToInt(address) };
}

export function isValidIpv4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255 && String(value) === part;
  });
}

export function ipv4ToInt(address) {
  return address.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
}

export function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function networkAddress(value, length) {
  if (length === 0) return 0;
  return (value & (0xffffffff << (IPV4_BITS - length))) >>> 0;
}

export function isPrefixContained(candidateCidr, prefixListEntry) {
  const candidate = parseCidr(candidateCidr);
  const prefix = parseCidr(prefixListEntry.prefix);
  const lower = prefixListEntry.ge ?? prefix.length;
  const upper = prefixListEntry.le ?? (prefixListEntry.ge !== undefined ? IPV4_BITS : prefix.length);
  if (lower > upper) {
    throw new Error(`前缀列表范围非法: ge(${lower}) > le(${upper})`);
  }
  if (candidate.length < lower || candidate.length > upper) return false;
  if (candidate.length < prefix.length) return false;
  return networkAddress(candidate.int, prefix.length) === prefix.int;
}

export class PrefixList {
  constructor(name, entries = []) {
    this.name = name;
    this.entries = entries.map((entry, index) => {
      parseCidr(entry.prefix);
      const action = entry.action ?? 'permit';
      if (action !== 'permit' && action !== 'deny') {
        throw new Error(`前缀列表 ${name} 第 ${index + 1} 条 action 非法: ${action}`);
      }
      const ge = entry.ge;
      const le = entry.le;
      if (ge !== undefined && (ge < 0 || ge > IPV4_BITS)) {
        throw new Error(`前缀列表 ${name} ge 超出范围: ${ge}`);
      }
      if (le !== undefined && (le < 0 || le > IPV4_BITS)) {
        throw new Error(`前缀列表 ${name} le 超出范围: ${le}`);
      }
      if (ge !== undefined && le !== undefined && ge > le) {
        throw new Error(`前缀列表 ${name} ge(${ge}) 不能大于 le(${le})`);
      }
      return {
        prefix: entry.prefix,
        action,
        ge,
        le,
        sequence: entry.sequence ?? index + 1,
      };
    }).sort((a, b) => a.sequence - b.sequence);
  }

  evaluate(cidr) {
    for (const entry of this.entries) {
      if (isPrefixContained(cidr, entry)) return entry.action;
    }
    return 'deny';
  }

  match(cidr) {
    for (const entry of this.entries) {
      if (isPrefixContained(cidr, entry)) return entry.action;
    }
    return null;
  }
}
