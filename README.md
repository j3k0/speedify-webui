# Speedify Web Dashboard

A modern, web-based dashboard for monitoring and controlling Speedify connections. Built with Flask and Tailwind CSS, this dashboard provides a clean interface for managing your Speedify VPN service.

## Features

- **Real-time Monitoring**: Live connection status, speeds, and data usage
- **Connection History**: 24 h / 7 d / 30 d up/down timeline built from Speedify's own session DB — every outage with its duration and plain-English cause (torrent cut, restart, lost connection…), availability %, longest outage
- **Data Budgets**: per uplink, usage today and over 30 days against Speedify's caps, over-cap behaviour (throttle rate), 30-day daily chart and pace
- **Devices**: per-device internet connections from pi3's conntrack table (the Deco is an access point, so each device has its own IP), with a torrent-like detector; when Speedify cuts the tunnel for TORRENT, the most active devices just before are saved and shown on that outage
- **Connection Control**: Connect, disconnect, and change servers with one click
- **Network Adapters**: View all network adapters and their status
- **Server Selection**: Pick a specific server, the best one in a country, or the closest torrent-safe (P2P-allowed) server; the status card flags servers that ban P2P
- **Works offline**: CSS is prebuilt and served locally, so the page still renders when the tunnel (and the internet) is down
- **Bypass Management**: Add and remove domain bypasses for streaming
- **Port Bypass**: Configure specific ports to bypass Speedify VPN
- **Auto-refresh**: Configurable auto-refresh interval (default: 3 seconds)
- **Modern UI**: Responsive design with Tailwind CSS
- **Network Security**: Restricted to the router's LAN subnets (192.168.145.0/24, 192.168.146.0/24) + loopback; anti-CSRF header on all state-changing requests

## Requirements

- Python 3.7 or higher
- Speedify installed and running on the system
- Access from one of the allowed LAN subnets (see Network Access)

## Installation

### 1. Create Virtual Environment

It's recommended to use a virtual environment to keep dependencies isolated:

```bash
cd /home/jeko/speedify-webui
python3 -m venv venv
```

### 2. Activate Virtual Environment

```bash
source venv/bin/activate
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

## Usage

### Starting the Dashboard

1. Make sure Speedify is installed and running on your system
2. Activate the virtual environment (if not already activated):

```bash
source venv/bin/activate
```

3. Run the Flask application:

```bash
python app.py
```

Or make it executable and run directly:

```bash
chmod +x app.py
./app.py
```

4. Access the dashboard from any device on your local network:

```
http://192.168.x.x:20333
```

Replace `192.168.x.x` with the IP address of the machine running the dashboard.

### Stopping the Dashboard

Press `Ctrl+C` in the terminal where the application is running.

## Configuration

### Port

The dashboard runs on port **20333** by default. To change this, edit the `PORT` variable in `app.py`:

```python
PORT = 20333  # Change to your preferred port
```

### Network Access

By default, the dashboard only accepts connections from `192.168.145.0/24`, `192.168.146.0/24` (pi3's LAN subnets) and loopback (SSH tunnels). It deliberately does **not** allow all of `192.168.0.0/16`: that would include the upstream Archer C5 network on pi3's WAN side. Override with an environment variable (comma-separated CIDRs) in the systemd unit:

```ini
Environment="WEBUI_ALLOWED_NETWORKS=192.168.145.0/24,192.168.146.0/24,127.0.0.0/8,::1/128"
```

### Per-device view (needs router support)

The Devices section reads `sudo -n /usr/local/bin/lan-flows`, a root wrapper around `conntrack -L` installed together with a no-arguments sudo rule and the byte-counter sysctl by `~/Documents/pi3-router/scripts/deploy.sh`. Without it the section shows an error instead of data; everything else keeps working. A background thread samples every 30 s (15 min kept in memory); runtime data lives in `data/` (gitignored): `incidents.db` (suspects saved at each TORRENT cut) and `device-labels.json` (names, keyed by MAC).

**Detector:** "P2P-like peers" = distinct remote hosts reached on non-standard ports (>= 1024 and not a known service); Tailscale/WireGuard are excluded by local port. Torrent-like: >= 30 such peers, or >= 12 plus connections on BitTorrent ports. Thresholds are in `lanflows.py`. Run the tests with `python3 -m unittest discover -s tests`.

### Styling (Tailwind)

Tailwind is prebuilt into `static/css/tailwind.css` (committed) instead of loading the Play CDN, so the dashboard keeps its styling when the internet is down. After adding or changing Tailwind classes in `templates/` or `static/js/`, rebuild on a machine with Node and commit the result:

```bash
./scripts/build-css.sh
```

### Auto-refresh Interval

The default auto-refresh interval is 3 seconds. You can change this in the dashboard UI using the "Interval (s)" input field, or modify the default in `static/js/dashboard.js`:

```javascript
let refreshInterval = 3000; // milliseconds
```

## Dashboard Sections

### Connection Status
- Shows current connection state (Connected/Disconnected)
- Displays current server location
- Shows your public IP address

### Quick Actions
- **Connect/Disconnect**: Control your Speedify connection
- **Server Selection**: Choose a server by country

### Statistics
- **Download Speed**: Current download speed in MB/s
- **Upload Speed**: Current upload speed in MB/s
- **Data Downloaded**: Total data downloaded
- **Data Uploaded**: Total data uploaded

### Network Adapters
- View all available network adapters
- Monitor adapter states, types, and priorities
- Track data usage per adapter

### Domain Bypasses
- Add domains to bypass Speedify (useful for streaming services)
- View and manage all active bypasses
- Remove bypasses with one click

### Port Bypasses
- Configure specific ports to bypass the VPN (use direct connection)
- Add ports individually with port validation (1-65535)
- View all active port bypasses
- Remove port bypasses with one click

## API Endpoints

The dashboard exposes several REST API endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Dashboard UI |
| GET | `/api/status` | Connection status |
| GET | `/api/adapters` | Network adapters |
| GET | `/api/servers` | Available servers |
| GET | `/api/stats` | Connection statistics |
| GET | `/api/usage?days=30` | Per-adapter data usage vs caps + daily history |
| GET | `/api/devices` | Per-device traffic (latest sample) + saved TORRENT-kick snapshots |
| GET | `/api/history?hours=24` | Up/down segments, outages and disconnect reasons (1–744 h) from Speedify's session DB |
| GET | `/api/bypasses` | Domain bypasses list |
| GET | `/api/port-bypasses` | Port bypasses list |
| POST | `/api/devices/label` | Name a device: JSON `{"mac": "aa:bb:..", "label": "..."}` (empty label removes it) |
| POST | `/api/connect` | Connect to Speedify |
| POST | `/api/disconnect` | Disconnect from Speedify |
| POST | `/api/server` | Change server: JSON `{"target": "p2p" \| "closest" \| "<country code>" \| "<server tag>"}` |
| POST | `/api/bypasses` | Add bypass (requires `domain` in JSON body) |
| POST | `/api/port-bypasses` | Add port bypass (requires `port` in JSON body) |
| DELETE | `/api/bypasses/<domain>` | Remove bypass |
| DELETE | `/api/port-bypasses/<port>` | Remove port bypass |

## Security

- **IP Restriction**: Access is restricted to `192.168.145.0/24`, `192.168.146.0/24` and loopback
- **CSRF protection**: POST/DELETE requests must carry `X-Requested-With: speedify-webui` (the dashboard's JS adds it). Browsers can't send that header cross-origin without a CORS preflight, so a web page opened on a LAN device can't trigger actions
- **No Authentication**: Since access is limited to the local network, no additional authentication is implemented
- **Isolated Dependencies**: Uses a virtual environment to avoid conflicts with system packages

## Troubleshooting

### Dashboard won't start
- Ensure Python 3.7+ is installed: `python3 --version`
- Check if port 20333 is already in use: `sudo netstat -tlnp | grep 20333`
- Verify all dependencies are installed: `pip list`

### Can't access from other devices
- Verify the server machine's IP address: `ip addr` or `hostname -I`
- Ensure firewall allows connections on port 20333
- Confirm you're accessing from an allowed subnet (192.168.145.0/24 or 192.168.146.0/24)

### Speedify API errors
- Ensure Speedify is installed and running: `speedify show state`
- Check Speedify service status
- Verify you have permissions to control Speedify

### Stats not updating
- Check the browser console for JavaScript errors (F12)
- Verify auto-refresh is enabled in the dashboard
- Ensure the backend is responding: check terminal for errors

## Running as a Service (Optional)

To run the dashboard automatically on system startup, you can create a systemd service:

1. Create service file:

```bash
sudo nano /etc/systemd/system/speedify-dashboard.service
```

2. Add the following content (adjust paths as needed):

```ini
[Unit]
Description=Speedify Web Dashboard
After=network.target

[Service]
Type=simple
User=jeko
WorkingDirectory=/home/jeko/speedify-webui
Environment="PATH=/home/jeko/speedify-webui/venv/bin"
ExecStart=/home/jeko/speedify-webui/venv/bin/python /home/jeko/speedify-webui/app.py
Restart=always

[Install]
WantedBy=multi-user.target
```

3. Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable speedify-dashboard
sudo systemctl start speedify-dashboard
```

4. Check status:

```bash
sudo systemctl status speedify-dashboard
```

## Technology Stack

- **Backend**: Flask (Python web framework)
- **Frontend**: HTML5, Tailwind CSS, Vanilla JavaScript
- **API**: speedify-py (Python wrapper for Speedify CLI)
- **HTTP Server**: Werkzeug (Flask's built-in server)

## Project Structure

```
speedify-webui/
├── app.py                    # Flask application and API endpoints
├── requirements.txt          # Python dependencies
├── templates/
│   └── dashboard.html        # Main dashboard UI
├── static/
│   ├── css/
│   │   └── custom.css       # Custom styles
│   └── js/
│       └── dashboard.js      # Frontend JavaScript
└── README.md                 # This file
```

## Development

### Adding New Features

1. **Backend**: Add new endpoints in `app.py`
2. **Frontend**: Update `dashboard.html` and `dashboard.js`
3. **Styling**: Modify `custom.css` or use Tailwind utility classes

### Debug Mode

To enable Flask debug mode (for development only), modify `app.py`:

```python
app.run(
    host='0.0.0.0',
    port=PORT,
    debug=True,  # Enable debug mode
    threaded=True
)
```

**Warning**: Never use debug mode in production!

## License

This project is provided as-is for personal use.

## Support

For issues with:
- **Speedify**: Contact Speedify support
- **Dashboard**: Check the troubleshooting section above

---

**Note**: This dashboard is designed for production use on a local network. Do not expose it to the public internet without proper authentication and encryption.

