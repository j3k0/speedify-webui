"""
Per-device internet traffic from pi3's connection-tracking table.

pi3 is the LAN's router (the Deco mesh is in access-point mode), so every
LAN device's internet connections pass through its conntrack table, keyed
by the device's own 192.168.145.x / 192.168.146.x address. pi3's own
traffic (Transmission, updates, ...) appears with one of pi3's addresses
and is reported as the device "pi3".

The table is read with `sudo -n /usr/local/bin/lan-flows` (a root-owned,
argument-free wrapper around `conntrack -L -o extended`, installed with a
matching sudo rule by ~/Documents/pi3-router/scripts/deploy.sh).

A background sampler reads it every SAMPLE_INTERVAL seconds and keeps the
last RING_SAMPLES samples in memory. When Speedify records a TORRENT
disconnect, the samples around it are saved to data/incidents.db so the
dashboard can show which devices were active when the tunnel was cut.

Torrent heuristic ("P2P-like peers"): distinct remote hosts reached on
non-service ports (>= 1024, not a known service). Browsers, phones and
streaming talk to a handful of hosts on 443; BitTorrent talks to dozens or
hundreds of peers on random high ports. Known non-BitTorrent P2P
(Tailscale, WireGuard) is excluded by its local port. Flows on BitTorrent's
own ports (peers 6881-6889, trackers 6969/1337/2710, Transmission 51413)
are counted separately as a strong signal.
"""

import collections
import ipaddress
import json
import os
import re
import sqlite3
import subprocess
import threading
import time

LAN_NETWORKS = [ipaddress.ip_network('192.168.145.0/24'),
                ipaddress.ip_network('192.168.146.0/24')]
LAN_FLOWS_CMD = ['/usr/bin/sudo', '-n', '/usr/local/bin/lan-flows']
LEASES_FILE = '/var/lib/misc/dnsmasq.leases'
ARP_FILE = '/proc/net/arp'

SAMPLE_INTERVAL = 30          # seconds between conntrack reads
RING_SAMPLES = 30             # 15 minutes of history in memory
SNAPSHOT_BEFORE = 15 * 60     # seconds before a kick saved with it
SNAPSHOT_AFTER = 60           # ... and after (the culprit keeps going)

TORRENT_PEERS = 30            # P2P-like peers -> "torrent-like"
ELEVATED_PEERS = 12           # P2P-like peers -> "elevated"

# Remote ports of ordinary client traffic -> service label
SERVICE_PORTS = {
    20: 'FTP', 21: 'FTP', 22: 'SSH', 25: 'SMTP', 53: 'DNS', 80: 'HTTP',
    110: 'POP3', 123: 'NTP', 143: 'IMAP', 443: 'HTTPS', 465: 'SMTP',
    500: 'IPsec', 587: 'SMTP', 853: 'DNS-over-TLS', 993: 'IMAP', 995: 'POP3',
    1194: 'OpenVPN', 1935: 'RTMP', 3478: 'STUN', 3479: 'STUN', 3480: 'STUN',
    4500: 'IPsec', 5222: 'XMPP', 5223: 'Apple push', 5228: 'Google push',
    5349: 'TURN', 8080: 'HTTP-alt', 8443: 'HTTPS-alt', 19302: 'STUN',
    41641: 'Tailscale', 51820: 'WireGuard',
}
# Local ports of P2P software that is not BitTorrent: its peers don't count
BENIGN_LOCAL_PORTS = {41641: 'Tailscale', 51820: 'WireGuard'}
# BitTorrent's own ports (remote: peer range + common tracker ports;
# local: Transmission's peer port and the classic range)
BT_REMOTE_PORTS = set(range(6881, 6890)) | {6969, 1337, 2710}
BT_LOCAL_PORTS = set(range(6881, 6890)) | {51413}

MAC_RE = re.compile(r'^[0-9a-f]{2}(:[0-9a-f]{2}){5}$')


# --------------------------------------------------------------------------
# Parsing and aggregation (pure functions, testable without a router)
# --------------------------------------------------------------------------

def parse_conntrack(text):
    """Parse `conntrack -L -o extended` output into flow dicts.

    Each line has the original direction (src=... dst=... sport=...
    dport=... [packets=... bytes=...]) followed by the reply direction
    with the same keys. Counters only exist with nf_conntrack_acct=1.
    """
    flows = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0] != 'ipv4':
            continue
        orig, reply = {}, {}
        cur = orig
        for tok in parts[4:]:
            key, sep, val = tok.partition('=')
            if not sep:
                continue
            if key == 'src' and 'src' in orig:
                cur = reply
            if key in ('src', 'dst', 'sport', 'dport', 'bytes') and key not in cur:
                cur[key] = val
        if 'src' not in orig or 'dst' not in orig:
            continue
        try:
            flows.append({
                'proto': parts[2],
                'src': orig['src'], 'dst': orig['dst'],
                'sport': int(orig.get('sport', 0)), 'dport': int(orig.get('dport', 0)),
                'txBytes': int(orig.get('bytes', 0)), 'rxBytes': int(reply.get('bytes', 0)),
            })
        except ValueError:
            continue
    return flows


def _is_local(ip, own):
    return (ip in own or ip.is_private or ip.is_loopback or ip.is_multicast
            or ip.is_link_local or ip.is_unspecified
            or ip == ipaddress.IPv4Address('255.255.255.255'))


def _device_key(src, own):
    """LAN client IP, 'pi3' for pi3's own traffic, None for inbound flows"""
    if src in own:
        return 'pi3'
    if any(src in net for net in LAN_NETWORKS):
        return str(src)
    return None


def aggregate(flows, own, prev_counters=None):
    """Per-device stats for one sample.

    own: set of pi3's own IPv4Address objects.
    prev_counters: {flow_key: (tx, rx)} from the previous sample, to turn
    cumulative per-flow byte counters into per-interval deltas.
    Returns (devices, counters).
    """
    prev_counters = prev_counters or {}
    devices = {}
    counters = {}
    for f in flows:
        try:
            src = ipaddress.ip_address(f['src'])
            dst = ipaddress.ip_address(f['dst'])
        except ValueError:
            continue
        key = _device_key(src, own)
        if key is None or _is_local(dst, own):
            continue  # inbound, or LAN-local (DNS to pi3, NAT-PMP, mDNS...)

        fkey = (f['proto'], f['src'], f['sport'], f['dst'], f['dport'])
        counters[fkey] = (f['txBytes'], f['rxBytes'])
        ptx, prx = prev_counters.get(fkey, (0, 0))
        dtx = f['txBytes'] - ptx if f['txBytes'] >= ptx else f['txBytes']
        drx = f['rxBytes'] - prx if f['rxBytes'] >= prx else f['rxBytes']

        d = devices.setdefault(key, {
            'flows': 0, 'tcp': 0, 'udp': 0, 'remotes': set(), 'p2p': set(),
            'btFlows': 0, 'txBytes': 0, 'rxBytes': 0,
            'services': collections.Counter(),
        })
        d['flows'] += 1
        if f['proto'] in ('tcp', 'udp'):
            d[f['proto']] += 1
        d['remotes'].add(f['dst'])
        d['txBytes'] += dtx
        d['rxBytes'] += drx

        if f['dport'] in BT_REMOTE_PORTS or f['sport'] in BT_LOCAL_PORTS:
            d['btFlows'] += 1
        benign = BENIGN_LOCAL_PORTS.get(f['sport'])
        service = SERVICE_PORTS.get(f['dport'])
        if benign:
            d['services'][benign] += 1
        elif service:
            d['services'][service] += 1
        elif f['dport'] >= 1024:
            d['services']['high ports'] += 1
            d['p2p'].add(f['dst'])
        else:
            d['services'][f"{f['proto']}/{f['dport']}"] += 1

    result = {}
    for key, d in devices.items():
        p2p = len(d['p2p'])
        if d['btFlows'] and p2p >= ELEVATED_PEERS or p2p >= TORRENT_PEERS:
            verdict = 'torrent'
        elif d['btFlows'] or p2p >= ELEVATED_PEERS:
            verdict = 'elevated'
        else:
            verdict = None
        result[key] = {
            'flows': d['flows'], 'tcp': d['tcp'], 'udp': d['udp'],
            'remotes': len(d['remotes']), 'p2pPeers': p2p, 'btFlows': d['btFlows'],
            'txBytes': d['txBytes'], 'rxBytes': d['rxBytes'],
            'services': d['services'].most_common(5),
            'verdict': verdict,
        }
    return result, counters


def own_addresses():
    """pi3's own IPv4 addresses (any interface)"""
    out = subprocess.run(['/usr/sbin/ip', '-4', '-o', 'addr', 'show'],
                         capture_output=True, text=True, timeout=5).stdout
    addrs = {ipaddress.IPv4Address('127.0.0.1')}
    for m in re.finditer(r'inet (\d+\.\d+\.\d+\.\d+)/', out):
        addrs.add(ipaddress.IPv4Address(m.group(1)))
    return addrs


def device_directory():
    """{ip: {'mac', 'hostname'}} from dnsmasq leases + the ARP table"""
    directory = {}
    try:
        with open(ARP_FILE) as fh:
            next(fh, None)
            for line in fh:
                p = line.split()
                if len(p) >= 4 and MAC_RE.match(p[3]) and p[3] != '00:00:00:00:00:00':
                    directory[p[0]] = {'mac': p[3], 'hostname': ''}
    except OSError:
        pass
    try:
        with open(LEASES_FILE) as fh:
            for line in fh:
                p = line.split()
                if len(p) >= 4:
                    name = '' if p[3] == '*' else p[3]
                    directory[p[2]] = {'mac': p[1].lower(), 'hostname': name}
    except OSError:
        pass
    return directory


def is_random_mac(mac):
    """Locally administered (privacy/randomised) MAC address"""
    try:
        return bool(int(mac[1], 16) & 2)
    except (ValueError, IndexError, TypeError):
        return False


# --------------------------------------------------------------------------
# Labels (user-given device names, keyed by MAC)
# --------------------------------------------------------------------------

class Labels:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()

    def load(self):
        try:
            with open(self.path) as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def set(self, mac, label):
        with self.lock:
            data = self.load()
            if label:
                data[mac] = label
            else:
                data.pop(mac, None)
            tmp = self.path + '.tmp'
            with open(tmp, 'w') as fh:
                json.dump(data, fh, indent=1, sort_keys=True)
            os.replace(tmp, self.path)
            return data


def describe(key, directory, labels):
    """Display info for a device key ('pi3' or an IP)"""
    if key == 'pi3':
        return {'ip': '', 'mac': '', 'hostname': 'pi3', 'label': '',
                'name': 'pi3 (this router)', 'randomMac': False}
    entry = directory.get(key, {})
    mac = entry.get('mac', '')
    hostname = entry.get('hostname', '')
    label = labels.get(mac, '') if mac else ''
    return {'ip': key, 'mac': mac, 'hostname': hostname, 'label': label,
            'name': label or hostname or key, 'randomMac': is_random_mac(mac)}


# --------------------------------------------------------------------------
# Background sampler + TORRENT-kick snapshots
# --------------------------------------------------------------------------

class LanSampler:
    def __init__(self, data_dir, speedify_db_uri):
        self.data_dir = data_dir
        self.incidents_path = os.path.join(data_dir, 'incidents.db')
        self.speedify_db_uri = speedify_db_uri
        self.labels = Labels(os.path.join(data_dir, 'device-labels.json'))
        self.lock = threading.Lock()
        self.ring = collections.deque(maxlen=RING_SAMPLES)
        self.error = None
        self.started = False
        self._prev_counters = {}
        self._prev_ts = None
        self._last_kick = None
        os.makedirs(data_dir, exist_ok=True)
        self._init_incidents_db()

    # -- storage --
    def _db(self):
        return sqlite3.connect(self.incidents_path, timeout=5)

    def _init_incidents_db(self):
        with self._db() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS incidents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kicked_at INTEGER NOT NULL UNIQUE,
                    server TEXT,
                    captured_at INTEGER NOT NULL,
                    samples INTEGER NOT NULL,
                    suspects TEXT NOT NULL
                )""")

    # -- sampling --
    def start(self):
        if self.started:
            return
        self.started = True
        threading.Thread(target=self._run, name='lan-sampler', daemon=True).start()

    def _run(self):
        try:
            self._last_kick = self._latest_torrent_kick()   # only snapshot new kicks
        except Exception as exc:  # Speedify DB unreadable: keep sampling anyway
            self._last_kick = int(time.time())
            print(f'lan-sampler: cannot read Speedify sessions: {exc}')
        while True:
            try:
                self.sample_once()
            except Exception as exc:
                with self.lock:
                    self.error = str(exc)
            try:
                self.check_kicks()
            except Exception as exc:
                print(f'lan-sampler: kick check failed: {exc}')
            time.sleep(SAMPLE_INTERVAL)

    def sample_once(self):
        proc = subprocess.run(LAN_FLOWS_CMD, capture_output=True, text=True, timeout=15)
        if proc.returncode != 0:
            raise RuntimeError(f'lan-flows failed ({proc.returncode}): '
                               f'{proc.stderr.strip()[:200] or "no output"}')
        now = time.time()
        flows = parse_conntrack(proc.stdout)
        devices, counters = aggregate(flows, own_addresses(), self._prev_counters)
        interval = now - self._prev_ts if self._prev_ts else None
        for d in devices.values():
            # first sample: counters are totals since each flow started -> no rate
            d['txBps'] = d['txBytes'] / interval if interval else None
            d['rxBps'] = d['rxBytes'] / interval if interval else None
        self._prev_counters = counters
        self._prev_ts = now
        with self.lock:
            self.ring.append({'ts': int(now), 'interval': interval, 'flows': len(flows),
                              'devices': devices})
            self.error = None

    # -- kicks --
    def _latest_torrent_kick(self):
        conn = sqlite3.connect(self.speedify_db_uri, uri=True, timeout=3)
        try:
            row = conn.execute("SELECT MAX(session_end) FROM sessions "
                               "WHERE disconnect_reason = 'TORRENT'").fetchone()
        finally:
            conn.close()
        return (row[0] if row else None) or 0

    def check_kicks(self):
        conn = sqlite3.connect(self.speedify_db_uri, uri=True, timeout=3)
        try:
            rows = conn.execute(
                "SELECT session_end, server FROM sessions WHERE disconnect_reason = 'TORRENT' "
                "AND session_end > ? ORDER BY session_end", (self._last_kick or 0,)).fetchall()
        finally:
            conn.close()
        for kicked_at, server in rows:
            self._save_snapshot(kicked_at, server)
            self._last_kick = kicked_at

    def _save_snapshot(self, kicked_at, server):
        with self.lock:
            samples = [s for s in self.ring
                       if kicked_at - SNAPSHOT_BEFORE <= s['ts'] <= kicked_at + SNAPSHOT_AFTER]
        per = {}
        for s in samples:
            for key, d in s['devices'].items():
                p = per.setdefault(key, {'key': key, 'peakP2p': 0, 'peakBtFlows': 0,
                                         'bytes': 0, 'samples': 0})
                p['peakP2p'] = max(p['peakP2p'], d['p2pPeers'])
                p['peakBtFlows'] = max(p['peakBtFlows'], d['btFlows'])
                p['bytes'] += d['txBytes'] + d['rxBytes']
                p['samples'] += 1
        ranked = sorted(per.values(),
                        key=lambda p: (p['peakBtFlows'] > 0, p['peakP2p'], p['bytes']),
                        reverse=True)[:8]
        directory = device_directory()
        for p in ranked:   # remember who it was at the time (IPs get reused)
            entry = directory.get(p['key'], {})
            p['mac'] = entry.get('mac', '')
            p['hostname'] = 'pi3' if p['key'] == 'pi3' else entry.get('hostname', '')
        with self._db() as conn:
            conn.execute("INSERT OR IGNORE INTO incidents "
                         "(kicked_at, server, captured_at, samples, suspects) "
                         "VALUES (?, ?, ?, ?, ?)",
                         (kicked_at, server, int(time.time()), len(samples), json.dumps(ranked)))

    # -- read side (API) --
    def incidents(self, since=0, limit=20):
        labels = self.labels.load()
        with self._db() as conn:
            rows = conn.execute(
                "SELECT kicked_at, server, samples, suspects FROM incidents "
                "WHERE kicked_at >= ? ORDER BY kicked_at DESC LIMIT ?", (since, limit)).fetchall()
        result = []
        for kicked_at, server, samples, suspects in rows:
            items = []
            for p in json.loads(suspects):
                label = labels.get(p.get('mac'), '') if p.get('mac') else ''
                name = ('pi3 (this router)' if p['key'] == 'pi3'
                        else label or p.get('hostname') or p['key'])
                items.append(dict(p, name=name))
            result.append({'kickedAt': kicked_at, 'server': server or '',
                           'samples': samples, 'suspects': items})
        return result

    def current(self):
        with self.lock:
            latest = self.ring[-1] if self.ring else None
            error = self.error
            recent = list(self.ring)[-10:]   # last ~5 minutes
        directory = device_directory()
        labels = self.labels.load()
        devices = []
        if latest:
            for key, d in latest['devices'].items():
                info = describe(key, directory, labels)
                # peak over the last ~5 min so short bursts stay visible
                info.update(d, recentPeakP2p=max(
                    (s['devices'].get(key, {}).get('p2pPeers', 0) for s in recent), default=0),
                    key=key)
                devices.append(info)
        rank = {'torrent': 2, 'elevated': 1, None: 0}
        devices.sort(key=lambda d: (rank[d['verdict']], d['p2pPeers'],
                                    (d['rxBps'] or 0) + (d['txBps'] or 0)), reverse=True)
        active = {d['ip'] for d in devices}
        idle = [describe(ip, directory, labels) for ip, e in directory.items()
                if ip not in active and any(ipaddress.ip_address(ip) in n for n in LAN_NETWORKS)
                and e.get('hostname') != 'deco-X50']
        return {
            'available': latest is not None,
            'error': error,
            'sampledAt': latest['ts'] if latest else None,
            'interval': SAMPLE_INTERVAL,
            'flows': latest['flows'] if latest else 0,
            'devices': devices,
            'idle': sorted(idle, key=lambda d: d['name'].lower()),
            'thresholds': {'torrent': TORRENT_PEERS, 'elevated': ELEVATED_PEERS},
        }
