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
    
    // Refresh interval change
    const intervalInput = document.getElementById('refreshInterval');
    intervalInput.addEventListener('change', (e) => {
        refreshInterval = parseInt(e.target.value) * 1000;
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
    
    // Copy public IP
    document.getElementById('copyIpBtn').addEventListener('click', async () => {
        const ip = document.getElementById('publicIp').textContent.trim();
        if (!ip || ip === '—') return;
        try {
            await navigator.clipboard.writeText(ip);
            const btn = document.getElementById('copyIpBtn');
            const original = btn.textContent;
            btn.textContent = '✓';
            btn.classList.add('text-green-400');
            setTimeout(() => {
                btn.textContent = original;
                btn.classList.remove('text-green-400');
            }, 1500);
        } catch (error) {
            console.error('Failed to copy IP:', error);
        }
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
 * Show when the data was last refreshed
 */
function updateLastUpdated() {
    const el = document.getElementById('lastUpdated');
    if (el) {
        el.textContent = 'Updated ' + new Date().toLocaleTimeString();
    }
}

/**
 * Load all dashboard data
 */
async function loadAllData() {
    await Promise.all([
        loadStatus(),
        loadAdapters(),
        loadServers(),
        loadBypasses(),
        loadPortBypasses(),
        loadStats()
    ]);
    updateLastUpdated();
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
        }
    } catch (error) {
        console.error('Error loading status:', error);
        showActionMessage('Error loading status', 'error');
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
                tbody.innerHTML = '<tr><td colspan="6" class="py-4 text-gray-500 text-center">No adapters found</td></tr>';
                return;
            }
            
            tbody.innerHTML = adapters.map(adapter => {
        // Get data usage from the adapter's dataUsage object
        const usageDaily = adapter.dataUsage?.usageDaily || 0;
        const usageMonthly = adapter.dataUsage?.usageMonthly || 0;
        const adapterId = adapter.name || adapter.adapterID || 'Unknown';
        
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
 * Update the Latency column of the adapters table from connection stats
 */
function updateAdapterLatency() {
    for (const [adapterId, conn] of Object.entries(connectionMap)) {
        const cell = document.getElementById('lat-' + adapterId);
        if (!cell) continue;
        
        let text = '—';
        if (conn.latencyMs != null) {
            const loss = (conn.lossReceive || 0) * 100;
            text = `${Math.round(conn.latencyMs)} ms`;
            if (loss > 0) {
                text += ` · ${loss < 0.1 ? loss.toFixed(2) : loss.toFixed(1)}% loss`;
            }
        }
        cell.textContent = text;
    }
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
            if (count) count.textContent = bypasses.length ? `${bypasses.length}` : '';
            
            if (bypasses.length === 0) {
                container.innerHTML = '<span class="text-gray-500 text-sm">No bypasses configured</span>';
                return;
            }
            
            container.innerHTML = bypasses.map(domain => `
                <span class="chip">
                    ${escapeHtml(domain)}
                    <button onclick="removeBypass('${escapeHtml(domain)}')" title="Remove ${escapeHtml(domain)}"
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
            if (count) count.textContent = ports.length ? `${ports.length}` : '';
            
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
                        <button onclick="removePortBypass('${escapeHtml(String(portNum))}')" title="Remove port ${portNum}"
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
                pushSpeedSample(mbps);
                
                // Per-direction breakdown using the same unit as the combined value
                const speedBreakdownElement = document.getElementById('speedBreakdown');
                if (speedBreakdownElement) {
                    const downMbps = (downloadBps * 8) / (1024 * 1024);
                    const upMbps = (uploadBps * 8) / (1024 * 1024);
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
            if (dataDownloadedSub && stats.maxDownloadMbps) {
                dataDownloadedSub.textContent = 'Last 30 days · peak ' + Number(stats.maxDownloadMbps).toFixed(1) + ' Mbps';
            }
            if (dataUploadedSub && stats.maxUploadMbps) {
                dataUploadedSub.textContent = 'Last 30 days · peak ' + Number(stats.maxUploadMbps).toFixed(1) + ' Mbps';
            }
            
            // Cache per-connection quality stats for the adapters table
            connectionMap = {};
            for (const conn of stats.connections || []) {
                if (conn.adapterID) {
                    connectionMap[conn.adapterID] = conn;
                }
            }
            updateAdapterLatency();
        }
    } catch (error) {
        console.error('Error loading stats:', error);
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
 * Remove bypass (global function)
 */
window.removeBypass = async function(domain) {
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
 * Remove port bypass (global function)
 */
window.removePortBypass = async function(port) {
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
 * Format speed to human-readable format
 */
function formatSpeed(speedMbps) {
    if (speedMbps < 1) {
        return (speedMbps * 1024).toFixed(2) + ' KB/s';
    }
    return speedMbps.toFixed(2) + ' MB/s';
}

/**
 * Push a new throughput sample into the sparkline history
 */
function pushSpeedSample(mbps) {
    speedHistory.push(mbps);
    if (speedHistory.length > 40) {
        speedHistory.shift();
    }
    renderSparkline();
}

/**
 * Render the inline SVG sparkline of recent total throughput
 */
function renderSparkline() {
    const svg = document.getElementById('speedSparkline');
    if (!svg) return;
    if (speedHistory.length < 2) {
        svg.innerHTML = '';
        return;
    }
    
    const w = 100, h = 30;
    const max = Math.max(...speedHistory, 1);
    const points = speedHistory
        .map((v, i) => {
            const x = (i / (speedHistory.length - 1)) * w;
            const y = h - (v / max) * (h - 4) - 2;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    
    svg.innerHTML =
        `<polyline points="${points}" fill="none" stroke="#34d399" stroke-width="1.5"` +
        ` vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"` +
        ` opacity="0.85"/>`;
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

