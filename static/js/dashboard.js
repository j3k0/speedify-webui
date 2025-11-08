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

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Speedify Dashboard initialized');
    
    // Setup event listeners
    setupEventListeners();
    
    // Load initial data
    loadAllData();
    
    // Start auto-refresh
    startAutoRefresh();
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
 * Load all dashboard data
 */
async function loadAllData() {
    await Promise.all([
        loadStatus(),
        loadAdapters(),
        loadServers(),
        loadBypasses(),
        loadStats()
    ]);
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
            
            // Update status indicator
            const indicator = document.getElementById('statusIndicator');
            const statusText = document.getElementById('statusText');
            
            if (isConnected) {
                indicator.className = 'w-3 h-3 rounded-full bg-green-500';
                statusText.textContent = 'Connected';
                statusText.className = 'text-lg font-medium text-green-400';
            } else {
                indicator.className = 'w-3 h-3 rounded-full bg-red-500';
                statusText.textContent = 'Disconnected';
                statusText.className = 'text-lg font-medium text-red-400';
            }
            
            // Update current server
            const serverElement = document.getElementById('currentServer');
            if (state.city && state.country) {
                serverElement.textContent = `${state.city}, ${state.country.toUpperCase()}`;
            } else if (state.country) {
                serverElement.textContent = state.country.toUpperCase();
            } else {
                serverElement.textContent = '-';
            }
            
            // Update public IP
            const ipElement = document.getElementById('publicIp');
            ipElement.textContent = state.publicIp || '-';
            
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
                tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-gray-400 text-center">No adapters found</td></tr>';
                return;
            }
            
            tbody.innerHTML = adapters.map(adapter => `
                <tr class="border-b border-gray-700">
                    <td class="py-3">${adapter.name || adapter.adapterID || 'Unknown'}</td>
                    <td class="py-3">
                        <span class="px-2 py-1 bg-gray-700 rounded text-sm">
                            ${adapter.type || adapter.connectionType || 'Unknown'}
                        </span>
                    </td>
                    <td class="py-3">
                        ${getAdapterStateHtml(adapter.state || adapter.adapterState)}
                    </td>
                    <td class="py-3">
                        <span class="font-medium">${adapter.priority || adapter.priorityBonus || 0}</span>
                    </td>
                    <td class="py-3">
                        <div class="text-sm">
                            <div class="text-green-400">↓ ${formatBytes(adapter.bytesDown || 0)}</div>
                            <div class="text-blue-400">↑ ${formatBytes(adapter.bytesUp || 0)}</div>
                        </div>
                    </td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading adapters:', error);
    }
}

/**
 * Get HTML for adapter state badge
 */
function getAdapterStateHtml(state) {
    const stateMap = {
        'connected': '<span class="px-2 py-1 bg-green-600 rounded text-sm">Connected</span>',
        'disconnected': '<span class="px-2 py-1 bg-red-600 rounded text-sm">Disconnected</span>',
        'connecting': '<span class="px-2 py-1 bg-yellow-600 rounded text-sm">Connecting</span>',
        'enabled': '<span class="px-2 py-1 bg-green-600 rounded text-sm">Enabled</span>',
        'disabled': '<span class="px-2 py-1 bg-gray-600 rounded text-sm">Disabled</span>'
    };
    
    return stateMap[state] || `<span class="px-2 py-1 bg-gray-600 rounded text-sm">${state || 'Unknown'}</span>`;
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
            
            if (bypasses.length === 0) {
                container.innerHTML = '<div class="text-gray-400 text-center py-4">No bypasses configured</div>';
                return;
            }
            
            container.innerHTML = bypasses.map(domain => `
                <div class="flex items-center justify-between p-3 bg-gray-750 rounded-lg border border-gray-700">
                    <span class="text-gray-200">${domain}</span>
                    <button onclick="removeBypass('${domain}')" 
                            class="bg-red-600 hover:bg-red-700 text-white text-sm font-semibold py-1 px-3 rounded transition duration-200">
                        Remove
                    </button>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading bypasses:', error);
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
            
            // Note: Speedify CLI doesn't provide real-time speed through simple commands
            // The stats() function requires callbacks/streaming which doesn't work well with REST
            // So we show "N/A" for speeds and display cumulative data usage instead
            
            document.getElementById('downloadSpeed').textContent = 'N/A';
            document.getElementById('uploadSpeed').textContent = 'N/A';
            
            // Update data usage (monthly total, split roughly in half for display)
            const totalUsage = stats.totalMonthly || 0;
            document.getElementById('dataDownloaded').textContent = formatBytes(totalUsage / 2);
            document.getElementById('dataUploaded').textContent = formatBytes(totalUsage / 2);
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
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
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

