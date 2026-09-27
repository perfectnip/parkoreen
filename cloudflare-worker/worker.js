/**
 * PARKOREEN - Cloudflare Worker
 * Handles authentication, map storage, and real-time multiplayer
 * 
 * Required KV Namespaces (bind in Cloudflare dashboard):
 * - USERS: User data storage
 * - MAPS: Map data storage
 * - SESSIONS: Session/token storage
 * - ROOMS: Active game rooms
 */

// ============================================
// CONFIGURATION
// ============================================
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

const JWT_SECRET = 'parkoreen-secret-key-change-in-production';
const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_MECHANICS_STATE_BYTES = 32 * 1024;

// ============================================
// UTILITIES
// ============================================
function generateId(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding similar chars
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function normalizeMechanicsPolygon(points) {
    if (!Array.isArray(points) || points.length < 3 || points.length > 12) return null;
    const normalized = [];
    for (const point of points) {
        if (Array.isArray(point) && point.length !== 2) return null;
        const x = Array.isArray(point) ? point[0] : point?.x;
        const y = Array.isArray(point) ? point[1] : point?.y;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
        if (normalized.some(existing => Math.abs(existing[0] - x) < 1e-8 && Math.abs(existing[1] - y) < 1e-8)) return null;
        normalized.push([x, y]);
    }
    let turnSign = 0;
    let doubledArea = 0;
    for (let i = 0; i < normalized.length; i++) {
        const a = normalized[i];
        const b = normalized[(i + 1) % normalized.length];
        const c = normalized[(i + 2) % normalized.length];
        const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cross) > 1e-8) {
            const sign = Math.sign(cross);
            if (turnSign && turnSign !== sign) return null;
            turnSign = sign;
        }
        doubledArea += a[0] * b[1] - b[0] * a[1];
    }
    return turnSign && Math.abs(doubledArea) >= 1e-8 ? normalized : null;
}

// Allowed characters for username: letters, numbers, and specific symbols
const ALLOWED_USERNAME_CHARS = /^[a-zA-Z0-9,""''\.?/:;\-_=+{}\[\]\\|~`【】<> ]+$/;

// Reserved display names (case-insensitive) - only these usernames may use each name (keep in sync with runtime.js RESERVED_DISPLAY_NAME_ALLOWLIST)
const RESERVED_NAMES = {
    'jimmyqrg': ['jimmyqrg', 'jimmyqrg160', 'jimmyqrgschool', 'parkoreen'],
    'parkoreen': ['jimmyqrg', 'jimmyqrg160', 'jimmyqrgschool', 'parkoreen']
};

// Invisible/problematic characters to block in display names
const BLOCKED_DISPLAY_CHARS = ['ㅤ']; // Hangul Filler U+3164

function validateUsername(username) {
    if (!username || typeof username !== 'string') {
        return { valid: false, error: 'Username is required' };
    }
    
    const trimmed = username.trim();
    
    if (trimmed.length === 0 || trimmed === ' ') {
        return { valid: false, error: 'Username cannot be empty or just a space' };
    }
    
    if (trimmed.length < 3) {
        return { valid: false, error: 'Username must be at least 3 characters' };
    }
    
    if (trimmed.length > 30) {
        return { valid: false, error: 'Username must be at most 30 characters' };
    }
    
    if (!ALLOWED_USERNAME_CHARS.test(trimmed)) {
        return { valid: false, error: 'Username contains invalid characters. Allowed: letters, numbers, and , " " \' \' . ? / : ; - _ = + { } [ ] \\ | ~ ` 【 】 < > space' };
    }
    
    return { valid: true };
}

function validateDisplayName(name, username) {
    if (!name || typeof name !== 'string') {
        return { valid: false, error: 'Display name is required' };
    }
    
    const trimmed = name.trim();
    
    if (trimmed.length === 0 || trimmed === ' ') {
        return { valid: false, error: 'Display name cannot be empty or just a space' };
    }
    
    if (trimmed.length > 50) {
        return { valid: false, error: 'Display name must be at most 50 characters' };
    }
    
    // Check for blocked characters
    for (const char of BLOCKED_DISPLAY_CHARS) {
        if (trimmed.includes(char)) {
            return { valid: false, error: 'Display name contains invalid characters' };
        }
    }
    
    // Check reserved names
    const nameLower = trimmed.toLowerCase();
    for (const [reservedName, allowedUsernames] of Object.entries(RESERVED_NAMES)) {
        if (nameLower === reservedName) {
            const usernameLower = (username || '').toLowerCase();
            if (!allowedUsernames.includes(usernameLower)) {
                return { valid: false, error: `The name "${trimmed}" is reserved` };
            }
        }
    }
    
    return { valid: true };
}

async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + JWT_SECRET);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, hash) {
    const passwordHash = await hashPassword(password);
    return passwordHash === hash;
}

function generateToken(userId) {
    const payload = {
        userId,
        exp: Date.now() + TOKEN_EXPIRY,
        iat: Date.now()
    };
    // Simple base64 encoding - in production, use proper JWT
    return btoa(JSON.stringify(payload));
}

function verifyToken(token) {
    try {
        const payload = JSON.parse(atob(token));
        if (payload.exp < Date.now()) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}

// Generate a unique, deterministic player color from user ID (used as fallback)
// Uses HSL to ensure vibrant, distinguishable colors
function generatePlayerColorFromId(userId) {
    // Simple hash function to get a number from the user ID
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        const char = userId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Use the hash to generate HSL values
    // Hue: full spectrum (0-360)
    // Saturation: 60-80% for vibrant colors
    // Lightness: 55-70% for good visibility
    const hue = Math.abs(hash % 360);
    const saturation = 60 + Math.abs((hash >> 8) % 20); // 60-80%
    const lightness = 55 + Math.abs((hash >> 16) % 15);  // 55-70%
    
    return hslToHex(hue, saturation, lightness);
}

// Convert HSL to hex color
function hslToHex(h, s, l) {
    const hNorm = h / 360;
    const sNorm = s / 100;
    const lNorm = l / 100;
    
    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
    };
    
    const q = lNorm < 0.5 ? lNorm * (1 + sNorm) : lNorm + sNorm - lNorm * sNorm;
    const p = 2 * lNorm - q;
    const r = Math.round(hue2rgb(p, q, hNorm + 1/3) * 255);
    const g = Math.round(hue2rgb(p, q, hNorm) * 255);
    const b = Math.round(hue2rgb(p, q, hNorm - 1/3) * 255);
    
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Convert hex color to HSL
function hexToHsl(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return { h: 0, s: 70, l: 60 };
    
    const r = parseInt(result[1], 16) / 255;
    const g = parseInt(result[2], 16) / 255;
    const b = parseInt(result[3], 16) / 255;
    
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    
    return { h: h * 360, s: s * 100, l: l * 100 };
}

// Calculate the minimum hue distance between a hue and all existing hues
function getMinHueDistance(hue, existingHues) {
    if (existingHues.length === 0) return 360;
    
    let minDist = 360;
    for (const existing of existingHues) {
        // Hue is circular, so we need to consider wrap-around
        let dist = Math.abs(hue - existing);
        if (dist > 180) dist = 360 - dist;
        if (dist < minDist) minDist = dist;
    }
    return minDist;
}

// Generate an optimal player color that's as different as possible from existing colors
// Prioritizes hue differences, only adjusts saturation/lightness if hue difference < 25
function generateOptimalPlayerColor(existingColors) {
    // If no existing colors, return a nice default
    if (!existingColors || existingColors.length === 0) {
        return hslToHex(Math.random() * 360, 70, 60);
    }
    
    // Convert existing colors to HSL
    const existingHsl = existingColors.map(c => hexToHsl(c));
    const existingHues = existingHsl.map(c => c.h);
    
    // Find the best hue by checking evenly spaced candidates
    let bestHue = 0;
    let bestHueDistance = 0;
    
    // Check 72 candidate hues (every 5 degrees)
    for (let candidateHue = 0; candidateHue < 360; candidateHue += 5) {
        const minDist = getMinHueDistance(candidateHue, existingHues);
        if (minDist > bestHueDistance) {
            bestHueDistance = minDist;
            bestHue = candidateHue;
        }
    }
    
    // Default saturation and lightness
    let saturation = 70;
    let lightness = 60;
    
    // If the best hue distance is less than 25, we need to also vary saturation/lightness
    if (bestHueDistance < 25) {
        // Find the closest existing color in terms of hue
        const closeColors = existingHsl.filter(c => {
            let dist = Math.abs(bestHue - c.h);
            if (dist > 180) dist = 360 - dist;
            return dist < 30;
        });
        
        if (closeColors.length > 0) {
            // Get average saturation and lightness of close colors
            const avgSat = closeColors.reduce((sum, c) => sum + c.s, 0) / closeColors.length;
            const avgLight = closeColors.reduce((sum, c) => sum + c.l, 0) / closeColors.length;
            
            // Move saturation and lightness away from existing colors
            // Try to be at least 15 units different in both
            if (avgSat > 65) {
                saturation = Math.max(45, avgSat - 20);
            } else {
                saturation = Math.min(90, avgSat + 20);
            }
            
            if (avgLight > 58) {
                lightness = Math.max(40, avgLight - 15);
            } else {
                lightness = Math.min(75, avgLight + 15);
            }
        }
    }
    
    // Clamp values to ensure good visibility
    saturation = Math.max(45, Math.min(90, saturation));
    lightness = Math.max(40, Math.min(75, lightness));
    
    return hslToHex(bestHue, saturation, lightness);
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS
        }
    });
}

function errorResponse(message, status = 400) {
    return jsonResponse({ error: true, message }, status);
}

// ============================================
// AUTH HANDLERS
// ============================================
async function handleSignup(request, env) {
    const { name, username, password } = await request.json();

    if (!name || !username || !password) {
        return errorResponse('Name, username, and password are required');
    }

    // Validate username
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
        return errorResponse(usernameValidation.error);
    }

    // Validate display name
    const nameValidation = validateDisplayName(name, username);
    if (!nameValidation.valid) {
        return errorResponse(nameValidation.error);
    }

    if (password.length < 6) {
        return errorResponse('Password must be at least 6 characters');
    }

    // Check if username exists
    const existingUser = await env.USERS.get(`username:${username.toLowerCase()}`);
    if (existingUser) {
        return errorResponse('Username already taken');
    }

    // Create user
    const userId = generateId();
    const passwordHash = await hashPassword(password);
    const color = generatePlayerColorFromId(userId);
    
    const user = {
        id: userId,
        name,
        username,
        passwordHash,
        color,
        createdAt: new Date().toISOString()
    };

    // Store user
    await env.USERS.put(`user:${userId}`, JSON.stringify(user));
    await env.USERS.put(`username:${username.toLowerCase()}`, userId);

    // Generate token
    const token = generateToken(userId);
    await env.SESSIONS.put(`token:${token}`, userId, { expirationTtl: TOKEN_EXPIRY / 1000 });

    return jsonResponse({
        user: { id: userId, name, username, color },
        token
    });
}

async function handleLogin(request, env) {
    const { username, password } = await request.json();

    if (!username || !password) {
        return errorResponse('Username and password are required');
    }

    // Get user ID by username
    const userId = await env.USERS.get(`username:${username.toLowerCase()}`);
    if (!userId) {
        return errorResponse('Invalid username or password', 401);
    }

    // Get user data
    const userData = await env.USERS.get(`user:${userId}`);
    if (!userData) {
        return errorResponse('User not found', 404);
    }

    const user = JSON.parse(userData);

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
        return errorResponse('Invalid username or password', 401);
    }

    // For existing users without a color, generate one deterministically from their ID
    const color = user.color || generatePlayerColorFromId(user.id);
    let needsSave = false;

    if (!user.color) {
        user.color = color;
        needsSave = true;
    }

    // Auto-rename users with reserved display names they're not allowed to use
    if (user.name) {
        const nameLower = user.name.toLowerCase().trim();
        for (const [reservedName, allowedUsernames] of Object.entries(RESERVED_NAMES)) {
            if (nameLower === reservedName && !allowedUsernames.includes(user.username.toLowerCase())) {
                user.name = 'Change Me';
                needsSave = true;
                break;
            }
        }
    }

    if (needsSave) {
        await env.USERS.put(`user:${userId}`, JSON.stringify(user));
    }

    // Generate token
    const token = generateToken(userId);
    await env.SESSIONS.put(`token:${token}`, userId, { expirationTtl: TOKEN_EXPIRY / 1000 });

    return jsonResponse({
        user: { id: user.id, name: user.name, username: user.username, color },
        token
    });
}

async function handleUpdateProfile(request, env, userId) {
    const updates = await request.json();
    
    const userData = await env.USERS.get(`user:${userId}`);
    if (!userData) {
        return errorResponse('User not found', 404);
    }

    const user = JSON.parse(userData);

    if (updates.name) {
        // Validate display name
        const nameValidation = validateDisplayName(updates.name, user.username);
        if (!nameValidation.valid) {
            return errorResponse(nameValidation.error);
        }
        user.name = updates.name;
    }

    await env.USERS.put(`user:${userId}`, JSON.stringify(user));

    return jsonResponse({
        user: { id: user.id, name: user.name, username: user.username }
    });
}

async function handleChangePassword(request, env, userId) {
    const { currentPassword, newPassword } = await request.json();

    if (!currentPassword || !newPassword) {
        return errorResponse('Current and new password are required');
    }

    if (newPassword.length < 6) {
        return errorResponse('New password must be at least 6 characters');
    }

    const userData = await env.USERS.get(`user:${userId}`);
    if (!userData) {
        return errorResponse('User not found', 404);
    }

    const user = JSON.parse(userData);

    const isValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!isValid) {
        return errorResponse('Current password is incorrect', 401);
    }

    user.passwordHash = await hashPassword(newPassword);
    await env.USERS.put(`user:${userId}`, JSON.stringify(user));

    return jsonResponse({ success: true });
}

// ============================================
// MAP HANDLERS
// ============================================
async function handleListMaps(env, userId) {
    // Get user's map list
    const mapListData = await env.MAPS.get(`user:${userId}:maps`);
    const mapList = mapListData ? JSON.parse(mapListData) : [];

    // Get map details
    const maps = [];
    for (const mapId of mapList) {
        const mapData = await env.MAPS.get(`map:${mapId}`);
        if (mapData) {
            const map = JSON.parse(mapData);
            maps.push({
                id: map.id,
                name: map.name,
                createdAt: map.createdAt,
                updatedAt: map.updatedAt
            });
        }
    }

    return jsonResponse(maps);
}

async function handleGetMap(mapId, env, userId) {
    const mapData = await env.MAPS.get(`map:${mapId}`);
    if (!mapData) {
        return errorResponse('Map not found', 404);
    }

    const map = JSON.parse(mapData);

    // Check ownership
    if (map.userId !== userId) {
        return errorResponse('Access denied', 403);
    }

    return jsonResponse(map);
}

async function handleCreateMap(request, env, userId) {
    const { name } = await request.json();

    if (!name || !name.trim()) {
        return errorResponse('Map name is required');
    }

    const mapId = generateId();
    const map = {
        id: mapId,
        name: name.trim(),
        userId,
        data: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // Store map
    await env.MAPS.put(`map:${mapId}`, JSON.stringify(map));

    // Add to user's map list
    const mapListData = await env.MAPS.get(`user:${userId}:maps`);
    const mapList = mapListData ? JSON.parse(mapListData) : [];
    mapList.push(mapId);
    await env.MAPS.put(`user:${userId}:maps`, JSON.stringify(mapList));

    return jsonResponse({ id: mapId, name: map.name });
}

async function handleUpdateMap(mapId, request, env, userId) {
    const mapData = await env.MAPS.get(`map:${mapId}`);
    if (!mapData) {
        return errorResponse('Map not found', 404);
    }

    const map = JSON.parse(mapData);

    if (map.userId !== userId) {
        return errorResponse('Access denied', 403);
    }

    const updates = await request.json();

    if (updates.name) {
        map.name = updates.name;
        if (map.pristineSample === true && String(map.name).trim() !== 'Sample Map') {
            map.pristineSample = false;
        }
    }
    if (updates.data !== undefined) {
        map.data = updates.data;
        // Dashboard seed marks default sample; any later save without the flag clears it
        if (updates.markPristineSample === true) {
            map.pristineSample = true;
        } else {
            map.pristineSample = false;
        }
    }
    map.updatedAt = new Date().toISOString();

    await env.MAPS.put(`map:${mapId}`, JSON.stringify(map));

    return jsonResponse({ success: true });
}

async function handleDeleteMap(mapId, env, userId) {
    const mapData = await env.MAPS.get(`map:${mapId}`);
    if (!mapData) {
        return errorResponse('Map not found', 404);
    }

    const map = JSON.parse(mapData);

    if (map.userId !== userId) {
        return errorResponse('Access denied', 403);
    }

    // Delete map
    await env.MAPS.delete(`map:${mapId}`);

    // Remove from user's map list
    const mapListData = await env.MAPS.get(`user:${userId}:maps`);
    const mapList = mapListData ? JSON.parse(mapListData) : [];
    const index = mapList.indexOf(mapId);
    if (index !== -1) {
        mapList.splice(index, 1);
        await env.MAPS.put(`user:${userId}:maps`, JSON.stringify(mapList));
    }

    return jsonResponse({ success: true });
}

// ============================================
// LEVEL PROGRESS HANDLERS
// ============================================
async function handleGetLevelProgress(env, userId) {
    const progressData = await env.USERS.get(`level_progress:${userId}`);
    if (!progressData) {
        return jsonResponse({ completed: [], group1Completed: false });
    }
    return jsonResponse(JSON.parse(progressData));
}

async function handleUpdateLevelProgress(request, env, userId) {
    const { completed, group1Completed } = await request.json();

    const progress = {
        completed: Array.isArray(completed) ? completed : [],
        group1Completed: !!group1Completed
    };

    await env.USERS.put(`level_progress:${userId}`, JSON.stringify(progress));
    return jsonResponse({ success: true });
}

// ============================================
// FLAG HANDLERS (EASTER EGGS)
// ============================================
async function handleGetFlag(flagName, env, userId) {
    const flagData = await env.USERS.get(`flag:${userId}:${flagName}`);
    if (!flagData) {
        return jsonResponse({ value: false });
    }
    return jsonResponse({ value: true });
}

async function handleSetFlag(flagName, env, userId) {
    await env.USERS.put(`flag:${userId}:${flagName}`, 'true');
    return jsonResponse({ success: true });
}

async function handleDeleteFlag(flagName, env, userId) {
    await env.USERS.delete(`flag:${userId}:${flagName}`);
    return jsonResponse({ success: true });
}

// ============================================
// SETTINGS HANDLERS (per-account preferences)
// ============================================
async function handleGetSettings(env, userId) {
    const data = await env.USERS.get(`settings:${userId}`);
    if (!data) {
        return jsonResponse({ settings: null });
    }
    try {
        return jsonResponse({ settings: JSON.parse(data) });
    } catch (e) {
        return jsonResponse({ settings: null });
    }
}

async function handleUpdateSettings(request, env, userId) {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return errorResponse('Invalid JSON body', 400);
    }
    const { settings } = body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return errorResponse('settings must be an object', 400);
    }
    // Whitelist allowed keys to prevent KV bloat / injection
    const allowed = ['volume', 'fontSize', 'keyboardLayout', 'roleMode', 'testerShowTouchboxes', 'theme'];
    const sanitized = {};
    for (const key of allowed) {
        if (key in settings) sanitized[key] = settings[key];
    }
    await env.USERS.put(`settings:${userId}`, JSON.stringify(sanitized));
    return jsonResponse({ success: true, settings: sanitized });
}

// ============================================
// EDITOR PREFERENCES HANDLERS (recent fonts)
// ============================================
async function handleGetRecentFonts(env, userId) {
    const data = await env.USERS.get(`recent_fonts:${userId}`);
    if (!data) {
        return jsonResponse({ fonts: [] });
    }
    try {
        const fonts = JSON.parse(data);
        return jsonResponse({ fonts: Array.isArray(fonts) ? fonts : [] });
    } catch (e) {
        return jsonResponse({ fonts: [] });
    }
}

async function handleUpdateRecentFonts(request, env, userId) {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return errorResponse('Invalid JSON body', 400);
    }
    const { fonts } = body;
    if (!Array.isArray(fonts)) {
        return errorResponse('fonts must be an array', 400);
    }
    // Cap to last 20, stringify-only entries
    const sanitized = fonts.slice(-20).map(f => String(f));
    await env.USERS.put(`recent_fonts:${userId}`, JSON.stringify(sanitized));
    return jsonResponse({ success: true, fonts: sanitized });
}

// ============================================
// ADMIN GLOBAL BANS
// ============================================
// Stored as a single JSON blob per ban-list (shared across admins):
//   key: `global_bans`
//   value: { "<playerName>": { expiresAt: <ms|null> } }
async function handleGetGlobalBans(env, userId) {
    const admin = await resolveAdminUser(env, userId);
    if (!admin) return errorResponse('Admin only', 403);
    const raw = await env.USERS.get('global_bans');
    if (!raw) return jsonResponse({ bans: {} });
    try {
        const bans = JSON.parse(raw);
        return jsonResponse({ bans: (bans && typeof bans === 'object') ? bans : {} });
    } catch (e) {
        return jsonResponse({ bans: {} });
    }
}

async function handleUpdateGlobalBans(request, env, userId) {
    const admin = await resolveAdminUser(env, userId);
    if (!admin) return errorResponse('Admin only', 403);
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return errorResponse('Invalid JSON body', 400);
    }
    const { bans } = body;
    if (!bans || typeof bans !== 'object' || Array.isArray(bans)) {
        return errorResponse('bans must be an object', 400);
    }
    // Sanitize: each entry must have expiresAt: number|null
    const sanitized = {};
    for (const [name, entry] of Object.entries(bans)) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof name !== 'string' || name.length === 0 || name.length > 50) continue;
        let expiresAt = null;
        if (entry.expiresAt === null || entry.expiresAt === undefined) {
            expiresAt = null;
        } else if (typeof entry.expiresAt === 'number' && entry.expiresAt > 0) {
            expiresAt = entry.expiresAt;
        } else {
            continue;
        }
        sanitized[name] = { expiresAt };
    }
    await env.USERS.put('global_bans', JSON.stringify(sanitized));
    return jsonResponse({ success: true, bans: sanitized });
}

// ============================================
// WEBSOCKET HANDLER (MULTIPLAYER)
// ============================================
class GameRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.sessions = new Map();
        this.roomData = null;
        this.mechanicsStateQueues = new Map();
        this.mechanicsTilemapCellIndexes = new Map();
        this.mechanicsTilemapCellIndexesBuilt = false;
        this.mechanicsTilemapCellOverrides = Object.create(null);
        this.mechanicsObjectPositions = Object.create(null);
        this.mechanicsSpawnedObjects = Object.create(null);
    }

    async fetch(request) {
        const url = new URL(request.url);
        const pathname = (url.pathname.replace(/\/+$/, '') || '/').replace(/^\/+/, '/');

        if (pathname === '/admin/rooms') {
            return this.handleAdminListRooms();
        }

        if (pathname === '/ws') {
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected websocket', { status: 400 });
            }

            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            
            await this.handleSession(server, request);

            return new Response(null, { status: 101, webSocket: client });
        }

        return new Response('Not found', { status: 404 });
    }

    async handleAdminListRooms() {
        const rooms = [];
        const seen = new Set();
        for (const [, session] of this.sessions) {
            if (session.roomCode && !seen.has(session.roomCode)) {
                seen.add(session.roomCode);
                const roomData = await this.state.storage.get(`room:${session.roomCode}`);
                const room = roomData ? JSON.parse(roomData) : {};
                const players = this.getPlayersInRoom(session.roomCode);
                const mapNameResolved =
                    room.mapName ||
                    (room.mapData && typeof room.mapData === 'object' && room.mapData.mapName) ||
                    null;
                rooms.push({
                    code: session.roomCode,
                    hostUsername: players.find(p => p.isHost)?.user?.username || 'unknown',
                    hostName: players.find(p => p.isHost)?.user?.name || 'unknown',
                    playerCount: players.length,
                    maxPlayers: room.maxPlayers || 10,
                    usePassword: room.usePassword || false,
                    createdAt: room.createdAt,
                    mapId: room.mapId || null,
                    mapName: mapNameResolved,
                    players: players.map(p => ({
                        id: p.id,
                        username: p.user?.username,
                        name: p.user?.name,
                        isHost: p.isHost
                    }))
                });
            }
        }
        return new Response(JSON.stringify(rooms), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleSession(webSocket, request) {
        webSocket.accept();

        const sessionId = generateId();
        const session = {
            id: sessionId,
            webSocket,
            userId: null,
            user: null,
            roomCode: null,
            isHost: false,
            playerColor: null // Will be set during auth from user's persistent color
        };

        this.sessions.set(sessionId, session);

        webSocket.addEventListener('message', async (event) => {
            try {
                if (typeof event.data !== 'string' || event.data.length > 65536) {
                    this.send(session, { type: 'error', message: 'Message is too large or invalid' });
                    return;
                }
                const data = JSON.parse(event.data);
                await this.handleMessage(session, data);
            } catch (error) {
                console.error('Message handling error:', error);
            }
        });

        webSocket.addEventListener('close', () => {
            this.handleDisconnect(session);
        });
    }

    async handleMessage(session, data) {
        switch (data.type) {
            case 'auth':
                await this.handleAuth(session, data);
                break;
            case 'create_room':
                await this.handleCreateRoom(session, data);
                break;
            case 'join_room':
                await this.handleJoinRoom(session, data);
                break;
            case 'rejoin_room':
                await this.handleRejoinRoom(session, data);
                break;
            case 'leave_room':
                await this.handleLeaveRoom(session);
                break;
            case 'position':
                this.handlePosition(session, data);
                break;
            case 'mechanics_state':
                await this.handleMechanicsState(session, data);
                break;
            case 'mechanics_event_request':
                await this.handleMechanicsEventRequest(session, data);
                break;
            case 'global_coin_collect_request':
                await this.handleGlobalCoinCollectRequest(session, data);
                break;
            case 'kick_player':
                this.handleKickPlayer(session, data);
                break;
            case 'chat':
                this.handleChat(session, data);
                break;
            case 'admin_title':
                this.handleAdminTitle(session, data);
                break;
        }
    }

    async handleAuth(session, data) {
        const payload = verifyToken(data.token);
        if (!payload) {
            this.send(session, { type: 'error', message: 'Invalid token' });
            return;
        }

        // Get user data
        const userData = await this.env.USERS.get(`user:${payload.userId}`);
        if (!userData) {
            this.send(session, { type: 'error', message: 'User not found' });
            return;
        }

        const user = JSON.parse(userData);
        session.userId = payload.userId;

        // Auto-rename reserved display names for unauthorized users
        if (user.name) {
            const nameLower = user.name.toLowerCase().trim();
            for (const [reservedName, allowedUsernames] of Object.entries(RESERVED_NAMES)) {
                if (nameLower === reservedName && !allowedUsernames.includes(user.username.toLowerCase())) {
                    user.name = 'Change Me';
                    await this.env.USERS.put(`user:${session.userId}`, JSON.stringify(user));
                    break;
                }
            }
        }

        // Get or generate user color
        const color = user.color || generatePlayerColorFromId(user.id);
        session.user = { id: user.id, name: user.name, username: user.username, color };
        session.playerColor = color;
        session.connectedAt = Date.now();

        this.send(session, { type: 'auth_success', playerId: session.id });
    }

    async handleCreateRoom(session, data) {
        if (!session.userId) {
            this.send(session, { type: 'error', message: 'Not authenticated' });
            return;
        }

        // Generate unique room code (retry if already exists)
        let roomCode;
        let attempts = 0;
        const maxAttempts = 10;
        
        do {
            roomCode = generateRoomCode();
            const existingRoom = await this.state.storage.get(`room:${roomCode}`);
            if (!existingRoom) break;
            attempts++;
        } while (attempts < maxAttempts);
        
        if (attempts >= maxAttempts) {
            this.send(session, { type: 'error', message: 'Failed to generate unique room code. Please try again.' });
            return;
        }
        
        const mapNameHint =
            (data.mapName && String(data.mapName)) ||
            (data.mapData && typeof data.mapData === 'object' && data.mapData.mapName) ||
            null;

        this.mechanicsTilemapCellIndexes.clear();
        this.mechanicsTilemapCellIndexesBuilt = false;
        this.mechanicsTilemapCellOverrides = Object.create(null);
        this.mechanicsObjectPositions = Object.create(null);
        this.mechanicsSpawnedObjects = Object.create(null);

        // Store room data
        const room = {
            code: roomCode,
            hostId: session.id,
            hostUserId: session.userId,
            mapData: data.mapData,
            mapId: data.mapId || null,
            mapName: mapNameHint,
            maxPlayers: data.maxPlayers || 10,
            usePassword: data.usePassword || false,
            password: data.password || null,
            players: new Map(),
            createdAt: Date.now()
        };

        await this.state.storage.put(`room:${roomCode}`, JSON.stringify({
            ...room,
            players: []
        }));

        session.roomCode = roomCode;
        session.isHost = true;
        this.resetMechanicsContactState(session);
        
        // Host gets an optimal color (first player, so it'll be a random vibrant color)
        session.playerColor = generateOptimalPlayerColor([]);

        this.send(session, {
            type: 'room_created',
            roomCode
        });
    }

    async handleJoinRoom(session, data) {
        if (!session.userId) {
            this.send(session, { type: 'error', message: 'Not authenticated' });
            return;
        }

        // Check if already in a room
        if (session.roomCode) {
            this.send(session, { type: 'error', message: 'You are already in a room. Leave it first.' });
            return;
        }

        await this.withMechanicsRoomLock(data.roomCode, async () => {
        if (session.roomCode) {
            this.send(session, { type: 'error', message: 'You are already in a room. Leave it first.' });
            return;
        }

        const roomData = await this.state.storage.get(`room:${data.roomCode}`);
        if (!roomData) {
            this.send(session, { type: 'error', message: 'Room not found. Please check the game code.' });
            return;
        }

        const room = JSON.parse(roomData);
        const mechanicsData = await this.state.storage.get(`mechanics:${data.roomCode}`);
        const mechanicsRecord = mechanicsData ? JSON.parse(mechanicsData) : null;

        // Check password
        if (room.usePassword && room.password !== data.password) {
            this.send(session, { type: 'error', message: 'Password required' });
            return;
        }

        // Check max players
        const playersInRoom = this.getPlayersInRoom(data.roomCode);
        if (playersInRoom.length >= room.maxPlayers) {
            this.send(session, { type: 'error', message: 'Room is full' });
            return;
        }

        // Check if this user is already in the room (same account from different device/tab)
        const existingPlayer = playersInRoom.find(p => p.userId === session.userId);
        if (existingPlayer) {
            this.send(session, { type: 'error', message: 'This account is already in this room.' });
            return;
        }

        session.roomCode = data.roomCode;
        session.isHost = false;
        this.resetMechanicsContactState(session);
        
        // Generate an optimal color that's different from existing players
        const existingColors = playersInRoom.map(p => p.playerColor).filter(c => c);
        session.playerColor = generateOptimalPlayerColor(existingColors);

        // Notify existing players
        this.broadcastToRoom(data.roomCode, {
            type: 'player_joined',
            playerId: session.id,
            playerName: session.user.name,
            playerUsername: session.user.username,
            playerColor: session.playerColor
        }, session.id);

        // Send room data to new player
        this.send(session, {
            type: 'room_joined',
            roomCode: data.roomCode,
            mapId: room.mapId || null,
            mapData: room.mapData,
            players: playersInRoom.map(p => ({
                id: p.id,
                name: p.user.name,
                username: p.user.username,
                color: p.playerColor
            })),
            mechanicsState: mechanicsRecord?.state || null,
            mechanicsRevision: Number.isSafeInteger(mechanicsRecord?.revision) ? mechanicsRecord.revision : 0,
            mechanicsServerTimestamp: Date.now(),
            globalCoinIds: Array.isArray(room.globalCoinIds) ? room.globalCoinIds : []
        });
        });
    }

    async handleRejoinRoom(session, data) {
        if (!session.userId) {
            this.send(session, { type: 'error', message: 'Not authenticated' });
            return;
        }

        await this.withMechanicsRoomLock(data.roomCode, async () => {
        const roomData = await this.state.storage.get(`room:${data.roomCode}`);
        if (!roomData) {
            this.send(session, { type: 'error', message: 'Room no longer exists.' });
            return;
        }

        const room = JSON.parse(roomData);
        const mechanicsData = await this.state.storage.get(`mechanics:${data.roomCode}`);
        const mechanicsRecord = mechanicsData ? JSON.parse(mechanicsData) : null;
        
        session.roomCode = data.roomCode;
        session.isHost = room.hostUserId === session.userId;
        this.resetMechanicsContactState(session);

        // Get existing players in room (excluding self)
        const playersInRoom = this.getPlayersInRoom(data.roomCode).filter(p => p.id !== session.id);
        
        // Generate an optimal color that's different from existing players
        const existingColors = playersInRoom.map(p => p.playerColor).filter(c => c);
        session.playerColor = generateOptimalPlayerColor(existingColors);

        // Notify others
        this.broadcastToRoom(data.roomCode, {
            type: 'player_joined',
            playerId: session.id,
            playerName: session.user.name,
            playerUsername: session.user.username,
            playerColor: session.playerColor
        }, session.id);

        // Send room data to rejoined player
        this.send(session, {
            type: 'room_rejoined',
            roomCode: data.roomCode,
            mapId: room.mapId || null,
            isHost: session.isHost,
            players: playersInRoom.map(p => ({
                id: p.id,
                name: p.user.name,
                username: p.user.username,
                color: p.playerColor
            })),
            mechanicsState: mechanicsRecord?.state || null,
            mechanicsRevision: Number.isSafeInteger(mechanicsRecord?.revision) ? mechanicsRecord.revision : 0,
            mechanicsServerTimestamp: Date.now(),
            globalCoinIds: Array.isArray(room.globalCoinIds) ? room.globalCoinIds : []
        });
        });
    }

    async handleLeaveRoom(session) {
        if (!session.roomCode) return;

        const roomCode = session.roomCode;
        const wasHost = session.isHost;

        session.roomCode = null;
        session.isHost = false;
        this.resetMechanicsContactState(session);

        if (wasHost) {
            await this.withMechanicsRoomLock(roomCode, async () => {
                // Close room and kick everyone.
                this.broadcastToRoom(roomCode, {
                    type: 'room_closed',
                    message: 'Host left the room'
                });

                // Clear room data after any in-flight state publish completes.
                await this.state.storage.delete(`room:${roomCode}`);
                await this.state.storage.delete(`mechanics:${roomCode}`);

                // Disconnect all players in room.
                for (const [id, s] of this.sessions) {
                    if (s.roomCode === roomCode) {
                        s.roomCode = null;
                        this.resetMechanicsContactState(s);
                    }
                }
            });
        } else {
            // Notify other players
            this.broadcastToRoom(roomCode, {
                type: 'player_left',
                playerId: session.id,
                playerName: session.user?.name,
                playerUsername: session.user?.username
            });
        }
    }

    resetMechanicsContactState(session) {
        session.x = null;
        session.y = null;
        session.vx = 0;
        session.vy = 0;
        session.jumps = 1;
        session.previousPosition = null;
        session.previousPositionAt = null;
        session.lastPositionAt = null;
        session.mechanicsContactLatches = new Map();
    }

    playerOverlapsMechanicsBounds(position, bounds) {
        if (!position || !bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
            !Number.isFinite(bounds.width) || bounds.width <= 0 ||
            !Number.isFinite(bounds.height) || bounds.height <= 0) return false;
        const player = { x: position.x, y: position.y, width: 24, height: 24 };
        if (bounds.shape === 'capsule') {
            const radius = Math.min(bounds.width, bounds.height) / 2;
            const horizontal = bounds.width > bounds.height;
            const middle = horizontal
                ? { x: bounds.x + radius, y: bounds.y, width: bounds.width - 2 * radius, height: bounds.height }
                : { x: bounds.x, y: bounds.y + radius, width: bounds.width, height: bounds.height - 2 * radius };
            const boxIntersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
                a.y < b.y + b.height && a.y + a.height > b.y;
            const circleIntersects = (cx, cy) => {
                const closestX = Math.max(player.x, Math.min(cx, player.x + player.width));
                const closestY = Math.max(player.y, Math.min(cy, player.y + player.height));
                const dx = cx - closestX;
                const dy = cy - closestY;
                return dx * dx + dy * dy <= radius * radius;
            };
            const firstCap = horizontal
                ? { x: bounds.x + radius, y: bounds.y + bounds.height / 2 }
                : { x: bounds.x + bounds.width / 2, y: bounds.y + radius };
            const secondCap = horizontal
                ? { x: bounds.x + bounds.width - radius, y: bounds.y + bounds.height / 2 }
                : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - radius };
            return boxIntersects(player, middle) || circleIntersects(firstCap.x, firstCap.y) ||
                circleIntersects(secondCap.x, secondCap.y);
        }
        if (bounds.shape === 'circle') {
            const radius = Math.min(bounds.width, bounds.height) / 2;
            const centerX = bounds.x + bounds.width / 2;
            const centerY = bounds.y + bounds.height / 2;
            const closestX = Math.max(player.x, Math.min(centerX, player.x + player.width));
            const closestY = Math.max(player.y, Math.min(centerY, player.y + player.height));
            const dx = centerX - closestX;
            const dy = centerY - closestY;
            return dx * dx + dy * dy <= radius * radius;
        }
        if (bounds.shape === 'polygon') {
            const points = normalizeMechanicsPolygon(bounds.points)?.map(([x, y]) => ({
                x: bounds.x + x * bounds.width,
                y: bounds.y + y * bounds.height
            }));
            if (!points) return false;
            const box = [
                { x: player.x, y: player.y },
                { x: player.x + player.width, y: player.y },
                { x: player.x + player.width, y: player.y + player.height },
                { x: player.x, y: player.y + player.height }
            ];
            const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
            for (let i = 0; i < points.length; i++) {
                const next = points[(i + 1) % points.length];
                axes.push({ x: -(next.y - points[i].y), y: next.x - points[i].x });
            }
            for (const axis of axes) {
                const shapeProjection = points.map(point => point.x * axis.x + point.y * axis.y);
                const boxProjection = box.map(point => point.x * axis.x + point.y * axis.y);
                if (Math.max(...shapeProjection) <= Math.min(...boxProjection) ||
                    Math.max(...boxProjection) <= Math.min(...shapeProjection)) return false;
            }
            return true;
        }
        return player.x < bounds.x + bounds.width && player.x + player.width > bounds.x &&
            player.y < bounds.y + bounds.height && player.y + player.height > bounds.y;
    }

    getMechanicsTilemapCellIndex(mapData) {
        if (this.mechanicsTilemapCellIndexesBuilt) return this.mechanicsTilemapCellIndexes;
        this.mechanicsTilemapCellIndexesBuilt = true;
        const rawTilemaps = Array.isArray(mapData?.tilemaps) ? mapData.tilemaps.slice(0, 4096) : [];
        const validLayers = new Set([0, 1, 2]);
        for (const layer of Array.isArray(mapData?.layerDefinitions) ? mapData.layerDefinitions.slice(0, 64) : []) {
            const rawDepth = layer?.depth;
            const depth = typeof rawDepth === 'number' ? rawDepth
                : (typeof rawDepth === 'string' && rawDepth.trim() ? Number(rawDepth) : Number.NaN);
            if (Number.isSafeInteger(depth) && depth >= -1000 && depth <= 1000) validLayers.add(depth);
        }
        const usedLayers = new Set();
        const usedIds = new Set();
        let totalCells = 0;

        for (const rawTilemap of rawTilemaps) {
            if (this.mechanicsTilemapCellIndexes.size >= 64 || totalCells >= 100000) break;
            if (!rawTilemap || typeof rawTilemap !== 'object' || Array.isArray(rawTilemap)) continue;
            const rawLayer = rawTilemap.layer;
            const layer = typeof rawLayer === 'number' ? rawLayer
                : (typeof rawLayer === 'string' && rawLayer.trim() ? Number(rawLayer) : Number.NaN);
            if (!Number.isSafeInteger(layer) || layer < -1000 || layer > 1000 ||
                !validLayers.has(layer) || usedLayers.has(layer)) continue;
            const rawId = typeof rawTilemap.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(rawTilemap.id)
                ? rawTilemap.id : `tilemap-${layer}`;
            let id = rawId;
            let idSuffix = 1;
            while (usedIds.has(id)) id = `${rawId}-${idSuffix++}`;
            usedLayers.add(layer);
            usedIds.add(id);
            const atlasColumns = Number.isSafeInteger(rawTilemap.atlas?.columns) && rawTilemap.atlas.columns > 0
                ? rawTilemap.atlas.columns : 0;
            const atlasRows = Number.isSafeInteger(rawTilemap.atlas?.rows) && rawTilemap.atlas.rows > 0
                ? rawTilemap.atlas.rows : 0;
            const atlasFrameCount = atlasColumns * atlasRows;

            const cells = new Map();
            const seenCellKeys = new Set();
            if (Array.isArray(rawTilemap.cells)) {
                let rawCellCount = 0;
                for (const rawCell of rawTilemap.cells) {
                    if (totalCells >= 100000 || rawCellCount++ >= 100000) break;
                    if (!rawCell || typeof rawCell !== 'object') continue;
                    const x = rawCell.x;
                    const y = rawCell.y;
                    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x % 32 !== 0 || y % 32 !== 0 ||
                        Math.abs(x) > 10000000 || Math.abs(y) > 10000000) continue;
                    const collisionType = ['solid', 'oneWay', 'rampUpRight', 'rampUpLeft', 'hazard', 'decorative'].includes(rawCell.collisionType)
                        ? rawCell.collisionType
                        : (rawCell.collision === false ? 'decorative'
                            : rawCell.oneWayPlatform === true ? 'oneWay'
                                : rawCell.actingType === 'spike' ? 'hazard' : 'solid');
                    const collisionPoints = rawCell.collisionShape === 'polygon' &&
                        !['rampUpRight', 'rampUpLeft', 'hazard', 'decorative'].includes(collisionType)
                        ? normalizeMechanicsPolygon(rawCell.collisionPoints) : null;
                    const key = `${x},${y}`;
                    if (!seenCellKeys.has(key)) {
                        seenCellKeys.add(key);
                        totalCells++;
                    }
                    cells.set(key, {
                        id: `tile-${id}-${x}-${y}`,
                        x,
                        y,
                        atlasFrameCount: Number.isSafeInteger(atlasFrameCount) && atlasFrameCount <= 4096 ? atlasFrameCount : 0,
                        collisionType,
                        ...(collisionPoints ? {
                            collisionShape: 'polygon', collisionPoints,
                            polygonOneWay: rawCell.polygonOneWay !== false
                        } : collisionType === 'rampUpRight' ? { collisionShape: 'slopeUpRight' }
                            : collisionType === 'rampUpLeft' ? { collisionShape: 'slopeUpLeft' } : {})
                    });
                }
            }
            this.mechanicsTilemapCellIndexes.set(id, cells);
        }
        return this.mechanicsTilemapCellIndexes;
    }

    mechanicsTilemapCellMatchesTriggerFilter(cellCollisionType, filter, polygonOneWay = false) {
        if (!['any', 'solid', 'oneWay', 'hazard'].includes(filter) || cellCollisionType === 'decorative') return false;
        if (filter === 'any') return true;
        if (filter === 'oneWay') {
            return ['oneWay', 'rampUpRight', 'rampUpLeft'].includes(cellCollisionType) || polygonOneWay === true;
        }
        return cellCollisionType === filter;
    }

    findMechanicsTilemapContact(mapData, tilemapId, collisionType, position, mechanicsState = {}) {
        if (typeof tilemapId !== 'string' || !position ||
            !['any', 'solid', 'oneWay', 'hazard'].includes(collisionType || 'any')) return null;
        const filter = collisionType || 'any';
        const cells = this.getMechanicsTilemapCellIndex(mapData).get(tilemapId);
        if (!cells) return null;
        const width = 24;
        const height = 24;
        const firstX = Math.floor(position.x / 32) * 32;
        const lastX = (Math.ceil((position.x + width) / 32) - 1) * 32;
        const firstY = Math.floor(position.y / 32) * 32;
        const lastY = (Math.ceil((position.y + height) / 32) - 1) * 32;
        for (let y = firstY; y <= lastY; y += 32) {
            for (let x = firstX; x <= lastX; x += 32) {
                const savedCell = cells.get(`${x},${y}`);
                if (!savedCell) continue;
                const effectiveCollisionType = mechanicsState.tilemapCells?.[savedCell.id] || savedCell.collisionType;
                const polygonOneWay = savedCell.collisionShape === 'polygon' && savedCell.polygonOneWay !== false;
                if (!this.mechanicsTilemapCellMatchesTriggerFilter(effectiveCollisionType, filter, polygonOneWay)) continue;
                const points = effectiveCollisionType === 'rampUpRight' ? [[0, 1], [1, 0], [1, 1]]
                    : effectiveCollisionType === 'rampUpLeft' ? [[0, 0], [0, 1], [1, 1]]
                        : savedCell.collisionShape === 'polygon' ? savedCell.collisionPoints : null;
                const bounds = { x, y, width: 32, height: 32, ...(points ? { shape: 'polygon', points } : {}) };
                if (this.playerOverlapsMechanicsBounds(position, bounds)) {
                    return { ...savedCell, collisionType: effectiveCollisionType, bounds };
                }
            }
        }
        return null;
    }

    refreshMechanicsContactLatches(roomCode) {
        const roomSessions = Array.from(this.sessions.values()).filter(session => session.roomCode === roomCode);
        for (const session of roomSessions) {
            const latches = session.mechanicsContactLatches;
            if (!(latches instanceof Map) || !Number.isFinite(session.x) || !Number.isFinite(session.y)) continue;
            for (const [triggerId, latch] of latches) {
                let stillActive = false;
                if (latch.kind === 'zone-group-inside') {
                    stillActive = latch.bounds.some(bounds => this.playerOverlapsMechanicsBounds(session, bounds));
                } else if (latch.kind === 'zone-group-outside') {
                    stillActive = !latch.bounds.some(bounds => this.playerOverlapsMechanicsBounds(session, bounds));
                } else if (latch.kind === 'zone-inside' || latch.kind === 'object-inside') {
                    stillActive = this.playerOverlapsMechanicsBounds(session, latch.bounds);
                } else if (latch.kind === 'object-outside') {
                    const currentPosition = this.mechanicsObjectPositions?.[latch.objectId] ||
                        this.mechanicsSpawnedObjects?.[latch.objectId];
                    const currentBounds = currentPosition && Number.isFinite(currentPosition.x) && Number.isFinite(currentPosition.y)
                        ? { ...latch.bounds, x: currentPosition.x, y: currentPosition.y }
                        : latch.bounds;
                    stillActive = !this.playerOverlapsMechanicsBounds(session, currentBounds);
                } else if (latch.kind === 'zone-outside') {
                    stillActive = !this.playerOverlapsMechanicsBounds(session, latch.bounds);
                } else if (latch.kind === 'tilemap-cell-contact') {
                    const effectiveType = this.mechanicsTilemapCellOverrides[latch.objectId] || latch.cellCollisionType;
                    stillActive = this.mechanicsTilemapCellMatchesTriggerFilter(
                        effectiveType, latch.collisionType, latch.polygonOneWay
                    ) &&
                        this.playerOverlapsMechanicsBounds(session, latch.bounds);
                } else if (latch.kind === 'player-contact') {
                    stillActive = roomSessions.some(other => other !== session &&
                        Number.isFinite(other.x) && Number.isFinite(other.y) &&
                        this.playerOverlapsMechanicsBounds(session, { x: other.x, y: other.y, width: 24, height: 24 }));
                }
                if (!stillActive) latches.delete(triggerId);
            }
        }
    }

    handlePosition(session, data) {
        if (!session.roomCode) return;
        if (typeof data.x !== 'number' || !Number.isFinite(data.x) || Math.abs(data.x) > 10000000 ||
            typeof data.y !== 'number' || !Number.isFinite(data.y) || Math.abs(data.y) > 10000000) return;

        // Retain recent position samples for room mechanics contact checks.
        session.previousPosition = Number.isFinite(session.x) && Number.isFinite(session.y)
            ? { x: session.x, y: session.y }
            : null;
        session.previousPositionAt = session.lastPositionAt || null;
        session.x = data.x;
        session.y = data.y;
        session.vx = typeof data.vx === 'number' && Number.isFinite(data.vx) ? data.vx : 0;
        session.vy = typeof data.vy === 'number' && Number.isFinite(data.vy) ? data.vy : 0;
        session.jumps = Number.isSafeInteger(data.jumps) && data.jumps >= 0 && data.jumps <= 100 ? data.jumps : 1;
        session.lastPositionAt = Date.now();
        this.refreshMechanicsContactLatches(session.roomCode);

        // Broadcast to other players
        this.broadcastToRoom(session.roomCode, {
            type: 'player_position',
            playerId: session.id,
            x: data.x,
            y: data.y,
            vx: session.vx,
            vy: session.vy,
            jumps: session.jumps
        }, session.id);

        // Echo back to sender for reconciliation
        this.send(session, {
            type: 'position_ack',
            x: data.x,
            y: data.y,
            vx: session.vx,
            vy: session.vy,
            jumps: session.jumps,
            timestamp: Date.now()
        });
    }

    async withMechanicsRoomLock(roomCode, operation) {
        const previous = this.mechanicsStateQueues.get(roomCode) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.mechanicsStateQueues.set(roomCode, current);
        try {
            return await current;
        } finally {
            if (this.mechanicsStateQueues.get(roomCode) === current) this.mechanicsStateQueues.delete(roomCode);
        }
    }

    sanitizeMechanicsState(mapData, state, validPlayerIds = new Set()) {
        if (!mapData || typeof mapData !== 'object' || !state || typeof state !== 'object' || Array.isArray(state)) return null;
        if (Object.keys(state).some(key => !['variables', 'lists', 'objects', 'objectCollisions', 'positions', 'motions', 'objectHealth', 'objectSpriteFrames', 'objectSpriteAnimations', 'objectOpacities', 'objectDrawLayers', 'playerVariables', 'playerLists', 'spawnedObjects', 'tilemapCells', 'tilemapCellFrames', 'layerVisibility', 'triggers', 'gravity', 'jumpForce', 'playerSpeed', 'horizontalAcceleration', 'airControl', 'terminalFallSpeed'].includes(key))) return null;
        if (state.gravity !== undefined && state.gravity !== null && (typeof state.gravity !== 'number' || !Number.isFinite(state.gravity) || state.gravity < 0 || state.gravity > 5)) return null;
        if (state.jumpForce !== undefined && state.jumpForce !== null && (typeof state.jumpForce !== 'number' || !Number.isFinite(state.jumpForce) || state.jumpForce < -100 || state.jumpForce > -0.1)) return null;
        if (state.playerSpeed !== undefined && state.playerSpeed !== null && (typeof state.playerSpeed !== 'number' || !Number.isFinite(state.playerSpeed) || state.playerSpeed < 0.1 || state.playerSpeed > 100)) return null;
        if (state.horizontalAcceleration !== undefined && state.horizontalAcceleration !== null && (typeof state.horizontalAcceleration !== 'number' || !Number.isFinite(state.horizontalAcceleration) || state.horizontalAcceleration < 0 || state.horizontalAcceleration > 20)) return null;
        if (state.airControl !== undefined && state.airControl !== null && (typeof state.airControl !== 'number' || !Number.isFinite(state.airControl) || state.airControl < 0 || state.airControl > 1)) return null;
        if (state.terminalFallSpeed !== undefined && state.terminalFallSpeed !== null && (typeof state.terminalFallSpeed !== 'number' || !Number.isFinite(state.terminalFallSpeed) || state.terminalFallSpeed < 1 || state.terminalFallSpeed > 100)) return null;
        if (state.variables !== undefined && (!state.variables || typeof state.variables !== 'object' || Array.isArray(state.variables))) return null;
        if (state.lists !== undefined && (!state.lists || typeof state.lists !== 'object' || Array.isArray(state.lists))) return null;
        if (state.objects !== undefined && (!state.objects || typeof state.objects !== 'object' || Array.isArray(state.objects))) return null;
        if (state.objectCollisions !== undefined && (!state.objectCollisions || typeof state.objectCollisions !== 'object' || Array.isArray(state.objectCollisions))) return null;
        if (state.positions !== undefined && (!state.positions || typeof state.positions !== 'object' || Array.isArray(state.positions))) return null;
        if (state.motions !== undefined && (!state.motions || typeof state.motions !== 'object' || Array.isArray(state.motions))) return null;
        if (state.objectHealth !== undefined && (!state.objectHealth || typeof state.objectHealth !== 'object' || Array.isArray(state.objectHealth))) return null;
        if (state.objectSpriteFrames !== undefined && (!state.objectSpriteFrames || typeof state.objectSpriteFrames !== 'object' || Array.isArray(state.objectSpriteFrames))) return null;
        if (state.objectSpriteAnimations !== undefined && (!state.objectSpriteAnimations || typeof state.objectSpriteAnimations !== 'object' || Array.isArray(state.objectSpriteAnimations))) return null;
        if (state.objectOpacities !== undefined && (!state.objectOpacities || typeof state.objectOpacities !== 'object' || Array.isArray(state.objectOpacities))) return null;
        if (state.objectDrawLayers !== undefined && (!state.objectDrawLayers || typeof state.objectDrawLayers !== 'object' || Array.isArray(state.objectDrawLayers))) return null;
        if (state.playerVariables !== undefined && (!state.playerVariables || typeof state.playerVariables !== 'object' || Array.isArray(state.playerVariables))) return null;
        if (state.playerLists !== undefined && (!state.playerLists || typeof state.playerLists !== 'object' || Array.isArray(state.playerLists))) return null;
        if (state.spawnedObjects !== undefined && (!state.spawnedObjects || typeof state.spawnedObjects !== 'object' || Array.isArray(state.spawnedObjects))) return null;
        if (state.tilemapCells !== undefined && (!state.tilemapCells || typeof state.tilemapCells !== 'object' || Array.isArray(state.tilemapCells))) return null;
        if (state.tilemapCellFrames !== undefined && (!state.tilemapCellFrames || typeof state.tilemapCellFrames !== 'object' || Array.isArray(state.tilemapCellFrames))) return null;
        if (state.layerVisibility !== undefined && (!state.layerVisibility || typeof state.layerVisibility !== 'object' || Array.isArray(state.layerVisibility))) return null;
        if (state.triggers !== undefined && (!state.triggers || typeof state.triggers !== 'object' || Array.isArray(state.triggers))) return null;
        const variables = state.variables || {};
        const lists = state.lists || {};
        const objects = state.objects || {};
        const objectCollisions = state.objectCollisions || {};
        const positions = state.positions || {};
        const motions = state.motions || {};
        const objectHealth = state.objectHealth || {};
        const objectSpriteFrames = state.objectSpriteFrames || {};
        const objectSpriteAnimations = state.objectSpriteAnimations || {};
        const objectOpacities = state.objectOpacities || {};
        const objectDrawLayers = state.objectDrawLayers || {};
        const playerVariables = state.playerVariables || {};
        const playerLists = state.playerLists || {};
        const spawnedObjects = state.spawnedObjects || {};
        const tilemapCells = state.tilemapCells || {};
        const tilemapCellFrames = state.tilemapCellFrames || {};
        const layerVisibility = state.layerVisibility || {};
        const triggers = state.triggers || {};
        const gravity = state.gravity ?? null;
        const jumpForce = state.jumpForce ?? null;
        const playerSpeed = state.playerSpeed ?? null;
        const horizontalAcceleration = state.horizontalAcceleration ?? null;
        const airControl = state.airControl ?? null;
        const terminalFallSpeed = state.terminalFallSpeed ?? null;
        const codeData = mapData.codeData && typeof mapData.codeData === 'object' ? mapData.codeData : {};
        const eventDefs = new Map((Array.isArray(codeData.events) ? codeData.events : [])
            .filter(event => event && typeof event.id === 'string' && event.id)
            .map(event => [event.id, event]));
        const triggerDefs = new Map((Array.isArray(codeData.triggers) ? codeData.triggers : [])
            .filter(trigger => trigger && typeof trigger.id === 'string' && trigger.id)
            .map(trigger => [trigger.id, trigger]));
        const variableDefs = new Map((Array.isArray(codeData.variables) ? codeData.variables : [])
            .filter(variable => variable && variable.enabled !== false && variable.variableType !== 'list' && variable.scope !== 'player')
            .map(variable => [String(variable.id), variable]));
        const playerVariableDefs = new Map((Array.isArray(codeData.variables) ? codeData.variables : [])
            .filter(variable => variable && variable.enabled !== false && variable.variableType !== 'list' && variable.scope === 'player')
            .map(variable => [String(variable.id), variable]));
        const playerListVariableDefs = new Map((Array.isArray(codeData.variables) ? codeData.variables : [])
            .filter(variable => variable && variable.enabled !== false && variable.variableType === 'list' && variable.scope === 'player')
            .map(variable => [String(variable.id), variable]));
        const listVariableDefs = new Map((Array.isArray(codeData.variables) ? codeData.variables : [])
            .filter(variable => variable && variable.enabled !== false && variable.variableType === 'list' && variable.scope !== 'player')
            .map(variable => [String(variable.id), variable]));
        const mapObjects = Array.isArray(mapData.objects) ? mapData.objects : [];
        const tilemapCellIds = new Map();
        for (const cells of this.getMechanicsTilemapCellIndex(mapData).values()) {
            for (const cell of cells.values()) tilemapCellIds.set(cell.id, cell);
        }
        const layerDefinitions = new Map([
            ['behind-player', { parallaxX: 1, parallaxY: 1 }],
            ['player-depth', { parallaxX: 1, parallaxY: 1 }],
            ['above-player', { parallaxX: 1, parallaxY: 1 }]
        ]);
        for (const layer of (Array.isArray(mapData.layerDefinitions) ? mapData.layerDefinitions.slice(0, 64) : [])) {
            if (typeof layer?.id === 'string' && layer.id.length > 0) {
                layerDefinitions.set(layer.id, {
                    ...layer,
                    parallaxX: layer.parallaxX === undefined ? 1 : layer.parallaxX,
                    parallaxY: layer.parallaxY === undefined ? 1 : layer.parallaxY
                });
            }
        }
        const objectDefinitions = new Map(mapObjects
            .filter(object => typeof object?.id === 'string' && object.id.length > 0)
            .map(object => [object.id, object]));
        const objectIds = new Set(objectDefinitions.keys());
        const spawnableTemplates = new Set(mapObjects
            .filter(object => object && typeof object.id === 'string' && object.id.length > 0 &&
                object.type !== 'teleportal' && object.appearanceType !== 'teleportal' &&
                !['zone', 'button', 'checkpoint', 'spawnpoint', 'endpoint'].includes(object.appearanceType) &&
                !['checkpoint', 'spawnpoint', 'endpoint'].includes(object.actingType))
            .map(object => object.id));
        if (Object.keys(variables).length > 1000 || Object.keys(lists).length > 1000 || Object.keys(objects).length > 2000 || Object.keys(objectCollisions).length > 2000 || Object.keys(positions).length > 2000 || Object.keys(motions).length > 2000 || Object.keys(objectHealth).length > 512 || Object.keys(objectSpriteFrames).length > 2000 || Object.keys(objectSpriteAnimations).length > 2000 || Object.keys(objectOpacities).length > 2000 || Object.keys(objectDrawLayers).length > 2000 || Object.keys(playerVariables).length > 100 || Object.keys(playerLists).length > 100 || Object.keys(spawnedObjects).length > 64 || Object.keys(tilemapCells).length > 2000 || Object.keys(tilemapCellFrames).length > 2000 || Object.keys(layerVisibility).length > 64 || Object.keys(triggers).length > 1000) return null;

        const cleanVariables = Object.create(null);
        for (const [id, value] of Object.entries(variables)) {
            const variable = variableDefs.get(id);
            if (!variable) return null;
            if (variable.valueType === 'boolean') {
                if (typeof value !== 'boolean') return null;
                cleanVariables[id] = value;
            } else if (variable.valueType === 'integer') {
                if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
                cleanVariables[id] = value;
            } else if (variable.valueType === 'float') {
                if (typeof value !== 'number' || !Number.isFinite(value)) return null;
                cleanVariables[id] = value;
            } else if (variable.valueType === 'string') {
                if (typeof value !== 'string' || value.length > 512) return null;
                cleanVariables[id] = value;
            } else {
                return null;
            }
        }

        const cleanLists = Object.create(null);
        let totalListItemCount = 0;
        for (const [id, value] of Object.entries(lists)) {
            const variable = listVariableDefs.get(id);
            if (!variable || !Array.isArray(value) || value.length > 100 || (totalListItemCount += value.length) > 2000) return null;
            const items = [];
            for (const item of value) {
                if (!item || typeof item !== 'object' || Array.isArray(item) ||
                    Object.keys(item).some(key => !['valueType', 'value'].includes(key))) return null;
                if (item.valueType === 'boolean') {
                    if (typeof item.value !== 'boolean') return null;
                } else if (item.valueType === 'integer') {
                    if (typeof item.value !== 'number' || !Number.isSafeInteger(item.value)) return null;
                } else if (item.valueType === 'float') {
                    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) return null;
                } else if (item.valueType === 'string') {
                    if (typeof item.value !== 'string' || item.value.length > 512) return null;
                } else {
                    return null;
                }
                items.push({ valueType: item.valueType, value: item.value });
            }
            cleanLists[id] = items;
        }

        const cleanObjects = Object.create(null);
        for (const [id, enabled] of Object.entries(objects)) {
            if (!objectIds.has(id) || typeof enabled !== 'boolean') return null;
            cleanObjects[id] = enabled;
        }
        const cleanObjectCollisions = Object.create(null);
        for (const [id, collisionEnabled] of Object.entries(objectCollisions)) {
            if (!objectIds.has(id) || typeof collisionEnabled !== 'boolean') return null;
            cleanObjectCollisions[id] = collisionEnabled;
        }
        const cleanPositions = Object.create(null);
        for (const [id, position] of Object.entries(positions)) {
            if (!objectIds.has(id) || !position || typeof position !== 'object' || Array.isArray(position) ||
                Object.keys(position).some(key => !['x', 'y'].includes(key)) ||
                typeof position.x !== 'number' || !Number.isFinite(position.x) || Math.abs(position.x) > 10000000 ||
                typeof position.y !== 'number' || !Number.isFinite(position.y) || Math.abs(position.y) > 10000000) return null;
            cleanPositions[id] = { x: position.x, y: position.y };
        }
        const cleanMotions = Object.create(null);
        const allowedMotionEasings = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut']);
        for (const [id, motion] of Object.entries(motions)) {
            if (!objectIds.has(id) || !motion || typeof motion !== 'object' || Array.isArray(motion) ||
                Object.keys(motion).some(key => !['motionId', 'fromX', 'fromY', 'toX', 'toY', 'startedAt', 'durationMs', 'easing'].includes(key)) ||
                typeof motion.motionId !== 'string' || motion.motionId.length < 1 || motion.motionId.length > 128 ||
                !['fromX', 'fromY', 'toX', 'toY'].every(key => typeof motion[key] === 'number' && Number.isFinite(motion[key]) && Math.abs(motion[key]) <= 10000000) ||
                !Number.isSafeInteger(motion.startedAt) || motion.startedAt <= 0 ||
                typeof motion.durationMs !== 'number' || !Number.isFinite(motion.durationMs) || motion.durationMs < 10 || motion.durationMs > 60000 ||
                !allowedMotionEasings.has(motion.easing)) return null;
            cleanMotions[id] = {
                motionId: motion.motionId,
                fromX: motion.fromX,
                fromY: motion.fromY,
                toX: motion.toX,
                toY: motion.toY,
                startedAt: motion.startedAt,
                durationMs: motion.durationMs,
                easing: motion.easing
            };
            if (!Object.prototype.hasOwnProperty.call(cleanPositions, id)) return null;
        }
        const cleanPlayerVariables = Object.create(null);
        let totalPlayerVariableCount = 0;
        for (const [playerId, values] of Object.entries(playerVariables)) {
            if (typeof playerId !== 'string' || !playerId || playerId.length > 128 || !values || typeof values !== 'object' || Array.isArray(values)) return null;
            // Drop state for players who have left. Their session ids are not
            // reusable and are never trusted as map-authored identifiers.
            if (!validPlayerIds.has(playerId)) continue;
            const entries = Object.entries(values);
            if (entries.length > 1000 || (totalPlayerVariableCount += entries.length) > 2000) return null;
            const cleanValues = Object.create(null);
            for (const [id, value] of entries) {
                const variable = playerVariableDefs.get(id);
                if (!variable) return null;
                if (variable.valueType === 'boolean') {
                    if (typeof value !== 'boolean') return null;
                    cleanValues[id] = value;
                } else if (variable.valueType === 'integer') {
                    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
                    cleanValues[id] = value;
                } else if (variable.valueType === 'float') {
                    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
                    cleanValues[id] = value;
                } else if (variable.valueType === 'string') {
                    if (typeof value !== 'string' || value.length > 512) return null;
                    cleanValues[id] = value;
                } else {
                    return null;
                }
            }
            cleanPlayerVariables[playerId] = cleanValues;
        }
        const cleanPlayerLists = Object.create(null);
        let totalPlayerListCount = 0;
        for (const [playerId, values] of Object.entries(playerLists)) {
            if (typeof playerId !== 'string' || !playerId || playerId.length > 128 || !values || typeof values !== 'object' || Array.isArray(values)) return null;
            if (!validPlayerIds.has(playerId)) continue;
            const entries = Object.entries(values);
            if (entries.length > 1000 || (totalPlayerListCount += entries.length) > 2000) return null;
            const cleanLists = Object.create(null);
            for (const [id, value] of entries) {
                const variable = playerListVariableDefs.get(id);
                if (!variable || !Array.isArray(value) || value.length > 100 || (totalListItemCount += value.length) > 2000) return null;
                const items = [];
                for (const item of value) {
                    if (!item || typeof item !== 'object' || Array.isArray(item) ||
                        Object.keys(item).some(key => !['valueType', 'value'].includes(key))) return null;
                    if (item.valueType === 'boolean') {
                        if (typeof item.value !== 'boolean') return null;
                    } else if (item.valueType === 'integer') {
                        if (typeof item.value !== 'number' || !Number.isSafeInteger(item.value)) return null;
                    } else if (item.valueType === 'float') {
                        if (typeof item.value !== 'number' || !Number.isFinite(item.value)) return null;
                    } else if (item.valueType === 'string') {
                        if (typeof item.value !== 'string' || item.value.length > 512) return null;
                    } else {
                        return null;
                    }
                    items.push({ valueType: item.valueType, value: item.value });
                }
                cleanLists[id] = items;
            }
            cleanPlayerLists[playerId] = cleanLists;
        }
        const cleanSpawnedObjects = Object.create(null);
        for (const [id, instance] of Object.entries(spawnedObjects)) {
            if (!/^mspawn_[A-Za-z0-9_-]{1,100}$/.test(id) || objectIds.has(id) ||
                !instance || typeof instance !== 'object' || Array.isArray(instance) ||
                Object.keys(instance).some(key => !['templateId', 'x', 'y', 'tag'].includes(key)) ||
                typeof instance.templateId !== 'string' || !spawnableTemplates.has(instance.templateId) ||
                typeof instance.x !== 'number' || !Number.isFinite(instance.x) || Math.abs(instance.x) > 10000000 ||
                typeof instance.y !== 'number' || !Number.isFinite(instance.y) || Math.abs(instance.y) > 10000000 ||
                typeof instance.tag !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(instance.tag)) return null;
            cleanSpawnedObjects[id] = {
                templateId: instance.templateId,
                x: instance.x,
                y: instance.y,
                tag: instance.tag
            };
        }
        const cleanObjectHealth = Object.create(null);
        for (const [id, health] of Object.entries(objectHealth)) {
            if ((!objectIds.has(id) && !Object.prototype.hasOwnProperty.call(cleanSpawnedObjects, id)) ||
                !health || typeof health !== 'object' || Array.isArray(health) ||
                Object.keys(health).some(key => !['current', 'maximum'].includes(key)) ||
                !Number.isSafeInteger(health.current) || !Number.isSafeInteger(health.maximum) ||
                health.maximum < 1 || health.maximum > 99999 || health.current < 0 || health.current > health.maximum) return null;
            cleanObjectHealth[id] = { current: health.current, maximum: health.maximum };
        }
        const cleanObjectSpriteFrames = Object.create(null);
        const mapObjectsById = new Map(mapObjects.filter(object => object && typeof object.id === 'string').map(object => [object.id, object]));
        for (const [id, frame] of Object.entries(objectSpriteFrames)) {
            const spriteSource = mapObjectsById.get(id) ||
                mapObjectsById.get(cleanSpawnedObjects[id]?.templateId);
            const spriteSheet = spriteSource?.spriteSheet;
            if (!spriteSheet || !Number.isSafeInteger(spriteSheet.frameCount) || spriteSheet.frameCount < 1 || spriteSheet.frameCount > 256 ||
                !Number.isSafeInteger(frame) || frame < 0 || frame >= spriteSheet.frameCount) return null;
            cleanObjectSpriteFrames[id] = frame;
        }
        const cleanObjectSpriteAnimations = Object.create(null);
        for (const [id, animation] of Object.entries(objectSpriteAnimations)) {
            const spriteSource = mapObjectsById.get(id) ||
                mapObjectsById.get(cleanSpawnedObjects[id]?.templateId);
            const frameLimit = spriteSource?.spriteSheet?.frameCount;
            const completionEventId = animation?.completionEventId === undefined ? '' : animation.completionEventId;
            const completionEventFired = animation?.completionEventFired === undefined ? false : animation.completionEventFired;
            if (!Number.isSafeInteger(frameLimit) || frameLimit < 1 || frameLimit > 256 ||
                !animation || typeof animation !== 'object' || Array.isArray(animation) ||
                Object.keys(animation).some(key => !['startFrame', 'frameCount', 'fps', 'loop', 'startedAtServer', 'completionEventId', 'completionEventFired'].includes(key)) ||
                !Number.isSafeInteger(animation.startFrame) || animation.startFrame < 0 ||
                !Number.isSafeInteger(animation.frameCount) || animation.frameCount < 1 || animation.startFrame + animation.frameCount > frameLimit ||
                typeof animation.fps !== 'number' || !Number.isFinite(animation.fps) || animation.fps < 1 || animation.fps > 30 ||
                typeof animation.loop !== 'boolean' || !Number.isSafeInteger(animation.startedAtServer) ||
                typeof completionEventId !== 'string' || completionEventId.length > 128 ||
                typeof completionEventFired !== 'boolean' ||
                (completionEventId && (!eventDefs.has(completionEventId) || eventDefs.get(completionEventId).enabled === false || animation.loop)) ||
                (!completionEventId && completionEventFired)) return null;
            cleanObjectSpriteAnimations[id] = {
                startFrame: animation.startFrame,
                frameCount: animation.frameCount,
                fps: animation.fps,
                loop: animation.loop,
                startedAtServer: animation.startedAtServer,
                completionEventId,
                completionEventFired
            };
        }
        const cleanObjectOpacities = Object.create(null);
        for (const [id, opacity] of Object.entries(objectOpacities)) {
            if (!objectIds.has(id) || typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) return null;
            cleanObjectOpacities[id] = opacity;
        }
        const cleanObjectDrawLayers = Object.create(null);
        for (const [objectId, layerId] of Object.entries(objectDrawLayers)) {
            const object = objectDefinitions.get(objectId);
            const layer = layerDefinitions.get(layerId);
            if (!object || !layer || typeof layerId !== 'string' ||
                (object.collision !== false && (layer.parallaxX !== 1 || layer.parallaxY !== 1))) return null;
            cleanObjectDrawLayers[objectId] = layerId;
        }
        const cleanTilemapCells = Object.create(null);
        for (const [id, collisionType] of Object.entries(tilemapCells)) {
            if (!tilemapCellIds.has(id) || !['solid', 'oneWay', 'rampUpRight', 'rampUpLeft', 'hazard', 'decorative'].includes(collisionType)) return null;
            cleanTilemapCells[id] = collisionType;
        }
        const cleanTilemapCellFrames = Object.create(null);
        for (const [id, atlasFrame] of Object.entries(tilemapCellFrames)) {
            const cell = tilemapCellIds.get(id);
            if (!cell || cell.atlasFrameCount < 1 || !Number.isSafeInteger(atlasFrame) || atlasFrame < 0 || atlasFrame >= cell.atlasFrameCount) return null;
            cleanTilemapCellFrames[id] = atlasFrame;
        }
        const cleanLayerVisibility = Object.create(null);
        for (const [id, visible] of Object.entries(layerVisibility)) {
            if (!layerDefinitions.has(id) || typeof visible !== 'boolean') return null;
            if (visible === false) cleanLayerVisibility[id] = false;
        }
        const cleanTriggers = Object.create(null);
        for (const [id, enabled] of Object.entries(triggers)) {
            if (!triggerDefs.has(id) || typeof enabled !== 'boolean') return null;
            cleanTriggers[id] = enabled;
        }
        const cleanState = { variables: cleanVariables, lists: cleanLists, objects: cleanObjects, objectCollisions: cleanObjectCollisions, positions: cleanPositions, motions: cleanMotions, objectHealth: cleanObjectHealth, objectSpriteFrames: cleanObjectSpriteFrames, objectSpriteAnimations: cleanObjectSpriteAnimations, objectOpacities: cleanObjectOpacities, objectDrawLayers: cleanObjectDrawLayers, playerVariables: cleanPlayerVariables, playerLists: cleanPlayerLists, spawnedObjects: cleanSpawnedObjects, tilemapCells: cleanTilemapCells, tilemapCellFrames: cleanTilemapCellFrames, layerVisibility: cleanLayerVisibility, triggers: cleanTriggers, gravity, jumpForce, playerSpeed, horizontalAcceleration, airControl, terminalFallSpeed };
        if (new TextEncoder().encode(JSON.stringify(cleanState)).byteLength > MAX_MECHANICS_STATE_BYTES) return null;
        return cleanState;
    }

    async handleMechanicsState(session, data) {
        if (!session.roomCode || !session.isHost) {
            this.send(session, { type: 'error', message: 'Only the room host can publish mechanics state' });
            return;
        }
        const roomCode = session.roomCode;

        await this.withMechanicsRoomLock(roomCode, async () => {
            if (session.roomCode !== roomCode || !session.isHost) return;
            const roomData = await this.state.storage.get(`room:${roomCode}`);
            if (!roomData) return;
            const room = JSON.parse(roomData);
            if (room.hostUserId !== session.userId) {
                this.send(session, { type: 'error', message: 'Only the room owner can publish mechanics state' });
                return;
            }
            const validPlayerIds = new Set(this.getPlayersInRoom(roomCode).map(player => player.id));
            const state = this.sanitizeMechanicsState(room.mapData, data.state, validPlayerIds);
            if (!state) {
                this.send(session, { type: 'error', message: 'Mechanics state does not match the map schema or size limits' });
                return;
            }
            const previousData = await this.state.storage.get(`mechanics:${roomCode}`);
            if (session.roomCode !== roomCode || !session.isHost) return;
            const previous = previousData ? JSON.parse(previousData) : null;
            const serverTimestamp = Date.now();
            const previousMotions = previous?.state?.motions && typeof previous.state.motions === 'object'
                ? previous.state.motions : {};
            for (const [objectId, motion] of Object.entries(state.motions)) {
                const previousMotion = previousMotions[objectId];
                const isSameMotion = previousMotion?.motionId === motion.motionId &&
                    previousMotion.fromX === motion.fromX && previousMotion.fromY === motion.fromY &&
                    previousMotion.toX === motion.toX && previousMotion.toY === motion.toY &&
                    previousMotion.durationMs === motion.durationMs && previousMotion.easing === motion.easing;
                motion.startedAt = isSameMotion && Number.isSafeInteger(previousMotion.startedAt)
                    ? previousMotion.startedAt
                    : serverTimestamp;
            }
            const previousRevision = Number.isSafeInteger(previous?.revision) && previous.revision >= 0
                ? previous.revision : 0;
            const revision = previousRevision < Number.MAX_SAFE_INTEGER ? previousRevision + 1 : 1;
            await this.state.storage.put(`mechanics:${roomCode}`, JSON.stringify({ revision, updatedAt: serverTimestamp, state }));
            this.mechanicsTilemapCellOverrides = state.tilemapCells;
            this.mechanicsObjectPositions = state.positions;
            this.mechanicsSpawnedObjects = state.spawnedObjects;
            this.refreshMechanicsContactLatches(roomCode);
            this.broadcastToRoom(roomCode, {
                type: 'mechanics_state',
                revision,
                state,
                serverTimestamp
            });
        });
    }

    async handleMechanicsEventRequest(session, data) {
        if (!session.roomCode || session.isHost) return;
        const roomCode = session.roomCode;
        const triggerId = typeof data.triggerId === 'string' ? data.triggerId : '';
        const eventId = typeof data.eventId === 'string' ? data.eventId : '';
        const choiceParentEventId = typeof data.choiceParentEventId === 'string' ? data.choiceParentEventId : '';
        if (!triggerId || triggerId.length > 128 || !eventId || eventId.length > 128 || choiceParentEventId.length > 128) return;

        const now = Date.now();
        if (!session.mechanicsRequestWindow || now - session.mechanicsRequestWindow.startedAt >= 1000) {
            session.mechanicsRequestWindow = { startedAt: now, count: 0 };
        }
        session.mechanicsRequestWindow.count++;
        if (session.mechanicsRequestWindow.count > 20) {
            this.send(session, { type: 'error', message: 'Mechanics event request limit reached' });
            return;
        }

        const roomData = await this.state.storage.get(`room:${roomCode}`);
        if (!roomData) return;
        if (session.roomCode !== roomCode || session.isHost) return;
        const room = JSON.parse(roomData);
        const codeData = room.mapData?.codeData || {};
        const triggers = Array.isArray(codeData.triggers) ? codeData.triggers : [];
        const eventsById = new Map();
        // Older room maps can contain both fields after a partial migration.
        // Use canonical events first, then fill gaps from legacy actions so a
        // valid guest request is not rejected just because another event exists.
        for (const records of [codeData.events, codeData.actions]) {
            if (!Array.isArray(records)) continue;
            for (const event of records) {
                if (typeof event?.id === 'string' && event.id && !eventsById.has(event.id)) {
                    eventsById.set(event.id, event);
                }
            }
        }
        const roomPlayers = this.getPlayersInRoom(roomCode);
        const trigger = triggers.find(item => item?.id === triggerId);
        if (['gameStarts', 'gameEnds', 'playerDies', 'repeat', 'playerJumps', 'playerLands', 'playerRespawns'].includes(trigger?.triggerType)) return;
        if (trigger?.triggerType === 'playerHealthChanged') return;
        if (trigger?.triggerType === 'variableCondition') {
            const variable = (Array.isArray(codeData.variables) ? codeData.variables : [])
                .find(item => item?.id === trigger.config?.variableId && item.enabled !== false &&
                    (item.scope === undefined || ['map', 'player'].includes(item.scope)) && item.variableType !== 'list');
            if (!variable) return;
        }
        const linkedEventId = trigger?.config?.eventId || trigger?.config?.actionId;
        const event = eventsById.get(eventId);
        const choiceParentEvent = choiceParentEventId ? eventsById.get(choiceParentEventId) : null;
        const isDirectChoiceRoute = (Array.isArray(choiceParentEvent?.actions) ? choiceParentEvent.actions : []).some(action =>
            (action?.type === 'showChoice' || action?.type === 'showMenu') &&
            ((Array.isArray(action.choices) ? action.choices : []).some(choice => choice?.eventId === eventId) ||
                (action.type === 'showMenu' && action.cancelEventId === eventId))
        );
        const isRootEventRequest = linkedEventId === eventId && !choiceParentEventId;
        if (!event || event.enabled === false || (!isRootEventRequest &&
            (!choiceParentEvent || choiceParentEvent.enabled === false || !isDirectChoiceRoute))) return;

        // Recheck trigger conditions instead of trusting a trigger id alone.
        // Position and keyboard samples remain client-reported; full server-
        // side physics and input remain separate requirements for cheat-
        // resistant play.
        const currentPosition = Number.isFinite(session.x) && Number.isFinite(session.y)
            ? { x: session.x, y: session.y }
            : null;
        const positionIsRecent = currentPosition && Number.isSafeInteger(session.lastPositionAt) &&
            now >= session.lastPositionAt && now - session.lastPositionAt <= 3000;
        let touchedPlayerId = null;
        const playerBounds = position => position && ({ x: position.x, y: position.y, width: 24, height: 24 });
        let contactLatch = null;
        const overlaps = (position, bounds) => {
            return this.playerOverlapsMechanicsBounds(position, bounds);
        };
        let mechanicsState = {};
        try {
            const mechanicsData = await this.state.storage.get(`mechanics:${roomCode}`);
            mechanicsState = mechanicsData ? JSON.parse(mechanicsData).state || {} : {};
        } catch (_) {
            return;
        }
        const triggerOverride = mechanicsState.triggers?.[triggerId];
        if (triggerOverride === false || (triggerOverride !== true && trigger.enabled === false)) return;
        this.mechanicsTilemapCellOverrides = mechanicsState.tilemapCells && typeof mechanicsState.tilemapCells === 'object'
            ? mechanicsState.tilemapCells : Object.create(null);
        this.mechanicsObjectPositions = mechanicsState.positions && typeof mechanicsState.positions === 'object'
            ? mechanicsState.positions : Object.create(null);
        this.mechanicsSpawnedObjects = mechanicsState.spawnedObjects && typeof mechanicsState.spawnedObjects === 'object'
            ? mechanicsState.spawnedObjects : Object.create(null);
        const mapObjects = Array.isArray(room.mapData?.objects) ? room.mapData.objects : [];
        const objectById = new Map(mapObjects.map(object => [object?.id, object]).filter(([id, object]) => id && object));
        const getBounds = object => {
            if (!object || mechanicsState.objects?.[object.id] === false) return null;
            const position = mechanicsState.positions?.[object.id] || object;
            return {
                x: position.x,
                y: position.y,
                width: object.width ?? object.w,
                height: object.height ?? object.h
            };
        };
        const triggerConfig = trigger.config && typeof trigger.config === 'object' ? trigger.config : {};
        const triggerType = trigger.triggerType;
        if (!['playerEnterZone', 'playerLeaveZone', 'playerTouchObject', 'playerLeaveObject', 'playerPressButton',
            'playerTouchTilemap', 'playerKeyInput', 'playerActionInput', 'variableCondition'].includes(triggerType)) return;
        if (triggerType === 'playerActionInput' && triggerConfig.action !== 'touchOtherPlayer') return;

        if (triggerType === 'variableCondition') {
            const variable = (Array.isArray(codeData.variables) ? codeData.variables : [])
                .find(item => item?.id === triggerConfig.variableId && item.enabled !== false &&
                    (item.scope === undefined || ['map', 'player'].includes(item.scope)) && item.variableType !== 'list');
            const operator = triggerConfig.operator || 'equals';
            if (!variable || !['equals', 'notEquals', 'truthy', 'falsy', 'greaterThan', 'lessThan'].includes(operator) ||
                (['greaterThan', 'lessThan'].includes(operator) && !['integer', 'float'].includes(variable.valueType))) return;

            const normalizeValue = value => {
                if (variable.valueType === 'integer') {
                    const number = Number(value);
                    return Number.isSafeInteger(number) ? number : null;
                }
                if (variable.valueType === 'float') {
                    const number = Number(value);
                    return Number.isFinite(number) ? number : null;
                }
                if (variable.valueType === 'boolean') return value === true || value === 'true';
                if (variable.valueType === 'string' && typeof value === 'string' && value.length <= 512) return value;
                return null;
            };
            const actualValues = variable.scope === 'player'
                ? mechanicsState.playerVariables?.[session.id] || {}
                : mechanicsState.variables || {};
            const actual = Object.prototype.hasOwnProperty.call(actualValues, variable.id)
                ? actualValues[variable.id]
                : normalizeValue(variable.defaultValue);
            const expected = normalizeValue(triggerConfig.value);
            if (actual === null || (!['truthy', 'falsy'].includes(operator) && expected === null)) return;
            const matches = operator === 'truthy' ? Boolean(actual)
                : operator === 'falsy' ? !actual
                    : operator === 'notEquals' ? actual !== expected
                        : operator === 'greaterThan' ? actual > expected
                            : operator === 'lessThan' ? actual < expected
                                : actual === expected;
            if (!matches) return;
        }

        if (triggerType === 'playerKeyInput') {
            const configuredKeys = triggerConfig.keys;
            const inputKeys = Array.isArray(data.inputKeys) ? data.inputKeys : [];
            if (!Array.isArray(configuredKeys) || !configuredKeys.length || configuredKeys.length > 16 ||
                configuredKeys.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || key === 'other') ||
                new Set(configuredKeys).size !== configuredKeys.length || inputKeys.length > 16 ||
                inputKeys.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) ||
                new Set(inputKeys).size !== inputKeys.length) return;
            const pressed = new Set(inputKeys);
            const allPressed = configuredKeys.every(key => key === 'any' || key === 'all'
                ? pressed.size > 0
                    : key === 'allAlphabet'
                        ? Array.from(pressed).some(code => /^Key[A-Z]$/.test(code))
                        : key === 'allNumbers'
                            ? Array.from(pressed).some(code => /^Digit[0-9]$/.test(code))
                            : key === 'allAlphanumeric'
                                ? Array.from(pressed).some(code => /^(Key[A-Z]|Digit[0-9])$/.test(code))
                    : pressed.has(key));
            if (!allPressed) return;
        }

        if (['playerEnterZone', 'playerLeaveZone'].includes(triggerType)) {
            const zoneBounds = mapObjects
                .filter(object => object?.appearanceType === 'zone' && object.zoneName === triggerConfig.zoneName)
                .map(getBounds)
                .filter(Boolean);
            const previousPosition = session.previousPosition;
            const previousIsRecent = previousPosition && Number.isSafeInteger(session.previousPositionAt) &&
                now >= session.previousPositionAt && now - session.previousPositionAt <= 3000;
            if (!positionIsRecent || !previousIsRecent || !zoneBounds.length) return;
            const wasInside = zoneBounds.some(bounds => overlaps(previousPosition, bounds));
            const isInside = zoneBounds.some(bounds => overlaps(currentPosition, bounds));
            if (triggerType === 'playerEnterZone' ? (wasInside || !isInside) : (!wasInside || isInside)) return;
            contactLatch = {
                kind: triggerType === 'playerEnterZone' ? 'zone-group-inside' : 'zone-group-outside',
                bounds: zoneBounds
            };
        } else if (triggerType === 'playerTouchObject') {
            const object = objectById.get(triggerConfig.objectId);
            if (!positionIsRecent || !object) return;
            const candidates = [];
            const contactShape = ['circle', 'capsule'].includes(triggerConfig.shape) ? triggerConfig.shape : 'box';
            const staticBounds = getBounds(object);
            if (staticBounds) candidates.push({ id: object.id, bounds: { ...staticBounds, shape: contactShape } });
            for (const [spawnId, instance] of Object.entries(mechanicsState.spawnedObjects || {})) {
                if (instance?.templateId !== object.id || !Number.isFinite(instance.x) || !Number.isFinite(instance.y)) continue;
                candidates.push({
                    id: spawnId,
                    bounds: {
                        x: instance.x,
                        y: instance.y,
                        width: object.width ?? object.w,
                        height: object.height ?? object.h,
                        shape: contactShape
                    }
                });
            }
            const touched = candidates.find(candidate => overlaps(currentPosition, candidate.bounds));
            if (!touched) return;
            contactLatch = { kind: 'object-inside', bounds: touched.bounds, objectId: touched.id };
        } else if (triggerType === 'playerLeaveObject') {
            const object = objectById.get(triggerConfig.objectId);
            const previousPosition = session.previousPosition;
            const previousIsRecent = previousPosition && Number.isSafeInteger(session.previousPositionAt) &&
                now >= session.previousPositionAt && now - session.previousPositionAt <= 3000;
            if (!positionIsRecent || !previousIsRecent || !object) return;
            const candidates = [];
            const contactShape = ['circle', 'capsule'].includes(triggerConfig.shape) ? triggerConfig.shape : 'box';
            const staticBounds = getBounds(object);
            if (staticBounds) candidates.push({ id: object.id, bounds: { ...staticBounds, shape: contactShape } });
            for (const [spawnId, instance] of Object.entries(mechanicsState.spawnedObjects || {})) {
                if (instance?.templateId !== object.id || !Number.isFinite(instance.x) || !Number.isFinite(instance.y)) continue;
                candidates.push({
                    id: spawnId,
                    bounds: {
                        x: instance.x,
                        y: instance.y,
                        width: object.width ?? object.w,
                        height: object.height ?? object.h,
                        shape: contactShape
                    }
                });
            }
            const left = candidates.find(candidate =>
                overlaps(previousPosition, candidate.bounds) && !overlaps(currentPosition, candidate.bounds));
            if (!left) return;
            contactLatch = { kind: 'object-outside', bounds: left.bounds, objectId: left.id };
        } else if (triggerType === 'playerPressButton') {
            if (!positionIsRecent || typeof triggerConfig.buttonName !== 'string' || !triggerConfig.buttonName) return;
            const button = mapObjects.find(object => object?.appearanceType === 'button' &&
                object.actingType === 'button' && object.name === triggerConfig.buttonName &&
                overlaps(currentPosition, getBounds(object)));
            if (!button) return;
            contactLatch = { kind: 'object-inside', bounds: getBounds(button), objectId: button.id };
        } else if (triggerType === 'playerTouchTilemap') {
            if (!positionIsRecent) return;
            const collisionType = triggerConfig.collisionType === undefined ? 'any' : triggerConfig.collisionType;
            if (!['any', 'solid', 'oneWay', 'hazard'].includes(collisionType)) return;
            const touched = this.findMechanicsTilemapContact(room.mapData, triggerConfig.tilemapId, collisionType, currentPosition, mechanicsState);
            if (!touched) return;
            const previousIsRecent = session.previousPosition && Number.isSafeInteger(session.previousPositionAt) &&
                now >= session.previousPositionAt && now - session.previousPositionAt <= 3000;
            if (previousIsRecent && this.findMechanicsTilemapContact(
                room.mapData, triggerConfig.tilemapId, collisionType, session.previousPosition, mechanicsState
            )) return;
            contactLatch = {
                kind: 'tilemap-cell-contact',
                bounds: touched.bounds,
                objectId: touched.id,
                collisionType,
                cellCollisionType: touched.collisionType,
                polygonOneWay: touched.polygonOneWay === true
            };
        } else if (triggerType === 'playerActionInput' && triggerConfig.action === 'touchOtherPlayer') {
            if (!positionIsRecent) return;
            const touchedPlayer = roomPlayers.find(other => other.id !== session.id &&
                Number.isSafeInteger(other.lastPositionAt) && now >= other.lastPositionAt && now - other.lastPositionAt <= 3000 &&
                overlaps(currentPosition, playerBounds(other)));
            if (!touchedPlayer) return;
            touchedPlayerId = touchedPlayer.id;
            contactLatch = { kind: 'player-contact' };
        }

        const hostSession = this.getPlayersInRoom(roomCode).find(player =>
            player.isHost && player.userId === room.hostUserId
        );
        if (!hostSession) return;
        if (contactLatch) {
            this.refreshMechanicsContactLatches(roomCode);
            if (!(session.mechanicsContactLatches instanceof Map)) session.mechanicsContactLatches = new Map();
            if (session.mechanicsContactLatches.has(triggerId) || session.mechanicsContactLatches.size >= 256) return;
            session.mechanicsContactLatches.set(triggerId, contactLatch);
        }
        this.send(hostSession, {
            type: 'mechanics_event_request',
            triggerId,
            eventId,
            choiceParentEventId: choiceParentEventId || null,
            playerId: session.id,
            touchedPlayerId,
            touchedObjectId: contactLatch?.objectId || null,
            playerName: String(session.user?.name || 'Player').slice(0, 50)
        });
    }

    async handleGlobalCoinCollectRequest(session, data) {
        const roomCode = session.roomCode;
        const coinId = typeof data.coinId === 'string' ? data.coinId : '';
        if (!roomCode || !coinId || coinId.length > 128) return;
        const now = Date.now();
        if (!session.coinRequestWindow || now - session.coinRequestWindow.startedAt >= 1000) {
            session.coinRequestWindow = { startedAt: now, count: 0 };
        }
        if (++session.coinRequestWindow.count > 10) {
            this.send(session, { type: 'global_coin_collection_rejected', coinId });
            return;
        }

        await this.withMechanicsRoomLock(roomCode, async () => {
            if (session.roomCode !== roomCode) return;
            const validationTime = Date.now();
            const reject = () => this.send(session, { type: 'global_coin_collection_rejected', coinId });
            const roomData = await this.state.storage.get(`room:${roomCode}`);
            if (!roomData) return reject();
            const room = JSON.parse(roomData);
            const coins = Array.isArray(room.mapData?.objects) ? room.mapData.objects : [];
            const coin = coins.find(object => object?.id === coinId && object.appearanceType === 'coin' &&
                object.coinActivityScope !== 'player');
            if (!coin || !Number.isFinite(session.x) || !Number.isFinite(session.y) ||
                !Number.isSafeInteger(session.lastPositionAt) || validationTime < session.lastPositionAt ||
                validationTime - session.lastPositionAt > 3000) return reject();

            const mechanicsData = await this.state.storage.get(`mechanics:${roomCode}`);
            const mechanicsState = mechanicsData ? JSON.parse(mechanicsData).state || {} : {};
            if (mechanicsState.objects?.[coinId] === false) return reject();
            const position = mechanicsState.positions?.[coinId] || coin;
            const width = Number(coin.width ?? coin.w);
            const height = Number(coin.height ?? coin.h);
            if (![position.x, position.y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
                !this.playerOverlapsMechanicsBounds(session, { x: position.x, y: position.y, width, height })) return reject();

            const collected = new Set(Array.isArray(room.globalCoinIds) ? room.globalCoinIds : []);
            if (collected.has(coinId)) {
                this.send(session, { type: 'global_coin_collected', coinId });
                return;
            }
            collected.add(coinId);
            room.globalCoinIds = Array.from(collected).slice(0, 10000);
            await this.state.storage.put(`room:${roomCode}`, JSON.stringify(room));
            this.broadcastToRoom(roomCode, { type: 'global_coin_collected', coinId });
        });
    }

    handleKickPlayer(session, data) {
        if (!session.isHost || !session.roomCode) return;

        const targetSession = this.sessions.get(data.playerId);
        if (targetSession && targetSession.roomCode === session.roomCode) {
            this.send(targetSession, {
                type: 'player_kicked',
                message: 'You have been kicked by the host'
            });

            targetSession.roomCode = null;

            this.broadcastToRoom(session.roomCode, {
                type: 'player_left',
                playerId: targetSession.id,
                playerName: targetSession.user?.name,
                playerUsername: targetSession.user?.username,
                kicked: true
            });
        }
    }

    handleChat(session, data) {
        if (!session.roomCode || !data.message) return;

        this.broadcastToRoom(session.roomCode, {
            type: 'chat_message',
            playerId: session.id,
            playerName: session.user?.name,
            playerUsername: session.user?.username,
            playerColor: session.playerColor,
            message: data.message.slice(0, 200) // Limit message length
        });
    }

    handleAdminTitle(session, data) {
        if (!session.isHost || !session.roomCode) return;

        const titleText = typeof data.text === 'string' ? data.text.trim() : '';
        if (!titleText) {
            this.send(session, { type: 'error', message: 'Title text cannot be empty' });
            return;
        }

        const titleColor = typeof data.color === 'string' ? data.color.trim() : '';
        const rawIds = Array.isArray(data.playerIds) ? data.playerIds : [];
        const uniqueIds = [...new Set(rawIds.map((id) => String(id)))];

        let delivered = 0;
        for (const targetId of uniqueIds) {
            if (targetId === '__self__') {
                this.send(session, {
                    type: 'title_message',
                    text: titleText.slice(0, 200),
                    color: titleColor.slice(0, 32),
                    from: session.user?.name || 'Host'
                });
                delivered++;
                continue;
            }

            const targetSession = this.sessions.get(targetId);
            if (!targetSession || targetSession.roomCode !== session.roomCode) continue;

            this.send(targetSession, {
                type: 'title_message',
                text: titleText.slice(0, 200),
                color: titleColor.slice(0, 32),
                from: session.user?.name || 'Host'
            });
            delivered++;
        }

        this.send(session, { type: 'admin_title_result', delivered });
    }

    async handleDisconnect(session) {
        if (session.roomCode) {
            this.handleLeaveRoom(session);
        }
        // Track play time
        if (session.userId && session.connectedAt) {
            try {
                const duration = Date.now() - session.connectedAt;
                if (duration > 5000) {
                    const userData = await this.env.USERS.get(`user:${session.userId}`);
                    if (userData) {
                        const user = JSON.parse(userData);
                        user.totalPlayTime = (user.totalPlayTime || 0) + duration;
                        const sessions = user.recentSessions || [];
                        sessions.push({ start: session.connectedAt, end: Date.now() });
                        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                        user.recentSessions = sessions.filter(s => s.end > weekAgo);
                        await this.env.USERS.put(`user:${session.userId}`, JSON.stringify(user));
                    }
                }
            } catch (e) { /* best-effort */ }
        }
        this.sessions.delete(session.id);
    }

    getPlayersInRoom(roomCode) {
        const players = [];
        for (const [id, session] of this.sessions) {
            if (session.roomCode === roomCode && session.userId) {
                players.push(session);
            }
        }
        return players;
    }

    broadcastToRoom(roomCode, message, excludeId = null) {
        for (const [id, session] of this.sessions) {
            if (session.roomCode === roomCode && id !== excludeId) {
                this.send(session, message);
            }
        }
    }

    send(session, message) {
        try {
            session.webSocket.send(JSON.stringify(message));
        } catch (error) {
            // Connection might be closed
        }
    }
}

// ============================================
// MAIL HANDLERS
// ============================================
async function handleListMail(env, userId) {
    const mailData = await env.USERS.get(`mail:${userId}`);
    const mails = mailData ? JSON.parse(mailData) : [];
    return jsonResponse(mails);
}

async function handleUnreadMailCount(env, userId) {
    const mailData = await env.USERS.get(`mail:${userId}`);
    const mails = mailData ? JSON.parse(mailData) : [];
    const count = mails.filter(m => !m.read).length;
    return jsonResponse({ count });
}

async function handleMarkMailRead(mailId, env, userId) {
    const mailData = await env.USERS.get(`mail:${userId}`);
    if (!mailData) return errorResponse('No mail found', 404);
    const mails = JSON.parse(mailData);
    const mail = mails.find(m => m.id === mailId);
    if (!mail) return errorResponse('Mail not found', 404);
    mail.read = true;
    await env.USERS.put(`mail:${userId}`, JSON.stringify(mails));
    return jsonResponse({ success: true });
}

async function handleDeleteMail(mailId, env, userId) {
    const mailData = await env.USERS.get(`mail:${userId}`);
    if (!mailData) return errorResponse('No mail found', 404);
    const mails = JSON.parse(mailData);
    const filtered = mails.filter(m => m.id !== mailId);
    await env.USERS.put(`mail:${userId}`, JSON.stringify(filtered));
    return jsonResponse({ success: true });
}

// ============================================
// ADMIN HANDLERS
// ============================================
const DEFAULT_ADMIN_USERNAMES = ['jimmyqrg', 'parkoreen'];

/** Normalize username for admin checks (trim, NFKC, lowercase). */
function normalizeUsernameForAdmin(raw) {
    if (raw == null || typeof raw !== 'string') return '';
    try {
        return raw.normalize('NFKC').trim().toLowerCase();
    } catch {
        return String(raw).trim().toLowerCase();
    }
}

/**
 * Admin allowlist: defaults + optional env.ADMIN_USERNAMES (comma/space-separated).
 * Set ADMIN_USERNAMES in the Worker dashboard or wrangler [vars] without redeploying code.
 */
function getAdminUsernameSet(env) {
    const set = new Set(DEFAULT_ADMIN_USERNAMES.map((s) => s.toLowerCase()));
    const extra = env?.ADMIN_USERNAMES;
    if (extra && typeof extra === 'string') {
        for (const part of extra.split(/[,;\s]+/)) {
            const t = normalizeUsernameForAdmin(part);
            if (t) set.add(t);
        }
    }
    return set;
}

async function resolveAdminUser(env, userId) {
    const userData = await env.USERS.get(`user:${userId}`);
    if (!userData) return null;
    const user = JSON.parse(userData);
    const uname = normalizeUsernameForAdmin(user.username);
    if (!uname || !getAdminUsernameSet(env).has(uname)) return null;
    return user;
}

async function handleAdminGetMap(mapId, env) {
    const mapData = await env.MAPS.get(`map:${mapId}`);
    if (!mapData) return errorResponse('Map not found', 404);
    return jsonResponse(JSON.parse(mapData));
}

async function handleAdminUpdateMap(mapId, request, env) {
    const mapData = await env.MAPS.get(`map:${mapId}`);
    if (!mapData) return errorResponse('Map not found', 404);
    const map = JSON.parse(mapData);
    const updates = await request.json();

    if (updates.name !== undefined) {
        const n = String(updates.name).trim();
        if (n) map.name = n;
        if (map.pristineSample === true && n && n.toLowerCase() !== 'sample map') {
            map.pristineSample = false;
        }
    }
    if (updates.data !== undefined) {
        map.data = updates.data;
        map.pristineSample = false;
    }
    map.updatedAt = new Date().toISOString();
    await env.MAPS.put(`map:${mapId}`, JSON.stringify(map));
    return jsonResponse({ success: true });
}

async function handleAdminDeleteMap(mapId, env) {
    const mapData = await env.MAPS.get(`map:${mapId}`);
    if (!mapData) return errorResponse('Map not found', 404);
    const map = JSON.parse(mapData);
    const ownerId = map.userId;

    await env.MAPS.delete(`map:${mapId}`);

    if (ownerId) {
        const mapListData = await env.MAPS.get(`user:${ownerId}:maps`);
        if (mapListData) {
            const mapList = JSON.parse(mapListData);
            const idx = mapList.indexOf(mapId);
            if (idx !== -1) {
                mapList.splice(idx, 1);
                await env.MAPS.put(`user:${ownerId}:maps`, JSON.stringify(mapList));
            }
        }
    }
    return jsonResponse({ success: true });
}

function roomMapNameHint(room) {
    return (
        room.mapName ||
        (room.mapData && typeof room.mapData === 'object' && room.mapData.mapName) ||
        null
    );
}

/** All maps in KV (admin), excluding untouched auto-seeded Sample Map (pristineSample). */
async function handleAdminListMaps(env) {
    const out = [];
    let cursor;
    do {
        const list = await env.MAPS.list({ prefix: 'map:', cursor });
        for (const key of list.keys) {
            const raw = await env.MAPS.get(key.name);
            if (!raw) continue;
            let map;
            try {
                map = JSON.parse(raw);
            } catch {
                continue;
            }
            if (!map || !map.id) continue;
            if (map.pristineSample === true) continue;

            const userData = map.userId ? await env.USERS.get(`user:${map.userId}`) : null;
            const user = userData ? JSON.parse(userData) : null;
            out.push({
                id: map.id,
                name: map.name || 'Untitled',
                userId: map.userId,
                ownerUsername: user ? user.username : 'unknown',
                ownerDisplayName: user ? user.name : '—',
                createdAt: map.createdAt,
                updatedAt: map.updatedAt,
                hasData: map.data != null
            });
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    } while (cursor);

    let roomsList = [];
    try {
        const rr = await handleAdminListRooms(env);
        if (rr.ok) roomsList = await rr.json();
    } catch {
        /* ignore */
    }

    const nameLower = (s) => (s || '').toLowerCase();
    for (const m of out) {
        m.activeRooms = roomsList
            .filter((r) => {
                if (r.mapId && r.mapId === m.id) return true;
                if (!r.mapId) {
                    const rn = roomMapNameHint(r);
                    if (rn && nameLower(rn) === nameLower(m.name)) return true;
                }
                return false;
            })
            .map((r) => ({
                code: r.code,
                playerCount: r.playerCount,
                hostUsername: r.hostUsername,
                mapName: roomMapNameHint(r)
            }));
    }

    out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return jsonResponse(out);
}

async function handleAdminListUsers(env) {
    const userKeys = await env.USERS.list({ prefix: 'user:' });
    const users = [];
    for (const key of userKeys.keys) {
        if (key.name.startsWith('user:') && !key.name.includes(':') && key.name.length > 5) {
            // user:USERID keys only (skip username: and flag: etc)
        }
    }
    // Better approach: iterate all keys with prefix 'user:' and filter by structure
    const allKeys = [];
    let cursor = undefined;
    while (true) {
        const list = await env.USERS.list({ prefix: 'user:', cursor });
        for (const key of list.keys) {
            const name = key.name;
            // Only match user:{id} pattern, not username:{x} or user:{id}:sessions etc.
            if (/^user:[A-Za-z0-9_-]{8,}$/.test(name)) {
                allKeys.push(name);
            }
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }

    for (const key of allKeys) {
        const userData = await env.USERS.get(key);
        if (!userData) continue;
        const user = JSON.parse(userData);
        const uid = user.id;

        // Count maps
        const mapListData = await env.MAPS.get(`user:${uid}:maps`);
        const mapList = mapListData ? JSON.parse(mapListData) : [];

        users.push({
            id: uid,
            username: user.username,
            name: user.name,
            color: user.color,
            createdAt: user.createdAt,
            mapsCount: mapList.length,
            totalPlayTime: user.totalPlayTime || 0,
            weekPlayTime: computeWeekPlayTime(user.recentSessions || [])
        });
    }

    return jsonResponse(users);
}

function computeWeekPlayTime(sessions) {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let total = 0;
    for (const s of sessions) {
        if (s.end > weekAgo) {
            const start = Math.max(s.start, weekAgo);
            total += s.end - start;
        }
    }
    return total;
}

async function handleAdminDeleteUser(targetUserId, env) {
    const userData = await env.USERS.get(`user:${targetUserId}`);
    if (!userData) return errorResponse('User not found', 404);
    const user = JSON.parse(userData);

    // Delete user data
    await env.USERS.delete(`user:${targetUserId}`);
    if (user.username) {
        await env.USERS.delete(`username:${user.username.toLowerCase()}`);
    }

    // Delete user's maps
    const mapListData = await env.MAPS.get(`user:${targetUserId}:maps`);
    if (mapListData) {
        const mapList = JSON.parse(mapListData);
        for (const mapId of mapList) {
            await env.MAPS.delete(`map:${mapId}`);
        }
        await env.MAPS.delete(`user:${targetUserId}:maps`);
    }

    // Delete user's mail
    await env.USERS.delete(`mail:${targetUserId}`);

    // Delete user's sessions
    const sessionKeys = await env.SESSIONS.list({ prefix: `user:${targetUserId}:` });
    for (const key of sessionKeys.keys) {
        await env.SESSIONS.delete(key.name);
    }

    // Delete user's flags
    let flagCursor = undefined;
    while (true) {
        const list = await env.USERS.list({ prefix: `flag:${targetUserId}:`, cursor: flagCursor });
        for (const key of list.keys) {
            await env.USERS.delete(key.name);
        }
        if (list.list_complete) break;
        flagCursor = list.cursor;
    }

    return jsonResponse({ success: true, deletedUsername: user.username });
}

async function handleAdminSendMail(targetUserId, request, env, senderUserId) {
    const targetUserData = await env.USERS.get(`user:${targetUserId}`);
    if (!targetUserData) return errorResponse('User not found', 404);

    const senderData = await env.USERS.get(`user:${senderUserId}`);
    const sender = senderData ? JSON.parse(senderData) : { name: 'System', username: 'system' };

    const { subject, body } = await request.json();
    if (!subject || !body) return errorResponse('Subject and body are required');

    const mailData = await env.USERS.get(`mail:${targetUserId}`);
    const mails = mailData ? JSON.parse(mailData) : [];

    mails.unshift({
        id: 'mail_' + generateId(12),
        from: senderUserId,
        fromName: sender.name,
        fromUsername: sender.username,
        subject: subject.slice(0, 200),
        body: body.slice(0, 2000),
        read: false,
        createdAt: new Date().toISOString()
    });

    // Keep max 100 mails per user
    if (mails.length > 100) mails.length = 100;

    await env.USERS.put(`mail:${targetUserId}`, JSON.stringify(mails));
    return jsonResponse({ success: true });
}

async function handleAdminListRooms(env) {
    if (!env.GAME_ROOMS) return jsonResponse([]);
    const id = env.GAME_ROOMS.idFromName('main');
    const room = env.GAME_ROOMS.get(id);
    const resp = await room.fetch(new Request('https://internal/admin/rooms'));
    return new Response(resp.body, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
}

// ============================================
// MAIN HANDLER
// ============================================
export default {
    async fetch(request, env, ctx) {
        // ALWAYS wrap in try-catch to ensure CORS headers are returned
        try {
            const url = new URL(request.url);
            // Normalize trailing slashes so /admin/users/ matches /admin/users
            let path = url.pathname.replace(/\/+$/, '') || '/';
            // Collapse duplicate slashes (e.g. https://host//admin/users from API_URL + '/admin/...')
            path = path.replace(/^\/+/, '/');
            // Same-origin / GitHub Pages often proxies API under /parkoreen
            if (path === '/parkoreen' || path.startsWith('/parkoreen/')) {
                path = path.slice('/parkoreen'.length) || '/';
                path = path.replace(/\/+$/, '') || '/';
                path = path.replace(/^\/+/, '/');
            }
            const method = request.method;

            // Handle CORS preflight
            if (method === 'OPTIONS') {
                return new Response(null, { headers: CORS_HEADERS });
            }

            // Root path - health check
            if (path === '/' || path === '') {
                return jsonResponse({ status: 'ok', message: 'Parkoreen API is running' });
            }

            // Check if KV bindings are available
            if (!env.USERS || !env.MAPS || !env.SESSIONS) {
                console.error('KV namespaces not bound:', { USERS: !!env.USERS, MAPS: !!env.MAPS, SESSIONS: !!env.SESSIONS });
                return errorResponse('Server not configured: KV namespaces not bound. Please check wrangler.toml', 503);
            }

            // WebSocket handling - delegate to Durable Object
            if (path === '/ws') {
                if (!env.GAME_ROOMS) {
                    return errorResponse('Multiplayer not configured', 503);
                }
                const id = env.GAME_ROOMS.idFromName('main');
                const room = env.GAME_ROOMS.get(id);
                return room.fetch(request);
            }

            // Auth middleware
            let userId = null;
            const authHeader = request.headers.get('Authorization');
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.slice(7);
                const payload = verifyToken(token);
                if (payload) {
                    userId = payload.userId;
                }
            }

            // Routes
            // Auth routes (no auth required)
            if (path === '/auth/signup' && method === 'POST') {
                return handleSignup(request, env);
            }
            if (path === '/auth/login' && method === 'POST') {
                return handleLogin(request, env);
            }

            // Protected routes
            if (!userId) {
                return errorResponse('Unauthorized', 401);
            }

            // Profile routes
            if (path === '/auth/profile' && method === 'PUT') {
                return handleUpdateProfile(request, env, userId);
            }
            if (path === '/auth/password' && method === 'PUT') {
                return handleChangePassword(request, env, userId);
            }

            // Level progress routes
            if (path === '/level-progress' && method === 'GET') {
                return handleGetLevelProgress(env, userId);
            }
            if (path === '/level-progress' && method === 'POST') {
                return handleUpdateLevelProgress(request, env, userId);
            }

            // Settings routes (per-account preferences)
            if (path === '/settings' && method === 'GET') {
                return handleGetSettings(env, userId);
            }
            if (path === '/settings' && method === 'PUT') {
                return handleUpdateSettings(request, env, userId);
            }

            // Editor recent-fonts routes
            if (path === '/editor/recent-fonts' && method === 'GET') {
                return handleGetRecentFonts(env, userId);
            }
            if (path === '/editor/recent-fonts' && method === 'PUT') {
                return handleUpdateRecentFonts(request, env, userId);
            }

            // Admin global bans
            if (path === '/admin/global-bans' && method === 'GET') {
                return handleGetGlobalBans(env, userId);
            }
            if (path === '/admin/global-bans' && method === 'PUT') {
                return handleUpdateGlobalBans(request, env, userId);
            }

            // Flag routes (for easter eggs)
            const flagMatch = path.match(/^\/flag\/([a-zA-Z0-9_]+)$/);
            if (flagMatch) {
                const flagName = flagMatch[1];
                if (method === 'GET') {
                    return handleGetFlag(flagName, env, userId);
                }
                if (method === 'PUT') {
                    return handleSetFlag(flagName, env, userId);
                }
                if (method === 'DELETE') {
                    return handleDeleteFlag(flagName, env, userId);
                }
            }

            // Map routes
            if (path === '/maps' && method === 'GET') {
                return handleListMaps(env, userId);
            }
            if (path === '/maps' && method === 'POST') {
                return handleCreateMap(request, env, userId);
            }

            const mapMatch = path.match(/^\/maps\/([a-zA-Z0-9]+)$/);
            if (mapMatch) {
                const mapId = mapMatch[1];
                if (method === 'GET') {
                    return handleGetMap(mapId, env, userId);
                }
                if (method === 'PUT') {
                    return handleUpdateMap(mapId, request, env, userId);
                }
                if (method === 'DELETE') {
                    return handleDeleteMap(mapId, env, userId);
                }
            }

            // Mail routes
            if (path === '/mail' && method === 'GET') {
                return handleListMail(env, userId);
            }
            if (path === '/mail/unread' && method === 'GET') {
                return handleUnreadMailCount(env, userId);
            }
            const mailMatch = path.match(/^\/mail\/([a-zA-Z0-9_]+)$/);
            if (mailMatch) {
                const mailId = mailMatch[1];
                if (method === 'PUT') {
                    return handleMarkMailRead(mailId, env, userId);
                }
                if (method === 'DELETE') {
                    return handleDeleteMail(mailId, env, userId);
                }
            }

            // Admin routes (require admin privileges)
            if (path.startsWith('/admin/')) {
                const admin = await resolveAdminUser(env, userId);
                if (!admin) return errorResponse('Forbidden', 403);

                if (path === '/admin/users' && method === 'GET') {
                    return handleAdminListUsers(env);
                }
                if (path === '/admin/rooms' && method === 'GET') {
                    return handleAdminListRooms(env);
                }
                if (path === '/admin/maps' && method === 'GET') {
                    return handleAdminListMaps(env);
                }
                const adminMapDetail = path.match(/^\/admin\/maps\/([^/]+)$/);
                if (adminMapDetail) {
                    const mid = adminMapDetail[1];
                    if (method === 'GET') return handleAdminGetMap(mid, env);
                    if (method === 'PUT') return handleAdminUpdateMap(mid, request, env);
                    if (method === 'DELETE') return handleAdminDeleteMap(mid, env);
                }
                const adminUserMatch = path.match(/^\/admin\/users\/([a-zA-Z0-9]+)$/);
                if (adminUserMatch) {
                    const targetUserId = adminUserMatch[1];
                    if (method === 'DELETE') {
                        return handleAdminDeleteUser(targetUserId, env);
                    }
                }
                const adminMailMatch = path.match(/^\/admin\/users\/([a-zA-Z0-9]+)\/mail$/);
                if (adminMailMatch) {
                    const targetUserId = adminMailMatch[1];
                    if (method === 'POST') {
                        return handleAdminSendMail(targetUserId, request, env, userId);
                    }
                }
                return errorResponse('Unknown admin route', 404);
            }

            return errorResponse('Not found', 404);
        } catch (error) {
            console.error('Worker error:', error);
            // Always return with CORS headers even on error
            return new Response(JSON.stringify({ error: true, message: 'Internal server error: ' + error.message }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    ...CORS_HEADERS
                }
            });
        }
    }
};

// Export Durable Object class
export { GameRoom };
