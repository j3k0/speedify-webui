import ipaddress
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import lanflows  # noqa: E402

# Lines copied from `conntrack -L -f ipv4 -o extended` on pi3. Flows created
# before nf_conntrack_acct was enabled have no packets=/bytes= counters.
SAMPLE = """\
ipv4     2 udp      17 0 src=192.168.145.97 dst=192.168.145.1 sport=63324 dport=5351 [UNREPLIED] src=192.168.145.1 dst=192.168.145.97 sport=5351 dport=63324 mark=0 use=1
ipv4     2 udp      17 44 src=192.168.145.244 dst=17.248.213.70 sport=51328 dport=443 src=17.248.213.70 dst=192.168.0.105 sport=443 dport=51328 [ASSURED] mark=0 use=1
ipv4     2 tcp      6 431809 ESTABLISHED src=192.168.145.97 dst=136.243.45.99 sport=55023 dport=22 src=136.243.45.99 dst=192.168.0.105 sport=22 dport=55023 [ASSURED] mark=0 use=1
ipv4     2 udp      17 83 src=192.168.0.105 dst=23.157.120.14 sport=51413 dport=6969 src=23.157.120.14 dst=192.168.0.105 sport=6969 dport=51413 [ASSURED] mark=0 use=1
ipv4     2 udp      17 19 src=192.168.0.105 dst=192.168.0.1 sport=52918 dport=53 packets=1 bytes=92 src=192.168.0.1 dst=192.168.0.105 sport=53 dport=52918 packets=1 bytes=148 mark=0 use=1
ipv4     2 tcp      6 100 ESTABLISHED src=192.168.145.49 dst=1.2.3.4 sport=50000 dport=443 packets=10 bytes=2000 src=1.2.3.4 dst=192.168.0.105 sport=443 dport=50000 packets=12 bytes=9000 [ASSURED] mark=0 use=1
"""

OWN = {ipaddress.IPv4Address('192.168.0.105'), ipaddress.IPv4Address('192.168.145.1'),
       ipaddress.IPv4Address('10.202.0.2')}


def torrent_flows(src, n, base_port=40000, proto='tcp'):
    """n flows from src to n different remote peers on random high ports"""
    return [{'proto': proto, 'src': src, 'dst': f'{20 + i // 250}.{i % 250}.7.9', 'sport': 50000 + i,
             'dport': base_port + i, 'txBytes': 100, 'rxBytes': 1000} for i in range(n)]


class ParseTests(unittest.TestCase):
    def test_parses_real_lines_and_counters(self):
        flows = lanflows.parse_conntrack(SAMPLE)
        self.assertEqual(len(flows), 6)
        last = flows[-1]
        self.assertEqual((last['src'], last['dst'], last['dport']), ('192.168.145.49', '1.2.3.4', 443))
        # counters: original direction = upload, reply direction = download
        self.assertEqual((last['txBytes'], last['rxBytes']), (2000, 9000))
        # flows without accounting parse with zero bytes
        self.assertEqual((flows[0]['txBytes'], flows[0]['rxBytes']), (0, 0))

    def test_ignores_garbage(self):
        self.assertEqual(lanflows.parse_conntrack('conntrack v1.4.8: 5 flow entries\n\nipv6 10 junk\n'), [])


class AggregateTests(unittest.TestCase):
    def test_attribution_and_filtering(self):
        devices, _ = lanflows.aggregate(lanflows.parse_conntrack(SAMPLE), OWN)
        # LAN-local flow (.97 -> pi3 NAT-PMP) is dropped; .97 keeps its SSH flow
        self.assertEqual(devices['192.168.145.97']['flows'], 1)
        self.assertEqual(devices['192.168.145.244']['flows'], 1)
        # pi3's own flows are grouped under "pi3"; its DNS to the Archer is local
        self.assertEqual(devices['pi3']['flows'], 1)
        self.assertEqual(devices['pi3']['btFlows'], 1)   # sport 51413 / tracker 6969
        self.assertEqual(devices['192.168.145.49']['txBytes'], 2000)
        self.assertEqual(devices['192.168.145.49']['rxBytes'], 9000)

    def test_normal_browsing_is_not_flagged(self):
        flows = [{'proto': 'tcp', 'src': '192.168.145.50', 'dst': f'142.250.{i}.1', 'sport': 50000 + i,
                  'dport': 443, 'txBytes': 1, 'rxBytes': 1} for i in range(200)]
        devices, _ = lanflows.aggregate(flows, OWN)
        d = devices['192.168.145.50']
        self.assertEqual((d['remotes'], d['p2pPeers'], d['verdict']), (200, 0, None))

    def test_many_peers_on_high_ports_is_torrent(self):
        devices, _ = lanflows.aggregate(torrent_flows('192.168.145.60', 80), OWN)
        self.assertEqual(devices['192.168.145.60']['verdict'], 'torrent')

    def test_moderate_peers_is_elevated(self):
        devices, _ = lanflows.aggregate(torrent_flows('192.168.145.60', 15), OWN)
        self.assertEqual(devices['192.168.145.60']['verdict'], 'elevated')

    def test_tailscale_is_not_counted_as_p2p(self):
        # many UDP peers, but all from Tailscale's local port 41641
        flows = [dict(f, sport=41641) for f in torrent_flows('192.168.145.97', 60, proto='udp')]
        devices, _ = lanflows.aggregate(flows, OWN)
        d = devices['192.168.145.97']
        self.assertEqual((d['p2pPeers'], d['verdict']), (0, None))
        self.assertEqual(d['services'][0][0], 'Tailscale')

    def test_bittorrent_port_flows_alone_are_elevated(self):
        flows = [{'proto': 'udp', 'src': '192.168.145.70', 'dst': '9.9.9.9', 'sport': 51413,
                  'dport': 6969, 'txBytes': 1, 'rxBytes': 1}]
        devices, _ = lanflows.aggregate(flows, OWN)
        self.assertEqual(devices['192.168.145.70']['verdict'], 'elevated')

    def test_counter_deltas(self):
        f = lambda tx, rx: [{'proto': 'tcp', 'src': '192.168.145.80', 'dst': '5.5.5.5', 'sport': 1111,
                             'dport': 443, 'txBytes': tx, 'rxBytes': rx}]
        _, counters = lanflows.aggregate(f(1000, 5000), OWN)
        devices, _ = lanflows.aggregate(f(1500, 7000), OWN, counters)
        self.assertEqual((devices['192.168.145.80']['txBytes'], devices['192.168.145.80']['rxBytes']), (500, 2000))
        # a flow whose counter went backwards (new flow, same tuple) counts from zero
        devices, _ = lanflows.aggregate(f(100, 200), OWN, counters)
        self.assertEqual((devices['192.168.145.80']['txBytes'], devices['192.168.145.80']['rxBytes']), (100, 200))


class MiscTests(unittest.TestCase):
    def test_random_mac(self):
        self.assertTrue(lanflows.is_random_mac('ee:94:cc:ae:40:1d'))    # locally administered
        self.assertFalse(lanflows.is_random_mac('f4:d4:88:70:f9:d7'))   # vendor MAC


if __name__ == '__main__':
    unittest.main()
