/**
 * PARKOREEN - Runtime
 * Shared functionality across all pages
 */

// ============================================
// API CONFIGURATION
// ============================================
const API_URL = 'https://parkoreen.ikunbeautiful.workers.dev';
const API_TIMEOUT = 10000; // 10 seconds timeout

// Set to true to use local storage instead of API (for testing without backend)
// KV namespaces are now configured!
const USE_LOCAL_MODE = false;

// Device presentation is detected from input capabilities and mobile/tablet
// user agents. This intentionally stays out of account settings.
const ParkoreenDevice = (() => {
    const mobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
    let activeInputMode = null;
    let lastReportedMobile = null;

    function hasTouch() {
        return (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    }

    function isMobile() {
        if (activeInputMode === 'touch') return true;
        if (activeInputMode === 'pointer' || activeInputMode === 'keyboard') return false;
        const ua = navigator.userAgent || '';
        const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches || false;
        const noHover = window.matchMedia?.('(hover: none)').matches || false;
        // iPadOS can use a desktop-style Macintosh UA. Multiple touch points
        // on that platform distinguish it from an ordinary Mac laptop.
        const ipadOS = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
        return mobileUserAgent.test(ua) || ipadOS || (hasTouch() && (coarsePointer || noHover));
    }

    function apply() {
        const mobile = isMobile();
        document.body?.classList.toggle('device-mobile', mobile);
        document.body?.classList.toggle('device-desktop', !mobile);
        if (lastReportedMobile === mobile) return;
        lastReportedMobile = mobile;
        window.dispatchEvent(new CustomEvent('parkoreen-device-change', {
            detail: { isMobile: mobile, hasTouch: hasTouch() }
        }));
    }

    // Hybrid devices (touch laptops, tablets with a mouse) can change their
    // preferred layout as the player changes input. Keep capability detection
    // as the startup fallback, then follow the most recent real pointer type.
    window.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch') activeInputMode = 'touch';
        else if (event.pointerType === 'mouse' || event.pointerType === 'pen') activeInputMode = 'pointer';
        else return;
        apply();
    }, { capture: true, passive: true });
    window.addEventListener('keydown', event => {
        if (event.isComposing || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        activeInputMode = 'keyboard';
        apply();
    }, { capture: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else {
        apply();
    }
    window.addEventListener('resize', apply, { passive: true });
    window.addEventListener('orientationchange', apply, { passive: true });
    window.matchMedia?.('(pointer: coarse)').addEventListener?.('change', apply);
    window.matchMedia?.('(hover: none)').addEventListener?.('change', apply);

    return { isMobile, hasTouch };
})();
window.ParkoreenDevice = ParkoreenDevice;

// ============================================
// FETCH WITH TIMEOUT
// ============================================
async function fetchWithTimeout(url, options = {}, timeout = API_TIMEOUT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const isAuthRequest = /\/auth\/(login|signup)(\?|$)/.test(url);
        if (response.status === 401 && window.Auth && !isAuthRequest) {
            window.Auth.logout();
            const currentPath = window.location.pathname + window.location.search;
            window.location.href = '/parkoreen/login/?redirect=' + encodeURIComponent(currentPath);
        }

        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. Please check your connection.');
        }
        throw new Error('Network error. Please check your connection.');
    }
}

// ============================================
// AUTH MANAGER
// ============================================
class AuthManager {
    constructor() {
        this.user = null;
        this.token = null;
        this.loadFromStorage();
    }

    loadFromStorage() {
        const savedUser = localStorage.getItem('parkoreen_user');
        const savedToken = localStorage.getItem('parkoreen_token');
        
        if (savedUser && savedToken) {
            try {
                this.user = JSON.parse(savedUser);
                this.token = savedToken;
            } catch (e) {
                this.logout();
            }
        }
    }

    saveToStorage() {
        if (this.user && this.token) {
            localStorage.setItem('parkoreen_user', JSON.stringify(this.user));
            localStorage.setItem('parkoreen_token', this.token);
        }
    }

    isLoggedIn() {
        return !!(this.user && this.token);
    }

    getToken() {
        return this.token;
    }

    getUser() {
        return this.user;
    }

    async login(username, password) {
        // Local mode - check local storage
        if (USE_LOCAL_MODE) {
            return this.localLogin(username, password);
        }

        try {
            const response = await fetchWithTimeout(`${API_URL}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            }, API_TIMEOUT * 4);

            if (!response.ok) {
                const error = await response.json().catch(() => ({ message: 'Login failed' }));
                throw new Error(error.message);
            }

            const data = await response.json();
            this.user = data.user;
            this.token = data.token;
            this.saveToStorage();

            // Pull per-account prefs now that we have a token (constructor-time
            // syncWithServer ran before the user was logged in).
            if (window.Settings) await window.Settings.syncWithServer();
            if (window.EditorPrefs) await window.EditorPrefs.syncWithServer();

            return data;
        } catch (err) {
            if (err.message === 'Request timed out. Please check your connection.') {
                throw new Error('Login timed out. Please check your connection and try again.');
            }
            throw err;
        }
    }

    async signup(name, username, password) {
        if (window.JimmyQrgManager?.isUnauthorizedReservedDisplayAttempt(name, username)) {
            window.JimmyQrgManager.triggerForReservedName();
            throw new Error('Nice try! ;)');
        }

        // Local mode - store in local storage
        if (USE_LOCAL_MODE) {
            return this.localSignup(name, username, password);
        }

        const response = await fetchWithTimeout(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, username, password })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Signup failed' }));
            throw new Error(error.message);
        }

        const data = await response.json();
        this.user = data.user;
        this.token = data.token;
        this.saveToStorage();
        
        return data;
    }

    // ========== LOCAL MODE METHODS (for testing without backend) ==========
    
    localLogin(username, password) {
        try {
            const usersStr = localStorage.getItem('parkoreen_local_users');
            console.log('[Auth] Local users storage:', usersStr);
            const users = JSON.parse(usersStr || '{}');
            const userKey = username.toLowerCase();
            const user = users[userKey];
            
            console.log('[Auth] Looking for user:', userKey);
            console.log('[Auth] Found user:', user ? 'yes' : 'no');
            
            if (!user) {
                throw new Error('User not found');
            }
            
            // Simple password check (not secure, just for local testing)
            if (user.password !== password) {
                console.log('[Auth] Password mismatch');
                throw new Error('Invalid password');
            }
            
            this.user = { id: user.id, name: user.name, username: user.username };
            this.token = 'local_' + user.id;
            this.saveToStorage();
            
            console.log('[Auth] Login successful:', this.user);
            return { user: this.user, token: this.token };
        } catch (e) {
            console.error('[Auth] Login error:', e);
            throw e;
        }
    }

    localSignup(name, username, password) {
        if (window.JimmyQrgManager?.isUnauthorizedReservedDisplayAttempt(name, username)) {
            window.JimmyQrgManager.triggerForReservedName();
            throw new Error('Nice try! ;)');
        }

        try {
            const usersStr = localStorage.getItem('parkoreen_local_users');
            const users = JSON.parse(usersStr || '{}');
            const userKey = username.toLowerCase();
            
            console.log('[Auth] Checking if username exists:', userKey);
            
            if (users[userKey]) {
                console.log('[Auth] Username already exists');
                throw new Error('Username already exists. Please choose a different username.');
            }
            
            const userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            
            users[userKey] = {
                id: userId,
                name,
                username,
                password, // In local mode, we store password directly (not secure, just for testing)
                createdAt: new Date().toISOString()
            };
            
            localStorage.setItem('parkoreen_local_users', JSON.stringify(users));
            console.log('[Auth] User created:', userId);
            
            this.user = { id: userId, name, username };
            this.token = 'local_' + userId;
            this.saveToStorage();
            
            return { user: this.user, token: this.token };
        } catch (e) {
            console.error('[Auth] Signup error:', e);
            throw e;
        }
    }

    async updateProfile(updates) {
        if (updates.name && window.JimmyQrgManager?.isUnauthorizedReservedDisplayAttempt(updates.name, this.user?.username)) {
            window.JimmyQrgManager.triggerForReservedName();
            throw new Error('Nice try! ;)');
        }

        if (USE_LOCAL_MODE) {
            return this.localUpdateProfile(updates);
        }

        const response = await fetchWithTimeout(`${API_URL}/auth/profile`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify(updates)
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Update failed' }));
            throw new Error(error.message);
        }

        const data = await response.json();
        this.user = { ...this.user, ...data.user };
        this.saveToStorage();
        
        return data;
    }

    async changePassword(currentPassword, newPassword) {
        if (USE_LOCAL_MODE) {
            return this.localChangePassword(currentPassword, newPassword);
        }

        const response = await fetchWithTimeout(`${API_URL}/auth/password`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify({ currentPassword, newPassword })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Password change failed' }));
            throw new Error(error.message);
        }

        return response.json();
    }

    localUpdateProfile(updates) {
        if (updates.name && window.JimmyQrgManager?.isUnauthorizedReservedDisplayAttempt(updates.name, this.user?.username)) {
            window.JimmyQrgManager.triggerForReservedName();
            throw new Error('Nice try! ;)');
        }

        const users = JSON.parse(localStorage.getItem('parkoreen_local_users') || '{}');
        const userKey = this.user.username.toLowerCase();
        
        if (users[userKey] && updates.name) {
            users[userKey].name = updates.name;
            localStorage.setItem('parkoreen_local_users', JSON.stringify(users));
            this.user.name = updates.name;
            this.saveToStorage();
        }
        
        return { user: this.user };
    }

    localChangePassword(currentPassword, newPassword) {
        const users = JSON.parse(localStorage.getItem('parkoreen_local_users') || '{}');
        const userKey = this.user.username.toLowerCase();
        
        if (!users[userKey]) {
            throw new Error('User not found');
        }
        
        if (users[userKey].password !== currentPassword) {
            throw new Error('Current password is incorrect');
        }
        
        users[userKey].password = newPassword;
        localStorage.setItem('parkoreen_local_users', JSON.stringify(users));
        
        return { success: true };
    }

    logout() {
        this.user = null;
        this.token = null;
        localStorage.removeItem('parkoreen_user');
        localStorage.removeItem('parkoreen_token');
    }

    requireAuth() {
        if (!this.isLoggedIn()) {
            // Preserve current URL as redirect destination
            var currentPath = window.location.pathname + window.location.search;
            window.location.href = '/parkoreen/login/?redirect=' + encodeURIComponent(currentPath);
            return false;
        }
        return true;
    }
}

// ============================================
// MAP MANAGER
// ============================================
class MapManager {
    constructor(auth) {
        this.auth = auth;
    }

    // Get local maps storage key for current user
    _getLocalMapsKey() {
        const user = this.auth.getUser();
        return user ? `parkoreen_local_maps_${user.id}` : 'parkoreen_local_maps';
    }

    _getLocalMaps() {
        return JSON.parse(localStorage.getItem(this._getLocalMapsKey()) || '{}');
    }

    _saveLocalMaps(maps) {
        localStorage.setItem(this._getLocalMapsKey(), JSON.stringify(maps));
    }

    async listMaps() {
        if (USE_LOCAL_MODE) {
            const maps = this._getLocalMaps();
            return Object.values(maps).map(m => ({
                id: m.id,
                name: m.name,
                createdAt: m.createdAt,
                updatedAt: m.updatedAt
            }));
        }

        const response = await fetchWithTimeout(`${API_URL}/maps`, {
            headers: {
                'Authorization': `Bearer ${this.auth.getToken()}`
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to load maps' }));
            throw new Error(error.message);
        }

        return response.json();
    }

    async getMap(mapId) {
        if (USE_LOCAL_MODE) {
            const maps = this._getLocalMaps();
            const map = maps[mapId];
            if (!map) {
                throw new Error('Map not found');
            }
            return map;
        }

        const response = await fetchWithTimeout(`${API_URL}/maps/${mapId}`, {
            headers: {
                'Authorization': `Bearer ${this.auth.getToken()}`
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to load map' }));
            throw new Error(error.message);
        }

        return response.json();
    }

    // Generate a unique name by appending a number if the name already exists
    _getUniqueName(existingMaps, baseName) {
        const existingNames = existingMaps.map(m => m.name.toLowerCase());
        
        // Check if the base name is already unique
        if (!existingNames.includes(baseName.toLowerCase())) {
            return baseName;
        }
        
        // Find the highest number suffix for this base name
        let maxNum = 1;
        const baseNameLower = baseName.toLowerCase();
        
        for (const existingName of existingNames) {
            // Check for exact match with number suffix (e.g., "Map 2", "Map 3")
            const match = existingName.match(new RegExp(`^${this._escapeRegex(baseNameLower)}\\s*(\\d+)?$`));
            if (match) {
                const num = match[1] ? parseInt(match[1]) : 1;
                if (num >= maxNum) {
                    maxNum = num + 1;
                }
            }
        }
        
        return `${baseName} ${maxNum}`;
    }
    
    _escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    async createMap(name) {
        if (USE_LOCAL_MODE) {
            const maps = this._getLocalMaps();
            const existingMaps = Object.values(maps);
            const uniqueName = this._getUniqueName(existingMaps, name);
            
            const mapId = 'map_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const map = {
                id: mapId,
                name: uniqueName,
                data: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            maps[mapId] = map;
            this._saveLocalMaps(maps);
            
            return { id: mapId, name: uniqueName };
        }

        // For API mode, first get existing maps to check for duplicates
        const existingMaps = await this.listMaps();
        const uniqueName = this._getUniqueName(existingMaps, name);

        const response = await fetchWithTimeout(`${API_URL}/maps`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.auth.getToken()}`
            },
            body: JSON.stringify({ name: uniqueName })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to create map' }));
            throw new Error(error.message);
        }

        return response.json();
    }

    async saveMap(mapId, data) {
        if (USE_LOCAL_MODE) {
            const maps = this._getLocalMaps();
            if (!maps[mapId]) {
                throw new Error('Map not found');
            }
            
            maps[mapId] = {
                ...maps[mapId],
                ...data,
                updatedAt: new Date().toISOString()
            };
            this._saveLocalMaps(maps);
            
            return { success: true };
        }

        const response = await fetchWithTimeout(`${API_URL}/maps/${mapId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.auth.getToken()}`
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to save map' }));
            throw new Error(error.message);
        }

        return response.json();
    }

    async adminGetMap(mapId) {
        if (USE_LOCAL_MODE) {
            throw new Error('Admin map API is not available in local mode');
        }
        const response = await fetchWithTimeout(`${API_URL}/admin/maps/${encodeURIComponent(mapId)}`, {
            headers: {
                'Authorization': `Bearer ${this.auth.getToken()}`
            }
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to load map' }));
            throw new Error(error.message);
        }
        return response.json();
    }

    async adminUpdateMap(mapId, data) {
        if (USE_LOCAL_MODE) {
            throw new Error('Admin map API is not available in local mode');
        }
        const response = await fetchWithTimeout(`${API_URL}/admin/maps/${encodeURIComponent(mapId)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.auth.getToken()}`
            },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to save map' }));
            throw new Error(error.message);
        }
        return response.json();
    }

    async adminDeleteMap(mapId) {
        if (USE_LOCAL_MODE) {
            throw new Error('Admin map API is not available in local mode');
        }
        const response = await fetchWithTimeout(`${API_URL}/admin/maps/${encodeURIComponent(mapId)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${this.auth.getToken()}`
            }
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to delete map' }));
            throw new Error(error.message);
        }
        return response.json();
    }

    async deleteMap(mapId) {
        if (USE_LOCAL_MODE) {
            const maps = this._getLocalMaps();
            if (!maps[mapId]) {
                throw new Error('Map not found');
            }
            
            delete maps[mapId];
            this._saveLocalMaps(maps);
            
            return { success: true };
        }

        const response = await fetchWithTimeout(`${API_URL}/maps/${mapId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${this.auth.getToken()}`
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to delete map' }));
            throw new Error(error.message);
        }

        return response.json();
    }

    async duplicateMap(mapId) {
        // Get the original map data
        const originalMap = await this.getMap(mapId);
        
        // Create a new map with the same name (will be auto-numbered)
        const newMap = await this.createMap(originalMap.name);
        
        // Copy the map data to the new map
        if (originalMap.data) {
            await this.saveMap(newMap.id, { data: originalMap.data });
        }
        
        return newMap;
    }
}

// ============================================
// MULTIPLAYER MANAGER
// ============================================
class MultiplayerManager {
    constructor(auth) {
        this.auth = auth;
        this.ws = null;
        this.roomCode = null;
        this.isHost = false;
        this.isAuthenticated = false;
        this.playerId = null;
        this.players = new Map();
        this.callbacks = {};
        this.mechanicsState = null;
        this.mechanicsRevision = 0;
        this.mechanicsServerTimestamp = null;
    }

    on(event, callback) {
        if (typeof callback !== 'function') return () => {};
        this.callbacks[event] = callback;
        return () => {
            if (this.callbacks[event] === callback) delete this.callbacks[event];
        };
    }

    off(event, callback) {
        if (this.callbacks[event] === callback) delete this.callbacks[event];
    }

    emit(event, data) {
        if (this.callbacks[event]) {
            this.callbacks[event](data);
        }
    }

    connect() {
        return new Promise((resolve, reject) => {
            const wsUrl = API_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws';
            console.log('[Multiplayer] Connecting to:', wsUrl);
            
            try {
                this.ws = new WebSocket(wsUrl);
            } catch (error) {
                console.error('[Multiplayer] Failed to create WebSocket:', error);
                reject(new Error('Multiplayer service unavailable. WebSocket connection failed.'));
                return;
            }
            
            // Connection timeout
            const timeout = setTimeout(() => {
                if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
                    this.ws.close();
                    reject(new Error('Connection timed out. Multiplayer server may be unavailable.'));
                }
            }, 10000);
            
            this.ws.onopen = () => {
                clearTimeout(timeout);
                console.log('[Multiplayer] Connected!');
                // Authenticate
                this.send({
                    type: 'auth',
                    token: this.auth.getToken()
                });
                resolve();
            };
            
            this.ws.onerror = (error) => {
                clearTimeout(timeout);
                console.error('[Multiplayer] WebSocket error:', error);
                reject(new Error('Multiplayer server unavailable. You can still edit maps locally.'));
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessage(data);
                } catch (e) {
                    console.error('[Multiplayer] Failed to parse message:', e);
                }
            };
            
            this.ws.onclose = (event) => {
                clearTimeout(timeout);
                console.log('[Multiplayer] Connection closed:', event.code, event.reason);
                this.emit('disconnected');
                this.ws = null;
            };
        });
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.roomCode = null;
        window.parkoreenRoomMapId = null;
        this.isHost = false;
        this.isAuthenticated = false;
        this.playerId = null;
        this.players.clear();
        this.mechanicsState = null;
        this.mechanicsRevision = 0;
        this.mechanicsServerTimestamp = null;
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
            return true;
        }
        return false;
    }

    acceptMechanicsState(state, revision, serverTimestamp = null) {
        if (!Number.isInteger(revision) || revision < 1 || revision <= this.mechanicsRevision ||
            !state || typeof state !== 'object' || Array.isArray(state)) return;
        this.mechanicsRevision = revision;
        this.mechanicsState = state;
        this.mechanicsServerTimestamp = Number.isSafeInteger(serverTimestamp) ? serverTimestamp : null;
        this.emit('mechanicsState', { revision, state, serverTimestamp: this.mechanicsServerTimestamp });
    }

    handleMessage(data) {
        switch (data.type) {
            case 'auth_success':
                this.playerId = typeof data.playerId === 'string' ? data.playerId : null;
                if (window.engine?.localPlayer && this.playerId) window.engine.localPlayer.id = this.playerId;
                this.emit('authenticated');
                break;
                
            case 'room_created':
                this.roomCode = data.roomCode;
                this.isHost = true;
                this.mechanicsState = null;
                this.mechanicsRevision = 0;
                this.mechanicsServerTimestamp = null;
                if (window.engine?.localPlayer) {
                    if (this.playerId) window.engine.localPlayer.id = this.playerId;
                    window.engine.localPlayer.isHost = true;
                }
                this.emit('roomCreated', data);
                break;
                
            case 'room_joined':
                this.roomCode = data.roomCode;
                this.isHost = false;
                window.parkoreenRoomMapId = typeof data.mapId === 'string' && data.mapId ? data.mapId : null;
                this.mechanicsState = null;
                this.mechanicsRevision = 0;
                this.mechanicsServerTimestamp = null;
                this.acceptMechanicsState(data.mechanicsState, data.mechanicsRevision, data.mechanicsServerTimestamp);
                if (window.engine?.localPlayer) {
                    if (this.playerId) window.engine.localPlayer.id = this.playerId;
                    window.engine.localPlayer.isHost = false;
                }
                if (data.players) {
                    data.players.forEach(p => {
                        this.players.set(p.id, { id: p.id, name: p.name, username: p.username, color: p.color });
                    });
                }
                this.emit('roomJoined', data);
                break;
                
            case 'room_rejoined':
                this.roomCode = data.roomCode;
                this.isHost = data.isHost || false;
                window.parkoreenRoomMapId = typeof data.mapId === 'string' && data.mapId ? data.mapId : null;
                this.mechanicsState = null;
                this.mechanicsRevision = 0;
                this.mechanicsServerTimestamp = null;
                this.acceptMechanicsState(data.mechanicsState, data.mechanicsRevision, data.mechanicsServerTimestamp);
                if (window.engine?.localPlayer) {
                    if (this.playerId) window.engine.localPlayer.id = this.playerId;
                    window.engine.localPlayer.isHost = this.isHost;
                }
                // Add existing players
                if (data.players) {
                    data.players.forEach(p => {
                        this.players.set(p.id, { id: p.id, name: p.name, username: p.username, color: p.color });
                    });
                }
                this.emit('roomRejoined', data);
                break;
                
            case 'player_joined':
                this.players.set(data.playerId, {
                    id: data.playerId,
                    name: data.playerName,
                    username: data.playerUsername,
                    color: data.playerColor
                });
                this.emit('playerJoined', data);
                break;
                
            case 'player_left':
                const leavingPlayer = this.players.get(data.playerId);
                this.players.delete(data.playerId);
                this.emit('playerLeft', {
                    ...data,
                    playerName: data.playerName || leavingPlayer?.name,
                    playerUsername: data.playerUsername || leavingPlayer?.username
                });
                break;
                
            case 'player_position':
                this.emit('playerPosition', data);
                break;

            case 'mechanics_state':
                this.acceptMechanicsState(data.state, data.revision);
                break;

            case 'mechanics_event_request':
                this.emit('mechanicsEventRequest', data);
                break;

            case 'global_coin_collected':
                this.emit('globalCoinCollected', data);
                break;

            case 'global_coin_collection_rejected':
                this.emit('globalCoinCollectionRejected', data);
                break;
            
            case 'position_ack':
                this.emit('positionAck', data);
                break;
                
            case 'player_kicked':
                this.roomCode = null;
                window.parkoreenRoomMapId = null;
                this.isHost = false;
                if (window.engine?.localPlayer) window.engine.localPlayer.isHost = null;
                this.mechanicsState = null;
                this.mechanicsRevision = 0;
                this.mechanicsServerTimestamp = null;
                this.emit('kicked', data);
                break;
                
            case 'room_closed':
                this.roomCode = null;
                window.parkoreenRoomMapId = null;
                this.isHost = false;
                if (window.engine?.localPlayer) window.engine.localPlayer.isHost = null;
                this.mechanicsState = null;
                this.mechanicsRevision = 0;
                this.mechanicsServerTimestamp = null;
                this.emit('roomClosed', data);
                break;
                
            case 'game_end':
                this.emit('gameEnd', data);
                break;
                
            case 'chat_message':
                this.emit('chatMessage', data);
                break;

            case 'title_message':
                this.emit('titleMessage', data);
                break;

            case 'admin_title_result':
                this.emit('adminTitleResult', data);
                break;
                
            case 'error':
                this.emit('error', data);
                break;
        }
    }

    async hostGame(options) {
        if (!this.ws) {
            await this.connect();
        }

        // Wait for authentication before creating room
        await this.waitForAuth();

        this.send({
            type: 'create_room',
            mapData: options.mapData,
            mapId: options.mapId != null ? options.mapId : null,
            mapName: options.mapName != null ? options.mapName : null,
            maxPlayers: options.maxPlayers,
            usePassword: options.usePassword,
            password: options.password
        });
    }

    async joinGame(roomCode, password = null) {
        if (!this.ws) {
            await this.connect();
        }

        // Wait for authentication before joining room
        await this.waitForAuth();

        this.send({
            type: 'join_room',
            roomCode,
            password
        });
    }

    waitForAuth() {
        return new Promise((resolve, reject) => {
            // If already authenticated, resolve immediately
            if (this.isAuthenticated) {
                resolve();
                return;
            }

            // Wait for auth_success
            const timeout = setTimeout(() => {
                reject(new Error('Authentication timed out'));
            }, 10000);

            const originalCallback = this.callbacks['authenticated'];
            this.on('authenticated', () => {
                clearTimeout(timeout);
                this.isAuthenticated = true;
                if (originalCallback) originalCallback();
                resolve();
            });
        });
    }

    leaveRoom() {
        this.send({ type: 'leave_room' });
        this.roomCode = null;
        window.parkoreenRoomMapId = null;
        this.isHost = false;
        if (window.engine?.localPlayer) window.engine.localPlayer.isHost = null;
        this.mechanicsState = null;
        this.mechanicsRevision = 0;
        this.mechanicsServerTimestamp = null;
        this.players.clear();
    }

    sendMechanicsState(state) {
        if (!this.roomCode || !this.isHost) return false;
        return this.send({ type: 'mechanics_state', state });
    }

    requestMechanicsEvent(triggerId, eventId, touchedPlayerId = null, triggerEvidence = null) {
        if (!this.roomCode || this.isHost) return false;
        const player = window.engine?.localPlayer;
        if (player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
            const jumps = Number.isSafeInteger(player.jumpsRemaining) && player.jumpsRemaining >= 0
                ? player.jumpsRemaining
                : 1;
            // Send the current contact position before the event request so
            // the room worker can verify zone and object overlap conditions.
            this.sendPosition(player.x, player.y, player.vx, player.vy, jumps);
        }
        return this.send({
            type: 'mechanics_event_request',
            triggerId,
            eventId,
            choiceParentEventId: typeof triggerEvidence?.choiceParentEventId === 'string'
                ? triggerEvidence.choiceParentEventId : null,
            touchedPlayerId: typeof touchedPlayerId === 'string' ? touchedPlayerId : null,
            inputKeys: Array.isArray(triggerEvidence?.inputKeys) ? triggerEvidence.inputKeys : undefined
        });
    }

    requestGlobalCoinCollection(coinId) {
        if (!this.roomCode || typeof coinId !== 'string' || !coinId) return false;
        const player = window.engine?.localPlayer;
        if (player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
            const jumps = Number.isSafeInteger(player.jumpsRemaining) && player.jumpsRemaining >= 0
                ? player.jumpsRemaining
                : 1;
            this.sendPosition(player.x, player.y, player.vx, player.vy, jumps);
        }
        return this.send({ type: 'global_coin_collect_request', coinId });
    }

    sendPosition(x, y, vx = 0, vy = 0, jumps = 1) {
        this.send({
            type: 'position',
            x,
            y,
            vx,
            vy,
            jumps
        });
    }

    kickPlayer(playerId) {
        if (!this.isHost) return;
        
        this.send({
            type: 'kick_player',
            playerId
        });
    }

    sendChatMessage(message) {
        this.send({
            type: 'chat',
            message
        });
    }

    sendAdminTitle(playerIds, color, text) {
        if (!this.isHost) return;
        this.send({
            type: 'admin_title',
            playerIds,
            color,
            text
        });
    }

    getPlayers() {
        return Array.from(this.players.values());
    }

    getRoomCode() {
        return this.roomCode;
    }
}

// ============================================
// JIMMYQRG EASTER EGG MANAGER
// ============================================
const RESERVED_DISPLAY_NAMES = ['jimmyqrg', 'parkoreen'];

/** Must match cloudflare-worker RESERVED_NAMES — who may use each reserved display name */
const RESERVED_DISPLAY_NAME_ALLOWLIST = {
    jimmyqrg: ['jimmyqrg', 'jimmyqrg160', 'jimmyqrgschool', 'parkoreen'],
    parkoreen: ['jimmyqrg', 'jimmyqrg160', 'jimmyqrgschool', 'parkoreen']
};

class JimmyQrgManager {
    constructor() {
        this.DB_NAME = 'ParkoreenEasterEgg';
        this.DB_STORE = 'flags';
        this.FLAG_KEY = 'JIMMYQRG';
        this.popupElement = null;
        this.isPhase2 = false;
    }

    // Check if name is reserved
    isReservedName(name) {
        if (!name) return false;
        return RESERVED_DISPLAY_NAMES.includes(name.toLowerCase().trim());
    }

    /** True → block signup/profile and show easter egg (reserved display, username not allowlisted) */
    isUnauthorizedReservedDisplayAttempt(displayName, username) {
        if (!this.isReservedName(displayName)) return false;
        const key = displayName.toLowerCase().trim();
        const allowed = RESERVED_DISPLAY_NAME_ALLOWLIST[key];
        if (!allowed || !allowed.length) return true;
        return !allowed.includes((username || '').toLowerCase());
    }

    // ========== LOCAL STORAGE ==========
    getLocalStorage() {
        return localStorage.getItem(this.FLAG_KEY) === 'true';
    }

    setLocalStorage(value) {
        if (value) {
            localStorage.setItem(this.FLAG_KEY, 'true');
        } else {
            localStorage.removeItem(this.FLAG_KEY);
        }
    }

    // ========== INDEXED DB ==========
    async openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.DB_STORE)) {
                    db.createObjectStore(this.DB_STORE, { keyPath: 'key' });
                }
            };
        });
    }

    async getIndexedDB() {
        try {
            const db = await this.openDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.DB_STORE, 'readonly');
                const store = tx.objectStore(this.DB_STORE);
                const request = store.get(this.FLAG_KEY);
                request.onsuccess = () => resolve(request.result?.value === true);
                request.onerror = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    async setIndexedDB(value) {
        try {
            const db = await this.openDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.DB_STORE, 'readwrite');
                const store = tx.objectStore(this.DB_STORE);
                if (value) {
                    store.put({ key: this.FLAG_KEY, value: true });
                } else {
                    store.delete(this.FLAG_KEY);
                }
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    // ========== SERVER STORAGE ==========
    async getServer() {
        try {
            const token = window.Auth?.getToken();
            // Skip the request entirely if not logged in — avoids a noisy 401 in the
            // network log for every page load when no session is present.
            if (!token) return false;
            if (!window.Auth?.isLoggedIn()) return false;

            const response = await fetch(`${API_URL}/flag/${this.FLAG_KEY}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return false;
            const data = await response.json();
            return data.value === true;
        } catch {
            return false;
        }
    }

    async setServer(value) {
        try {
            const token = window.Auth?.getToken();
            if (!token) return false;
            if (!window.Auth?.isLoggedIn()) return false;

            const response = await fetch(`${API_URL}/flag/${this.FLAG_KEY}`, {
                method: value ? 'PUT' : 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ value: true })
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // ========== COMBINED OPERATIONS ==========
    async checkFlagExists() {
        const [local, indexed, server] = await Promise.all([
            this.getLocalStorage(),
            this.getIndexedDB(),
            this.getServer()
        ]);
        return local || indexed || server;
    }

    async setAllFlags(value) {
        await Promise.all([
            this.setLocalStorage(value),
            this.setIndexedDB(value),
            this.setServer(value)
        ]);
    }

    async clearAllFlags() {
        await this.setAllFlags(false);
    }

    // ========== POPUP MANAGEMENT ==========
    createPopup() {
        // Remove existing popup if any
        this.removePopup();

        const overlay = document.createElement('div');
        overlay.id = 'jimmyqrg-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            font-family: 'Parkoreen UI', -apple-system, BlinkMacSystemFont, sans-serif;
        `;

        const popup = document.createElement('div');
        popup.id = 'jimmyqrg-popup';
        popup.style.cssText = `
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border: 2px solid #4ade80;
            border-radius: 16px;
            padding: 32px;
            max-width: 450px;
            text-align: center;
            box-shadow: 0 0 40px rgba(74, 222, 128, 0.3);
        `;

        this.updatePopupContent(popup);
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        this.popupElement = overlay;

        // Prevent closing via escape or clicking outside
        overlay.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('keydown', this.blockEscape);

        // Anti-adblocker: Re-create if removed
        this.startAntiRemovalCheck();
    }

    updatePopupContent(popup) {
        if (!popup) popup = document.getElementById('jimmyqrg-popup');
        if (!popup) return;

        const title = this.isPhase2 ? ':):):):):):):):):)' : ':):):):):)';
        const content = this.isPhase2 
            ? "Come on, you can't avoid this."
            : "If you really love me that much, why don't you go ahead and create a fan club?";
        
        const buttonLabels = this.isPhase2
            ? ['YES I DID', 'YES I DID', 'YES I DID', 'YES I DID', 'No one would do that']
            : ['YES I DID', 'Yes I did', 'Yes I did', 'Yes I did', 'No one would do that'];

        popup.innerHTML = `
            <h1 style="color: #4ade80; font-size: 2.5rem; margin: 0 0 20px 0; letter-spacing: 4px;">${title}</h1>
            <p style="color: #e0e0e0; font-size: 1.1rem; line-height: 1.6; margin: 0 0 28px 0;">${content}</p>
            <div style="display: flex; flex-direction: column; gap: 12px;">
                ${buttonLabels.map((label, index) => {
                    const isDisabled = this.isPhase2 && index === 4;
                    const isDefault = index === 0;
                    return `
                        <button 
                            class="jimmyqrg-btn" 
                            data-index="${index}"
                            style="
                                padding: 14px 24px;
                                font-size: 1rem;
                                font-weight: ${isDefault ? '600' : '500'};
                                border-radius: 8px;
                                cursor: ${isDisabled ? 'not-allowed' : 'pointer'};
                                transition: all 0.2s ease;
                                font-family: inherit;
                                ${isDefault ? `
                                    background: linear-gradient(135deg, #22c55e, #16a34a);
                                    border: none;
                                    color: white;
                                    box-shadow: 0 4px 15px rgba(34, 197, 94, 0.4);
                                ` : isDisabled ? `
                                    background: #333;
                                    border: 1px solid #444;
                                    color: #666;
                                ` : `
                                    background: rgba(255,255,255,0.1);
                                    border: 1px solid rgba(255,255,255,0.2);
                                    color: #ccc;
                                `}
                            "
                            ${isDisabled ? 'disabled' : ''}
                        >${label}</button>
                    `;
                }).join('')}
            </div>
        `;

        // Attach button handlers
        popup.querySelectorAll('.jimmyqrg-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleButtonClick(e));
            btn.addEventListener('mouseenter', (e) => {
                if (!e.target.disabled) {
                    e.target.style.transform = 'scale(1.02)';
                }
            });
            btn.addEventListener('mouseleave', (e) => {
                e.target.style.transform = 'scale(1)';
            });
        });
    }

    async handleButtonClick(e) {
        const index = parseInt(e.target.dataset.index);
        
        if (index === 4) {
            // "No one would do that" button
            if (!this.isPhase2) {
                this.isPhase2 = true;
                this.updatePopupContent();
            }
            return;
        }

        // Any "YES I DID" / "Yes I did" button
        this.removePopup();
        await this.clearAllFlags();
        this.showGoodBoyPopup();
    }

    showGoodBoyPopup() {
        const message = this.isPhase2 ? 'GOOOOOOOOD BOOOOOYY :)' : 'Good Boy';
        
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            font-family: 'Parkoreen UI', -apple-system, BlinkMacSystemFont, sans-serif;
        `;

        const popup = document.createElement('div');
        popup.style.cssText = `
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border: 2px solid #4ade80;
            border-radius: 16px;
            padding: 40px 60px;
            text-align: center;
            box-shadow: 0 0 60px rgba(74, 222, 128, 0.4);
        `;

        popup.innerHTML = `
            <h1 style="color: #4ade80; font-size: ${this.isPhase2 ? '2rem' : '2.5rem'}; margin: 0 0 24px 0;">${message}</h1>
            <button id="goodboy-ok" style="
                padding: 14px 48px;
                font-size: 1.1rem;
                font-weight: 600;
                background: linear-gradient(135deg, #22c55e, #16a34a);
                border: none;
                color: white;
                border-radius: 8px;
                cursor: pointer;
                font-family: inherit;
                box-shadow: 0 4px 15px rgba(34, 197, 94, 0.4);
            ">OK</button>
        `;

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        document.getElementById('goodboy-ok').addEventListener('click', () => {
            overlay.remove();
            document.removeEventListener('keydown', this.blockEscape);
        });
    }

    blockEscape = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    removePopup() {
        if (this.popupElement) {
            this.popupElement.remove();
            this.popupElement = null;
        }
        const existing = document.getElementById('jimmyqrg-overlay');
        if (existing) existing.remove();
        this.stopAntiRemovalCheck();
    }

    // Anti-removal check (in case popup is removed by extensions)
    startAntiRemovalCheck() {
        this.antiRemovalInterval = setInterval(() => {
            if (!document.getElementById('jimmyqrg-overlay')) {
                this.createPopup();
            }
        }, 100);
    }

    stopAntiRemovalCheck() {
        if (this.antiRemovalInterval) {
            clearInterval(this.antiRemovalInterval);
            this.antiRemovalInterval = null;
        }
    }

    // ========== MAIN TRIGGER ==========
    async triggerForReservedName() {
        await this.setAllFlags(true);
        this.isPhase2 = false;
        this.createPopup();
    }

    // Check on page load
    async checkOnLoad() {
        const flagExists = await this.checkFlagExists();
        if (flagExists) {
            this.isPhase2 = false;
            this.createPopup();
        }
    }
}

// Global instance
window.JimmyQrgManager = new JimmyQrgManager();

// Check on page load
document.addEventListener('DOMContentLoaded', () => {
    window.JimmyQrgManager.checkOnLoad();
});

// ============================================
// SETTINGS MANAGER
// ============================================
/** Usernames that may use admin role / admin API (must match worker ADMIN_USERNAMES) */
const PARKOREEN_ADMIN_USERNAMES = ['jimmyqrg', 'parkoreen'];
function isParkoreenAdminUsername(username) {
    return !!username && PARKOREEN_ADMIN_USERNAMES.includes(String(username).toLowerCase());
}

class SettingsManager {
    constructor() {
        this.defaults = {
            volume: 100,
            fontSize: 100, // percentage (50-150)
            keyboardLayout: 'jimmyqrg',
            roleMode: 'normal',
            controllableJumpEnabled: false,
            testerShowTouchboxes: false,
            theme: 'default'
        };
        this.settings = { ...this.defaults };
        // Load synchronously from local cache so the constructor stays usable
        // for callers that read settings immediately. The async sync with the
        // server is started after construction by `syncWithServer()`.
        this.loadFromLocal();
        this.applyFontSize();
    }

    applyFontSize() {
        const size = this.settings.fontSize || 100;
        document.documentElement.style.fontSize = `${size}%`;
    }

    loadFromLocal() {
        const saved = localStorage.getItem('parkoreen_settings');
        if (saved) {
            try {
                this.settings = { ...this.defaults, ...JSON.parse(saved) };
                delete this.settings.touchscreenMode;
            } catch (e) {
                this.settings = { ...this.defaults };
            }
        }
        if (this.settings.roleMode === 'admin') {
            const user = JSON.parse(localStorage.getItem('parkoreen_user') || '{}');
            if (!isParkoreenAdminUsername(user.username)) {
                this.settings.roleMode = 'normal';
                this._saveLocal();
            }
        }
    }

    _saveLocal() {
        localStorage.setItem('parkoreen_settings', JSON.stringify(this.settings));
    }

    // Fetch the server-side settings for the logged-in user. If the server
    // has nothing yet but local cache has data, push local → server (one-time
    // migration from device-bound to account-bound storage). If both have
    // data, server wins (account is the source of truth).
    async syncWithServer() {
        if (!window.Auth || !Auth.isLoggedIn()) return;
        const token = Auth.getToken();
        if (!token) return;
        try {
            const res = await fetchWithTimeout(`${API_URL}/settings`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.settings && typeof data.settings === 'object') {
                this.settings = { ...this.defaults, ...this.settings, ...data.settings };
                delete this.settings.touchscreenMode;
                this._saveLocal();
                this.applyFontSize();
            } else {
                // Server has no settings yet — migrate local cache up
                const localRaw = localStorage.getItem('parkoreen_settings');
                if (localRaw) {
                    await fetchWithTimeout(`${API_URL}/settings`, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ settings: this.settings })
                    });
                }
            }
        } catch (e) {
            // Network failure: keep using local cache; will retry next page load.
        }
    }

    save() {
        this._saveLocal();
        if (!window.Auth || !Auth.isLoggedIn()) return;
        const token = Auth.getToken();
        if (!token) return;
        // Fire-and-forget server write. Failures are silent (local cache wins
        // for this session; next syncWithServer() will reconcile).
        fetch(`${API_URL}/settings`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ settings: this.settings })
        }).catch(() => {});
    }

    get(key) {
        return this.settings[key];
    }

    set(key, value) {
        this.settings[key] = value;
        this.save();

        // Apply font size immediately when changed
        if (key === 'fontSize') {
            this.applyFontSize();
        }
    }

    reset() {
        this.settings = { ...this.defaults };
        this.save();
    }
}

// ============================================
// EDITOR PREFERENCES (recent fonts)
// ============================================
class EditorPrefs {
    constructor() {
        this.fonts = this._loadLocal();
    }

    _loadLocal() {
        try {
            return JSON.parse(localStorage.getItem('parkoreen_recent_fonts') || '[]');
        } catch (e) {
            return [];
        }
    }

    _saveLocal() {
        localStorage.setItem('parkoreen_recent_fonts', JSON.stringify(this.fonts));
    }

    // Sync with server. If server has data, replace local; otherwise push
    // local → server (one-time migration).
    async syncWithServer() {
        if (!window.Auth || !Auth.isLoggedIn()) return;
        const token = Auth.getToken();
        if (!token) return;
        try {
            const res = await fetchWithTimeout(`${API_URL}/editor/recent-fonts`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) return;
            const data = await res.json();
            if (Array.isArray(data.fonts) && data.fonts.length > 0) {
                this.fonts = data.fonts;
                this._saveLocal();
            } else if (this.fonts.length > 0) {
                await fetchWithTimeout(`${API_URL}/editor/recent-fonts`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ fonts: this.fonts })
                });
            }
        } catch (e) {
            // Offline: keep local cache.
        }
    }

    add(font) {
        if (!font || typeof font !== 'string') return;
        this.fonts = this.fonts.filter(f => f !== font);
        this.fonts.push(font);
        if (this.fonts.length > 20) this.fonts = this.fonts.slice(-20);
        this._saveLocal();
        this._syncList();
    }

    // Push the current list verbatim to the server. Use after mutations that
    // don't fit the add() pattern (e.g. removal, trim).
    _syncList() {
        if (!window.Auth || !Auth.isLoggedIn()) return;
        const token = Auth.getToken();
        if (!token) return;
        fetch(`${API_URL}/editor/recent-fonts`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ fonts: this.fonts })
        }).catch(() => {});
    }
}

// ============================================
// NAVIGATION
// ============================================
const Navigation = {
    toDashboard() {
        window.location.href = '/parkoreen/dashboard/';
    },
    
    toEditor(mapId) {
        window.location.href = `/parkoreen/host.html?map=${mapId}`;
    },
    
    toJoin() {
        window.location.href = '/parkoreen/join.html';
    },
    
    toSettings() {
        window.location.href = '/parkoreen/settings/';
    },

    toMails() {
        window.location.href = '/parkoreen/mails/';
    },

    toAdmin() {
        window.location.href = '/parkoreen/admin/';
    },
    
    toHowToPlay() {
        window.location.href = '/parkoreen/howtoplay/';
    },
    
    toLogin() {
        window.location.href = '/parkoreen/login/';
    },
    
    toSignup() {
        window.location.href = '/parkoreen/signup/';
    },

    toMails() {
        window.location.href = '/parkoreen/mails/';
    },

    toAdmin() {
        window.location.href = '/parkoreen/admin/';
    }
};

// ============================================
// FOOTER
// ============================================
function createFooter() {
    const isIframed = (window !== window.top);
    const footer = document.createElement('footer');
    footer.className = 'page-footer';
    footer.innerHTML = `
        <span>© Copyright JimmyQrg 2026</span>
        <a href="https://github.com/jimmyqrg/" ${isIframed ? '' : 'target="_blank" rel="noopener"'} class="github-link">
            <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z'/%3E%3C/svg%3E" alt="GitHub">
        </a>
    `;
    if (isIframed) {
        footer.querySelector('a').onclick = (e) => {
            e.preventDefault();
            location.href = 'https://github.com/jimmyqrg/';
        };
    }
    return footer;
}

// ============================================
// GLOBAL INSTANCES
// ============================================
console.log('[Runtime] Initializing global instances...');
window.API_URL = API_URL;
window.Auth = new AuthManager();

// Small local save store shared by the game and built-in mechanics runtime.
// Saves are scoped to the current map and account (or browser device when
// playing without an account); they are not uploaded or synced between devices.
window.ParkoreenLocalSave = (() => {
    const deviceIdKey = 'parkoreen_local_save_device_id';

    const createId = () => {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    };

    const getMapId = (world) => {
        const roomMapId = window.parkoreenRoomMapId;
        if (typeof roomMapId === 'string' && roomMapId.trim()) return roomMapId.trim();
        // Solo scene transitions keep the editor page mounted. Scope local
        // saves to the scene currently loaded into the engine, not the map
        // that originally opened the editor page.
        const activeSceneMapId = window.parkoreenActiveSceneMapId;
        if (typeof activeSceneMapId === 'string' && activeSceneMapId.trim()) return activeSceneMapId.trim();
        const cloudMapId = window.parkoreenEditorMapId;
        if (typeof cloudMapId === 'string' && cloudMapId.trim()) return cloudMapId.trim();
        return typeof world?.mechanicsSaveId === 'string' && world.mechanicsSaveId.trim()
            ? world.mechanicsSaveId.trim()
            : null;
    };

    const getUserId = () => {
        const user = window.Auth?.getUser?.();
        if (user?.id !== undefined && user?.id !== null && String(user.id).trim()) {
            return `account:${String(user.id).trim()}`;
        }
        try {
            let deviceId = localStorage.getItem(deviceIdKey);
            if (!deviceId) {
                deviceId = createId();
                localStorage.setItem(deviceIdKey, deviceId);
            }
            return `device:${deviceId}`;
        } catch (error) {
            return null;
        }
    };

    const getKey = (world, namespace) => {
        if (typeof namespace !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(namespace)) return null;
        const mapId = getMapId(world);
        const userId = getUserId();
        if (!mapId || !userId) return null;
        return `parkoreen_local_save_v1:${encodeURIComponent(mapId)}:${encodeURIComponent(userId)}:${namespace}`;
    };

    const read = (world, namespace) => {
        const key = getKey(world, namespace);
        if (!key) return null;
        try {
            const serialized = localStorage.getItem(key) || 'null';
            if (serialized.length > 1048576) return null;
            const value = JSON.parse(serialized);
            return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch (error) {
            return null;
        }
    };

    const write = (world, namespace, value) => {
        const key = getKey(world, namespace);
        if (!key || !value || typeof value !== 'object' || Array.isArray(value)) return false;
        try {
            const serialized = JSON.stringify(value);
            if (serialized.length > 1048576) return false;
            localStorage.setItem(key, serialized);
            return true;
        } catch (error) {
            return false;
        }
    };

    const remove = (world, namespace) => {
        const key = getKey(world, namespace);
        if (!key) return false;
        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            return false;
        }
    };

    return { getKey, read, write, remove };
})();
window.MapManager = new MapManager(window.Auth);
window.MultiplayerManager = new MultiplayerManager(window.Auth);
window.Settings = new SettingsManager();
window.EditorPrefs = new EditorPrefs();
// Pull per-account settings/fonts from the server once on startup (no-op if
// not logged in; silently uses local cache on network failure).
window.Settings.syncWithServer();
window.EditorPrefs.syncWithServer();
window.isParkoreenAdminUsername = isParkoreenAdminUsername;
window.PARKOREEN_ADMIN_USERNAMES = PARKOREEN_ADMIN_USERNAMES;
window.Navigation = Navigation;
window.createFooter = createFooter;
console.log('[Runtime] Global instances initialized:', {
    Auth: typeof window.Auth,
    MapManager: typeof window.MapManager,
    MultiplayerManager: typeof window.MultiplayerManager,
    'MultiplayerManager.on': typeof window.MultiplayerManager?.on
});

// Auto-add footer to pages
document.addEventListener('DOMContentLoaded', () => {
    const pageContainer = document.querySelector('.page-container');
    if (pageContainer && !document.querySelector('.page-footer')) {
        pageContainer.appendChild(createFooter());
    }
});

// Redirect to levels if level group 0 not completed (and not on exempt pages)
const LEVEL_GROUP_0 = ['0_1', '0_2', '0_3'];
const EXEMPT_PATHS = ['/parkoreen/login/', '/parkoreen/signup/', '/parkoreen/wiki/', '/parkoreen/settings/', '/parkoreen/index.html', '/parkoreen/host.html'];

function getNextUnfinishedGroup0(completedSet) {
    for (const lvl of LEVEL_GROUP_0) {
        if (!completedSet.has(lvl)) return lvl;
    }
    return null;
}

// Fetch level progress from the server (authoritative source) and cache into
// localStorage. Falls back to localStorage on failure.
async function fetchAndCacheLevelProgress() {
    const token = localStorage.getItem('parkoreen_token');
    if (!token) return null;

    try {
        const res = await fetch(API_URL + '/level-progress', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) return null;
        const data = await res.json();
        // Cache server response for offline use / fallback
        localStorage.setItem('parkoreen_level_progress', JSON.stringify({
            completed: data.completed || [],
            group1Completed: data.group1Completed || false
        }));
        return data;
    } catch (e) {
        console.warn('[LevelProgress] Server fetch failed, using cache:', e);
        return null;
    }
}

function readCachedLevelProgress() {
    try {
        const raw = localStorage.getItem('parkoreen_level_progress');
        if (!raw) return { completed: [], group1Completed: false };
        const data = JSON.parse(raw);
        return {
            completed: Array.isArray(data.completed) ? data.completed : [],
            group1Completed: !!data.group1Completed
        };
    } catch (e) {
        return { completed: [], group1Completed: false };
    }
}

async function checkLevelGroup0Required() {
    const path = window.location.pathname;

    // Exempt pages: don't gate
    if (EXEMPT_PATHS.some(p => path.startsWith(p))) return;

    // Only enforce for logged-in users
    if (!window.Auth || !window.Auth.isLoggedIn()) return;

    // Try server first (authoritative)
    let progress = await fetchAndCacheLevelProgress();
    if (!progress) {
        // Fall back to local cache
        progress = readCachedLevelProgress();
    }

    const completedSet = new Set(progress.completed || []);
    const nextLevel = getNextUnfinishedGroup0(completedSet);

    if (nextLevel) {
        // Send user straight to the next unfinished group-0 level, preserving
        // the page they were trying to reach via sessionStorage for later.
        const intended = path + window.location.search;
        if (intended !== '/parkoreen/index.html') {
            sessionStorage.setItem('parkoreen_intended_path', intended);
        }
        // Hand off to index.html which has ImportManager + playLevelByName
        window.location.href = '/parkoreen/index.html?continue=' + encodeURIComponent(nextLevel);
    }
    // If all group 0 done, do nothing — user can browse normally.
}

// Run after Auth initializes
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(checkLevelGroup0Required, 200));
} else {
    setTimeout(checkLevelGroup0Required, 200);
}
