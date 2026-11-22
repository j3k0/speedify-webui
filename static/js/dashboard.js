/**
 * Speedify Dashboard JavaScript
 * Handles dynamic updates, API calls, and user interactions
 */

// Configuration
let autoRefresh = true;
let refreshInterval = 3000; // milliseconds
let refreshTimer = null;

// State
let isConnected = false;
let availableServers = [];
let speedHistory = [];            // last N total-throughput samples (Mbps)
let uploadHistory = [];           // last N upload samples (Mbps)
let connectionMap = {};           // adapterID -> per-connection quality stats
let messageTimer = null;
let currentServerTag = '';        // tag of the connected server (from /api/status)
let serversLoadedAt = 0;          // servers list changes rarely; refresh every 10 min
let historyHours = parseInt(localStorage.getItem('historyHours'), 10) || 24;
let historyData = null;           // last /api/history payload
let outagesExpanded = false;      // outage list: newest 5, or all ("show more")
const OUTAGES_COLLAPSED = 5;
let historyLoadedAt = 0;          // history is polled every 60 s, not every refresh
let usageLoadedAt = 0;            // data budgets: polled every 60 s
let devicesLoadedAt = 0;          // per-device traffic: server samples every 30 s
let devicesData = null;

const SERVERS_TTL_MS = 10 * 60 * 1000;
const HISTORY_TTL_MS = 60 * 1000;
const USAGE_TTL_MS = 60 * 1000;
const DEVICES_TTL_MS = 15 * 1000;

/**
 * fetch() wrapper that adds the anti-CSRF header the backend requires on
 * POST/DELETE (a cross-site page can't send custom headers without a CORS
 * preflight, which the backend never grants).
 */
function apiFetch(url, options = {}) {
    const headers = Object.assign({ 'X-Requested-With': 'speedify-webui' }, options.headers || {});
    return fetch(url, Object.assign({}, options, { headers }));
}

// Speed tracking state - no longer needed, keeping for compatibility
// Bandwidth is now calculated server-side from Speedify's real-time stats

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Speedify Dashboard initialized');
    
    // Setup event listeners
    setupEventListeners();
    
    // Load initial data
    loadAllData();
    
    // Start auto-refresh
    startAutoRefresh();
    
    // Handle page visibility to pause updates when tab is hidden
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log('🔕 Tab hidden - pausing auto-refresh');
            stopAutoRefresh();
        } else {
            console.log('🔔 Tab visible - resuming auto-refresh');
            // Refresh data immediately when tab becomes visible
            loadAllData();
            if (autoRefresh) {
                startAutoRefresh();
            }
        }
    });
});

/**
 * Setup all event listeners
 */
function setupEventListeners() {
    // Auto-refresh toggle
    const autoRefreshCheckbox = document.getElementById('autoRefresh');
    autoRefreshCheckbox.addEventListener('change', (e) => {
        autoRefresh = e.target.checked;
        if (autoRefresh) {
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    });
    
    // Refresh interval change (clamped to 1-60s)
    const intervalInput = document.getElementById('refreshInterval');
    intervalInput.addEventListener('change', (e) => {
        let seconds = parseInt(e.target.value, 10);
        if (isNaN(seconds) || seconds < 1) seconds = 3;
        seconds = Math.min(60, seconds);
        e.target.value = seconds;
        refreshInterval = seconds * 1000;
        if (autoRefresh) {
            stopAutoRefresh();
            startAutoRefresh();
        }
    });
    
    // Connect button
    document.getElementById('connectBtn').addEventListener('click', connectSpeedify);
    
    // Disconnect button
    document.getElementById('disconnectBtn').addEventListener('click', disconnectSpeedify);
    
    // Change server button
    document.getElementById('changeServerBtn').addEventListener('click', () => {
        const select = document.getElementById('serverSelect');
        const option = select.options[select.selectedIndex];
        changeServer(select.value, option ? option.dataset.label || option.textContent : '');
    });
    
    // One-click torrent-safe server (`speedify_cli connect p2p`)
    document.getElementById('p2pServerBtn').addEventListener('click', () => {
        changeServer('p2p', 'the closest torrent-safe server');
    });
    
    // Device naming (pencil button in the Devices table)
    document.getElementById('devicesTable').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mac]');
        if (btn) renameDevice(btn.dataset.mac, btn.dataset.name, btn.dataset.label);
    });
    
    // Outage list: "…show N more" / "Show less"
    document.getElementById('outageTable').addEventListener('click', (e) => {
        if (!e.target.closest('button[data-outages-toggle]')) return;
        outagesExpanded = !outagesExpanded;
        if (historyData) renderHistory(historyData);
    });
    
    // History range toggle (24 h / 7 d / 30 d)
    document.querySelectorAll('.history-range').forEach((btn) => {
        btn.addEventListener('click', () => {
            outagesExpanded = false;
            historyHours = parseInt(btn.dataset.hours, 10) || 24;
            localStorage.setItem('historyHours', String(historyHours));
            updateHistoryRangeButtons();
            loadHistory(true);
        });
    });
    updateHistoryRangeButtons();
    
    // Add bypass button
    document.getElementById('addBypassBtn').addEventListener('click', addBypass);
    
    // Bypass domain input - Enter key
    document.getElementById('bypassDomain').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            addBypass();
        }
    });
    
    // Add port bypass button
    document.getElementById('addPortBypassBtn').addEventListener('click', addPortBypass);
    
    // Port bypass input - Enter key
    document.getElementById('bypassPort').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            addPortBypass();
        }
    });
    
    // Copy public IP (with execCommand fallback — the page is plain HTTP,
    // where navigator.clipboard may be undefined)
    document.getElementById('copyIpBtn').addEventListener('click', async () => {
        const ip = document.getElementById('publicIp').textContent.trim();
        if (!ip || ip === '—') return;
        
        const btn = document.getElementById('copyIpBtn');
        const original = btn.textContent;
        let ok = false;
        
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(ip);
                ok = true;
            }
        } catch (error) {
            console.error('Clipboard API failed, trying fallback:', error);
        }
        
        if (!ok) {
            const ta = document.createElement('textarea');
            ta.value = ip;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                ok = document.execCommand('copy');
            } catch (error) {
                console.error('execCommand copy failed:', error);
            }
            document.body.removeChild(ta);
        }
        
        if (ok) {
            btn.textContent = '✓';
            btn.classList.add('text-green-400');
            setTimeout(() => {
                btn.textContent = original;
                btn.classList.remove('text-green-400');
            }, 1500);
        } else {
            showActionMessage('Could not copy IP', 'error');
        }
    });
    
    // Bypass chip removal (event delegation — avoids inline handlers with
    // user-provided strings)
    document.getElementById('bypassesList').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-domain]');
        if (btn) removeBypass(btn.dataset.domain);
    });
    
    document.getElementById('portBypassesList').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-port]');
        if (btn) removePortBypass(btn.dataset.port);
    });
}

/**
 * Start auto-refresh timer
 */
function startAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    
    refreshTimer = setInterval(() => {
        loadAllData();
    }, refreshInterval);
}

/**
 * Stop auto-refresh timer
 */
function stopAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

/**
 * Show when the data was last refreshed (or that a refresh failed)
 */
function updateLastUpdated(ok) {
    const el = document.getElementById('lastUpdated');
    if (!el) return;
    if (ok) {
        el.textContent = 'Updated ' + new Date().toLocaleTimeString();
        el.className = 'text-xs text-gray-500';
    } else {
        el.textContent = '⚠ Refresh failed — retrying…';
        el.className = 'text-xs text-red-400';
    }
}

/**
 * Load all dashboard data
 */
async function loadAllData() {
    const [statusOk] = await Promise.all([
        loadStatus(),
        loadAdapters(),
        loadServers(),     // self-throttled (SERVERS_TTL_MS)
        loadBypasses(),
        loadPortBypasses(),
        loadStats(),
        loadHistory(),     // self-throttled (HISTORY_TTL_MS)
        loadUsage(),       // self-throttled (USAGE_TTL_MS)
        loadDevices()      // self-throttled (DEVICES_TTL_MS)
    ]);
    updateLastUpdated(!!statusOk);
}

/**
 * Load connection status
 */
async function loadStatus() {
    try {
        const response = await fetch('/api/status');
        const result = await response.json();
        
        if (result.success && result.data) {
            const state = result.data;
            
            // Update connection state - check both 'connected' field and state string
            isConnected = state.connected || state.state === 'CONNECTED' || state.state === 'ENABLED';
            
            // Update status badge (pill + pulsing dot)
            const badge = document.getElementById('statusBadge');
            const indicator = document.getElementById('statusIndicator');
            const statusText = document.getElementById('statusText');
            
            const baseBadge = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-full border font-semibold';
            if (isConnected) {
                badge.className = baseBadge + ' bg-green-500/10 border-green-500/30 text-green-400';
                indicator.className = 'w-2 h-2 rounded-full bg-green-500 animate-pulse';
                statusText.textContent = 'Connected';
            } else {
                badge.className = baseBadge + ' bg-red-500/10 border-red-500/30 text-red-400';
                indicator.className = 'w-2 h-2 rounded-full bg-red-500';
                statusText.textContent = 'Disconnected';
            }
            
            // Encryption badge
            const encryptionBadge = document.getElementById('encryptionBadge');
            if (state.encrypted) {
                encryptionBadge.classList.remove('hidden');
                encryptionBadge.classList.add('inline-flex');
            } else {
                encryptionBadge.classList.add('hidden');
                encryptionBadge.classList.remove('inline-flex');
            }
            
            // Update current server
            const serverElement = document.getElementById('currentServer');
            const previousTag = currentServerTag;
            currentServerTag = state.serverTag || '';
            if (state.serverName) {
                serverElement.textContent = state.serverName;
                serverElement.title = state.serverTag || '';
            } else if (state.city && state.country) {
                serverElement.textContent = `${state.city}, ${state.country.toUpperCase()}`;
            } else if (state.country) {
                serverElement.textContent = state.country.toUpperCase();
            } else {
                serverElement.textContent = '—';
            }
            updateP2pBadge(state.torrentAllowed);
            if (previousTag !== currentServerTag) {
                renderServerSelect();   // move the "current" marker
            }
            updateSessionInfo();
            
            // Update public IP
            const ipElement = document.getElementById('publicIp');
            ipElement.textContent = state.publicIp || '—';
            
            // Update bonding mode
            const bondingModeElement = document.getElementById('bondingMode');
            if (bondingModeElement && state.bondingMode) {
                bondingModeElement.textContent = state.bondingMode.charAt(0).toUpperCase() + state.bondingMode.slice(1);
            }
            
            // Update button states
            updateButtonStates();
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error loading status:', error);
        showActionMessage('Error loading status', 'error');
        return false;
    }
}

/**
 * Load network adapters
 */
async function loadAdapters() {
    try {
        const response = await fetch('/api/adapters');
        const result = await response.json();
        
        if (result.success && result.data) {
            const adapters = result.data.adapters || result.data;
            const tbody = document.getElementById('adaptersTable');
            
            if (!adapters || adapters.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="py-4 text-gray-500 text-center">No adapters found</td></tr>';
                return;
            }
            
            tbody.innerHTML = adapters.map(adapter => {
        // Get data usage from the adapter's dataUsage object
        const usageDaily = adapter.dataUsage?.usageDaily || 0;
        const usageMonthly = adapter.dataUsage?.usageMonthly || 0;
        const adapterId = adapter.adapterID || adapter.name || 'Unknown';
        
        return `
        <tr class="border-b border-gray-700">
            <td class="py-3 font-mono text-sm">${escapeHtml(adapterId)}</td>
            <td class="py-3">
                <span class="px-2 py-1 bg-gray-700 rounded text-sm">
                    ${escapeHtml(adapter.type || adapter.connectionType || 'Unknown')}
                </span>
            </td>
            <td class="py-3">
                ${getAdapterStateHtml(adapter.state || adapter.adapterState)}
            </td>
            <td class="py-3">
                <span class="font-medium">${adapter.priority || adapter.priorityBonus || '-'}</span>
            </td>
            <td class="py-3 text-sm text-gray-300 tabular-nums" id="lat-${escapeHtml(adapterId)}">—</td>
            <td class="py-3" id="thr-${escapeHtml(adapterId)}">
                <div class="flex items-center gap-2">
                    <div class="flex-1 min-w-[70px]">${barHtml(0, 0, 'bg-gray-600')}</div>
                    <span class="text-sm tabular-nums text-gray-500">idle</span>
                </div>
            </td>
            <td class="py-3">
                <div class="text-sm tabular-nums">
                    <div class="text-gray-400">Daily: ${formatBytes(usageDaily)}</div>
                    <div class="text-gray-500">Month: ${formatBytes(usageMonthly)}</div>
                </div>
            </td>
        </tr>
        `;
        }).join('');
        
        // Fill in latency/loss from the (possibly already loaded) connection stats
        updateAdapterLatency();
        }
    } catch (error) {
        console.error('Error loading adapters:', error);
    }
}

/**
 * Update the Latency and Throughput columns of the adapters table from
 * the merged connection stats. Latency gets a quality colour (green/
 * amber/red) and shows receive packet loss; throughput gets an animated
 * bar (busy = green, low = amber, idle = gray) sized against the busiest
 * connection, plus ↓/↑ estimate Mbps when Speedify reports them.
 */
function updateAdapterLatency() {
    let maxTotalBps = 0;
    for (const conn of Object.values(connectionMap)) {
        maxTotalBps = Math.max(maxTotalBps, conn.totalBps || 0);
    }

    for (const [adapterId, conn] of Object.entries(connectionMap)) {
        const latCell = document.getElementById('lat-' + adapterId);
        const thrCell = document.getElementById('thr-' + adapterId);
        if (!latCell || !thrCell) continue;

        // --- Latency / loss ---
        let latHtml = '<span class="text-gray-500">—</span>';
        if (conn.latencyMs > 0) {
            const latency = Math.round(conn.latencyMs);
            const loss = (conn.lossReceive || 0) * 100;
            const jitter = conn.jitterMs && conn.jitterMs > 0
                ? ` <span class="text-gray-500">±${Math.round(conn.jitterMs)}</span>` : '';
            const color = latency < 80 ? 'text-green-400'
                       : latency < 200 ? 'text-yellow-400' : 'text-red-400';
            const lossFmt = loss < 0.1 ? loss.toFixed(2) : loss.toFixed(1);
            latHtml = `<span class="${color} font-medium">${latency} ms${jitter}</span>`;
            if (loss > 0) {
                latHtml += ` <span class="text-gray-500">· ${lossFmt}% ↓loss</span>`;
            }
        }
        latCell.innerHTML = latHtml;

        // --- Throughput bar ---
        const totalBps = conn.totalBps || 0;
        const frac = maxTotalBps > 0 ? totalBps / maxTotalBps : 0;
        const cls = totalBps === 0 ? 'bg-gray-600'
                  : frac < 0.35 ? 'bg-yellow-500' : 'bg-green-500';
        thrCell.innerHTML =
            `<div class="flex items-center gap-2">
                <div class="flex-1 min-w-[70px]">${barHtml(totalBps, maxTotalBps, cls)}</div>
                <span class="thr-val text-sm tabular-nums ${totalBps === 0 ? 'text-gray-500' : 'text-gray-200'}">${formatMbps(totalBps)}</span>
            </div>`;

        const down = conn.receiveEstimateMbps;
        const up = conn.sendEstimateMbps;
        if ((down && down > 0) || (up && up > 0)) {
            const note = `↓ ${Number(down || 0).toFixed(1)} · ↑ ${Number(up || 0).toFixed(1)} Mbps`; 
            let val = thrCell.querySelector('.thr-val');
            val.insertAdjacentHTML('beforeend',
                `<div class="thr-note text-[10px] text-gray-500 tabular-nums">${note}</div>`);
        }
    }
}

/**
 * Build a small progress bar (width 0-100% vs the busiest line)
 */
function barHtml(value, max, colorClass) {
    const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 4;
    return `<div class="thr-track"><div class="thr-fill ${colorClass}" style="width: ${pct}%"></div></div>`;
}

/**
 * Convert bytes/second to a human-readable Mbps string
 */
function formatMbps(bps) {
    return (((bps || 0) * 8) / 1000000).toFixed(1) + ' Mbps';
}

/**
 * Get HTML for adapter state badge
 */
function getAdapterStateHtml(state) {
    const stateMap = {
        'connected': 'pill-green',
        'disconnected': 'pill-red',
        'connecting': 'pill-yellow',
        'enabled': 'pill-green',
        'disabled': 'pill-gray'
    };
    
    const cls = stateMap[state] || 'pill-gray';
    const label = state ? (state.charAt(0).toUpperCase() + state.slice(1)) : 'Unknown';
    return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

/**
 * Load available servers
 */
async function loadServers(force) {
    // `speedify_cli show servers` is slow on a Pi 3 and rarely changes
    if (!force && Date.now() - serversLoadedAt < SERVERS_TTL_MS) return;
    serversLoadedAt = Date.now();
    try {
        const response = await fetch('/api/servers');
        const result = await response.json();
        
        if (result.success && result.data) {
            // Handle server data structure: { private: [], public: [] }
            const serverData = result.data;
            availableServers = [...(serverData.public || []), ...(serverData.private || [])];
            renderServerSelect();
        } else {
            serversLoadedAt = 0;   // retry on next refresh
        }
    } catch (error) {
        serversLoadedAt = 0;
        console.error('Error loading servers:', error);
    }
}

/**
 * Country display name from a server's friendlyName ("Belgium - Oostkamp #3")
 */
function serverCountryName(server) {
    const name = String(server.friendlyName || '');
    return name.includes(' - ') ? name.split(' - ')[0] : String(server.country || '').toUpperCase();
}

/**
 * Server label without the country prefix ("Oostkamp #3")
 */
function serverShortName(server) {
    const name = String(server.friendlyName || server.tag || '');
    return name.includes(' - ') ? name.split(' - ').slice(1).join(' - ') : name;
}

/**
 * Fill the server picker:
 *   1. torrent-safe servers (P2P allowed) + "closest torrent-safe"
 *   2. "any server in <country>" (Speedify picks the best one)
 *   3. every individual server, grouped by country
 * Option values are what `speedify_cli connect` accepts: p2p, a country
 * code, or a server tag.
 */
function renderServerSelect() {
    const select = document.getElementById('serverSelect');
    if (!select || availableServers.length === 0) return;
    const previous = select.value;

    const opt = (value, label, extra = '') =>
        `<option value="${escapeHtml(value)}" data-label="${escapeHtml(label)}">${escapeHtml(label)}${extra}</option>`;
    const current = (tag) => (tag && tag === currentServerTag ? ' ← current' : '');

    const p2p = availableServers
        .filter((s) => s.torrentAllowed)
        .sort((a, b) => String(a.friendlyName).localeCompare(String(b.friendlyName), undefined, { numeric: true }));

    const byCountry = {};
    for (const s of availableServers) {
        const cc = String(s.country || '').toLowerCase();
        if (!cc) continue;
        (byCountry[cc] = byCountry[cc] || { name: serverCountryName(s), servers: [] }).servers.push(s);
    }
    const countries = Object.keys(byCountry).sort((a, b) => byCountry[a].name.localeCompare(byCountry[b].name));

    let html = '<option value="">Select server…</option>';
    html += '<optgroup label="Torrent-safe (P2P allowed)">';
    html += opt('p2p', 'Closest torrent-safe server');
    html += p2p.map((s) => opt(s.tag, s.friendlyName || s.tag, current(s.tag))).join('');
    html += '</optgroup>';

    html += '<optgroup label="Best server in a country">';
    html += countries.map((cc) => {
        const c = byCountry[cc];
        const nP2p = c.servers.filter((s) => s.torrentAllowed).length;
        const note = ` (${c.servers.length}${nP2p ? `, ${nP2p} P2P` : ''})`;
        return opt(cc, c.name, note);
    }).join('');
    html += '</optgroup>';

    for (const cc of countries) {
        const c = byCountry[cc];
        const servers = c.servers.slice().sort((a, b) =>
            serverShortName(a).localeCompare(serverShortName(b), undefined, { numeric: true }));
        html += `<optgroup label="${escapeHtml(c.name)}">`;
        html += servers.map((s) =>
            opt(s.tag, s.friendlyName || s.tag, (s.torrentAllowed ? ' · P2P' : '') + current(s.tag))).join('');
        html += '</optgroup>';
    }

    select.innerHTML = html;
    if (previous && [...select.options].some((o) => o.value === previous)) {
        select.value = previous;
    }

    const countEl = document.getElementById('p2pServerCount');
    if (countEl) {
        const p2pCountries = [...new Set(p2p.map((s) => String(s.country || '').toUpperCase()))];
        countEl.textContent = p2p.length
            ? `${p2p.length} of ${availableServers.length} servers, in ${p2pCountries.join(', ')}`
            : 'none available right now';
    }
}

/**
 * P2P badge next to the server name in the status card
 */
function updateP2pBadge(torrentAllowed) {
    const badge = document.getElementById('p2pBadge');
    if (!badge) return;
    if (torrentAllowed === true) {
        badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 border border-emerald-500/30 text-emerald-300';
        badge.textContent = 'P2P OK';
        badge.title = 'This server allows torrents: P2P traffic will not cut the tunnel.';
    } else if (torrentAllowed === false) {
        badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 border border-amber-500/30 text-amber-300';
        badge.textContent = 'No P2P';
        badge.title = 'This server bans P2P: if any device torrents, the server cuts the tunnel for the whole house (reason TORRENT).';
    } else {
        badge.className = 'hidden';
        badge.textContent = '';
    }
}

/**
 * Load bypasses
 */
async function loadBypasses() {
    try {
        const response = await fetch('/api/bypasses');
        const result = await response.json();
        
        if (result.success) {
            const bypasses = result.data.domains || result.data || [];
            const container = document.getElementById('bypassesList');
            const count = document.getElementById('bypassCount');
            if (count) count.textContent = String(bypasses.length);
            
            if (bypasses.length === 0) {
                container.innerHTML = '<span class="text-gray-500 text-sm">No bypasses configured</span>';
                return;
            }
            
            container.innerHTML = bypasses.map(domain => `
                <span class="chip">
                    ${escapeHtml(domain)}
                    <button data-domain="${escapeHtml(domain)}" title="Remove ${escapeHtml(domain)}"
                            class="chip-x">✕</button>
                </span>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading bypasses:', error);
    }
}

/**
 * Load port bypasses
 */
async function loadPortBypasses() {
    try {
        const response = await fetch('/api/port-bypasses');
        const result = await response.json();
        
        if (result.success) {
            const ports = result.data || [];
            const container = document.getElementById('portBypassesList');
            const count = document.getElementById('portBypassCount');
            if (count) count.textContent = String(ports.length);
            
            if (ports.length === 0) {
                container.innerHTML = '<span class="text-gray-500 text-sm">No port bypasses configured</span>';
                return;
            }
            
            container.innerHTML = ports.map(portObj => {
                // Handle both object format {port: 443, protocol: "tcp"} and simple port numbers
                const portNum = typeof portObj === 'object' ? portObj.port : portObj;
                const protocol = typeof portObj === 'object' && portObj.protocol ? ` <span class="opacity-60">${escapeHtml(String(portObj.protocol).toUpperCase())}</span>` : '';
                
                return `
                    <span class="chip chip-mono">
                        ${portNum}${protocol}
                        <button data-port="${escapeHtml(String(portNum))}" title="Remove port ${portNum}"
                                class="chip-x">✕</button>
                    </span>
                `;
            }).join('');
        }
    } catch (error) {
        console.error('Error loading port bypasses:', error);
    }
}

/**
 * Load statistics
 */
async function loadStats() {
    try {
        const response = await fetch('/api/stats');
        const result = await response.json();
        
        if (result.success && result.data) {
            const stats = result.data;
            
            // Display real-time bandwidth from Speedify's stats
            const downloadSpeedElement = document.getElementById('downloadSpeed');
            
            if (downloadSpeedElement) {
                // Get download speed in bytes per second from backend
                const downloadBps = stats.downloadBps || 0;
                const uploadBps = stats.uploadBps || 0;
                const upMbps = (uploadBps * 8) / (1024 * 1024);
                
                // Calculate total throughput in Mbps
                const totalBps = downloadBps + uploadBps;
                const mbps = (totalBps * 8) / (1024 * 1024);
                
                if (mbps > 0.01) {
                    downloadSpeedElement.textContent = mbps.toFixed(2) + ' Mbps';
                    downloadSpeedElement.className = 'text-3xl font-bold tabular-nums text-green-400 mt-2';
                } else {
                    downloadSpeedElement.textContent = '0.00 Mbps';
                    downloadSpeedElement.className = 'text-3xl font-bold tabular-nums text-gray-400 mt-2';
                }
                pushSpeedSample(mbps, upMbps, { dl: stats.maxDownloadMbps, up: stats.maxUploadMbps });
                
                // Per-direction breakdown using the same unit as the combined value
                const speedBreakdownElement = document.getElementById('speedBreakdown');
                if (speedBreakdownElement) {
                    const downMbps = (downloadBps * 8) / (1024 * 1024);
                    speedBreakdownElement.textContent = '↓ ' + downMbps.toFixed(1) + ' Mbps · ↑ ' + upMbps.toFixed(1) + ' Mbps';
                }
            }
            
            // Update monthly data usage (real session stats, not adapter sums)
            const dataDownloadedElement = document.getElementById('dataDownloaded');
            const dataUploadedElement = document.getElementById('dataUploaded');
            const dataDownloadedSub = document.getElementById('dataDownloadedSub');
            const dataUploadedSub = document.getElementById('dataUploadedSub');

            if (dataDownloadedElement) {
                dataDownloadedElement.textContent = formatBytes(stats.monthDownloaded || 0);
            }
            if (dataUploadedElement) {
                dataUploadedElement.textContent = formatBytes(stats.monthUploaded || 0);
            }
            if (dataDownloadedSub) {
                dataDownloadedSub.textContent = 'Last 30 days · peak ' +
                    (stats.maxDownloadMbps ? Number(stats.maxDownloadMbps).toFixed(1) + ' Mbps' : '—');
            }
            if (dataUploadedSub) {
                dataUploadedSub.textContent = 'Last 30 days · peak ' +
                    (stats.maxUploadMbps ? Number(stats.maxUploadMbps).toFixed(1) + ' Mbps' : '—');
            }
            // Sparkline label row under the main speed chart
            const peakLbl = document.getElementById('speedPeakLbl');
            if (peakLbl) {
                const p = Math.max(stats.maxDownloadMbps || 0, stats.maxUploadMbps || 0);
                peakLbl.textContent = '30-day peak ' + (p > 0 ? p.toFixed(1) + ' Mbps' : '—');
            }
            const winLbl = document.getElementById('speedWindowLbl');
            if (winLbl) {
                const secs = refreshInterval / 1000 * speedHistory.length;
                winLbl.textContent = 'last ' + (secs >= 60 ? Math.round(secs / 60) + ' min' : Math.round(secs) + 's');
            }
            
            // Cache per-connection quality stats for the adapters table.
            // Several connections can share an adapterID (virtual adapters);
            // keep the busiest one so an idle backup line doesn't win.
            connectionMap = {};
            for (const conn of stats.connections || []) {
                const id = conn.adapterID;
                if (!id) continue;
                const prev = connectionMap[id];
                if (!prev || (conn.totalBps || 0) > (prev.totalBps || 0)) {
                    connectionMap[id] = conn;
                }
            }
            updateAdapterLatency();
        }
    } catch (error) {
        console.error('Error loading stats:', error);
        // Flat-line the sparkline so a failed refresh is visible instead
        // of the chart silently freezing on its last shape.
        pushSpeedSample(0);
    }
}

/**
 * Connect to Speedify
 */
async function connectSpeedify() {
    try {
        showActionMessage('Connecting...', 'info');
        
        const response = await apiFetch('/api/connect', {
            method: 'POST'
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage('Connected successfully!', 'success');
            await Promise.all([loadStatus(), loadHistory(true)]);
        } else {
            showActionMessage(`Failed to connect: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error connecting:', error);
        showActionMessage('Error connecting to Speedify', 'error');
    }
}

/**
 * Disconnect from Speedify
 */
async function disconnectSpeedify() {
    try {
        showActionMessage('Disconnecting...', 'info');
        
        const response = await apiFetch('/api/disconnect', {
            method: 'POST'
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage('Disconnected successfully!', 'success');
            await Promise.all([loadStatus(), loadHistory(true)]);
        } else {
            showActionMessage(`Failed to disconnect: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error disconnecting:', error);
        showActionMessage('Error disconnecting from Speedify', 'error');
    }
}

/**
 * Change server
 */
async function changeServer(target, label) {
    if (!target) {
        showActionMessage('Please select a server', 'error');
        return;
    }
    const name = label || target;
    // Every LAN client rides the tunnel: a switch drops the whole house
    if (!confirm(`Switch to ${name}?\n\nInternet drops for everyone in the house for a few seconds.${p2pRiskWarning(target)}`)) {
        return;
    }

    const buttons = ['changeServerBtn', 'p2pServerBtn'].map((id) => document.getElementById(id));
    buttons.forEach((b) => { b.disabled = true; });
    try {
        showActionMessage(`Switching to ${name}…`, 'info');
        
        const response = await apiFetch('/api/server', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ target })
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage(result.message || `Connected to ${name}`, 'success');
            await Promise.all([loadStatus(), loadHistory(true)]);
        } else {
            showActionMessage(`Failed to change server: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error changing server:', error);
        showActionMessage('Error changing server', 'error');
    } finally {
        buttons.forEach((b) => { b.disabled = false; });
    }
}

/**
 * Add bypass
 */
async function addBypass() {
    try {
        const input = document.getElementById('bypassDomain');
        const domain = input.value.trim();
        
        if (!domain) {
            showActionMessage('Please enter a domain', 'error');
            return;
        }
        
        showActionMessage(`Adding bypass for ${domain}...`, 'info');
        
        const response = await apiFetch('/api/bypasses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ domain })
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage(`Bypass added for ${domain}!`, 'success');
            input.value = '';
            await loadBypasses();
        } else {
            showActionMessage(`Failed to add bypass: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error adding bypass:', error);
        showActionMessage('Error adding bypass', 'error');
    }
}

/**
 * Remove bypass
 */
async function removeBypass(domain) {
    try {
        showActionMessage(`Removing bypass for ${domain}...`, 'info');
        
        const response = await apiFetch(`/api/bypasses/${encodeURIComponent(domain)}`, {
            method: 'DELETE'
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage(`Bypass removed for ${domain}!`, 'success');
            await loadBypasses();
        } else {
            showActionMessage(`Failed to remove bypass: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error removing bypass:', error);
        showActionMessage('Error removing bypass', 'error');
    }
};

/**
 * Add port bypass
 */
async function addPortBypass() {
    try {
        const input = document.getElementById('bypassPort');
        const port = input.value.trim();
        
        if (!port) {
            showActionMessage('Please enter a port number', 'error');
            return;
        }
        
        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
            showActionMessage('Port must be between 1 and 65535', 'error');
            return;
        }
        
        showActionMessage(`Adding port bypass for port ${portNum}...`, 'info');
        
        const response = await apiFetch('/api/port-bypasses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ port: portNum })
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage(`Port bypass added for port ${portNum}!`, 'success');
            input.value = '';
            await loadPortBypasses();
        } else {
            showActionMessage(`Failed to add port bypass: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error adding port bypass:', error);
        showActionMessage('Error adding port bypass', 'error');
    }
}

/**
 * Remove port bypass
 */
async function removePortBypass(port) {
    try {
        showActionMessage(`Removing port bypass for port ${port}...`, 'info');
        
        const response = await apiFetch(`/api/port-bypasses/${encodeURIComponent(port)}`, {
            method: 'DELETE'
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage(`Port bypass removed for port ${port}!`, 'success');
            await loadPortBypasses();
        } else {
            showActionMessage(`Failed to remove port bypass: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error removing port bypass:', error);
        showActionMessage('Error removing port bypass', 'error');
    }
};

/**
 * Load per-device traffic (latest conntrack sample + TORRENT-kick snapshots)
 */
async function loadDevices(force) {
    if (!force && Date.now() - devicesLoadedAt < DEVICES_TTL_MS) return;
    devicesLoadedAt = Date.now();
    try {
        const response = await fetch('/api/devices');
        const result = await response.json();
        if (result.success && result.data) {
            devicesData = result.data;
            renderDevices(devicesData);
        } else {
            throw new Error(result.error || 'devices unavailable');
        }
    } catch (error) {
        console.error('Error loading devices:', error);
        devicesLoadedAt = Date.now() - DEVICES_TTL_MS + 10000;
    }
}

function formatRate(bps) {
    if (bps == null) return '—';
    const bits = bps * 8;
    if (bits < 1000) return '0';
    if (bits < 1e6) return (bits / 1e3).toFixed(0) + ' kbps';
    return (bits / 1e6).toFixed(bits < 1e7 ? 1 : 0) + ' Mbps';
}

function verdictPill(verdict) {
    if (verdict === 'torrent') {
        return '<span class="inline-flex px-2 py-0.5 rounded-full border text-xs font-medium bg-red-500/15 border-red-500/30 text-red-300" title="Connected to many different peers on non-standard ports, or to BitTorrent ports: looks like a torrent client.">torrent-like</span>';
    }
    if (verdict === 'elevated') {
        return '<span class="inline-flex px-2 py-0.5 rounded-full border text-xs font-medium bg-amber-500/15 border-amber-500/30 text-amber-300" title="More peer-to-peer style connections than normal browsing or apps.">elevated</span>';
    }
    return '';
}

function deviceNameHtml(d) {
    const sub = [];
    if (d.ip) sub.push(d.ip);
    if (d.label && d.hostname && d.hostname !== d.label) sub.push(d.hostname);
    if (d.randomMac) sub.push('private MAC');
    const edit = d.mac
        ? `<button data-mac="${escapeHtml(d.mac)}" data-name="${escapeHtml(d.name)}" data-label="${escapeHtml(d.label || '')}" title="Name this device" class="ml-1 text-gray-500 hover:text-gray-200 text-xs">✏️</button>`
        : '';
    return `<div class="font-medium text-gray-200">${escapeHtml(d.name)}${edit}</div>
        <div class="text-xs text-gray-500">${escapeHtml(sub.join(' · '))}</div>`;
}

function renderDevices(data) {
    const tbody = document.getElementById('devicesTable');
    const meta = document.getElementById('devicesMeta');
    const idleEl = document.getElementById('devicesIdle');
    if (!tbody) return;

    if (!data.available) {
        meta.textContent = '';
        const why = data.error
            ? `Cannot read the connection table: ${escapeHtml(data.error)}`
            : 'Collecting the first sample…';
        tbody.innerHTML = `<tr><td colspan="5" class="py-3 ${data.error ? 'text-red-300' : 'text-gray-500'}">${why}</td></tr>`;
        idleEl.textContent = '';
    } else {
        const age = Math.max(0, Math.round(Date.now() / 1000 - data.sampledAt));
        meta.textContent = `${data.flows} connections tracked · sampled ${age}s ago`;
        if (data.devices.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="py-3 text-gray-500">No internet connections right now</td></tr>';
        } else {
            tbody.innerHTML = data.devices.map((d) => {
                const peerClass = d.verdict === 'torrent' ? 'text-red-300 font-semibold'
                    : d.verdict === 'elevated' ? 'text-amber-300 font-medium' : 'text-gray-300';
                const peak = d.recentPeakP2p > d.p2pPeers
                    ? ` <span class="text-xs text-gray-500" title="Highest in the last 5 minutes">(peak ${d.recentPeakP2p})</span>` : '';
                const bt = d.btFlows ? ` <span class="text-xs text-red-300" title="Connections on BitTorrent ports (6881-6889, trackers, Transmission 51413)">· ${d.btFlows} on BT ports</span>` : '';
                const services = (d.services || []).map(([name, n]) => `${escapeHtml(name)} ×${n}`).join(' · ');
                return `<tr class="border-b border-gray-700/60 ${d.verdict === 'torrent' ? 'bg-red-500/5' : ''}">
                    <td class="py-2 pr-3">${deviceNameHtml(d)}</td>
                    <td class="py-2 pr-3 whitespace-nowrap tabular-nums">
                        <span class="text-gray-200">↓ ${formatRate(d.rxBps)}</span>
                        <span class="text-gray-500">↑ ${formatRate(d.txBps)}</span></td>
                    <td class="py-2 pr-3 tabular-nums text-gray-300">${d.flows}
                        <span class="text-xs text-gray-500">(${d.remotes} hosts)</span></td>
                    <td class="py-2 pr-3 tabular-nums"><span class="${peerClass}">${d.p2pPeers}</span>${peak}${bt}
                        ${verdictPill(d.verdict) ? ' ' + verdictPill(d.verdict) : ''}</td>
                    <td class="py-2 text-xs text-gray-400">${services || '—'}</td>
                </tr>`;
            }).join('');
        }
        idleEl.textContent = data.idle && data.idle.length
            ? 'Connected but idle: ' + data.idle.map((d) => d.name).join(', ')
            : '';
    }
    renderIncidents(data.incidents || []);
}

function suspectLine(s) {
    const bits = [];
    if (s.peakBtFlows) bits.push(`${s.peakBtFlows} BT-port connections`);
    bits.push(`${s.peakP2p} P2P-like peers`);
    bits.push(formatBytes(s.bytes));
    const hot = s.peakBtFlows > 0 || s.peakP2p >= 30;
    return `<span class="${hot ? 'text-red-300 font-medium' : 'text-gray-300'}">${escapeHtml(s.name)}</span>
        <span class="text-xs text-gray-500">${escapeHtml(bits.join(' · '))}</span>`;
}

function renderIncidents(incidents) {
    const el = document.getElementById('incidentsList');
    if (!el) return;
    if (incidents.length === 0) {
        el.innerHTML = '<div class="text-gray-500">No torrent cuts recorded since the sampler started. The next one will show up here with the devices that were active.</div>';
        return;
    }
    el.innerHTML = incidents.map((i) => {
        const lines = i.suspects.length
            ? i.suspects.slice(0, 4).map((s) => `<div>${suspectLine(s)}</div>`).join('')
            : '<div class="text-gray-500">No device activity captured (sampler was not running)</div>';
        return `<div class="rounded-lg bg-gray-900/60 border border-gray-700 px-3 py-2">
            <div class="text-xs text-gray-400 mb-1">${escapeHtml(formatWhen(i.kickedAt))} · <span class="font-mono">${escapeHtml(i.server)}</span> · ${i.samples} samples</div>
            ${lines}
        </div>`;
    }).join('');
}

async function renameDevice(mac, name, current) {
    const input = prompt(`Name for ${name} (${mac}).\nLeave empty to remove the name.`, current || '');
    if (input === null) return;
    try {
        const response = await apiFetch('/api/devices/label', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac, label: input })
        });
        const result = await response.json();
        if (result.success) {
            await Promise.all([loadDevices(true), loadHistory(true)]);
        } else {
            showActionMessage(`Could not save the name: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error saving device name:', error);
        showActionMessage('Error saving the device name', 'error');
    }
}

/**
 * Load per-adapter data budgets (usage vs Speedify caps + daily history)
 */
async function loadUsage(force) {
    if (!force && Date.now() - usageLoadedAt < USAGE_TTL_MS) return;
    usageLoadedAt = Date.now();
    try {
        const response = await fetch('/api/usage?days=30');
        const result = await response.json();
        if (result.success && result.data) {
            renderBudgets(result.data);
        } else {
            throw new Error(result.error || 'usage unavailable');
        }
    } catch (error) {
        console.error('Error loading usage:', error);
        usageLoadedAt = Date.now() - USAGE_TTL_MS + 15000;   // retry in 15 s
    }
}

/**
 * Usage bar coloured by how close it is to the cap
 */
function budgetBar(used, cap) {
    if (!cap) {
        return '<div class="h-2 rounded-full bg-gray-700"></div>';
    }
    const frac = used / cap;
    const cls = frac >= 0.9 ? 'bg-red-500' : frac >= 0.7 ? 'bg-amber-500' : 'bg-green-500';
    const pct = Math.min(100, Math.max(frac > 0 ? 2 : 0, frac * 100));
    return `<div class="h-2 rounded-full bg-gray-700 overflow-hidden">
        <div class="h-full rounded-full ${cls}" style="width:${pct.toFixed(1)}%"></div>
    </div>`;
}

function budgetRow(label, used, cap, note) {
    const capText = cap
        ? `<span class="text-gray-500">/ ${formatBytes(cap)}</span> <span class="text-gray-400">(${Math.round((used / cap) * 100)}%)</span>`
        : '<span class="text-gray-500">· no cap</span>';
    return `<div>
        <div class="flex items-baseline justify-between gap-2 text-sm mb-1">
            <span class="text-gray-400">${label}${note ? ` <span class="text-xs text-gray-500">${note}</span>` : ''}</span>
            <span class="tabular-nums"><span class="font-semibold text-gray-200">${formatBytes(used)}</span> ${capText}</span>
        </div>
        ${budgetBar(used, cap)}
    </div>`;
}

/**
 * 30-day daily usage bars (SVG) with the daily cap as a dashed line.
 * Bars over the daily cap are red; today is highlighted.
 */
function usageChart(history, dailyCap) {
    const n = history.length;
    if (!n) return '';
    const w = 300, h = 64, gap = 1.5;
    const maxUsed = Math.max(...history.map((d) => d.bytes), 1);
    const scale = Math.max(maxUsed, dailyCap ? dailyCap * 1.15 : 0);
    const bw = w / n;
    let bars = '';
    history.forEach((d, i) => {
        const bh = d.bytes > 0 ? Math.max(1, (d.bytes / scale) * (h - 2)) : 0;
        const isToday = i === n - 1;
        const over = dailyCap && d.bytes >= dailyCap;
        const fill = over ? '#ef4444' : isToday ? '#60a5fa' : '#3b82f6';
        const opacity = isToday ? 1 : 0.75;
        const date = new Date(d.date + 'T00:00:00');
        const label = `${date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}: ${formatBytes(d.bytes)}${isToday ? ' (today so far)' : ''}`;
        // full-height transparent hit area so tiny bars still get a tooltip
        bars += `<g><title>${escapeHtml(label)}</title>
            <rect x="${(i * bw).toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${h}" fill="transparent"/>
            <rect x="${(i * bw + gap / 2).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${Math.max(0.5, bw - gap).toFixed(2)}" height="${bh.toFixed(2)}" rx="1" fill="${fill}" opacity="${opacity}"/></g>`;
    });
    let capLine = '';
    if (dailyCap) {
        const y = (h - (dailyCap / scale) * (h - 2)).toFixed(2);
        capLine = `<line x1="0" x2="${w}" y1="${y}" y2="${y}" stroke="#f87171" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"><title>Daily cap ${escapeHtml(formatBytes(dailyCap))}</title></line>`;
    }
    const first = new Date(history[0].date + 'T00:00:00');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="w-full h-16">${bars}${capLine}</svg>
        <div class="flex justify-between text-[10px] text-gray-500 tabular-nums mt-0.5">
            <span>${escapeHtml(first.toLocaleDateString([], { day: 'numeric', month: 'short' }))}</span>
            <span>max ${escapeHtml(formatBytes(maxUsed))}/day</span>
            <span>today</span>
        </div>`;
}

function renderBudgets(data) {
    const container = document.getElementById('budgetCards');
    if (!container) return;
    // Only real uplinks: skip adapters Speedify has never counted any data on
    const adapters = (data.adapters || []).filter((a) =>
        a.daily.cap || a.monthly.cap || a.monthly.used || a.history.some((d) => d.bytes > 0));
    if (adapters.length === 0) {
        container.innerHTML = '<div class="text-gray-500 text-sm">No adapter usage recorded</div>';
        return;
    }

    container.innerHTML = adapters.map((a) => {
        const rate = a.overLimitRateBps
            ? `${(a.overLimitRateBps / 1e6).toFixed(a.overLimitRateBps % 1e6 ? 1 : 0)} Mbps` : null;
        const capped = a.daily.cap || a.monthly.cap;
        let overHtml = '';
        if (a.overDaily || a.overMonthly) {
            const which = a.overDaily && a.overMonthly ? 'daily and 30-day caps' : a.overDaily ? 'daily cap' : 'monthly cap';
            overHtml = `<div class="mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
                ⚠ Over the ${which}: ${rate ? `throttled to ${rate}` : 'Speedify has stopped using this link'}</div>`;
        } else if (capped) {
            overHtml = `<div class="mt-3 text-xs text-gray-500">Over a cap, Speedify ${rate ? `throttles this link to ${rate}` : 'stops using this link'}.</div>`;
        }

        const m = a.monthly;
        const monthLabel = m.resetDay ? 'This month' : 'Last 30 days';
        const monthNote = m.resetDay
            ? (m.nextReset ? `resets ${new Date(m.nextReset + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' })}` : '')
            : 'rolling';
        const boostNote = a.daily.boost ? `incl. ${formatBytes(a.daily.boost)} boost` : '';

        // Pace: 7-day average vs the caps
        let pace = `7-day average ${formatBytes(Math.round(a.avg7))}/day`;
        if (a.daily.cap && a.avg7) pace += ` · ${Math.round((a.avg7 / a.daily.cap) * 100)}% of the daily cap`;
        if (!m.resetDay && m.cap && a.avg7) {
            const projected = a.avg7 * 30;
            pace += ` · 30-day pace ${formatBytes(Math.round(projected))}`;
            if (projected > m.cap) pace += ' <span class="text-amber-300">(over the cap)</span>';
        }

        const title = a.isp ? `${escapeHtml(a.name)} <span class="text-gray-400 font-normal">· ${escapeHtml(a.isp)}</span>` : escapeHtml(a.name);
        return `<div class="rounded-lg bg-gray-900/60 border border-gray-700 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div class="font-semibold text-gray-200">${title}
                    <span class="ml-1 text-xs font-normal text-gray-500">${escapeHtml(a.type)}</span></div>
                <div class="flex items-center gap-2 text-xs">
                    <span class="text-gray-500">priority ${escapeHtml(a.priority || '—')}</span>
                    ${getAdapterStateHtml(a.state)}
                </div>
            </div>
            <div class="space-y-3">
                ${budgetRow('Today', a.daily.used, a.daily.cap, boostNote)}
                ${budgetRow(monthLabel, m.used, m.cap, monthNote)}
            </div>
            <div class="mt-4">${usageChart(a.history, a.daily.cap)}</div>
            <div class="mt-1 text-xs text-gray-500">${pace}</div>
            ${overHtml}
        </div>`;
    }).join('');
}

/**
 * Disconnect reasons recorded by Speedify (sessions.disconnect_reason),
 * with plain-English explanations. Class strings are written out in full
 * so the Tailwind build picks them up.
 */
const REASONS = {
    TORRENT: {
        label: 'Torrent cut', bar: 'bg-red-500',
        pill: 'bg-red-500/15 border-red-500/30 text-red-300',
        explain: 'The Speedify server cut the tunnel: a device on the LAN sent BitTorrent traffic and this server bans P2P.'
    },
    CONNECTIVITY: {
        label: 'Lost connection', bar: 'bg-amber-500',
        pill: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
        explain: 'Speedify lost contact with the server (uplinks down or unstable).'
    },
    STARTTIMEOUT: {
        label: 'Start timeout', bar: 'bg-orange-500',
        pill: 'bg-orange-500/15 border-orange-500/30 text-orange-300',
        explain: 'The tunnel could not be (re)established in time.'
    },
    REBOOT: {
        label: 'Restart', bar: 'bg-purple-500',
        pill: 'bg-purple-500/15 border-purple-500/30 text-purple-300',
        explain: 'pi3 or the Speedify service restarted.'
    },
    USERINITIATED: {
        label: 'Manual / switch', bar: 'bg-sky-500',
        pill: 'bg-sky-500/15 border-sky-500/30 text-sky-300',
        explain: 'Disconnected on purpose: manual disconnect, server change, or the night-window script.'
    },
    UNKNOWN: {
        label: 'Unknown', bar: 'bg-gray-500',
        pill: 'bg-gray-500/15 border-gray-500/30 text-gray-300',
        explain: 'Speedify recorded no reason.'
    }
};

function reasonInfo(reason) {
    return REASONS[reason] || Object.assign({}, REASONS.UNKNOWN, {
        label: reason ? reason.charAt(0) + reason.slice(1).toLowerCase() : 'Unknown',
        explain: reason ? `Speedify reason: ${reason}` : REASONS.UNKNOWN.explain
    });
}

function reasonPill(reason) {
    const r = reasonInfo(reason);
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${r.pill}" title="${escapeHtml(r.explain)}">${escapeHtml(r.label)}</span>`;
}

/**
 * "45 s", "12 min", "1 h 35 min", "2 d 3 h"
 */
function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(s / 3600);
    if (h < 24) return `${h} h ${Math.round((s % 3600) / 60)} min`;
    return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function formatClock(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * "Today 06:04", "Yesterday 23:59", "Sun 06:04", "15 Nov 19:36"
 */
function formatWhen(ts) {
    const d = new Date(ts * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayDiff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    const clock = formatClock(ts);
    if (dayDiff === 0) return `Today ${clock}`;
    if (dayDiff === 1) return `Yesterday ${clock}`;
    if (dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${clock}`;
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock}`;
}

function updateHistoryRangeButtons() {
    document.querySelectorAll('.history-range').forEach((btn) => {
        const active = parseInt(btn.dataset.hours, 10) === historyHours;
        btn.classList.toggle('bg-blue-600', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-400', !active);
        btn.classList.toggle('hover:bg-gray-700', !active);
    });
}

/**
 * Load the up/down timeline (Speedify session DB). Throttled to once a
 * minute unless forced (range change, connect/disconnect, server switch).
 */
async function loadHistory(force) {
    if (!force && Date.now() - historyLoadedAt < HISTORY_TTL_MS) return;
    historyLoadedAt = Date.now();
    const hours = historyHours;
    try {
        const response = await fetch(`/api/history?hours=${hours}`);
        const result = await response.json();
        if (hours !== historyHours) return;   // range changed meanwhile
        if (result.success && result.data) {
            historyData = result.data;
            renderHistory(historyData);
            updateSessionInfo();
        } else {
            throw new Error(result.error || 'history unavailable');
        }
    } catch (error) {
        console.error('Error loading history:', error);
        historyLoadedAt = Date.now() - HISTORY_TTL_MS + 15000;   // retry in 15 s
        const summary = document.getElementById('historySummary');
        if (summary && !historyData) {
            summary.innerHTML = '<div class="text-red-400 text-sm col-span-2">Could not read Speedify history</div>';
        }
    }
}

function statCard(label, value, sub, valueClass) {
    return `<div class="rounded-lg bg-gray-900/60 border border-gray-700 px-3 py-2">
        <div class="text-xs text-gray-500 uppercase tracking-wide">${label}</div>
        <div class="text-xl font-bold tabular-nums ${valueClass || 'text-gray-200'}">${value}</div>
        <div class="text-xs text-gray-500 mt-0.5">${sub || '&nbsp;'}</div>
    </div>`;
}

function renderHistory(d) {
    const span = Math.max(1, d.now - d.since);
    const pct = (t) => ((t - d.since) / span) * 100;
    const s = d.summary || {};
    const segments = d.segments || [];
    const outages = segments.filter((g) => g.type === 'down');
    const rangeLabel = d.hours <= 24 ? 'last 24 h' : `last ${Math.round(d.hours / 24)} days`;

    // --- Headline numbers ---
    const avail = s.availability;
    const availClass = avail == null ? 'text-gray-400'
        : avail >= 0.99 ? 'text-green-400' : avail >= 0.95 ? 'text-yellow-400' : 'text-red-400';
    const availText = avail == null ? '—'
        : (avail >= 0.9995 ? '100' : (avail * 100).toFixed(avail >= 0.99 ? 2 : 1)) + '%';

    const cuts = Object.entries(s.cuts || {}).sort((a, b) => b[1] - a[1]);
    const torrentCuts = (s.cuts || {}).TORRENT || 0;
    const cutsHtml = cuts.length
        ? cuts.map(([reason, n]) => `<span class="whitespace-nowrap">${escapeHtml(reasonInfo(reason).label)} ×${n}</span>`).join(' · ')
        : 'none';

    const longest = s.longestOutage;
    const longestSub = longest
        ? `${formatWhen(longest.start)} · ${escapeHtml(reasonInfo(longest.cause).label)}`
        : 'no outages';

    document.getElementById('historySummary').innerHTML =
        statCard('Online', availText, `${formatDuration(s.upSeconds || 0)} up · ${rangeLabel}`, availClass) +
        statCard('Offline', formatDuration(s.downSeconds || 0),
            `${s.outageCount || 0} outage${s.outageCount === 1 ? '' : 's'} ≥ 1 min`,
            (s.downSeconds || 0) >= 600 ? 'text-red-400' : (s.downSeconds || 0) > 0 ? 'text-yellow-400' : 'text-green-400') +
        statCard('Torrent cuts', String(torrentCuts), `all disconnects: ${cutsHtml}`,
            torrentCuts ? 'text-red-400' : 'text-green-400') +
        statCard('Longest outage', longest ? formatDuration(longest.end - longest.start) : '—', longestSub,
            longest && longest.end - longest.start >= 600 ? 'text-red-400' : 'text-gray-200');

    // --- Timeline strip ---
    const ticks = historyTicks(d.since, d.now, d.hours);
    let strip = ticks.map(([t]) =>
        `<div class="absolute top-0 bottom-0 w-px bg-black/40" style="left:${pct(t).toFixed(3)}%"></div>`).join('');
    // up first, outages on top (min 2px so short cuts stay visible)
    for (const g of segments.filter((x) => x.type === 'up')) {
        const title = `Online ${formatWhen(g.start)} → ${g.ongoing ? 'now' : formatClock(g.end)} (${formatDuration(g.end - g.start)})` +
            ` · ${g.server}` + (g.ongoing ? '' : ` · ended: ${reasonInfo(g.endReason).label}`);
        strip += `<div class="absolute top-0 bottom-0 bg-green-600/80" style="left:${pct(g.start).toFixed(3)}%;width:${(pct(g.end) - pct(g.start)).toFixed(3)}%" title="${escapeHtml(title)}"></div>`;
    }
    for (const g of outages) {
        const r = reasonInfo(g.cause);
        const title = `Offline ${formatWhen(g.start)} → ${g.ongoing ? 'now' : formatClock(g.end)} (${formatDuration(g.end - g.start)}) · ${r.label}: ${r.explain}`;
        strip += `<div class="absolute top-0 bottom-0 ${r.bar}" style="left:${pct(g.start).toFixed(3)}%;width:${(pct(g.end) - pct(g.start)).toFixed(3)}%;min-width:2px" title="${escapeHtml(title)}"></div>`;
    }
    document.getElementById('historyStrip').innerHTML = strip;

    // --- Axis labels (skip ones that would hit the edges) ---
    document.getElementById('historyAxis').innerHTML = ticks
        .filter(([t]) => pct(t) > 4 && pct(t) < 94)
        .map(([t, label]) => `<span class="absolute -translate-x-1/2 whitespace-nowrap" style="left:${pct(t).toFixed(3)}%">${escapeHtml(label)}</span>`)
        .join('') + '<span class="absolute right-0">now</span>';

    // --- Legend: online + the causes present in this range ---
    const causes = [...new Set(outages.map((g) => g.cause || 'UNKNOWN'))];
    document.getElementById('historyLegend').innerHTML =
        '<span class="inline-flex items-center gap-1.5"><span class="w-3 h-3 rounded-sm bg-green-600/80"></span>Online</span>' +
        causes.map((c) => {
            const r = reasonInfo(c);
            return `<span class="inline-flex items-center gap-1.5" title="${escapeHtml(r.explain)}"><span class="w-3 h-3 rounded-sm ${r.bar}"></span>Offline: ${escapeHtml(r.label)}</span>`;
        }).join('');

    // --- Outage table (newest first) ---
    const rows = outages.slice().reverse();
    const longOnes = outages.filter((g) => g.end - g.start >= 60).length;
    document.getElementById('outageCount').textContent =
        rows.length ? `· ${rows.length} in the ${rangeLabel} (${longOnes} ≥ 1 min)` : '';
    const tbody = document.getElementById('outageTable');
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-3 text-green-400">No outages in the ${rangeLabel} 🎉</td></tr>`;
        return;
    }
    const hidden = Math.max(0, rows.length - OUTAGES_COLLAPSED);
    const visible = outagesExpanded ? rows : rows.slice(0, OUTAGES_COLLAPSED);
    tbody.innerHTML = visible.map((g) => {
        const dur = g.end - g.start;
        const dim = dur < 60 ? ' text-gray-500' : '';
        const r = reasonInfo(g.cause);
        return `<tr class="border-b border-gray-700/60${dim}">
            <td class="py-2 pr-3 whitespace-nowrap tabular-nums">${escapeHtml(formatWhen(g.start))}</td>
            <td class="py-2 pr-3 whitespace-nowrap tabular-nums ${dur >= 600 ? 'text-red-300 font-medium' : ''}">${formatDuration(dur)}${g.ongoing ? ' <span class="text-red-400">(ongoing)</span>' : ''}</td>
            <td class="py-2 pr-3">${reasonPill(g.cause)} <span class="hidden md:inline text-xs text-gray-500">${escapeHtml(r.explain)}</span>${suspectsHtml(g)}</td>
            <td class="py-2 font-mono text-xs">${escapeHtml(g.server || '—')}</td>
        </tr>`;
    }).join('') + (hidden > 0
        ? `<tr><td colspan="4" class="pt-3">
            <button data-outages-toggle class="text-sm text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline">${
                outagesExpanded ? 'Show less' : `…show ${hidden} more`}</button></td></tr>` : '');
}

/**
 * Does a `connect` target guarantee a P2P-allowed server? Specific tag:
 * its torrentAllowed flag. Country: only if every server there allows it.
 * closest/public/...: no guarantee.
 */
function targetAllowsP2p(target) {
    if (target === 'p2p') return true;
    const server = availableServers.find((s) => s.tag === target);
    if (server) return !!server.torrentAllowed;
    const inCountry = availableServers.filter((s) => String(s.country).toLowerCase() === target);
    return inCountry.length > 0 && inCountry.every((s) => s.torrentAllowed);
}

/**
 * Extra confirm() text when switching to a server that may ban P2P while a
 * device (or pi3's Transmission) shows torrent-like traffic: that server
 * would cut the tunnel for everyone within minutes.
 */
function p2pRiskWarning(target) {
    if (targetAllowsP2p(target) || !devicesData || !devicesData.devices) return '';
    const risky = devicesData.devices.filter((d) => d.verdict || d.btFlows > 0 || d.recentPeakP2p >= 30);
    if (risky.length === 0) return '';
    const names = risky.slice(0, 3).map((d) => d.name).join(', ');
    return `\n\n⚠ ${names} ${risky.length === 1 ? 'has' : 'have'} torrent-like traffic right now. ` +
        'This server may ban P2P: Speedify would then cut the tunnel for the whole house (usually within ~2 minutes). ' +
        'Stop the torrents first, or pick a torrent-safe server.';
}

/**
 * Top suspects saved by the LAN sampler for a TORRENT outage
 */
function suspectsHtml(g) {
    if (g.cause !== 'TORRENT') return '';
    if (!g.suspects || g.suspects.length === 0) {
        return '<div class="text-xs text-gray-600 mt-0.5">no per-device snapshot (cut happened before sampling started)</div>';
    }
    return `<div class="text-xs mt-1"><span class="text-gray-500">Most active just before:</span> ` +
        g.suspects.slice(0, 2).map(suspectLine).join(' <span class="text-gray-600">|</span> ') + '</div>';
}

/**
 * Axis ticks aligned to the local clock: every 6 h (24 h view),
 * every midnight (7 d view) or every 5 days (30 d view).
 */
function historyTicks(since, now, hours) {
    const ticks = [];
    const t = new Date(since * 1000);
    if (hours <= 48) {
        const step = hours <= 24 ? 6 : 12;
        t.setMinutes(0, 0, 0);
        t.setHours(Math.ceil((t.getHours() + 1) / step) * step);
        while (t.getTime() / 1000 <= now) {
            ticks.push([t.getTime() / 1000, formatClock(t.getTime() / 1000)]);
            t.setHours(t.getHours() + step);
        }
    } else {
        const step = hours <= 24 * 8 ? 1 : 5;
        t.setHours(24, 0, 0, 0);   // next local midnight
        while (t.getTime() / 1000 <= now) {
            const label = step === 1
                ? t.toLocaleDateString([], { weekday: 'short' })
                : t.toLocaleDateString([], { day: 'numeric', month: 'short' });
            ticks.push([t.getTime() / 1000, label]);
            t.setDate(t.getDate() + step);
        }
    }
    return ticks;
}

/**
 * One-line "why" next to the status pill: current session age and the
 * last cut, or how long we've been offline and why.
 */
function updateSessionInfo() {
    const el = document.getElementById('sessionInfo');
    if (!el || !historyData) return;
    const segments = historyData.segments || [];
    const nowSec = Date.now() / 1000;
    const lastUp = segments.filter((g) => g.type === 'up').pop();
    const lastDown = segments.filter((g) => g.type === 'down').pop();

    if (isConnected) {
        const parts = [];
        if (lastUp && lastUp.ongoing) parts.push(`up ${formatDuration(nowSec - lastUp.sessionStart)}`);
        if (lastDown && !lastDown.ongoing) {
            parts.push(`last cut ${formatWhen(lastDown.start)} (${reasonInfo(lastDown.cause).label.toLowerCase()})`);
        }
        el.textContent = parts.join(' · ');
        el.className = 'text-sm text-gray-400';
        el.title = lastDown ? reasonInfo(lastDown.cause).explain : '';
    } else {
        const reason = (lastDown && lastDown.ongoing && lastDown.cause) || historyData.lastDisconnectReason;
        const r = reasonInfo(reason);
        const since = lastDown && lastDown.ongoing ? ` for ${formatDuration(nowSec - lastDown.start)}` : '';
        el.textContent = `offline${since} · ${r.label}`;
        el.className = 'text-sm text-red-300';
        el.title = r.explain;
    }
}

/**
 * Update button states based on connection status
 */
function updateButtonStates() {
    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    
    connectBtn.disabled = isConnected;
    disconnectBtn.disabled = !isConnected;
}

/**
 * Show action message
 */
function showActionMessage(message, type = 'info') {
    const container = document.getElementById('actionMessage');
    const content = document.getElementById('actionMessageContent');
    
    const typeClasses = {
        'success': 'bg-green-900 border border-green-700 text-green-200',
        'error': 'bg-red-900 border border-red-700 text-red-200',
        'info': 'bg-blue-900 border border-blue-700 text-blue-200'
    };
    
    content.className = `p-3 rounded-lg ${typeClasses[type] || typeClasses.info}`;
    content.textContent = message;
    container.classList.remove('hidden');
    
    // Auto-hide after 5 seconds (cancel any pending hide so a fresh
    // message isn't dismissed by the previous one's timer)
    if (messageTimer) clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
        container.classList.add('hidden');
    }, 5000);
}

/**
 * Format bytes to human-readable format
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Push a new throughput sample into the sparkline history
 */
function pushSpeedSample(mbps, upMbps, peak) {
    speedHistory.push(mbps);
    if (speedHistory.length > 40) speedHistory.shift();
    uploadHistory.push(upMbps || 0);
    if (uploadHistory.length > 40) uploadHistory.shift();
    renderSparkline('speedSparkline', speedHistory, '#34d399', { fill: true });
    renderSparkline('uploadSparkline', uploadHistory, '#fbbf24');

    // Peak speed sparklines: rolling window of the reported 30-day peak
    // values (they only climb, so this traces the trend).
    pushPeakSample('dlPeakSparkline', 'peakDlHistory', peak && peak.dl || 0);
    pushPeakSample('upPeakSparkline', 'peakUpHistory', peak && peak.up || 0);
}

const peakHistories = {};
function pushPeakSample(svgId, key, value) {
    peakHistories[key] = peakHistories[key] || [];
    peakHistories[key].push(value);
    if (peakHistories[key].length > 40) peakHistories[key].shift();
    renderSparkline(svgId, peakHistories[key], key === 'peakDlHistory' ? '#c084fc' : '#fbbf24');
}

/**
 * Render an inline SVG sparkline of a rolling value window. Supports an
 * optional gradient area fill, a min/max label row, and an upper limit
 * for scaling (so 30-day peak values stay visible).
 */
function renderSparkline(id, data, stroke, opts) {
    const svg = document.getElementById(id);
    if (!svg || !data || data.length < 2) return;

    const o = opts || {};
    const w = 100, h = 30;
    const max = Math.max(...data, 0.001);
    const scaleMax = o.maxScale && o.maxScale > max ? o.maxScale : max;
    const points = data
        .map((v, i) => {
            const x = (i / (data.length - 1)) * w;
            const y = h - (Math.min(v, scaleMax) / scaleMax) * (h - 6) - 3;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    // Area fill (down to the baseline) when requested
    let area = '';
    if (o.fill) {
        const gid = 'g-' + id.replace(/[^a-z]/gi, '');
        area =
            `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${stroke}" stop-opacity="0.35"/>
                <stop offset="100%" stop-color="${stroke}" stop-opacity="0.02"/>
            </linearGradient></defs>
            <polygon points="0,${h} ${points} ${w},${h}" fill="url(#${gid})" stroke="none"/>
            <polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.5"
                vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
            <circle cx="${w}" cy="${(h - (Math.min(data[data.length - 1], scaleMax) / scaleMax) * (h - 6) - 3).toFixed(1)}" r="1.8" fill="${stroke}"/>
        `;
    } else {
        area = `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.5"
            vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`;
    }
    svg.innerHTML = area;
}


/**
 * Escape a string for safe embedding in HTML
 */
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[c]);
}

