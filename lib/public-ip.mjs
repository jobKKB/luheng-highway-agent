import net, { BlockList } from 'node:net';

// Shared, conservative outbound policy. Keep the browser's verified ranges
// here so model and mail endpoints cannot accept addresses the browser rejects.
const blockedIPv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedIPv4.addSubnet(address, prefix, 'ipv4');
const publicIPv6 = new BlockList(); publicIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new BlockList();
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blockedIPv6.addSubnet(address,prefix,'ipv6');

// BlockList parses IPv6 numerically, including expanded/mapped spellings.
// Only global-unicast IPv6 is eligible; translation/special-use ranges fail closed.
export function isPublicAddress(address) {
  if (typeof address !== 'string') return false;
  if (net.isIPv4(address)) return !blockedIPv4.check(address, 'ipv4');
  if (net.isIPv6(address)) return publicIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
  return false;
}
