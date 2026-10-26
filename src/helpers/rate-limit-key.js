import { isIPv6 } from 'node:net';

const IPV6_GROUP_COUNT = 8;
const IPV6_PREFIX_GROUPS = 4;
const IPV4_MAPPED_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

// Expands an IPv6 string into its 8 numeric groups (hex strings, no zero padding).
function expandIpv6Groups(address) {
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(IPV6_GROUP_COUNT - headGroups.length - tailGroups.length).fill('0');
  return [...headGroups, ...fill, ...tailGroups];
}

// Converts the two trailing hex groups of an IPv4-mapped address into dotted form.
function hexGroupsToIpv4(high, low) {
  const value = (parseInt(high, 16) << 16) | parseInt(low, 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

// Maps a client IP to its rate-limit identity: IPv4 (also IPv4-mapped IPv6) as is, other IPv6 as its /64 prefix.
export function normalizeRateLimitIp(ip) {
  const address = String(ip ?? '').split('%')[0].toLowerCase();
  const mappedDotted = IPV4_MAPPED_PREFIX.exec(address);
  if (mappedDotted) return mappedDotted[1];
  const mappedHex = IPV4_MAPPED_HEX.exec(address);
  if (mappedHex) return hexGroupsToIpv4(mappedHex[1], mappedHex[2]);
  if (!isIPv6(address)) return address;
  const prefix = expandIpv6Groups(address).slice(0, IPV6_PREFIX_GROUPS).map((group) => parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

// Builds a key generator that keys by user id (falling back to the normalized IP) under a per-route namespace.
export function userRateLimitKey(namespace) {
  return (request) => `${namespace}:${request.user?.id ?? normalizeRateLimitIp(request.ip)}`;
}

// Default key for every route: the authenticated user, otherwise the normalized IP.
export function globalRateLimitKey(request) {
  return request.user?.id ? `user:${request.user.id}` : `ip:${normalizeRateLimitIp(request.ip)}`;
}
