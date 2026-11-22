#!/usr/bin/env python3
"""
Speedify Web Dashboard
A Flask-based web interface for monitoring and controlling Speedify
"""

from flask import Flask, render_template, jsonify, request, abort
import datetime
import ipaddress
import os
import re
import sqlite3
import time
import speedify
import traceback

app = Flask(__name__)

# Configuration
PORT = 20333

# Only the router's own LAN subnets (eth-builtin / wlan-builtin) plus
# loopback (SSH tunnels). NOT 192.168.0.0/16: that would also admit the
# Archer C5's upstream network on the WAN side (pi3 is 192.168.0.105 there).
# Override with WEBUI_ALLOWED_NETWORKS="cidr,cidr,...".
ALLOWED_NETWORKS = [
    ipaddress.ip_network(n.strip())
    for n in os.environ.get(
        'WEBUI_ALLOWED_NETWORKS',
        '192.168.145.0/24,192.168.146.0/24,127.0.0.0/8,::1/128'
    ).split(',')
    if n.strip()
]
ALLOWED_NETWORKS_LABEL = ', '.join(
    str(n) for n in ALLOWED_NETWORKS if not n.is_loopback
)

# State-changing requests must carry this header. Browsers refuse to send a
# custom header cross-origin without a CORS preflight (which we never
# grant), so a random web page opened on a LAN device cannot e.g. POST
# /api/disconnect.
CSRF_HEADER = 'X-Requested-With'
CSRF_VALUE = 'speedify-webui'

# Speedify's own session history (world-readable, WAL mode). mode=ro
# reads the WAL too, so the current session is included.
SPEEDIFY_DB_URI = 'file:/usr/share/speedify/logs/sql.db?mode=ro'

# Valid targets for `speedify_cli connect`: keywords, a 2-letter country
# code, or a server tag such as "nl-amsterdam-5".
CONNECT_KEYWORDS = {'closest', 'p2p', 'public', 'private', 'last'}
COUNTRY_RE = re.compile(r'^[a-z]{2}$')
SERVER_TAG_RE = re.compile(r'^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$')


def client_allowed(addr):
    """True if the client address is inside one of ALLOWED_NETWORKS"""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    if getattr(ip, 'ipv4_mapped', None):
        ip = ip.ipv4_mapped
    return any(ip in net for net in ALLOWED_NETWORKS if ip.version == net.version)


# Apply middleware to all routes
@app.before_request
def check_access():
    """Restrict to the LAN and require the CSRF header on mutations"""
    if not client_allowed(request.remote_addr):
        abort(403, description=f"Access denied: only accessible from {ALLOWED_NETWORKS_LABEL}")

    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
            abort(403, description=f"Missing {CSRF_HEADER} header")


@app.route('/')
def dashboard():
    """Serve the main dashboard page"""
    return render_template('dashboard.html')


@app.route('/api/status')
def get_status():
    """Get current Speedify connection status"""
    try:
        # Get state enum
        state = speedify.show_state()
        
        # Get additional info
        settings = speedify.show_settings()
        current_server = speedify.show_currentserver()
        
        # Try to get public IP from multiple sources
        public_ip = ''
        
        # Try settings first
        if isinstance(settings, dict):
            public_ip = settings.get('publicIp', '') or settings.get('publicIP', '') or settings.get('public_ip', '')
        
        # Try current_server if not found in settings
        if not public_ip and isinstance(current_server, dict):
            public_ip = current_server.get('publicIp', '') or current_server.get('publicIP', '') or current_server.get('ip', '')
        
        # Build response
        server = current_server if isinstance(current_server, dict) else {}
        status_data = {
            'state': state.name if hasattr(state, 'name') else str(state),
            'connected': state.name in ['CONNECTED', 'ENABLED'] if hasattr(state, 'name') else False,
            'country': server.get('country', ''),
            'city': server.get('city', ''),
            'serverTag': server.get('tag', ''),
            'serverName': server.get('friendlyName', ''),
            # Servers with torrentAllowed=false kill the whole session when
            # any LAN device torrents (disconnect reason TORRENT).
            'torrentAllowed': server.get('torrentAllowed'),
            'publicIp': public_ip,
            'bondingMode': settings.get('bondingMode', '') if isinstance(settings, dict) else '',
            'encrypted': settings.get('encrypted', False) if isinstance(settings, dict) else False,
        }
        
        return jsonify({
            'success': True,
            'data': status_data
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/adapters')
def get_adapters():
    """Get network adapters information"""
    try:
        adapters = speedify.show_adapters()
        return jsonify({
            'success': True,
            'data': adapters
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/servers')
def get_servers():
    """Get available Speedify servers"""
    try:
        servers = speedify.show_servers()
        return jsonify({
            'success': True,
            'data': servers
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/connect', methods=['POST'])
def connect():
    """Connect to Speedify"""
    try:
        result = speedify.connect()
        return jsonify({
            'success': True,
            'message': 'Connected successfully',
            'data': result
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/disconnect', methods=['POST'])
def disconnect():
    """Disconnect from Speedify"""
    try:
        result = speedify.disconnect()
        return jsonify({
            'success': True,
            'message': 'Disconnected successfully',
            'data': result
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/server', methods=['POST'])
def change_server():
    """Change Speedify server.

    Body: {"target": "p2p" | "closest" | "<cc>" | "<server-tag>"}
    (legacy {"country": "<cc>"} still accepted).
    """
    try:
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or data.get('country') or '').strip().lower()

        if not (target in CONNECT_KEYWORDS or COUNTRY_RE.match(target)
                or SERVER_TAG_RE.match(target)):
            return jsonify({
                'success': False,
                'error': 'target must be p2p, closest, a 2-letter country code or a server tag'
            }), 400

        result = speedify.connect(target)
        name = result.get('friendlyName') if isinstance(result, dict) else None

        return jsonify({
            'success': True,
            'message': f'Connected to {name or target}',
            'data': result
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/bypasses')
def get_bypasses():
    """Get list of domain bypasses"""
    try:
        # Get streaming bypass list
        bypass_data = speedify.show_streamingbypass()
        
        return jsonify({
            'success': True,
            'data': bypass_data
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/bypasses', methods=['POST'])
def add_bypass():
    """Add a domain bypass rule"""
    try:
        data = request.get_json()
        
        if not data or 'domain' not in data:
            return jsonify({
                'success': False,
                'error': 'Domain is required'
            }), 400
        
        domain = data['domain']
        
        # Add to streaming bypass
        result = speedify.streamingbypass_domains_add(domain)
        
        return jsonify({
            'success': True,
            'message': f'Added bypass for {domain}',
            'data': result
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/bypasses/<domain>', methods=['DELETE'])
def remove_bypass(domain):
    """Remove a domain bypass rule"""
    try:
        # Remove from streaming bypass
        result = speedify.streamingbypass_domains_rem(domain)
        
        return jsonify({
            'success': True,
            'message': f'Removed bypass for {domain}',
            'data': result
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/port-bypasses')
def get_port_bypasses():
    """Get list of port bypasses"""
    try:
        # Get streaming bypass list which includes ports
        bypass_data = speedify.show_streamingbypass()
        
        return jsonify({
            'success': True,
            'data': bypass_data.get('ports', []) if isinstance(bypass_data, dict) else []
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/port-bypasses', methods=['POST'])
def add_port_bypass():
    """Add a port bypass rule"""
    try:
        data = request.get_json()
        
        if not data or 'port' not in data:
            return jsonify({
                'success': False,
                'error': 'Port is required'
            }), 400
        
        port = data['port']
        
        # Validate port number
        try:
            port_num = int(port)
            if port_num < 1 or port_num > 65535:
                return jsonify({
                    'success': False,
                    'error': 'Port must be between 1 and 65535'
                }), 400
        except ValueError:
            return jsonify({
                'success': False,
                'error': 'Port must be a valid number'
            }), 400
        
        # Add to streaming bypass ports
        result = speedify.streamingbypass_ports_add(str(port_num))
        
        return jsonify({
            'success': True,
            'message': f'Added port bypass for {port_num}',
            'data': result
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/port-bypasses/<port>', methods=['DELETE'])
def remove_port_bypass(port):
    """Remove a port bypass rule"""
    try:
        # Validate port number
        try:
            port_num = int(port)
            if port_num < 1 or port_num > 65535:
                return jsonify({
                    'success': False,
                    'error': 'Port must be between 1 and 65535'
                }), 400
        except ValueError:
            return jsonify({
                'success': False,
                'error': 'Port must be a valid number'
            }), 400
        
        # Remove from streaming bypass ports
        result = speedify.streamingbypass_ports_rem(str(port_num))
        
        return jsonify({
            'success': True,
            'message': f'Removed port bypass for {port_num}',
            'data': result
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/stats')
def get_stats():
    """Get connection statistics (data usage and real-time bandwidth)"""
    try:
        # Get comprehensive stats including real-time bandwidth
        all_stats = speedify.stats()
        
        # Extract adapter data and connection stats
        adapters = []
        connection_stats = None
        
        for stat_entry in all_stats:
            if stat_entry[0] == 'adapters':
                adapters = stat_entry[1]
            elif stat_entry[0] == 'connection_stats':
                connection_stats = stat_entry[1]
        
        # Real monthly usage from session stats (auto-reset by Speedify
        # at periodStartTime). Adapter usageMonthly is per-adapter billed
        # bytes with overlap on bonded traffic — not usable as totals.
        month_cmd = speedify._run_speedify_cmd(['stats', 'session', 'month'])
        month = month_cmd.get('month', {}) if isinstance(month_cmd, dict) else {}
        month_down = month.get('bytesReceived', 0)
        month_up = month.get('bytesSent', 0)

        # Peak speeds seen this period (session stats)
        max_down_mbps = month.get('maxDownloadSpeed', 0)
        max_up_mbps = month.get('maxUploadSpeed', 0)

        # Calculate real-time bandwidth + per-connection quality from
        # connection stats
        download_bps = 0
        upload_bps = 0
        connections = []

        if connection_stats and 'connections' in connection_stats:
            for conn in connection_stats['connections']:
                # Skip proxy connections as they don't represent real bandwidth
                if conn.get('protocol') == 'proxy':
                    continue
                download_bps += conn.get('receiveBps', 0)
                upload_bps += conn.get('sendBps', 0)
                connections.append({
                    'adapterID': conn.get('adapterID'),
                    'latencyMs': conn.get('latencyMs'),
                    'jitterMs': conn.get('jitterMs'),
                    'lossReceive': conn.get('lossReceive', 0),
                    'lossSend': conn.get('lossSend', 0),
                    'mos': conn.get('mos'),
                    'receiveEstimateMbps': conn.get('receiveEstimateMbps'),
                    'sendEstimateMbps': conn.get('sendEstimateMbps'),
                    'totalBps': conn.get('totalBps', 0),
                })

        stats_data = {
            'monthDownloaded': month_down,
            'monthUploaded': month_up,
            'maxDownloadMbps': max_down_mbps,
            'maxUploadMbps': max_up_mbps,
            'downloadBps': download_bps,
            'uploadBps': upload_bps,
            'connections': connections,
            'adapters': adapters
        }
        
        return jsonify({
            'success': True,
            'data': stats_data
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


def _fetch_sessions(since):
    """Sessions overlapping [since, now], plus the one before (to know why
    the window may start inside an outage). Ordered by start time."""
    conn = sqlite3.connect(SPEEDIFY_DB_URI, uri=True, timeout=3)
    try:
        return conn.execute(
            """
            SELECT session_start, session_end, session_length,
                   disconnect_reason, server, bytes_recv, bytes_sent
            FROM sessions
            WHERE session_start >= COALESCE(
                (SELECT MAX(session_start) FROM sessions WHERE session_start < ?), 0)
            ORDER BY session_start
            """,
            (since,),
        ).fetchall()
    finally:
        conn.close()


@app.route('/api/history')
def get_history():
    """Tunnel up/down timeline from Speedify's session DB.

    While the tunnel is down every LAN client is offline, so the gaps
    between sessions are the household's outages. Each gap is attributed
    to the disconnect reason of the session that ended it.
    """
    try:
        try:
            hours = int(request.args.get('hours', 24))
        except ValueError:
            hours = 24
        hours = max(1, min(hours, 24 * 31))

        now = int(time.time())
        since = now - hours * 3600
        rows = _fetch_sessions(since)

        try:
            state = speedify.show_state()
            connected = getattr(state, 'name', '') == 'CONNECTED'
        except Exception:
            connected = False

        try:
            last_reason = speedify._run_speedify_cmd(['show', 'disconnect']).get('disconnectReason')
        except Exception:
            last_reason = None

        sessions = []
        for i, (start, end, length, reason, server, b_in, b_out) in enumerate(rows):
            end = end or (start + (length or 0))
            is_last = i == len(rows) - 1
            # The row of the running session has no reason yet and is only
            # refreshed about once a minute; treat it as live up to now.
            ongoing = is_last and connected and reason is None
            if ongoing:
                end = now
            sessions.append({
                'start': start, 'end': max(end, start),
                'reason': None if ongoing else (reason or 'UNKNOWN'),
                'server': server or '', 'bytesRecv': b_in or 0, 'bytesSent': b_out or 0,
                'ongoing': ongoing,
            })

        # Build up/down segments clipped to the window
        segments = []

        def add(seg_type, start, end, **extra):
            start, end = max(start, since), min(end, now)
            if end > start:
                segments.append({'type': seg_type, 'start': start, 'end': end, **extra})

        for i, s in enumerate(sessions):
            add('up', s['start'], s['end'], server=s['server'], endReason=s['reason'],
                ongoing=s['ongoing'], bytesRecv=s['bytesRecv'], bytesSent=s['bytesSent'],
                sessionStart=s['start'])
            if s['ongoing']:
                continue
            next_start = sessions[i + 1]['start'] if i + 1 < len(sessions) else now
            add('down', s['end'], next_start, cause=s['reason'], server=s['server'],
                ongoing=i + 1 == len(sessions))
        if not sessions:
            add('down', since, now, cause=last_reason or 'UNKNOWN', server='', ongoing=True)

        up = sum(g['end'] - g['start'] for g in segments if g['type'] == 'up')
        down = sum(g['end'] - g['start'] for g in segments if g['type'] == 'down')
        outages = [g for g in segments if g['type'] == 'down']
        cuts = {}
        for s in sessions:
            if s['reason'] and since <= s['end'] <= now:
                cuts[s['reason']] = cuts.get(s['reason'], 0) + 1
        longest = max(outages, key=lambda g: g['end'] - g['start'], default=None)

        return jsonify({
            'success': True,
            'data': {
                'since': since,
                'now': now,
                'hours': hours,
                'connected': connected,
                'lastDisconnectReason': last_reason,
                'segments': segments,
                'summary': {
                    'upSeconds': up,
                    'downSeconds': down,
                    'availability': (up / (up + down)) if (up + down) else None,
                    'outageCount': sum(1 for g in outages if g['end'] - g['start'] >= 60),
                    'cuts': cuts,
                    'longestOutage': longest,
                },
            }
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


def _day_key(day):
    """Speedify's intf_netw_stats.day encoding: (year-1900)*10000 + month*100
    + day, e.g. 2026-11-22 -> 1261122 (local time)."""
    return (day.year - 1900) * 10000 + day.month * 100 + day.day


def _daily_usage(since_day):
    """{adapterID: {day_key: bytes}} from Speedify's per-interface daily
    usage. interface.guid holds the adapterID (interface.name is NULL)."""
    conn = sqlite3.connect(SPEEDIFY_DB_URI, uri=True, timeout=3)
    try:
        rows = conn.execute(
            """
            SELECT i.guid, s.day, SUM(s.usage)
            FROM intf_netw_stats s JOIN interface i ON i.id = s.interface_id
            WHERE s.day >= ?
            GROUP BY i.guid, s.day
            """,
            (_day_key(since_day),),
        ).fetchall()
    finally:
        conn.close()
    usage = {}
    for guid, day, total in rows:
        usage.setdefault(guid, {})[day] = total or 0
    return usage


@app.route('/api/usage')
def get_usage():
    """Per-adapter data budgets: usage vs Speedify's daily / monthly caps,
    what happens over the cap, and daily usage history.

    Caps are Speedify's own (`adapter datalimit ...`). Monthly reset day 0
    means a rolling 30-day window. Over a cap, Speedify throttles the
    adapter to overlimitRatelimit (bits/s), or stops using it if that is 0.
    """
    try:
        try:
            days = int(request.args.get('days', 30))
        except ValueError:
            days = 30
        days = max(7, min(days, 90))

        today = datetime.date.today()
        day_list = [today - datetime.timedelta(days=i) for i in range(days - 1, -1, -1)]
        history_db = _daily_usage(day_list[0])

        adapters = speedify.show_adapters()
        if isinstance(adapters, dict):
            adapters = adapters.get('adapters', [])

        result = []
        for a in adapters or []:
            adapter_id = a.get('adapterID') or a.get('name') or ''
            du = a.get('dataUsage') or {}
            used_today = du.get('usageDaily') or 0
            daily_limit = du.get('usageDailyLimit') or 0
            daily_boost = du.get('usageDailyBoost') or 0
            daily_cap = daily_limit + daily_boost if daily_limit else 0
            used_month = du.get('usageMonthly') or 0
            monthly_cap = du.get('usageMonthlyLimit') or 0
            reset_day = du.get('usageMonthlyResetDay') or 0

            per_day = history_db.get(adapter_id, {})
            history = []
            for day in day_list:
                used = per_day.get(_day_key(day), 0)
                if day == today:
                    # the DB row lags the live counter a little
                    used = max(used, used_today)
                history.append({'date': day.isoformat(), 'bytes': used})

            # Average over the last 7 complete days (today is partial)
            last7 = [h['bytes'] for h in history[-8:-1]]
            avg7 = sum(last7) / len(last7) if last7 else 0

            next_reset = None
            if reset_day:
                year, month = today.year, today.month
                if today.day >= reset_day:
                    month += 1
                    if month > 12:
                        year, month = year + 1, 1
                # clamp to the month's length (e.g. reset day 31 in Feb)
                last = (datetime.date(year + (month == 12), month % 12 + 1, 1)
                        - datetime.timedelta(days=1)).day
                next_reset = datetime.date(year, month, min(reset_day, last)).isoformat()

            result.append({
                'id': adapter_id,
                'name': a.get('description') or adapter_id,
                'isp': a.get('isp') or '',
                'type': a.get('type') or '',
                'state': a.get('state') or '',
                'priority': a.get('workingPriority') or a.get('priority') or '',
                'daily': {'used': used_today, 'cap': daily_cap, 'boost': daily_boost},
                'monthly': {'used': used_month, 'cap': monthly_cap,
                            'resetDay': reset_day, 'nextReset': next_reset},
                'overDaily': bool(daily_cap) and used_today >= daily_cap,
                'overMonthly': bool(monthly_cap) and used_month >= monthly_cap,
                'overLimitRateBps': du.get('overlimitRatelimit') or 0,
                'avg7': avg7,
                'history': history,
            })

        return jsonify({
            'success': True,
            'data': {'days': days, 'today': today.isoformat(), 'adapters': result}
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.errorhandler(403)
def forbidden(e):
    """Handle forbidden access"""
    return jsonify({
        'success': False,
        'error': str(e.description)
    }), 403


@app.errorhandler(404)
def not_found(e):
    """Handle not found errors"""
    return jsonify({
        'success': False,
        'error': 'Endpoint not found'
    }), 404


if __name__ == '__main__':
    import sys
    
    # Enable debug mode if --dev flag is passed
    debug_mode = '--dev' in sys.argv
    
    print(f"🚀 Starting Speedify Dashboard on port {PORT}")
    print(f"🔒 Access restricted to {ALLOWED_NETWORKS_LABEL} (+ loopback)")
    print(f"📡 Dashboard available at http://pi3.local:{PORT}")
    
    if debug_mode:
        print("🔧 Development mode: Auto-reload enabled")
    
    app.run(
        host='0.0.0.0',
        port=PORT,
        debug=debug_mode,
        use_reloader=debug_mode,
        threaded=True
    )

