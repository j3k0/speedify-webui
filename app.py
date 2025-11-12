#!/usr/bin/env python3
"""
Speedify Web Dashboard
A Flask-based web interface for monitoring and controlling Speedify
"""

from flask import Flask, render_template, jsonify, request, abort
from functools import wraps
import ipaddress
import speedify
import traceback

app = Flask(__name__)

# Configuration
PORT = 20333
ALLOWED_NETWORK = ipaddress.ip_network('192.168.0.0/16')


def require_local_network(f):
    """Decorator to restrict access to local network (192.168.0.0/16)"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        client_ip = request.remote_addr
        
        try:
            # Check if the client IP is in the allowed network
            if ipaddress.ip_address(client_ip) not in ALLOWED_NETWORK:
                abort(403, description="Access denied: Only accessible from 192.168.0.0/16")
        except ValueError:
            # Invalid IP address format
            abort(403, description="Access denied: Invalid IP address")
        
        return f(*args, **kwargs)
    return decorated_function


# Apply middleware to all routes
@app.before_request
def check_ip():
    """Check IP address before processing any request"""
    client_ip = request.remote_addr
    
    try:
        if ipaddress.ip_address(client_ip) not in ALLOWED_NETWORK:
            abort(403, description="Access denied: Only accessible from 192.168.0.0/16")
    except ValueError:
        abort(403, description="Access denied: Invalid IP address")


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
        status_data = {
            'state': state.name if hasattr(state, 'name') else str(state),
            'connected': state.name in ['CONNECTED', 'ENABLED'] if hasattr(state, 'name') else False,
            'country': current_server.get('country', '') if isinstance(current_server, dict) else '',
            'city': current_server.get('city', '') if isinstance(current_server, dict) else '',
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
    """Change Speedify server/country"""
    try:
        data = request.get_json()
        
        if not data or 'country' not in data:
            return jsonify({
                'success': False,
                'error': 'Country code is required'
            }), 400
        
        country = data['country'].lower()  # Speedify expects lowercase country codes
        
        # Change server using speedify API - connect_country expects just the country code
        result = speedify.connect_country(country)
        
        return jsonify({
            'success': True,
            'message': f'Server changed to {country.upper()}',
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
        
        # Calculate total usage from all adapters
        total_monthly = 0
        total_daily = 0
        
        for adapter in adapters:
            if 'dataUsage' in adapter:
                total_monthly += adapter['dataUsage'].get('usageMonthly', 0)
                total_daily += adapter['dataUsage'].get('usageDaily', 0)
        
        # Calculate real-time bandwidth from connection stats
        download_bps = 0
        upload_bps = 0
        
        if connection_stats and 'connections' in connection_stats:
            for conn in connection_stats['connections']:
                # Skip proxy connections as they don't represent real bandwidth
                if conn.get('protocol') != 'proxy':
                    download_bps += conn.get('receiveBps', 0)
                    upload_bps += conn.get('sendBps', 0)
        
        stats_data = {
            'totalMonthly': total_monthly,
            'totalDaily': total_daily,
            'downloadBps': download_bps,
            'uploadBps': upload_bps,
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
    print(f"🔒 Access restricted to 192.168.0.0/16")
    print(f"📡 Dashboard available at http://192.168.x.x:{PORT}")
    
    if debug_mode:
        print("🔧 Development mode: Auto-reload enabled")
    
    app.run(
        host='0.0.0.0',
        port=PORT,
        debug=debug_mode,
        use_reloader=debug_mode,
        threaded=True
    )

