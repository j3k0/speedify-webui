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
    document.getElementById('changeServerBtn').addEventListener('click', changeServer);
    
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
        loadServers(),
        loadBypasses(),
        loadPortBypasses(),
        loadStats()
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
            if (state.city && state.country) {
                serverElement.textContent = `${state.city}, ${state.country.toUpperCase()}`;
            } else if (state.country) {
                serverElement.textContent = state.country.toUpperCase();
            } else {
                serverElement.textContent = '—';
            }
            
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
async function loadServers() {
    try {
        const response = await fetch('/api/servers');
        const result = await response.json();
        
        if (result.success && result.data) {
            // Handle server data structure: { private: [], public: [] }
            const serverData = result.data;
            const publicServers = serverData.public || [];
            const privateServers = serverData.private || [];
            
            // Combine all servers
            availableServers = [...publicServers, ...privateServers];
            
            // Populate country select
            const select = document.getElementById('countrySelect');
            
            // Save current selection
            const currentSelection = select.value;
            
            // Extract unique countries
            const countries = [...new Set(availableServers.map(s => s.country))].sort();
            
            select.innerHTML = '<option value="">Select Country...</option>' + 
                countries.map(country => `<option value="${country}">${country.toUpperCase()}</option>`).join('');
            
            // Restore selection if it still exists
            if (currentSelection && countries.includes(currentSelection)) {
                select.value = currentSelection;
            }
        }
    } catch (error) {
        console.error('Error loading servers:', error);
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
        
        const response = await fetch('/api/connect', {
            method: 'POST'
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage('Connected successfully!', 'success');
            await loadStatus();
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
        
        const response = await fetch('/api/disconnect', {
            method: 'POST'
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage('Disconnected successfully!', 'success');
            await loadStatus();
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
async function changeServer() {
    try {
        const select = document.getElementById('countrySelect');
        const country = select.value;
        
        if (!country) {
            showActionMessage('Please select a country', 'error');
            return;
        }
        
        showActionMessage(`Changing server to ${country}...`, 'info');
        
        const response = await fetch('/api/server', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ country })
        });
        const result = await response.json();
        
        if (result.success) {
            showActionMessage(`Server changed to ${country}!`, 'success');
            await loadStatus();
        } else {
            showActionMessage(`Failed to change server: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Error changing server:', error);
        showActionMessage('Error changing server', 'error');
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
        
        const response = await fetch('/api/bypasses', {
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
        
        const response = await fetch(`/api/bypasses/${encodeURIComponent(domain)}`, {
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
        
        const response = await fetch('/api/port-bypasses', {
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
        
        const response = await fetch(`/api/port-bypasses/${encodeURIComponent(port)}`, {
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

