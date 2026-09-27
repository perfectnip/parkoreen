/**
 * PARKOREEN - Game Engine
 * Core game mechanics: physics, player, camera, collisions
 */

// ============================================
// CONSTANTS
// ============================================
const GRID_SIZE = 32;
// Physics: Lower gravity for floatier feel, jump force adjusted to maintain same jump HEIGHT
// Formula: h = v²/(2g), so to keep h constant: v₂ = v₁ * sqrt(g₂/g₁)
// Old: g=0.8, v=-14, h=122.5 | New: g=0.5, v=-13.2
const DEFAULT_GRAVITY = 0.71;
const DEFAULT_JUMP_FORCE = -13.2;
const DEFAULT_MOVE_SPEED = 5;
const DEFAULT_HORIZONTAL_ACCELERATION = 0;
const DEFAULT_AIR_CONTROL = 1;
const MAX_HORIZONTAL_ACCELERATION = 20;
const DEFAULT_TERMINAL_FALL_SPEED = 16;
const MAX_TERMINAL_FALL_SPEED = 100;
const WORLD_TILEMAP_MAX_COUNT = 64;
const WORLD_TILEMAP_MAX_CELLS = 100000;
const WORLD_TILEMAP_MAX_ANIMATED_CELLS = 2048;
const WORLD_TILEMAP_MAX_POSITION = 10000000;
const WORLD_TILEMAP_ATLAS_MAX_DATA_URL_LENGTH = 1500000;
const WORLD_TILEMAP_ATLAS_MAX_PIXELS = 16000000;
const WORLD_TILEMAP_ATLAS_TOTAL_MAX_PIXELS = 32000000;
const WORLD_TILEMAP_CELL_BEHAVIORS = new Set(['solid', 'oneWay', 'rampUpRight', 'rampUpLeft', 'hazard', 'decorative']);
const FLY_SPEED = 8;
const CAMERA_LERP_X = 0.12;
const CAMERA_LERP_Y = 0.12;
const PLAYER_SIZE = 32;
const WORLD_LAYER_MIN_DEPTH = -1000;
const WORLD_LAYER_MAX_DEPTH = 1000;
const WORLD_LAYER_MAX_COUNT = 64;
// Rasterized world chunks are only a rendering cache. Keep the active camera's
// chunks warm without retaining a bitmap for every chunk in a large map.
const WORLD_TILE_RENDER_CACHE_MAX_CHUNKS = 128;
const WORLD_COLLISION_POLYGON_MAX_POINTS = 12;
const DEFAULT_WORLD_COLLISION_POLYGON = [
    [0, 0.25], [0.25, 0], [0.75, 0], [1, 0.25], [1, 1], [0, 1]
];
const DEFAULT_WORLD_LAYER_DEFINITIONS = [
    { id: 'behind-player', name: 'Behind Player', depth: 0, builtin: true, parallaxX: 1, parallaxY: 1 },
    { id: 'player-depth', name: 'Same Layer', depth: 1, builtin: true, parallaxX: 1, parallaxY: 1 },
    { id: 'above-player', name: 'Above Player', depth: 2, builtin: true, parallaxX: 1, parallaxY: 1 }
];
const normalizeWorldLayerParallax = value => {
    const factor = typeof value === 'number'
        ? value
        : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
    return Number.isFinite(factor) ? Math.max(0, Math.min(2, factor)) : 1;
};

const normalizeWorldLayerDepth = value => {
    const depth = typeof value === 'number'
        ? value
        : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
    return Number.isSafeInteger(depth) && depth >= WORLD_LAYER_MIN_DEPTH && depth <= WORLD_LAYER_MAX_DEPTH
        ? depth
        : null;
};

const normalizeWorldCollisionPolygon = points => {
    if (!Array.isArray(points) || points.length < 3 || points.length > WORLD_COLLISION_POLYGON_MAX_POINTS) return null;
    const normalized = [];
    for (const point of points) {
        if (Array.isArray(point) && point.length !== 2) return null;
        const x = Array.isArray(point) ? point[0] : point?.x;
        const y = Array.isArray(point) ? point[1] : point?.y;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
        normalized.push([x, y]);
    }
    const pointEqual = (a, b) => Math.abs(a[0] - b[0]) < 1e-8 && Math.abs(a[1] - b[1]) < 1e-8;
    for (let i = 0; i < normalized.length; i++) {
        for (let j = i + 1; j < normalized.length; j++) {
            if (pointEqual(normalized[i], normalized[j])) return null;
        }
    }
    const orientation = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const onSegment = (a, b, p) => p[0] >= Math.min(a[0], b[0]) - 1e-8 && p[0] <= Math.max(a[0], b[0]) + 1e-8 &&
        p[1] >= Math.min(a[1], b[1]) - 1e-8 && p[1] <= Math.max(a[1], b[1]) + 1e-8;
    const segmentsIntersect = (a, b, c, d) => {
        const abC = orientation(a, b, c);
        const abD = orientation(a, b, d);
        const cdA = orientation(c, d, a);
        const cdB = orientation(c, d, b);
        if (((abC > 1e-8 && abD < -1e-8) || (abC < -1e-8 && abD > 1e-8)) &&
            ((cdA > 1e-8 && cdB < -1e-8) || (cdA < -1e-8 && cdB > 1e-8))) return true;
        return (Math.abs(abC) <= 1e-8 && onSegment(a, b, c)) || (Math.abs(abD) <= 1e-8 && onSegment(a, b, d)) ||
            (Math.abs(cdA) <= 1e-8 && onSegment(c, d, a)) || (Math.abs(cdB) <= 1e-8 && onSegment(c, d, b));
    };
    for (let i = 0; i < normalized.length; i++) {
        const nextI = (i + 1) % normalized.length;
        for (let j = i + 1; j < normalized.length; j++) {
            const nextJ = (j + 1) % normalized.length;
            if (i === j || nextI === j || nextJ === i) continue;
            if (segmentsIntersect(normalized[i], normalized[nextI], normalized[j], normalized[nextJ])) return null;
        }
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
            if (turnSign && sign !== turnSign) return null;
            turnSign = sign;
        }
        doubledArea += a[0] * b[1] - b[0] * a[1];
    }
    if (!turnSign || Math.abs(doubledArea) < 1e-8) return null;
    return normalized;
};

const normalizeWorldLayerDefinitions = (definitions, objectConfigs = []) => {
    const result = DEFAULT_WORLD_LAYER_DEFINITIONS.map(layer => ({ ...layer }));
    const ids = new Set(result.map(layer => layer.id));
    const depths = new Set(result.map(layer => layer.depth));
    const names = new Set(result.map(layer => layer.name.toLocaleLowerCase()));

    const addLayer = layer => {
        if (!layer || typeof layer !== 'object' || Array.isArray(layer) || result.length >= WORLD_LAYER_MAX_COUNT) return;
        const depth = normalizeWorldLayerDepth(layer.depth);
        const id = typeof layer.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(layer.id) ? layer.id : '';
        const name = typeof layer.name === 'string' ? layer.name.trim().slice(0, 40) : '';
        const normalizedName = name.toLocaleLowerCase();
        if (depth === null || depth === 0 || depth === 1 || depth === 2 ||
            depths.has(depth) || !id || ids.has(id) || !name || names.has(normalizedName)) return;
        result.push({
            id,
            name,
            depth,
            builtin: false,
            parallaxX: normalizeWorldLayerParallax(layer.parallaxX),
            parallaxY: normalizeWorldLayerParallax(layer.parallaxY)
        });
        ids.add(id);
        depths.add(depth);
        names.add(normalizedName);
    };

    if (Array.isArray(definitions)) {
        for (const layer of definitions) addLayer(layer);
    }

    if (Array.isArray(objectConfigs)) {
        for (const object of objectConfigs) {
            const depth = normalizeWorldLayerDepth(object?.layer);
            if (depth === null || depths.has(depth) || result.length >= WORLD_LAYER_MAX_COUNT) continue;
            let id = `legacy-layer-${depth}`;
            let name = `Layer ${depth}`;
            let suffix = 1;
            while (ids.has(id)) id = `legacy-layer-${depth}-${suffix++}`;
            while (names.has(name.toLocaleLowerCase())) name = `Layer ${depth} (${suffix++})`;
            addLayer({ id, name, depth });
        }
    }

    return result.sort((a, b) => a.depth - b.depth);
};

// ============================================
// GAME STATE
// ============================================
const GameState = {
    EDITOR: 'editor',
    PLAYING: 'playing',
    TESTING: 'testing',
    ENDED: 'ended'
};

// ============================================
// AUDIO MANAGER
// ============================================
class AudioManager {
    constructor() {
        this.sounds = {};
        this.volume = 1;
        this.loadSounds();
    }

    loadSounds() {
        this.sounds.jump = new Audio('/parkoreen/assets/ogg/jump.ogg');
        this.sounds.jump.volume = this.volume;
        this.sounds.coin = new Audio('/parkoreen/assets/ogg/coin.ogg');
        this.sounds.coin.volume = this.volume;
        this.sounds.bounce = new Audio('/parkoreen/assets/ogg/bounce.ogg');
        this.sounds.bounce.volume = this.volume;
        this.sounds.button = new Audio('/parkoreen/assets/ogg/button.ogg');
        this.sounds.button.volume = this.volume;
        this.sounds.checkpoint = new Audio('/parkoreen/assets/ogg/checkpoint.ogg');
        this.sounds.checkpoint.volume = this.volume;
        this.sounds.endpoint = new Audio('/parkoreen/assets/ogg/endpoint.ogg');
        this.sounds.endpoint.volume = this.volume;
        this.sounds.place = new Audio('/parkoreen/assets/ogg/tile.ogg');
        this.sounds.place.volume = this.volume;
        this.sounds.erase = new Audio('/parkoreen/assets/ogg/erase.ogg');
        this.sounds.erase.volume = this.volume;
    }

    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, vol));
        Object.values(this.sounds).forEach(sound => {
            sound.volume = this.volume;
        });
        // Volume is owned by SettingsManager (account-bound). Settings.set()
        // writes both the local cache and (if logged in) the server.
        if (window.Settings && typeof window.Settings.set === 'function') {
            window.Settings.set('volume', Math.round(this.volume * 100));
        } else {
            try { localStorage.setItem('parkoreen_volume', this.volume); } catch (e) {}
        }
    }

    play(soundName) {
        const sound = this.sounds[soundName];
        if (sound) {
            sound.currentTime = 0;
            sound.play().catch(() => {});
        }
    }

    loadVolumeFromStorage() {
        // Prefer SettingsManager (account-bound); fall back to legacy localStorage.
        if (window.Settings && typeof window.Settings.get === 'function') {
            const v = window.Settings.get('volume');
            if (typeof v === 'number') {
                this.setVolume(v / 100);
                return;
            }
        }
        const saved = localStorage.getItem('parkoreen_volume');
        if (saved !== null) {
            this.setVolume(parseFloat(saved));
        }
    }
}

// ============================================
// PLAYER CLASS
// ============================================
class Player {
    constructor(x, y, name, color) {
        this.id = null;
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        this.width = PLAYER_SIZE;
        this.height = PLAYER_SIZE;
        this.name = name || 'Player';
        this.displayName = this.name;
        this.username = '';
        this.tag = '';
        this.isHost = null;
        this.color = color || this.generateRandomColor();
        
        // States
        this.isOnGround = false;
        this._groundedCircleObjectId = null;
        this._groundedSlopeObjectId = null;
        this.canJump = true;
        this.jumpsRemaining = 1;
        this.maxJumps = 1;
        this.additionalAirjump = false;
        this.isFlying = false;
        
        // Input state
        this.input = {
            left: false,
            right: false,
            up: false,
            down: false,
            jump: false,
            shift: false,
            space: false,
            // Plugin inputs (HK controls)
            attack: false,
            heal: false,
            dash: false,
            superDash: false
        };
        
        // Touchboxes - positioned lower on the player sprite
        // Ground touchbox: used for ground collision (full width for partial ground contact)
        this.groundTouchbox = { x: 0, y: 8, width: PLAYER_SIZE, height: PLAYER_SIZE - 8 };
        // Hurt touchbox: used for spike damage detection (moderately inset from visual)
        this.hurtTouchbox = { x: 4, y: 6, width: PLAYER_SIZE - 8, height: PLAYER_SIZE - 8 };
        
        this.isLocal = false;
        this.isDead = false;
        this._world = null;
        
        // Direction change tracking for checkpoint jump reset
        this.lastDirection = 0; // -1 left, 0 none, 1 right
        this.lastDirectionChangeTime = 0;
        this.directionChangeCount = 0;
        this.directionChangeWindowStart = 0;
        
        // Coyote time - grace period after leaving ground where ground jump still counts
        this.coyoteTimeStart = null;
        this.COYOTE_TIME = 250; // 0.25 seconds in milliseconds
        
        // Plugin-injectable properties (plugins can add properties dynamically)
        // These are set by plugins via hooks
    }

    generateRandomColor() {
        const colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
            '#F8B500', '#00CED1', '#FF69B4', '#32CD32', '#FFD700'
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    update(world, audioManager, editorMode = false) {
        if (this.isDead || this._mechanicsDialogueOpen) return;
        this._world = world || this._world || null;

        if (this.isFlying) {
            this.updateFlying(world, editorMode);
        } else {
            this.updatePhysics(world, audioManager, editorMode);
        }
    }

    updateFlying(world, editorMode = false) {
        let dx = 0, dy = 0;
        if (this.input.left) dx -= 1;
        if (this.input.right) dx += 1;
        if (this.input.up) dy -= 1;
        if (this.input.down || this.input.shift) dy += 1;
        
        // Normalize so diagonal movement isn't faster
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
            dx /= len;
            dy /= len;
        }
        
        // Space key = 2x speed boost while flying
        const speed = this.input.space ? FLY_SPEED * 2 : FLY_SPEED;
        this.x += dx * speed;
        this.y += dy * speed;
        
        this.vx = 0;
        this.vy = 0;
        
        if (world && !editorMode) {
            this.checkHurtCollisions(world);
        }
    }

    updatePhysics(world, audioManager, editorMode = false) {
        // Get physics settings from world or use defaults
        const moveSpeed = Number.isFinite(world?._mechanicsPlayerSpeed)
            ? world._mechanicsPlayerSpeed
            : (world?.playerSpeed ?? DEFAULT_MOVE_SPEED);
        const gravity = Number.isFinite(world?._mechanicsGravity)
            ? world._mechanicsGravity
            : (world?.gravity ?? DEFAULT_GRAVITY);
        const jumpForce = Number.isFinite(world?._mechanicsJumpForce)
            ? world._mechanicsJumpForce
            : (world?.jumpForce ?? DEFAULT_JUMP_FORCE);
        const horizontalAcceleration = Number.isFinite(world?._mechanicsHorizontalAcceleration)
            ? world._mechanicsHorizontalAcceleration
            : (world?.horizontalAcceleration ?? DEFAULT_HORIZONTAL_ACCELERATION);
        const airControl = Number.isFinite(world?._mechanicsAirControl)
            ? world._mechanicsAirControl
            : (world?.airControl ?? DEFAULT_AIR_CONTROL);
        const configuredTerminalFallSpeed = Number.isFinite(world?._mechanicsTerminalFallSpeed)
            ? world._mechanicsTerminalFallSpeed
            : world?.terminalFallSpeed;
        const terminalFallSpeed = Number.isFinite(configuredTerminalFallSpeed) &&
            configuredTerminalFallSpeed > 0 && configuredTerminalFallSpeed <= MAX_TERMINAL_FALL_SPEED
            ? configuredTerminalFallSpeed
            : DEFAULT_TERMINAL_FALL_SPEED * (gravity / DEFAULT_GRAVITY);
        
        // Horizontal movement
        let currentDirection = 0;
        if (this.input.left !== this.input.right) currentDirection = this.input.left ? -1 : 1;
        if (horizontalAcceleration > 0) {
            const isGrounded = this.isOnGround || this.grounded;
            const control = isGrounded ? 1 : airControl;
            if (control > 0) {
                const targetVelocity = currentDirection * moveSpeed;
                const velocityDelta = targetVelocity - this.vx;
                const maxDelta = horizontalAcceleration * control;
                this.vx += Math.sign(velocityDelta) * Math.min(Math.abs(velocityDelta), maxDelta);
            }
        } else {
            // Zero acceleration preserves the original instant-start movement.
            this.vx = currentDirection * moveSpeed;
        }
        
        // Track direction changes for checkpoint jump reset
        const now = Date.now();
        if (currentDirection !== 0 && currentDirection !== this.lastDirection && this.lastDirection !== 0) {
            // Direction changed
            if (now - this.directionChangeWindowStart > 500) {
                // Start new window
                this.directionChangeWindowStart = now;
                this.directionChangeCount = 1;
            } else {
                this.directionChangeCount++;
            }
            this.lastDirectionChangeTime = now;
        }
        if (currentDirection !== 0) {
            this.lastDirection = currentDirection;
        }

        // Apply gravity
        this.vy += gravity;
        
        // Cap fall speed (scaled with gravity)
        if (this.vy > terminalFallSpeed) this.vy = terminalFallSpeed;

        // Handle jump - infinite jumps in editor mode
        // Check coyote time - if within grace period, the jump counts as a ground jump
        const inCoyoteTime = this.coyoteTimeStart !== null && (now - this.coyoteTimeStart) <= this.COYOTE_TIME;
        const canJumpNow = editorMode ? true : (this.jumpsRemaining > 0 || inCoyoteTime);
        
        const droppedThroughPlatform = !editorMode && this.input.down && this.input.jump &&
            this.isOnGround && this.dropThroughOneWayPlatform(world);

        if (!droppedThroughPlatform && this.input.jump && this.canJump && canJumpNow) {
            const wasGrounded = this.isOnGround || this.grounded || inCoyoteTime;
            this.vy = jumpForce;
            if (!editorMode) {
                // If jumping during coyote time, it counts as ground jump (use full jumps minus 1)
                if (inCoyoteTime && this.jumpsRemaining === 0) {
                    // Restore to max jumps minus 1 (the ground jump we're using now)
                    this.jumpsRemaining = Math.max(0, this.maxJumps - 1);
                } else {
                this.jumpsRemaining--;
                }
                // Clear coyote time after jumping
                this.coyoteTimeStart = null;
            }
            this.canJump = false;
            this.isOnGround = false;
            if (audioManager) audioManager.play('jump');
            if (window.PluginManager) {
                window.PluginManager.executeHook('player.jumped', {
                    player: this,
                    world,
                    wasGrounded: Boolean(wasGrounded),
                    source: 'core'
                });
            }
        } else if (this.input.jump && this.canJump && !canJumpNow && !editorMode) {
            // Can't jump normally - let plugins handle (e.g., monarch wings)
            if (window.PluginManager) {
                const result = window.PluginManager.executeHook('player.jump', {
                    player: this,
                    canJump: false
                });
                if (result.didJump) {
                    this.canJump = false;
                    window.PluginManager.executeHook('player.jumped', {
                        player: this,
                        world,
                        wasGrounded: false,
                        source: 'plugin'
                    });
                }
            }
        }
        
        // Expire coyote time if not used
        if (this.coyoteTimeStart !== null && (now - this.coyoteTimeStart) > this.COYOTE_TIME) {
            this.coyoteTimeStart = null;
        }

        if (!this.input.jump) {
            this.canJump = true;
        }

        // Apply movement with collision
        this.moveWithCollision(world, editorMode);
    }

    moveWithCollision(world, editorMode = false) {
        const CORNER_TOLERANCE = 6;

        // Move horizontally
        const previousX = this.x;
        const previousGroundSurfaceId = this.isOnGround ? this._groundedSlopeObjectId : null;
        this.x += this.vx;
        
        // Check horizontal collisions
        const hCollisions = this.checkCollisions(world, 'horizontal', this.y, previousX, null, previousGroundSurfaceId);
        for (const obj of hCollisions) {
            if (obj.collision) {
                // Corner correction: if player barely clips a block vertically,
                // nudge them into an adjacent gap instead of stopping
                if (!['circle', 'capsule', 'slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.collisionShape) &&
                    this._tryCornerNudgeVertical(obj, world, CORNER_TOLERANCE)) continue;

                if (obj.collisionShape === 'polygon' && obj.polygonOneWay === false) {
                    const contactX = this.getPolygonAxisContact(obj, this.getGroundTouchbox(), 'x', this.vx);
                    if (contactX !== null && this.vx !== 0) {
                        this.x = contactX - this.groundTouchbox.x - this.groundTouchbox.width / 2;
                    }
                } else if (obj.collisionShape === 'circle') {
                    const box = this.getGroundTouchbox();
                    const contactX = this.getCircleHorizontalContact(obj, box, this.vx);
                    if (contactX !== null && this.vx !== 0) {
                        this.x = this.vx > 0
                            ? contactX - this.groundTouchbox.x - this.groundTouchbox.width
                            : contactX - this.groundTouchbox.x;
                    }
                } else if (obj.collisionShape === 'capsule') {
                    const box = this.getGroundTouchbox();
                    const contactX = this.getCapsuleHorizontalContact(obj, box, this.vx);
                    if (contactX !== null && this.vx !== 0) {
                        this.x = this.vx > 0
                            ? contactX - this.groundTouchbox.x - this.groundTouchbox.width
                            : contactX - this.groundTouchbox.x;
                    }
                } else if (this.vx > 0) {
                    this.x = obj.x - this.width;
                } else if (this.vx < 0) {
                    this.x = obj.x + obj.width;
                }
                this.vx = 0;
            }
        }

        // Move vertically
        const previousY = this.y;
        this.y += this.vy;
        
        // Check vertical collisions
        const wasOnGround = this.isOnGround;
        const previousGroundCircleId = wasOnGround ? this._groundedCircleObjectId : null;
        const previousGroundSlopeId = wasOnGround ? this._groundedSlopeObjectId : null;
        this.isOnGround = false;
        this._groundedCircleObjectId = null;
        this._groundedSlopeObjectId = null;
        
        const vCollisions = this.checkCollisions(world, 'vertical', previousY, this.x, previousGroundCircleId, previousGroundSlopeId);
        for (const obj of vCollisions) {
            if (obj.collision) {
                // Corner correction: nudge horizontally into an adjacent gap
                if (!['circle', 'capsule', 'slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.collisionShape) &&
                    this._tryCornerNudgeHorizontal(obj, world, CORNER_TOLERANCE)) continue;

                if (['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.collisionShape)) {
                    const box = this.getGroundTouchbox();
                    const contactY = obj.collisionShape === 'polygon' && obj.polygonOneWay === false
                        ? this.getPolygonAxisContact(obj, box, 'y', this.vy)
                        : this.getSlopeSurfaceY(obj, box.x + box.width / 2);
                    if (contactY !== null && this.vy >= 0) {
                        const centerOffset = obj.collisionShape === 'polygon' && obj.polygonOneWay === false
                            ? this.groundTouchbox.height / 2 : this.groundTouchbox.height;
                        this.y = contactY - this.groundTouchbox.y - centerOffset;
                        if (this.vy > 0 || obj.collisionShape !== 'polygon' || obj.polygonOneWay !== false) {
                            this.isOnGround = true;
                            this._groundedSlopeObjectId = obj.id;
                            this.resetJumps();
                            if (!wasOnGround && window.PluginManager) {
                                if (!this._landData) this._landData = {};
                                this._landData.player = this;
                                this._landData.world = world;
                                this._landData.surface = obj;
                                window.PluginManager.executeHook('player.land', this._landData);
                            }
                        }
                    } else if (contactY !== null && this.vy < 0 && obj.collisionShape === 'polygon' && obj.polygonOneWay === false) {
                        this.y = contactY - this.groundTouchbox.y - this.groundTouchbox.height / 2;
                    }
                } else if (obj.collisionShape === 'circle') {
                    const box = this.getGroundTouchbox();
                    const contactY = this.getCircleVerticalContact(obj, box, this.vy);
                    if (contactY !== null && this.vy > 0) {
                        this.y = contactY - this.groundTouchbox.y - this.groundTouchbox.height;
                        this.isOnGround = true;
                        this._groundedCircleObjectId = obj.id;
                        this.resetJumps();
                        if (!wasOnGround && window.PluginManager) {
                            if (!this._landData) this._landData = {};
                            this._landData.player = this;
                            this._landData.world = world;
                            this._landData.surface = obj;
                            window.PluginManager.executeHook('player.land', this._landData);
                        }
                    } else if (contactY !== null && this.vy < 0) {
                        this.y = contactY - this.groundTouchbox.y;
                    }
                } else if (obj.collisionShape === 'capsule') {
                    const box = this.getGroundTouchbox();
                    const contactY = this.getCapsuleVerticalContact(obj, box, this.vy);
                    if (contactY !== null && this.vy > 0) {
                        this.y = contactY - this.groundTouchbox.y - this.groundTouchbox.height;
                        this.isOnGround = true;
                        this._groundedCircleObjectId = obj.id;
                        this.resetJumps();
                        if (!wasOnGround && window.PluginManager) {
                            if (!this._landData) this._landData = {};
                            this._landData.player = this;
                            this._landData.world = world;
                            this._landData.surface = obj;
                            window.PluginManager.executeHook('player.land', this._landData);
                        }
                    } else if (contactY !== null && this.vy < 0) {
                        this.y = contactY - this.groundTouchbox.y;
                    }
                } else if (this.vy > 0) {
                    // Landing on ground
                    this.y = obj.y - this.height;
                    this.isOnGround = true;
                    this._groundedCircleObjectId = null;
                    this.resetJumps();
                    if (!wasOnGround && window.PluginManager) {
                        if (!this._landData) this._landData = {};
                        this._landData.player = this;
                        this._landData.world = world;
                        this._landData.surface = obj;
                        window.PluginManager.executeHook('player.land', this._landData);
                    }
                } else if (this.vy < 0) {
                    // Hitting ceiling
                    this.y = obj.y + obj.height;
                }
                this.vy = 0;
            }
        }
        
        // Check if player walked off a ledge (was on ground, now falling, didn't jump)
        // If additionalAirjump is disabled, start coyote time instead of immediately losing the ground jump
        if (wasOnGround && !this.isOnGround && !this.additionalAirjump && this.jumpsRemaining === this.maxJumps) {
            // Player walked off ledge - start coyote time grace period
            this.coyoteTimeStart = Date.now();
            // Reduce jumps now, but coyote time allows recovery if jump happens within the window
            this.jumpsRemaining = Math.max(0, this.maxJumps - 1);
        }

        // Check hurt collisions (skip in editor mode)
        if (!editorMode) {
            this.checkHurtCollisions(world);
        }
    }

    _hasBlockAt(world, x, y) {
        if (!this._blockCheckBox) this._blockCheckBox = { x: 0, y: 0, width: GRID_SIZE - 2, height: GRID_SIZE - 2 };
        this._blockCheckBox.x = x + 1;
        this._blockCheckBox.y = y + 1;
        const near = world.queryNear(x + 1, y + 1, GRID_SIZE - 2, GRID_SIZE - 2);
        for (let i = 0; i < near.length; i++) {
            const o = near[i];
            if (!o.collision || o.actingType === 'spike' || o.actingType === 'text' || o.type === 'teleportal') continue;
            if (o.type === 'spinner' || o.appearanceType === 'spinner') continue;
            if (this.collisionShapeIntersectsBox(this._blockCheckBox, o)) return true;
        }
        return false;
    }

    _tryCornerNudgeVertical(obj, world, tolerance) {
        const box = this.getGroundTouchbox();
        const overlapTop = box.y + box.height - obj.y;
        const overlapBottom = obj.y + obj.height - box.y;

        if (overlapTop > 0 && overlapTop <= tolerance) {
            // Player's bottom clips the top edge of the block — try nudging up
            const gapY = obj.y - GRID_SIZE;
            if (!this._hasBlockAt(world, obj.x, gapY)) {
                this.y -= overlapTop;
                return true;
            }
        } else if (overlapBottom > 0 && overlapBottom <= tolerance) {
            // Player's top clips the bottom edge — try nudging down
            const gapY = obj.y + obj.height;
            if (!this._hasBlockAt(world, obj.x, gapY)) {
                this.y += overlapBottom;
                return true;
            }
        }
        return false;
    }

    _tryCornerNudgeHorizontal(obj, world, tolerance) {
        const box = this.getGroundTouchbox();
        const overlapLeft = box.x + box.width - obj.x;
        const overlapRight = obj.x + obj.width - box.x;

        if (overlapLeft > 0 && overlapLeft <= tolerance) {
            // Player's right clips the left edge — try nudging left
            const gapX = obj.x - GRID_SIZE;
            if (!this._hasBlockAt(world, gapX, obj.y)) {
                this.x -= overlapLeft;
                return true;
            }
        } else if (overlapRight > 0 && overlapRight <= tolerance) {
            // Player's left clips the right edge — try nudging right
            const gapX = obj.x + obj.width;
            if (!this._hasBlockAt(world, gapX, obj.y)) {
                this.x += overlapRight;
                return true;
            }
        }
        return false;
    }

    checkCollisions(world, direction, previousY = this.y, previousX = this.x, previousGroundCircleId = null, previousGroundSlopeId = null) {
        if (!this._collisionsH) { this._collisionsH = []; this._collisionsV = []; }
        const collisions = direction === 'horizontal' ? this._collisionsH : this._collisionsV;
        collisions.length = 0;
        const box = this.getGroundTouchbox();
        const worldSpikeMode = world?.spikeTouchbox || 'normal';
        
        const nearby = world.queryNear(box.x - 2, box.y - 2, box.width + 4, box.height + 4);
        for (let ni = 0; ni < nearby.length; ni++) {
            const obj = nearby[ni];
            if (!obj.collision) continue;
            if (obj.oneWayPlatform &&
                (direction !== 'vertical' || this.vy <= 0 || previousY + this.height > obj.y + 1)) continue;
            if (obj.actingType === 'text') continue;
            if (obj.type === 'teleportal') continue;
            
            // Spinners (saw blades) acting as spikes have no ground collision
            // They only damage - player should not stand on them
            if ((obj.type === 'spinner' || obj.appearanceType === 'spinner') && obj.actingType === 'spike') {
                continue;
            }

            if (obj.collisionShape === 'polygon' && obj.polygonOneWay === false) {
                if (!this.collisionShapeIntersectsBox(box, obj)) continue;
                const axis = direction === 'horizontal' ? 'x' : 'y';
                const movement = axis === 'x' ? this.vx : this.vy;
                if (movement === 0) continue;
                if (axis === 'x' && previousGroundSlopeId === obj.id && this.isOnGround) continue;
                const contact = this.getPolygonAxisContact(obj, box, axis, movement);
                if (contact === null) continue;
                const halfExtent = axis === 'x' ? this.groundTouchbox.width / 2 : this.groundTouchbox.height / 2;
                const centerOffset = axis === 'x' ? this.groundTouchbox.x + halfExtent : this.groundTouchbox.y + halfExtent;
                const previousCenter = (axis === 'x' ? previousX : previousY) + centerOffset;
                const currentCenter = (axis === 'x' ? box.x : box.y) + halfExtent;
                const crossed = movement > 0
                    ? previousCenter <= contact + 1 && currentCenter >= contact - 1
                    : previousCenter >= contact - 1 && currentCenter <= contact + 1;
                const supportedOnTop = axis === 'y' && movement > 0 && previousGroundSlopeId === obj.id;
                if (crossed || supportedOnTop) collisions.push(obj);
                continue;
            }

            if (['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.collisionShape)) {
                if (direction !== 'vertical' || this.vy < 0) continue;
                const centerX = box.x + box.width / 2;
                const contactY = this.getSlopeSurfaceY(obj, centerX);
                if (contactY === null) continue;
                const previousFeet = previousY + this.groundTouchbox.y + this.groundTouchbox.height;
                const currentFeet = box.y + box.height;
                const wasSupportedBySlope = previousGroundSlopeId === obj.id;
                if (currentFeet >= contactY - 1 && (previousFeet <= contactY + 1 || wasSupportedBySlope)) {
                    collisions.push(obj);
                }
                continue;
            }
            
            // Handle spike collision based on mode
            if (obj.actingType === 'spike') {
                const spikeMode = obj.spikeTouchbox || worldSpikeMode;
                
                // In 'air' mode, spikes have no collision at all
                if (spikeMode === 'air') continue;
                
                // In 'full' or 'all-spike' mode, spikes only damage, no ground collision
                if (spikeMode === 'full' || spikeMode === 'all-spike') continue;
                
                // Only the flat base of the spike is solid ground.
                // The pointy part must let the player through so they can take damage.
                // The flat part only acts as a floor/ceiling (vertical), never as a wall (horizontal).
                // Skip flat collision entirely if a solid block is adjacent on the flat side.
                if (this.boxIntersects(box, obj)) {
                    if (spikeMode === 'ground') {
                        collisions.push(obj);
                    } else if (direction === 'vertical' && !this._spikeHasAdjacentBlock(obj, world)) {
                        const flatBox = this.getSpikeFlat(obj);
                        if (this.boxIntersects(box, flatBox)) {
                            if (!this._flatCollision) this._flatCollision = { collision: true };
                            this._flatCollision.x = flatBox.x;
                            this._flatCollision.y = flatBox.y;
                            this._flatCollision.width = flatBox.width;
                            this._flatCollision.height = flatBox.height;
                            this._flatCollision.collision = obj.collision;
                            collisions.push(this._flatCollision);
                        }
                    }
                }
                continue;
            }

            if (obj.collisionShape === 'circle' || obj.collisionShape === 'capsule') {
                if (!this.collisionShapeIntersectsBox(box, obj)) continue;
                if (direction === 'horizontal' && this.vx !== 0) {
                    const contactX = obj.collisionShape === 'capsule'
                        ? this.getCapsuleHorizontalContact(obj, box, this.vx)
                        : this.getCircleHorizontalContact(obj, box, this.vx);
                    if (contactX === null) continue;
                    const oldLeft = previousX + this.groundTouchbox.x;
                    const oldRight = oldLeft + this.groundTouchbox.width;
                    const approachedFromSide = this.vx > 0
                        ? oldRight <= contactX + 1
                        : oldLeft >= contactX - 1;
                    if (!approachedFromSide) continue;
                } else if (direction === 'vertical' && this.vy !== 0) {
                    const contactY = obj.collisionShape === 'capsule'
                        ? this.getCapsuleVerticalContact(obj, box, this.vy)
                        : this.getCircleVerticalContact(obj, box, this.vy);
                    if (contactY === null) continue;
                    const oldTop = previousY + this.groundTouchbox.y;
                    const oldBottom = oldTop + this.groundTouchbox.height;
                    const approachedFromFace = this.vy > 0
                        ? oldBottom <= contactY + 1
                        : oldTop >= contactY - 1;
                    const followingGroundedCircle = this.vy >= 0 && previousGroundCircleId === obj.id;
                    if (!approachedFromFace && !followingGroundedCircle) continue;
                } else {
                    continue;
                }
                collisions.push(obj);
                continue;
            }
            
            if (this.collisionShapeIntersectsBox(box, obj)) {
                collisions.push(obj);
            }
        }
        
        return collisions;
    }

    checkHurtCollisions(world) {
        if (!world || !world.objects) return;
        if (GameEngine._invincible) return;
        
        const hurtBox = this.getHurtTouchbox();
        const worldSpikeMode = world?.spikeTouchbox || 'normal';
        const dropHurtOnly = world?.dropHurtOnly || false;
        
        const nearby = world.queryNear(hurtBox.x - 2, hurtBox.y - 2, hurtBox.width + 4, hurtBox.height + 4);
        for (let ni = 0; ni < nearby.length; ni++) {
            const obj = nearby[ni];
            if (obj.actingType !== 'spike' || obj.collision === false) continue;
            {
                let gotHit = false;
                
                // Spinners (saw blades) use circular hitbox slightly smaller than visual
                if (obj.type === 'spinner' || obj.appearanceType === 'spinner') {
                    const cx = obj.x + obj.width / 2;
                    const cy = obj.y + obj.height / 2;
                    const r = Math.min(obj.width, obj.height) / 2 * 0.82;
                    if (this.circleIntersectsBox(cx, cy, r, hurtBox)) {
                        gotHit = true;
                    }
                } else {
                    // Regular spike - apply touchbox modes
                    // Use per-object spikeTouchbox if set, otherwise use world default
                    const spikeMode = obj.spikeTouchbox || worldSpikeMode;
                    
                    // In 'air', 'ground', or 'flag' mode, spikes don't damage
                    if (spikeMode === 'air' || spikeMode === 'ground' || spikeMode === 'flag') continue;
                    
                    // Check dropHurtOnly - if enabled, only hurt when player moves toward spike tip
                    // Use per-object dropHurtOnly if set, otherwise use world default
                    const useDropHurtOnly = obj.dropHurtOnly !== undefined ? obj.dropHurtOnly : dropHurtOnly;
                    if (useDropHurtOnly && !this.isMovingTowardSpikeTip(obj)) {
                        continue;
                    }
                    
                    // In 'full' mode, any contact with spike = damage
                    if (spikeMode === 'full') {
                        if (this.boxIntersects(hurtBox, obj)) {
                            gotHit = true;
                        }
                    }
                    
                    // In 'all-spike' mode, danger zone AND flat base both damage (no safe ground)
                    if (spikeMode === 'all-spike') {
                        const dangerBox = this.getSpikeDanger(obj);
                        const flatBox = this.getSpikeFlat(obj);
                        if (this.boxIntersects(hurtBox, dangerBox) || this.boxIntersects(hurtBox, flatBox)) {
                            gotHit = true;
                        }
                    }
                    
                    // In 'normal' mode, danger zone damages (between visual tip and flat base)
                    if (spikeMode === 'normal') {
                        const dangerBox = this.getSpikeDanger(obj);
                        if (this.boxIntersects(hurtBox, dangerBox)) {
                            gotHit = true;
                        }
                    }
                    
                    // In 'tip' mode, only the very tip damages
                    if (spikeMode === 'tip') {
                        const tipBox = this.getSpikeTip(obj);
                        if (this.boxIntersects(hurtBox, tipBox)) {
                            gotHit = true;
                        }
                    }
                }
                
                if (gotHit) {
                    // Let plugins handle damage via hook
                    if (window.PluginManager) {
                        const result = window.PluginManager.executeHook('player.damage', { 
                            player: this, 
                            source: obj,
                            world: world
                        });
                        if (result.preventDefault) {
                            return; // Plugin handled the damage
                        }
                    }
                    this.die(world, obj);
                    return;
                }
            }
        }
    }
    
    getSpikeFlat(spike) {
        const r = spike.rotation || 0;
        const fd = spike.height * 0.22;
        const b = this._spikeFlat || (this._spikeFlat = { x: 0, y: 0, width: 0, height: 0 });
        if (r === 0 || (r !== 90 && r !== 180 && r !== 270)) {
            b.x = spike.x; b.y = spike.y + spike.height - fd; b.width = spike.width; b.height = fd;
        } else if (r === 90) {
            b.x = spike.x; b.y = spike.y; b.width = fd; b.height = spike.height;
        } else if (r === 180) {
            b.x = spike.x; b.y = spike.y; b.width = spike.width; b.height = fd;
        } else {
            b.x = spike.x + spike.width - fd; b.y = spike.y; b.width = fd; b.height = spike.height;
        }
        return b;
    }

    _spikeHasAdjacentBlock(spike, world) {
        const r = spike.rotation || 0;
        const probe = 2;
        if (!this._adjProbe) this._adjProbe = { x: 0, y: 0, width: 0, height: 0 };
        const p = this._adjProbe;
        // Probe a thin strip on the outside of the flat side
        if (r === 0 || (r !== 90 && r !== 180 && r !== 270)) {
            // tip up, flat at bottom → probe below
            p.x = spike.x; p.y = spike.y + spike.height; p.width = spike.width; p.height = probe;
        } else if (r === 90) {
            // tip right, flat at left → probe to the left
            p.x = spike.x - probe; p.y = spike.y; p.width = probe; p.height = spike.height;
        } else if (r === 180) {
            // tip down, flat at top → probe above
            p.x = spike.x; p.y = spike.y - probe; p.width = spike.width; p.height = probe;
        } else {
            // tip left, flat at right → probe to the right
            p.x = spike.x + spike.width; p.y = spike.y; p.width = probe; p.height = spike.height;
        }
        const near = world.queryNear(p.x, p.y, p.width, p.height);
        for (let i = 0; i < near.length; i++) {
            const o = near[i];
            if (o === spike) continue;
            if (!o.collision) continue;
            if (o.actingType === 'spike' || o.actingType === 'text' || o.type === 'teleportal') continue;
            if (o.type === 'spinner' || o.appearanceType === 'spinner') continue;
            if (this.collisionShapeIntersectsBox(p, o)) return true;
        }
        return false;
    }

    getSpikeDanger(spike) {
        const r = spike.rotation || 0;
        const w = spike.width;
        const h = spike.height;
        // Danger zone sits near the flat base of the spike.
        // Flat zone is 22% from base (78%-100%). Danger spans 58%-86%.
        const dangerStart = 0.58;
        const dangerLen = 0.28;
        const b = this._spikeDanger || (this._spikeDanger = { x: 0, y: 0, width: 0, height: 0 });
        if (r === 0 || (r !== 90 && r !== 180 && r !== 270)) {
            b.x = spike.x; b.y = spike.y + h * dangerStart; b.width = w; b.height = h * dangerLen;
        } else if (r === 90) {
            b.x = spike.x + w * (1 - dangerStart - dangerLen); b.y = spike.y; b.width = w * dangerLen; b.height = h;
        } else if (r === 180) {
            b.x = spike.x; b.y = spike.y + h * (1 - dangerStart - dangerLen); b.width = w; b.height = h * dangerLen;
        } else {
            b.x = spike.x + w * dangerStart; b.y = spike.y; b.width = w * dangerLen; b.height = h;
        }
        return b;
    }
    
    getSpikeTip(spike) {
        const r = spike.rotation || 0;
        const td = spike.height * 0.1;
        const tw = spike.width * 0.3;
        const b = this._spikeTip || (this._spikeTip = { x: 0, y: 0, width: 0, height: 0 });
        if (r === 0 || (r !== 90 && r !== 180 && r !== 270)) {
            b.x = spike.x + spike.width * 0.35; b.y = spike.y; b.width = tw; b.height = td;
        } else if (r === 90) {
            b.x = spike.x + spike.width - td; b.y = spike.y + spike.height * 0.35; b.width = td; b.height = tw;
        } else if (r === 180) {
            b.x = spike.x + spike.width * 0.35; b.y = spike.y + spike.height - td; b.width = tw; b.height = td;
        } else {
            b.x = spike.x; b.y = spike.y + spike.height * 0.35; b.width = td; b.height = tw;
        }
        return b;
    }
    
    // Check if player is moving toward the spike's tip direction
    isMovingTowardSpikeTip(spike) {
        const rotation = spike.rotation || 0;
        const vx = this.vx || 0;
        const vy = this.vy || 0;
        const speed = Math.sqrt(vx * vx + vy * vy);
        
        // If not moving, don't trigger drop hurt
        if (speed < 0.5) return false;
        
        // Check movement direction relative to spike tip direction
        switch (rotation) {
            case 0: // Tip up - player must be moving down (positive vy)
                return vy > 0;
            case 90: // Tip right - player must be moving left (negative vx)
                return vx < 0;
            case 180: // Tip down - player must be moving up (negative vy)
                return vy < 0;
            case 270: // Tip left - player must be moving right (positive vx)
                return vx > 0;
            default:
                return vy > 0; // Default to tip up
        }
    }

    getGroundTouchbox() {
        // Reuse cached object to avoid GC pressure in hot collision loops
        if (!this._groundBox) this._groundBox = { x: 0, y: 0, width: 0, height: 0 };
        this._groundBox.x = this.x + this.groundTouchbox.x;
        this._groundBox.y = this.y + this.groundTouchbox.y;
        this._groundBox.width = this.groundTouchbox.width;
        this._groundBox.height = this.groundTouchbox.height;
        return this._groundBox;
    }

    getHurtTouchbox() {
        if (!this._hurtBox) this._hurtBox = { x: 0, y: 0, width: 0, height: 0 };
        this._hurtBox.x = this.x + this.hurtTouchbox.x;
        this._hurtBox.y = this.y + this.hurtTouchbox.y;
        this._hurtBox.width = this.hurtTouchbox.width;
        this._hurtBox.height = this.hurtTouchbox.height;
        return this._hurtBox;
    }

    boxIntersects(a, b) {
        return a.x < b.x + b.width &&
               a.x + a.width > b.x &&
               a.y < b.y + b.height &&
               a.y + a.height > b.y;
    }

    collisionShapeIntersectsBox(box, object) {
        if (['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(object?.collisionShape)) {
            const points = this.getCollisionPolygonPoints(object);
            if (!points || !Number.isFinite(box.x) || !Number.isFinite(box.y) || box.width <= 0 || box.height <= 0) return false;
            const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
            for (let i = 0; i < points.length; i++) {
                const next = points[(i + 1) % points.length];
                const dx = next.x - points[i].x;
                const dy = next.y - points[i].y;
                axes.push({ x: -dy, y: dx });
            }
            const boxPoints = [
                { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
                { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
            ];
            for (const axis of axes) {
                const triangleProjection = points.map(point => point.x * axis.x + point.y * axis.y);
                const boxProjection = boxPoints.map(point => point.x * axis.x + point.y * axis.y);
                if (Math.max(...triangleProjection) <= Math.min(...boxProjection) ||
                    Math.max(...boxProjection) <= Math.min(...triangleProjection)) return false;
            }
            return true;
        }
        if (object?.collisionShape === 'capsule') {
            if (!Number.isFinite(object.x) || !Number.isFinite(object.y) ||
                !Number.isFinite(object.width) || object.width <= 0 ||
                !Number.isFinite(object.height) || object.height <= 0 ||
                !Number.isFinite(box?.x) || !Number.isFinite(box?.y) || box.width <= 0 || box.height <= 0) return false;
            const radius = Math.min(object.width, object.height) / 2;
            const horizontal = object.width > object.height;
            const middle = horizontal
                ? { x: object.x + radius, y: object.y, width: object.width - 2 * radius, height: object.height }
                : { x: object.x, y: object.y + radius, width: object.width, height: object.height - 2 * radius };
            const firstCap = horizontal
                ? { x: object.x + radius, y: object.y + object.height / 2 }
                : { x: object.x + object.width / 2, y: object.y + radius };
            const secondCap = horizontal
                ? { x: object.x + object.width - radius, y: object.y + object.height / 2 }
                : { x: object.x + object.width / 2, y: object.y + object.height - radius };
            return this.boxIntersects(box, middle) ||
                this.circleIntersectsBox(firstCap.x, firstCap.y, radius, box) ||
                this.circleIntersectsBox(secondCap.x, secondCap.y, radius, box);
        }
        if (object?.collisionShape !== 'circle') return this.boxIntersects(box, object);
        if (!Number.isFinite(object.width) || object.width <= 0 ||
            !Number.isFinite(object.height) || object.height <= 0) return false;
        const radius = Math.min(object.width, object.height) / 2;
        if (!Number.isFinite(radius) || radius <= 0) return false;
        const centerX = object.x + object.width / 2;
        const centerY = object.y + object.height / 2;
        const closestX = Math.max(box.x, Math.min(centerX, box.x + box.width));
        const closestY = Math.max(box.y, Math.min(centerY, box.y + box.height));
        const dx = centerX - closestX;
        const dy = centerY - closestY;
        return dx * dx + dy * dy < radius * radius;
    }

    getCapsuleVerticalContact(object, box, direction) {
        if (!Number.isFinite(object?.x) || !Number.isFinite(object?.y) ||
            !Number.isFinite(object?.width) || object.width <= 0 ||
            !Number.isFinite(object?.height) || object.height <= 0 ||
            !Number.isFinite(box?.x) || !Number.isFinite(box?.width) || box.width <= 0) return null;
        if (object.width > object.height) return direction > 0 ? object.y : object.y + object.height;
        const radius = object.width / 2;
        const centerX = object.x + radius;
        const closestX = Math.max(box.x, Math.min(centerX, box.x + box.width));
        const dx = centerX - closestX;
        const reachSquared = radius * radius - dx * dx;
        if (reachSquared < 0) return null;
        const reach = Math.sqrt(reachSquared);
        return direction > 0 ? object.y + radius - reach : object.y + object.height - radius + reach;
    }

    getCapsuleHorizontalContact(object, box, direction) {
        if (!Number.isFinite(object?.x) || !Number.isFinite(object?.y) ||
            !Number.isFinite(object?.width) || object.width <= 0 ||
            !Number.isFinite(object?.height) || object.height <= 0 ||
            !Number.isFinite(box?.y) || !Number.isFinite(box?.height) || box.height <= 0) return null;
        const radius = Math.min(object.width, object.height) / 2;
        if (object.width <= object.height) {
            const segmentTop = object.y + radius;
            const segmentBottom = object.y + object.height - radius;
            let distanceY = 0;
            if (box.y + box.height < segmentTop) distanceY = segmentTop - (box.y + box.height);
            else if (box.y > segmentBottom) distanceY = box.y - segmentBottom;
            const reachSquared = radius * radius - distanceY * distanceY;
            if (reachSquared < 0) return null;
            const extent = Math.sqrt(reachSquared);
            return direction > 0 ? object.x + radius + extent : object.x + radius - extent;
        }
        const centerY = object.y + radius;
        const closestY = Math.max(box.y, Math.min(centerY, box.y + box.height));
        const dy = centerY - closestY;
        const reachSquared = radius * radius - dy * dy;
        if (reachSquared < 0) return null;
        const reach = Math.sqrt(reachSquared);
        return direction > 0 ? object.x + object.width - radius + reach : object.x + radius - reach;
    }

    getCollisionPolygonPoints(object) {
        if (!object || !Number.isFinite(object.x) || !Number.isFinite(object.y) ||
            !Number.isFinite(object.width) || !Number.isFinite(object.height) || object.width <= 0 || object.height <= 0) return null;
        if (object.collisionShape === 'slopeUpRight') {
            return [
                { x: object.x, y: object.y + object.height },
                { x: object.x + object.width, y: object.y },
                { x: object.x + object.width, y: object.y + object.height }
            ];
        }
        if (object.collisionShape === 'slopeUpLeft') {
            return [
                { x: object.x, y: object.y },
                { x: object.x, y: object.y + object.height },
                { x: object.x + object.width, y: object.y + object.height }
            ];
        }
        if (object.collisionShape !== 'polygon') return null;
        const points = normalizeWorldCollisionPolygon(object.collisionPoints);
        return points?.map(([x, y]) => ({ x: object.x + x * object.width, y: object.y + y * object.height })) || null;
    }

    getSlopeSurfaceY(object, x) {
        if (!Number.isFinite(x) || !Number.isFinite(object?.x) || !Number.isFinite(object?.y) ||
            !Number.isFinite(object?.width) || !Number.isFinite(object?.height) || object.width <= 0 || object.height <= 0 ||
            !['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(object.collisionShape) ||
            x < object.x || x > object.x + object.width) return null;
        const points = this.getCollisionPolygonPoints(object);
        if (!points) return null;
        let highestSurface = Infinity;
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            const minX = Math.min(a.x, b.x);
            const maxX = Math.max(a.x, b.x);
            if (x < minX || x > maxX) continue;
            const dx = b.x - a.x;
            const y = Math.abs(dx) < 1e-8
                ? Math.min(a.y, b.y)
                : a.y + (x - a.x) * (b.y - a.y) / dx;
            if (Number.isFinite(y)) highestSurface = Math.min(highestSurface, y);
        }
        return Number.isFinite(highestSurface) ? highestSurface : null;
    }

    getPolygonAxisContact(object, box, axis, direction) {
        if (!['x', 'y'].includes(axis) || !Number.isFinite(direction) || direction === 0 ||
            !Number.isFinite(box?.width) || !Number.isFinite(box?.height) || box.width <= 0 || box.height <= 0) return null;
        const polygon = this.getCollisionPolygonPoints(object);
        if (!polygon) return null;
        const halfWidth = box.width / 2;
        const halfHeight = box.height / 2;
        const expanded = [];
        for (const point of polygon) {
            expanded.push(
                { x: point.x - halfWidth, y: point.y - halfHeight },
                { x: point.x + halfWidth, y: point.y - halfHeight },
                { x: point.x + halfWidth, y: point.y + halfHeight },
                { x: point.x - halfWidth, y: point.y + halfHeight }
            );
        }
        expanded.sort((a, b) => a.x - b.x || a.y - b.y);
        const cross = (origin, a, b) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
        const unique = expanded.filter((point, index) => index === 0 ||
            Math.abs(point.x - expanded[index - 1].x) >= 1e-8 || Math.abs(point.y - expanded[index - 1].y) >= 1e-8);
        const lower = [];
        for (const point of unique) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 1e-8) lower.pop();
            lower.push(point);
        }
        const upper = [];
        for (let i = unique.length - 1; i >= 0; i--) {
            const point = unique[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 1e-8) upper.pop();
            upper.push(point);
        }
        const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
        if (hull.length < 3) return null;

        const scanValue = axis === 'x' ? box.y + halfHeight : box.x + halfWidth;
        const values = [];
        for (let i = 0; i < hull.length; i++) {
            const a = hull[i];
            const b = hull[(i + 1) % hull.length];
            const aScan = axis === 'x' ? a.y : a.x;
            const bScan = axis === 'x' ? b.y : b.x;
            const aResult = axis === 'x' ? a.x : a.y;
            const bResult = axis === 'x' ? b.x : b.y;
            if (Math.abs(aScan - bScan) < 1e-8) {
                if (Math.abs(scanValue - aScan) < 1e-8) values.push(aResult, bResult);
                continue;
            }
            if (scanValue < Math.min(aScan, bScan) || scanValue > Math.max(aScan, bScan)) continue;
            const progress = (scanValue - aScan) / (bScan - aScan);
            values.push(aResult + (bResult - aResult) * progress);
        }
        if (!values.length) return null;
        return direction > 0 ? Math.min(...values) : Math.max(...values);
    }

    getCircleHorizontalContact(object, box, direction) {
        if (!Number.isFinite(object.width) || object.width <= 0 ||
            !Number.isFinite(object.height) || object.height <= 0) return null;
        const radius = Math.min(object.width, object.height) / 2;
        if (!Number.isFinite(radius) || radius <= 0) return null;
        const centerX = object.x + object.width / 2;
        const centerY = object.y + object.height / 2;
        const closestY = Math.max(box.y, Math.min(centerY, box.y + box.height));
        const dy = centerY - closestY;
        const reachSquared = radius * radius - dy * dy;
        if (reachSquared < 0) return null;
        const reachX = Math.sqrt(reachSquared);
        return direction > 0 ? centerX - reachX : centerX + reachX;
    }

    getCircleVerticalContact(object, box, direction) {
        if (!Number.isFinite(object.width) || object.width <= 0 ||
            !Number.isFinite(object.height) || object.height <= 0) return null;
        const radius = Math.min(object.width, object.height) / 2;
        if (!Number.isFinite(radius) || radius <= 0) return null;
        const centerX = object.x + object.width / 2;
        const centerY = object.y + object.height / 2;
        const closestX = Math.max(box.x, Math.min(centerX, box.x + box.width));
        const dx = centerX - closestX;
        const reachSquared = radius * radius - dx * dx;
        if (reachSquared < 0) return null;
        const reachY = Math.sqrt(reachSquared);
        return direction > 0 ? centerY - reachY : centerY + reachY;
    }

    circleIntersectsBox(cx, cy, r, box) {
        const closestX = Math.max(box.x, Math.min(cx, box.x + box.width));
        const closestY = Math.max(box.y, Math.min(cy, box.y + box.height));
        const dx = cx - closestX;
        const dy = cy - closestY;
        return dx * dx + dy * dy <= r * r;
    }

    resetJumps() {
        this.jumpsRemaining = this.maxJumps;
        this.coyoteTimeStart = null;
        this.monarchWingsUsed = 0;
    }

    dropThroughOneWayPlatform(world) {
        if (!world) return false;
        const groundBox = this.getGroundTouchbox();
        const playerBottom = this.y + this.height;
        const candidates = world.queryNear
            ? world.queryNear(groundBox.x - 2, playerBottom - 4, groundBox.width + 4, 8)
            : (world.objects || []);
        const platform = candidates.find(object => (object.oneWayPlatform || ['slopeUpRight', 'slopeUpLeft'].includes(object.collisionShape) ||
            (object.collisionShape === 'polygon' && object.polygonOneWay !== false)) && object.collision !== false &&
            Math.abs(playerBottom - (['slopeUpRight', 'slopeUpLeft'].includes(object.collisionShape) ||
                (object.collisionShape === 'polygon' && object.polygonOneWay !== false)
                ? this.getSlopeSurfaceY(object, groundBox.x + groundBox.width / 2) ?? Infinity
                : object.y)) <= 2 &&
            groundBox.x < object.x + object.width && groundBox.x + groundBox.width > object.x);
        if (!platform) return false;

        // Step past the top plane before normal collision runs this frame.
        // The one-way collision check will then ignore this surface while the
        // player is below it, while lower platforms remain eligible for landings.
        this.y += 2;
        this.vy = Math.max(this.vy, 0);
        this.isOnGround = false;
        this.canJump = false;
        if (!this.additionalAirjump && this.jumpsRemaining === this.maxJumps) {
            this.coyoteTimeStart = Date.now();
            this.jumpsRemaining = Math.max(0, this.maxJumps - 1);
        }
        return true;
    }

    die(world = this._world || (typeof window !== 'undefined' ? window.engine?.world : null), source = null) {
        if (this.isDead) return false;
        this.isDead = true;
        this._world = world || this._world || null;
        if (this._world && typeof window !== 'undefined' && window.PluginManager) {
            window.PluginManager.executeHook('player.died', {
                player: this,
                world: this._world,
                source: source || null
            });
        }
        // Will respawn at checkpoint or spawn
        return true;
    }

    respawn(x, y) {
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        this.isDead = false;
        this.isOnGround = false;
        this._groundedCircleObjectId = null;
        this._groundedSlopeObjectId = null;
        this.resetJumps();
    }

    setMaxJumps(num, additionalAirjump = false) {
        this.maxJumps = num;
        this.additionalAirjump = additionalAirjump;
        this.resetJumps();
    }

    render(ctx, camera, showPosition = false, world = this._world) {
        if (this.isDead) return;

        const screenX = this.x - camera.x;
        const screenY = this.y - camera.y;
        if (!this.renderSpriteSheet(ctx, screenX, screenY, world?.playerSpriteSheet)) {
            ctx.fillStyle = this.color;
            ctx.fillRect(screenX, screenY, this.width, this.height);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
            ctx.fillRect(screenX + this.width - 4, screenY + 4, 4, this.height - 4);
            ctx.fillRect(screenX + 4, screenY + this.height - 4, this.width - 4, 4);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.fillRect(screenX, screenY, this.width - 4, 4);
            ctx.fillRect(screenX, screenY, 4, this.height - 4);
        }
        
        // Cache font strings to avoid per-frame string concatenation + font parsing
        if (!this._cachedFonts) {
            const scale = (typeof Settings !== 'undefined' && Settings.get('fontSize')) ? Settings.get('fontSize') / 100 : 1;
            this._cachedFonts = {
                pos: `${Math.round(16 * scale)}px "Parkoreen Game", sans-serif`,
                name: `${Math.round(14 * scale)}px "Parkoreen Game", sans-serif`,
                nameOffsetY: Math.round(16 * scale)
            };
        }
        
        ctx.save();
        ctx.textAlign = 'center';
        
        if (showPosition) {
            const posText = `(${Math.round(this.x)}, ${Math.round(this.y)})`;
            const tx = screenX + this.width / 2;
            ctx.font = this._cachedFonts.pos;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillText(posText, tx + 1, screenY - 9);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fillText(posText, tx, screenY - 10);
        }
        
        const nameY = screenY + this.height + this._cachedFonts.nameOffsetY;
        const nameX = screenX + this.width / 2;
        ctx.font = this._cachedFonts.name;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillText(this.name, nameX + 1, nameY + 1);
        ctx.fillStyle = 'white';
        ctx.fillText(this.name, nameX, nameY);
        ctx.restore();
    }

    renderSpriteSheet(ctx, x, y, spriteSheet) {
        if (!spriteSheet) return false;
        let image = Player._spriteSheetImageCache.get(spriteSheet.data);
        if (!image) {
            image = new Image();
            image.src = spriteSheet.data;
            Player._spriteSheetImageCache.set(spriteSheet.data, image);
            if (Player._spriteSheetImageCache.size > 32) {
                Player._spriteSheetImageCache.delete(Player._spriteSheetImageCache.keys().next().value);
            }
        }
        if (!image.complete || !image.naturalWidth || !image.naturalHeight ||
            image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 16000000) return false;

        const columns = Math.floor(image.naturalWidth / spriteSheet.frameWidth);
        const rows = Math.floor(image.naturalHeight / spriteSheet.frameHeight);
        if (columns < 1 || rows < 1) return false;
        if (Object.values(spriteSheet.animations || {}).some(animation =>
            !animation || !Number.isInteger(animation.row) || animation.row < 0 || animation.row >= rows ||
            !Number.isInteger(animation.frameCount) || animation.frameCount < 1 || animation.frameCount > columns ||
            !Number.isFinite(animation.fps) || animation.fps < 1 || animation.fps > 30)) return false;
        const grounded = this.isOnGround || this.grounded;
        const locomotionAnimationName = !grounded ? (this.vy < 0 ? 'jump' : 'fall')
            : Math.abs(this.vx) > 0.5 ? 'run' : 'idle';
        const now = Date.now();
        const requestedActionAnimation = this.damageStunUntil > now ? 'hurt'
            : this.isAttacking === true ? 'attack'
                : this.isDashing === true || this.isSuperDashing === true ? 'dash' : null;
        const actionAnimation = requestedActionAnimation && spriteSheet.animations[requestedActionAnimation];
        const useActionAnimation = actionAnimation && actionAnimation.row < rows;
        const animation = useActionAnimation
            ? actionAnimation
            : spriteSheet.animations[locomotionAnimationName] || spriteSheet.animations.idle;
        if (!animation) return false;
        const row = animation.row;
        const frameCount = animation.frameCount;
        const frame = useActionAnimation && requestedActionAnimation === 'attack'
            ? Math.min(frameCount - 1, Math.floor(Math.max(0, Date.now() - (Number(this.attackStartTime) || Date.now())) / 1000 * animation.fps))
            : Math.floor(performance.now() / 1000 * animation.fps) % frameCount;
        const centerX = x + this.width / 2;
        ctx.save();
        if (this.lastDirection < 0) {
            ctx.translate(centerX, 0);
            ctx.scale(-1, 1);
            ctx.translate(-centerX, 0);
        }
        ctx.drawImage(image, frame * spriteSheet.frameWidth, row * spriteSheet.frameHeight,
            spriteSheet.frameWidth, spriteSheet.frameHeight, x, y, this.width, this.height);
        ctx.restore();
        return true;
    }
}
Player._spriteSheetImageCache = new Map();

// ============================================
// CAMERA CLASS
// ============================================
class Camera {
    constructor(width, height) {
        this.x = 0;
        this.y = 0;
        this.targetX = 0;
        this.targetY = 0;
        this.width = width;
        this.height = height;
        this.defaultZoom = 1.5; // Default zoom level (1.5x zoomed in)
        this.zoom = this.defaultZoom;
        this.minZoom = 0.5; // Can zoom out to 0.5x in editor/test
        this.maxZoom = 4; // Can zoom in to 4x
    }
    
    // Set zoom limits based on game mode
    setZoomLimits(mode) {
        if (mode === 'editor') {
            this.minZoom = 0.5;
            this.maxZoom = 4;
        } else {
            // Test/Play: zoom is locked to default
            this.minZoom = this.defaultZoom;
            this.maxZoom = this.defaultZoom;
        }
        // Clamp current zoom to new limits
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));
    }
    
    // Reset zoom to default
    resetZoom() {
        this.zoom = this.defaultZoom;
    }

    follow(target, mode = 'both') {
        if (mode === 'both' || mode === 'horizontal') {
            this.targetX = target.x + target.width / 2 - this.width / 2 / this.zoom;
        }
        if (mode === 'both' || mode === 'vertical') {
            this.targetY = target.y + target.height / 2 - this.height / 2 / this.zoom;
        }
    }

    clampPositionToBounds(x, y, bounds) {
        const viewWidth = this.width / this.zoom;
        const viewHeight = this.height / this.zoom;
        const clampAxis = (position, start, length, viewLength) => {
            if (length <= viewLength) return start + (length - viewLength) / 2;
            return Math.max(start, Math.min(start + length - viewLength, position));
        };

        return {
            x: clampAxis(x, bounds.x, bounds.width, viewWidth),
            y: clampAxis(y, bounds.y, bounds.height, viewHeight)
        };
    }

    update(lerpX = CAMERA_LERP_X, lerpY = CAMERA_LERP_Y, bounds = null) {
        const validBounds = bounds &&
            Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
            Number.isFinite(bounds.width) && bounds.width > 0 &&
            Number.isFinite(bounds.height) && bounds.height > 0 &&
            Number.isFinite(bounds.x + bounds.width) && Number.isFinite(bounds.y + bounds.height);

        if (validBounds) {
            const target = this.clampPositionToBounds(this.targetX, this.targetY, bounds);
            this.targetX = target.x;
            this.targetY = target.y;
        }

        // Smooth camera movement (separate horizontal/vertical smoothness)
        this.x += (this.targetX - this.x) * lerpX;
        this.y += (this.targetY - this.y) * lerpY;

        if (validBounds) {
            const position = this.clampPositionToBounds(this.x, this.y, bounds);
            this.x = position.x;
            this.y = position.y;
        }
    }

    setZoom(zoom, centerX = null, centerY = null) {
        const oldZoom = this.zoom;
        const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
        
        if (oldZoom !== newZoom && centerX !== null && centerY !== null) {
            // Adjust camera position to keep the center point in the same screen position
            // Before zoom: screenCenter = (centerX - this.x) * oldZoom
            // After zoom: screenCenter = (centerX - newX) * newZoom
            // We want them equal, so: (centerX - this.x) * oldZoom = (centerX - newX) * newZoom
            // Solving for newX: newX = centerX - (centerX - this.x) * oldZoom / newZoom
            this.x = centerX - (centerX - this.x) * oldZoom / newZoom;
            this.y = centerY - (centerY - this.y) * oldZoom / newZoom;
            this.targetX = this.x;
            this.targetY = this.y;
        }
        
        this.zoom = newZoom;
    }

    zoomIn(centerX = null, centerY = null) {
        this.setZoom(this.zoom + 0.1, centerX, centerY);
    }

    zoomOut(centerX = null, centerY = null) {
        this.setZoom(this.zoom - 0.1, centerX, centerY);
    }

    screenToWorld(screenX, screenY) {
        return {
            x: this.x + screenX / this.zoom,
            y: this.y + screenY / this.zoom
        };
    }

    worldToScreen(worldX, worldY) {
        return {
            x: (worldX - this.x) * this.zoom,
            y: (worldY - this.y) * this.zoom
        };
    }
}

// ============================================
// IMAGE LOADERS
// ============================================
const SpikeImage = {
    image: null,
    loaded: false,
    load() {
        if (this.image) return;
        this.image = new Image();
        this.image.onload = () => { this.loaded = true; };
        this.image.src = '/parkoreen/assets/svg/spike-512x.svg';
    }
};

const PortalImage = {
    image: null,
    loaded: false,
    load() {
        if (this.image) return;
        this.image = new Image();
        this.image.onload = () => { this.loaded = true; };
        this.image.src = '/parkoreen/assets/svg/portal-512x.svg';
    }
};

const SpinnerImage = {
    image: null,
    loaded: false,
    load() {
        if (this.image) return;
        this.image = new Image();
        this.image.onload = () => { this.loaded = true; };
        this.image.src = 'assets/svg/spinner.svg';
    }
};

const CoinImage = {
    image: null,
    loaded: false,
    load() {
        if (this.image) return;
        this.image = new Image();
        this.image.onload = () => { this.loaded = true; };
        this.image.src = '/parkoreen/assets/svg/coin.svg';
    }
};

const BouncerImage = {
    image: null,
    loaded: false,
    load() {
        if (this.image) return;
        this.image = new Image();
        this.image.onload = () => { this.loaded = true; };
        this.image.src = '/parkoreen/assets/svg/bouncer.svg';
    }
};

// Repeating built-in surfaces are shared by regular blocks and tilemap cells.
const createBlockTexture = path => ({
    image: null,
    loaded: false,
    load() {
        if (this.image) return;
        this.image = new Image();
        this.image.onload = () => { this.loaded = true; };
        this.image.src = path;
    }
});
const BlockTextures = {
    brick: createBlockTexture('assets/svg/block-brick-pattern.svg'),
    stone: createBlockTexture('assets/svg/block-stone-pattern.svg'),
    wood: createBlockTexture('assets/svg/block-wood-pattern.svg'),
    moss: createBlockTexture('assets/svg/block-moss-pattern.svg')
};

/**
 * Repeating block texture fill in rectangle (x,y,w,h) in screen space.
 * Must translate + clip then fill: patterns repeat from the canvas origin unless
 * the coordinate system is moved so the tile phase follows the block.
 */
function fillBlockSurfaceTexture(ctx, textureKey, x, y, w, h) {
    const tex = BlockTextures[textureKey];
    if (!tex?.loaded || !tex.image) return;
    if (!tex._pattern) {
        tex._pattern = ctx.createPattern(tex.image, 'repeat');
    }
    const pattern = tex._pattern;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

const CloudImages = {
    images: [],
    loaded: false,
    _loadCount: 0,
    /** Must match numbered files assets/svg/cloud1.svg … cloud{N}.svg */
    _total: 9,
    load() {
        if (this.images.length) return;
        for (let i = 1; i <= this._total; i++) {
            const img = new Image();
            img.onload = () => {
                this._loadCount++;
                if (this._loadCount >= this._total) this.loaded = true;
            };
            img.src = `assets/svg/cloud${i}.svg`;
            this.images.push(img);
        }
    }
};

// Load images immediately
SpikeImage.load();
PortalImage.load();
SpinnerImage.load();
CoinImage.load();
BouncerImage.load();
Object.values(BlockTextures).forEach(texture => texture.load());
CloudImages.load();

// ============================================
// WORLD OBJECT CLASS
// ============================================
const WORLD_OBJECT_SPRITE_MAX_DATA_URL_LENGTH = 1500000;
const WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH = 8 * 1024 * 1024;
const normalizeWorldObjectSpriteAnimations = (animations, frameCount) => {
    if (animations === undefined) return [];
    if (!Array.isArray(animations) || animations.length > 32) return null;
    const names = new Set();
    const normalized = [];
    for (const animation of animations) {
        if (!animation || typeof animation !== 'object' || Array.isArray(animation) ||
            typeof animation.name !== 'string' || !/^[A-Za-z][A-Za-z0-9 _-]{0,31}$/.test(animation.name.trim()) ||
            !Number.isSafeInteger(animation.startFrame) || animation.startFrame < 0 ||
            !Number.isSafeInteger(animation.frameCount) || animation.frameCount < 1 ||
            animation.startFrame + animation.frameCount > frameCount ||
            !Number.isFinite(animation.fps) || animation.fps < 1 || animation.fps > 30 ||
            typeof animation.loop !== 'boolean') return null;
        const name = animation.name.trim();
        const normalizedName = name.toLocaleLowerCase('en-US');
        if (names.has(normalizedName)) return null;
        names.add(normalizedName);
        normalized.push({
            name,
            startFrame: animation.startFrame,
            frameCount: animation.frameCount,
            fps: animation.fps,
            loop: animation.loop
        });
    }
    return normalized;
};
const normalizeWorldObjectSpriteSheet = (spriteSheet) => {
    if (!spriteSheet || typeof spriteSheet !== 'object' || Array.isArray(spriteSheet)) return null;
    const data = typeof spriteSheet.data === 'string' ? spriteSheet.data : '';
    if (data.length > WORLD_OBJECT_SPRITE_MAX_DATA_URL_LENGTH ||
        !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    const frameWidth = Number(spriteSheet.frameWidth);
    const frameHeight = Number(spriteSheet.frameHeight);
    const frameCount = Number(spriteSheet.frameCount);
    const fps = Number(spriteSheet.fps);
    if (!Number.isInteger(frameWidth) || frameWidth < 1 || frameWidth > 4096 ||
        !Number.isInteger(frameHeight) || frameHeight < 1 || frameHeight > 4096 ||
        !Number.isInteger(frameCount) || frameCount < 1 || frameCount > 256 ||
        !Number.isFinite(fps) || fps < 1 || fps > 30) return null;
    const animations = normalizeWorldObjectSpriteAnimations(spriteSheet.animations, frameCount);
    if (!animations) return null;
    return { data, frameWidth, frameHeight, frameCount, fps, animations };
};

const PLAYER_SPRITE_ANIMATIONS = ['idle', 'run', 'jump', 'fall'];
const PLAYER_SPRITE_ACTION_ANIMATIONS = ['attack', 'hurt', 'dash'];
const normalizeWorldPlayerSpriteSheet = (spriteSheet) => {
    if (!spriteSheet || typeof spriteSheet !== 'object' || Array.isArray(spriteSheet)) return null;
    const data = typeof spriteSheet.data === 'string' ? spriteSheet.data : '';
    if (data.length > WORLD_OBJECT_SPRITE_MAX_DATA_URL_LENGTH ||
        !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    const frameWidth = Number(spriteSheet.frameWidth);
    const frameHeight = Number(spriteSheet.frameHeight);
    if (!Number.isInteger(frameWidth) || frameWidth < 1 || frameWidth > 4096 ||
        !Number.isInteger(frameHeight) || frameHeight < 1 || frameHeight > 4096) return null;
    if (spriteSheet.animations !== undefined &&
        (!spriteSheet.animations || typeof spriteSheet.animations !== 'object' || Array.isArray(spriteSheet.animations))) return null;
    const animations = {};
    for (const [index, name] of PLAYER_SPRITE_ANIMATIONS.entries()) {
        const source = spriteSheet.animations?.[name];
        if (source !== undefined && (!source || typeof source !== 'object' || Array.isArray(source) ||
            (source.row !== undefined && (!Number.isInteger(source.row) || source.row < 0 || source.row > 127)) ||
            (source.frameCount !== undefined && (!Number.isInteger(source.frameCount) || source.frameCount < 1 || source.frameCount > 256)) ||
            (source.fps !== undefined && (!Number.isFinite(source.fps) || source.fps < 1 || source.fps > 30)))) return null;
        const row = source?.row ?? index;
        const frameCount = source?.frameCount ?? 1;
        const fps = source?.fps ?? 8;
        animations[name] = { row, frameCount, fps };
    }
    for (const name of PLAYER_SPRITE_ACTION_ANIMATIONS) {
        const animation = spriteSheet.animations?.[name];
        if (animation === undefined) continue;
        if (!animation || typeof animation !== 'object' || Array.isArray(animation) ||
            !Number.isInteger(animation.row) || animation.row < 0 || animation.row > 127 ||
            !Number.isInteger(animation.frameCount) || animation.frameCount < 1 || animation.frameCount > 256 ||
            !Number.isFinite(animation.fps) || animation.fps < 1 || animation.fps > 30) return null;
        animations[name] = { row: animation.row, frameCount: animation.frameCount, fps: animation.fps };
    }
    return { data, frameWidth, frameHeight, animations };
};

class WorldObject {
    constructor(config) {
        this.id = config.id || this.generateId();
        this.x = config.x || 0;
        this.y = config.y || 0;
        this.width = config.width || GRID_SIZE;
        this.height = config.height || GRID_SIZE;
        this.type = config.type || 'block'; // block, koreen, text
        this.appearanceType = config.appearanceType || 'ground'; // ground, spike, checkpoint, spawnpoint, endpoint
        this.actingType = config.actingType || 'ground'; // ground, spike, checkpoint, spawnpoint, endpoint, text
        this.collision = config.collision !== undefined ? config.collision : true;
        this.collisionShape = ['circle', 'capsule', 'slopeUpRight', 'slopeUpLeft', 'polygon'].includes(config.collisionShape) &&
            this.type === 'block' && this.appearanceType === 'ground' && this.actingType === 'ground' &&
            Number.isFinite(this.width) && this.width > 0 && Number.isFinite(this.height) && this.height > 0
            ? config.collisionShape : 'box';
        this.collisionPoints = this.collisionShape === 'polygon'
            ? (normalizeWorldCollisionPolygon(config.collisionPoints) || DEFAULT_WORLD_COLLISION_POLYGON).map(point => point.slice())
            : null;
        this.polygonOneWay = this.collisionShape === 'polygon' ? config.polygonOneWay !== false : false;
        this.oneWayPlatform = config.oneWayPlatform === true &&
            this.type === 'block' && this.appearanceType === 'ground' && this.actingType === 'ground' &&
            this.collisionShape === 'box';
        this.color = config.color || '#787878';
        this.opacity = config.opacity !== undefined ? config.opacity : 1;
        this.layer = normalizeWorldLayerDepth(config.layer) ?? 1; // Draw depth; 0/1 render below the player and 2 renders above.
        this.rotation = config.rotation || 0;
        this.flipHorizontal = config.flipHorizontal || false;
        this.texture = config.texture || 'solid'; // solid, brick, etc.
        this.spriteSheet = normalizeWorldObjectSpriteSheet(config.spriteSheet);
        this._spriteSheetImage = null;
        this._spriteSheetImageData = null;
        
        // Text specific
        this.content = config.content || '';
        this.font = config.font || 'Parkoreen Game';
        this.fontSize = config.fontSize || 24;
        this.hAlign = config.hAlign || 'center'; // left, center, right
        this.vAlign = config.vAlign || 'center'; // top, center, bottom
        this.hSpacing = config.hSpacing || 0;
        this.vSpacing = config.vSpacing || 0;
        
        // Checkpoint state (default, active, touched)
        this.checkpointState = config.checkpointState || 'default';
        
        // Per-spike touchbox mode (null = use world default, or 'full', 'normal', 'tip', 'ground', 'flag', 'air')
        this.spikeTouchbox = config.spikeTouchbox || null;
        
        // Per-spike dropHurtOnly (undefined = use world default, true/false = override)
        this.dropHurtOnly = config.dropHurtOnly;
        
        // Zone-specific property
        this.zoneName = config.zoneName || null;

        // Bouncer-specific properties
        this.bouncerStrength = config.bouncerStrength !== undefined ? config.bouncerStrength : 20;
        const legacyBouncerRotation = ((config.rotation || 0) % 360 + 360) % 360;
        const hasBouncerDirection = config.bouncerDirection !== undefined;
        const hasBouncerAppearanceDirection = config.bouncerAppearanceDirection !== undefined;
        this.bouncerDirection = hasBouncerDirection
            ? config.bouncerDirection
            : (config.appearanceType === 'bouncer' ? legacyBouncerRotation : 0); // 0=up, 90=right, 180=down, 270=left
        this.bouncerMatchAppearance = config.bouncerMatchAppearance !== undefined ? config.bouncerMatchAppearance : true;
        this.bouncerAppearanceDirection = hasBouncerAppearanceDirection
            ? config.bouncerAppearanceDirection
            : (config.appearanceType === 'bouncer' ? legacyBouncerRotation : this.bouncerDirection);

        // Legacy maps may store bouncer orientation in generic rotation only.
        if (config.appearanceType === 'bouncer' && !hasBouncerDirection && !hasBouncerAppearanceDirection && legacyBouncerRotation !== 0) {
            this.rotation = 0;
        }

        // Coin-specific properties
        this.coinAmount = config.coinAmount !== undefined ? config.coinAmount : 1;
        this.coinActivityScope = config.coinActivityScope || 'global'; // 'global' | 'player'
        this.endpointRequireCoins = config.endpointRequireCoins !== undefined ? config.endpointRequireCoins : false;
        this.endpointRequiredCoins = config.endpointRequiredCoins;
        if (this.appearanceType === 'coin') {
            const coinSeed = this._stableSeedFromString(this.id || `${this.x},${this.y}`);
            this._bobOffset = (coinSeed % 6283) / 1000; // 0..~2PI
            this._bobFlowDiv = 320 + (coinSeed % 240); // lower = faster bob
            this._bobAmplitude = 3 + ((coinSeed >> 6) % 21) / 10; // 3.0..5.0
        }

        // Damage amount (for spikes and spinners)
        this.damageAmount = config.damageAmount !== undefined ? config.damageAmount : 1;

        // Spinner-specific properties
        this.spinSpeed = config.spinSpeed !== undefined ? config.spinSpeed : 1;
        this.spinDirection = config.spinDirection !== undefined ? config.spinDirection : 1; // 1=clockwise, -1=counter-clockwise

        // Button-specific properties
        this.displayName = config.displayName || '';
        this.displayDescription = config.displayDescription || '';
        this.buttonVisible = config.buttonVisible !== undefined ? config.buttonVisible : true;
        this.buttonWidth = config.buttonWidth || null;
        this.buttonHeight = config.buttonHeight || null;
        this.buttonInteraction = config.buttonInteraction || 'click'; // 'click' | 'collide'
        this.buttonOnlyOnce = config.buttonOnlyOnce !== undefined ? config.buttonOnlyOnce : false;
        this.buttonColor2 = config.buttonColor2 || '#CFCFCF';

        // Teleportal-specific properties
        this.teleportalName = config.teleportalName || null;
        // sendTo/receiveFrom: Array of {name, enabled} objects (backward compatible with string arrays)
        this.sendTo = (config.sendTo || []).map(item => 
            typeof item === 'string' ? { name: item, enabled: true } : item
        );
        this.receiveFrom = (config.receiveFrom || []).map(item => 
            typeof item === 'string' ? { name: item, enabled: true } : item
        );
        this.particleOpacity = config.particleOpacity !== undefined ? config.particleOpacity : 100;
        
        this.name = config.name || this.getDefaultName();
    }

    generateId() {
        return 'obj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    _stableSeedFromString(str) {
        const text = String(str || 'coin');
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    getDefaultName() {
        if (this.type === 'teleportal') {
            return 'Teleportal';
        }
        const typeNames = {
            ground: 'Block',
            spike: 'Spike',
            checkpoint: 'Checkpoint',
            spawnpoint: 'Spawn Point',
            endpoint: 'End Point',
            teleportal: 'Teleportal',
            soulStatue: 'Soul Statue',
            button: 'Button',
            bouncer: 'Bouncer',
            coin: 'Coin'
        };
        return typeNames[this.appearanceType] || 'Object';
    }

    render(ctx, camera, checkpointColors = null, world = null) {
        if (this._mechanicsEnabled === false) return;
        const screenX = this.x - camera.x;
        const screenY = this.y - camera.y;
        const width = this.width;
        const height = this.height;

        const at = this.appearanceType;
        const isSpinner = at === 'spinner' || this.type === 'spinner';
        const effectiveOpacity = Number.isFinite(this._mechanicsOpacity)
            ? Math.max(0, Math.min(1, this._mechanicsOpacity)) : this.opacity;

        // Saw blade: editor rotation + spin animation must share one pivot. The generic
        // translate(center)-rotate-translate(-center) wrapper breaks inner translate(center)
        // because nested translates use the already-rotated axes — blade "unpins" from hitbox.
        if (isSpinner) {
            ctx.save();
            if (effectiveOpacity !== 1) ctx.globalAlpha = effectiveOpacity;
            ctx.translate(screenX + width / 2, screenY + height / 2);
            if (this.rotation !== 0) ctx.rotate(this.rotation * Math.PI / 180);
            if (this.flipHorizontal) ctx.scale(-1, 1);
            this.renderSpinner(ctx, width, height, camera);
            ctx.restore();
            return;
        }

        const isBouncer = at === 'bouncer';
        const needsTransform = !isBouncer && (this.rotation !== 0 || this.flipHorizontal);
        const needsAlpha = effectiveOpacity !== 1;
        
        // Only save/restore when we actually change state
        if (needsTransform || needsAlpha) {
            ctx.save();
            if (needsAlpha) ctx.globalAlpha = effectiveOpacity;
            if (needsTransform) {
                ctx.translate(screenX + width / 2, screenY + height / 2);
                if (this.rotation !== 0) ctx.rotate(this.rotation * Math.PI / 180);
                if (this.flipHorizontal) ctx.scale(-1, 1);
                ctx.translate(-(screenX + width / 2), -(screenY + height / 2));
            }
        }

        if (this.spriteSheet && this.renderSpriteSheet(ctx, screenX, screenY, width, height)) {
            // The custom sprite replaces artwork while leaving this object's
            // collision and mechanic behavior intact.
        } else if (this.type === 'text') {
            this.renderText(ctx, screenX, screenY, width, height);
        } else if (at === 'spike') {
            this.renderSpike(ctx, screenX, screenY, width, height);
        } else if (at === 'checkpoint') {
            this.renderCheckpoint(ctx, screenX, screenY, width, height, checkpointColors);
        } else if (at === 'spawnpoint') {
            this.renderSpawnpoint(ctx, screenX, screenY, width, height);
        } else if (at === 'endpoint') {
            this.renderEndpoint(ctx, screenX, screenY, width, height, world);
        } else if (at === 'zone') {
            this.renderZone(ctx, screenX, screenY, width, height);
        } else if (at === 'button') {
            this.renderButton(ctx, screenX, screenY, width, height);
        } else if (at === 'bouncer') {
            this.renderBouncer(ctx, screenX, screenY, width, height);
        } else if (at === 'coin') {
            const collected = typeof window !== 'undefined'
                ? window.engine?.isCoinCollectedForLocalPlayer?.(this, world) ?? this._collected
                : this._collected;
            if (!collected) this.renderCoin(ctx, screenX, screenY, width, height);
        } else if (at === 'teleportal' || this.type === 'teleportal') {
            this.renderTeleportal(ctx, screenX, screenY, width, height);
        } else if (at === 'soulStatue') {
            const hookData = {
                ctx,
                screenX,
                screenY,
                width,
                height,
                obj: this,
                handled: false
            };
            if (window.PluginManager) {
                window.PluginManager.executeHook('render.soulStatue', hookData);
            }
            if (!hookData.handled) {
                this.renderSoulStatueFallback(ctx, screenX, screenY, width, height);
            }
        } else {
            this.renderBlock(ctx, screenX, screenY, width, height);
        }

        if (needsTransform || needsAlpha) {
            ctx.restore();
        }
    }

    renderSpriteSheet(ctx, x, y, width, height) {
        const sprite = this.spriteSheet;
        if (!sprite) return false;
        if (!this._spriteSheetImage || this._spriteSheetImageData !== sprite.data) {
            let image = WorldObject._spriteSheetImageCache.get(sprite.data);
            if (!image) {
                image = new Image();
                image.src = sprite.data;
                WorldObject._spriteSheetImageCache.set(sprite.data, image);
                if (WorldObject._spriteSheetImageCache.size > 32) {
                    WorldObject._spriteSheetImageCache.delete(WorldObject._spriteSheetImageCache.keys().next().value);
                }
            }
            this._spriteSheetImage = image;
            this._spriteSheetImageData = sprite.data;
        }
        const image = this._spriteSheetImage;
        if (!image.complete || !image.naturalWidth || !image.naturalHeight) return false;
        const columns = Math.floor(image.naturalWidth / sprite.frameWidth);
        const rows = Math.floor(image.naturalHeight / sprite.frameHeight);
        const availableFrames = columns * rows;
        if (columns < 1 || rows < 1 || availableFrames < 1) return false;
        if (sprite.frameCount > availableFrames) return false;
        const frameCount = sprite.frameCount;
        const animation = this._mechanicsSpriteAnimation;
        const animationIsValid = animation && Number.isSafeInteger(animation.startFrame) &&
            Number.isSafeInteger(animation.frameCount) && Number.isFinite(animation.fps) &&
            typeof animation.loop === 'boolean' && Number.isFinite(animation.startedAt) &&
            animation.startFrame >= 0 && animation.frameCount >= 1 && animation.fps >= 1 && animation.fps <= 30 &&
            animation.startFrame + animation.frameCount <= frameCount;
        let animationFrame = null;
        if (animationIsValid) {
            const elapsedFrames = Math.floor(Math.max(0, Date.now() - animation.startedAt) / 1000 * animation.fps);
            animationFrame = animation.startFrame + (animation.loop
                ? elapsedFrames % animation.frameCount
                : Math.min(animation.frameCount - 1, elapsedFrames));
        }
        const requestedFrame = Number.isSafeInteger(this._mechanicsSpriteFrame) &&
            this._mechanicsSpriteFrame >= 0 && this._mechanicsSpriteFrame < frameCount
            ? this._mechanicsSpriteFrame : null;
        const frame = WorldObject._editorMode
            ? 0
            : requestedFrame ?? animationFrame ?? Math.floor((performance.now() / 1000) * sprite.fps) % frameCount;
        const sourceX = (frame % columns) * sprite.frameWidth;
        const sourceY = Math.floor(frame / columns) * sprite.frameHeight;
        const faceLeft = this._mechanicsMotionDirection < 0;
        if (faceLeft) {
            ctx.save();
            ctx.translate(x + width / 2, 0);
            ctx.scale(-1, 1);
            ctx.translate(-(x + width / 2), 0);
        }
        ctx.drawImage(image, sourceX, sourceY, sprite.frameWidth, sprite.frameHeight, x, y, width, height);
        if (faceLeft) ctx.restore();
        return true;
    }

    renderBlock(ctx, x, y, w, h) {
        const texture = this.texture || 'solid';
        
        ctx.fillStyle = this.color;
        ctx.fillRect(x, y, w, h);
        
        if (texture !== 'solid' && BlockTextures[texture]?.loaded && BlockTextures[texture]?.image) {
            fillBlockSurfaceTexture(ctx, texture, x, y, w, h);
        } else if (texture === 'solid' && w >= 16 && h >= 16) {
            // Shadow (bottom-right): two rects combined into one beginPath for fewer GPU state flushes
            ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.beginPath();
            ctx.rect(x + w - 4, y + 4, 4, h - 4);
            ctx.rect(x + 4, y + h - 4, w - 4, 4);
            ctx.fill();
            // Highlight (top-left)
            ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.beginPath();
            ctx.rect(x, y, w - 4, 4);
            ctx.rect(x, y, 4, h - 4);
            ctx.fill();
        }

        if (this.oneWayPlatform) {
            ctx.fillStyle = 'rgba(255, 224, 130, 0.9)';
            ctx.fillRect(x, y, w, Math.min(3, h));
        }
    }

    renderSpike(ctx, x, y, w, h) {
        if (SpikeImage.loaded && SpikeImage.image) {
            const dpr = window.devicePixelRatio || 1;
            const cacheKey = `${this.color}_${w}_${h}_${dpr}`;
            if (this._spikeCacheKey !== cacheKey) {
                const offscreen = document.createElement('canvas');
                offscreen.width = w * dpr;
                offscreen.height = h * dpr;
                const offCtx = offscreen.getContext('2d');
                offCtx.scale(dpr, dpr);
                offCtx.drawImage(SpikeImage.image, 0, 0, w, h);
                offCtx.globalCompositeOperation = 'source-in';
                offCtx.fillStyle = this.color;
                offCtx.fillRect(0, 0, w, h);
                this._spikeCache = offscreen;
                this._spikeCacheKey = cacheKey;
            }
            ctx.drawImage(this._spikeCache, 0, 0, this._spikeCache.width, this._spikeCache.height, x, y, w, h);
        } else {
            // Fallback: simple triangle spikes if image not loaded
            const color = this.color;
            const numTeeth = Math.max(3, Math.min(6, Math.round(w / 12)));
            const toothWidth = w / numTeeth;
            const baseHeight = h * 0.17;
            
            ctx.fillStyle = color;
            ctx.fillRect(x, y + h - baseHeight, w, baseHeight);
            
            for (let t = 0; t < numTeeth; t++) {
                const toothX = x + t * toothWidth;
        ctx.beginPath();
                ctx.moveTo(toothX, y + h - baseHeight);
                ctx.lineTo(toothX + toothWidth / 2, y);
                ctx.lineTo(toothX + toothWidth, y + h - baseHeight);
        ctx.closePath();
        ctx.fill();
            }
        }
    }

    renderCheckpoint(ctx, x, y, w, h, checkpointColors = null) {
        // Flag pole
        ctx.fillStyle = '#8B4513';
        ctx.fillRect(x + w * 0.4, y + h * 0.2, w * 0.1, h * 0.8);
        
        // Flag color based on state (use provided colors or defaults)
        const defaultColor = checkpointColors?.default || '#808080';
        const activeColor = checkpointColors?.active || '#4CAF50';
        const touchedColor = checkpointColors?.touched || '#2196F3';
        
        let flagColor = defaultColor;
        if (this.checkpointState === 'active') {
            flagColor = activeColor;
        } else if (this.checkpointState === 'touched') {
            flagColor = touchedColor;
        }
        
        ctx.fillStyle = flagColor;
        ctx.beginPath();
        ctx.moveTo(x + w * 0.5, y + h * 0.2);
        ctx.lineTo(x + w * 0.9, y + h * 0.35);
        ctx.lineTo(x + w * 0.5, y + h * 0.5);
        ctx.closePath();
        ctx.fill();
    }

    renderSpawnpoint(ctx, x, y, w, h) {
        // Base platform
        ctx.fillStyle = '#4CAF50';
        ctx.fillRect(x + w * 0.1, y + h * 0.7, w * 0.8, h * 0.2);
        
        // Arrow pointing up
        ctx.fillStyle = '#81C784';
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y + h * 0.2);
        ctx.lineTo(x + w * 0.7, y + h * 0.5);
        ctx.lineTo(x + w * 0.55, y + h * 0.5);
        ctx.lineTo(x + w * 0.55, y + h * 0.7);
        ctx.lineTo(x + w * 0.45, y + h * 0.7);
        ctx.lineTo(x + w * 0.45, y + h * 0.5);
        ctx.lineTo(x + w * 0.3, y + h * 0.5);
        ctx.closePath();
        ctx.fill();
    }

    renderEndpoint(ctx, x, y, w, h, world = null) {
        const requireCoins = !!this.endpointRequireCoins;
        let isLocked = false;
        if (requireCoins && world) {
            const totalCoins = world.objects.filter(o => o.appearanceType === 'coin' && o._mechanicsEnabled !== false).length;
            let requiredCoins = Number.isFinite(this.endpointRequiredCoins)
                ? Math.max(0, Math.floor(this.endpointRequiredCoins))
                : totalCoins;
            requiredCoins = Math.min(requiredCoins, totalCoins);
            const collectedCoins = world.objects.filter(o => o.appearanceType === 'coin' && o._mechanicsEnabled !== false &&
                (window.engine?.isCoinCollectedForLocalPlayer?.(o, world) ?? o._collected)).length;
            isLocked = collectedCoins < requiredCoins;
        }

        const baseColor = isLocked ? '#717171' : '#FFD700';
        const cupColor = isLocked ? '#8A8A8A' : '#FFD700';
        const starColor = isLocked ? '#D2D2D2' : '#FFF';

        // Trophy base
        ctx.fillStyle = baseColor;
        ctx.fillRect(x + w * 0.25, y + h * 0.7, w * 0.5, h * 0.2);
        
        // Trophy cup
        ctx.beginPath();
        ctx.moveTo(x + w * 0.15, y + h * 0.15);
        ctx.quadraticCurveTo(x + w * 0.15, y + h * 0.55, x + w * 0.35, y + h * 0.6);
        ctx.lineTo(x + w * 0.35, y + h * 0.7);
        ctx.lineTo(x + w * 0.65, y + h * 0.7);
        ctx.lineTo(x + w * 0.65, y + h * 0.6);
        ctx.quadraticCurveTo(x + w * 0.85, y + h * 0.55, x + w * 0.85, y + h * 0.15);
        ctx.closePath();
        ctx.fillStyle = cupColor;
        ctx.fill();
        
        // Star
        ctx.fillStyle = starColor;
        const cx = x + w / 2;
        const cy = y + h * 0.35;
        const spikes = 5;
        const outerRadius = w * 0.12;
        const innerRadius = w * 0.05;
        
        ctx.beginPath();
        for (let i = 0; i < spikes * 2; i++) {
            const radius = i % 2 === 0 ? outerRadius : innerRadius;
            const angle = (i * Math.PI / spikes) - Math.PI / 2;
            const px = cx + Math.cos(angle) * radius;
            const py = cy + Math.sin(angle) * radius;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
    }
    
    /** Fallback if no plugin draws soul statue (e.g. HK not loaded) */
    renderSoulStatueFallback(ctx, x, y, w, h) {
        ctx.fillStyle = 'rgba(100, 80, 140, 0.35)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(180, 160, 220, 0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
    }

    _renderSoulStatueWithImage(ctx, x, y, w, h, img) {
        if (img.complete && img.naturalWidth > 0) {
            const imgAspect = img.naturalWidth / img.naturalHeight;
            const boxAspect = w / h;
            
            let drawWidth, drawHeight;
            if (imgAspect > boxAspect) {
                drawWidth = w;
                drawHeight = w / imgAspect;
            } else {
                drawHeight = h;
                drawWidth = h * imgAspect;
            }
            
            // Center within the touchbox
            const drawX = x + (w - drawWidth) / 2;
            const drawY = y + (h - drawHeight) / 2;
            
            ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
        } else {
            // Fallback: simple placeholder while loading
            ctx.fillStyle = '#3a3a4a';
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.beginPath();
            ctx.arc(x + w / 2, y + h * 0.3, w * 0.4, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    
    renderZone(ctx, x, y, w, h) {
        // Semi-transparent white fill (30% opacity)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fillRect(x, y, w, h);
        
        // Solid white border
        ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]);
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        ctx.setLineDash([]);
        
        // Zone name label
        if (this.zoneName) {
            const zoneFontScale = (typeof Settings !== 'undefined' && Settings.get('fontSize')) ? Settings.get('fontSize') / 100 : 1;
            ctx.font = `${Math.round(12 * zoneFontScale)}px "Parkoreen Game", sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            
            const padding = 4;
            const textWidth = ctx.measureText(this.zoneName).width;
            
            // Background for label
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(x + 4, y + 4, textWidth + padding * 2, 18);
            
            // Text (white to match border)
            ctx.fillStyle = 'rgba(255, 255, 255, 1)';
            ctx.fillText(this.zoneName, x + 4 + padding, y + 6);
        }
    }
    
    renderButton(ctx, x, y, w, h) {
        if (!this.buttonVisible) return;

        if (this.buttonInteraction === 'collide') {
            // Pressure-plate appearance — sits at bottom of zone
            const bw = this.buttonWidth || w;
            const plateH = Math.max(10, Math.min(20, h));
            const bx = x + (w - bw) / 2;
            const by = y + h - plateH;

            // Shadow / depth
            ctx.fillStyle = this.buttonColor2 || '#CFCFCF';
            ctx.fillRect(bx + 3, by + 5, bw, plateH);

            // Main surface (rounded top)
            const r = Math.min(4, bw / 6, plateH / 2);
            ctx.beginPath();
            ctx.moveTo(bx + r, by);
            ctx.lineTo(bx + bw - r, by);
            ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
            ctx.lineTo(bx + bw, by + plateH);
            ctx.lineTo(bx, by + plateH);
            ctx.lineTo(bx, by + r);
            ctx.quadraticCurveTo(bx, by, bx + r, by);
            ctx.closePath();
            ctx.fillStyle = this.color || '#F52C2C';
            ctx.fill();

            // Shine strip
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fillRect(bx + bw * 0.08, by + 3, bw * 0.84, 3);

            // Raised edge highlight
            ctx.strokeStyle = 'rgba(255,255,255,0.4)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(bx, by + plateH);
            ctx.lineTo(bx, by + r);
            ctx.quadraticCurveTo(bx, by, bx + r, by);
            ctx.lineTo(bx + bw - r, by);
            ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
            ctx.lineTo(bx + bw, by + plateH);
            ctx.stroke();

            // Label above the plate
            if (this.displayName) {
                const fontSize = Math.min(13, h * 0.38);
                ctx.font = `bold ${fontSize}px "Parkoreen Game", sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = 3;
                ctx.fillStyle = '#fff';
                ctx.fillText(this.displayName, x + w / 2, by - 2);
                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';
            }
            return;
        }

        const bw = this.buttonWidth || w;
        const bh = this.buttonHeight || h;
        const bx = x + (w - bw) / 2;
        const by = y + (h - bh) / 2;
        
        // Rounded rectangle fill
        const r = Math.min(8, bw / 4, bh / 4);
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by);
        ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
        ctx.lineTo(bx + bw, by + bh - r);
        ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
        ctx.lineTo(bx + r, by + bh);
        ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        
        ctx.fillStyle = this.color || '#F52C2C';
        ctx.fill();
        ctx.strokeStyle = this.buttonColor2 || '#CFCFCF';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Display name label
        if (this.displayName) {
            const fontSize = Math.min(14, bh * 0.4);
            ctx.font = `bold ${fontSize}px "Parkoreen Game", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#fff';
            ctx.fillText(this.displayName, bx + bw / 2, by + bh / 2);
        }
    }

    renderCoin(ctx, x, y, w, h) {
        const now = Date.now();
        const bobDiv = this._bobFlowDiv || 400;
        const bobAmp = this._bobAmplitude || 4;
        const bob = Math.sin(now / bobDiv + (this._bobOffset || 0)) * bobAmp;
        const cx = x + w / 2;
        const cy = y + h / 2 + bob;
        const r = Math.min(w, h) * 0.42;

        // Outer glow
        const grd = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.4);
        grd.addColorStop(0, 'rgba(255, 230, 60, 0.35)');
        grd.addColorStop(1, 'rgba(255, 230, 60, 0)');
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.4, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        if (CoinImage.loaded && CoinImage.image) {
            const drawSize = Math.min(w, h) * 1.02;
            const drawX = cx - drawSize / 2;
            const drawY = cy - drawSize / 2;
            ctx.drawImage(CoinImage.image, drawX, drawY, drawSize, drawSize);
        } else {
            // Fallback if SVG is not ready yet.
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = this.color || '#FFDD00';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = '#c8960c';
            ctx.lineWidth = Math.max(1.5, r * 0.12);
            ctx.stroke();
        }
    }

    renderBouncer(ctx, x, y, w, h) {
        const color = this.color || '#461A0C';

        // Determine appearance direction
        const appearDir = this.bouncerMatchAppearance !== false
            ? (this.bouncerDirection || 0)
            : (this.bouncerAppearanceDirection || 0);

        // Spring animation: damped oscillation offset.
        let padOffset = 0;
        if (this._bounceAnimStart) {
            const ANIM_DURATION = 700;
            const elapsed = Date.now() - this._bounceAnimStart;
            if (elapsed < ANIM_DURATION) {
                const t = elapsed / 1000; // seconds
                const A = Math.min(h * 0.35, 14) * (this._bounceIntensity || 1);
                padOffset = -A * Math.exp(-5 * t) * Math.sin(18 * t);
            } else {
                this._bounceAnimStart = null;
                this._bounceIntensity = 1;
            }
        }

        const maxUp = h * 0.45;
        const maxDown = h * 0.25;
        padOffset = Math.max(-maxUp, Math.min(maxDown, padOffset));

        const drawOffset = padOffset * 0.3;
        const cx = x + w / 2;
        const cy = y + h / 2;

        if (BouncerImage.loaded && BouncerImage.image) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(appearDir * Math.PI / 180);
            ctx.drawImage(BouncerImage.image, -w / 2, -h / 2 + drawOffset, w, h);
            ctx.restore();
            return;
        }

        // Fallback: simple rect if SVG is not ready yet.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(appearDir * Math.PI / 180);
        ctx.fillStyle = color;
        ctx.fillRect(-w / 2, -h / 2 + drawOffset, w, h);
        ctx.restore();
    }

    renderTeleportal(ctx, x, y, w, h) {
        const centerX = x + w / 2;
        const centerY = y + h / 2;
        
        if (PortalImage.loaded && PortalImage.image) {
            const dpr = window.devicePixelRatio || 1;
            const cacheKey = `${this.color}_${w}_${h}_${dpr}`;
            if (this._portalCacheKey !== cacheKey) {
                const offscreen = document.createElement('canvas');
                offscreen.width = w * dpr;
                offscreen.height = h * dpr;
                const offCtx = offscreen.getContext('2d');
                offCtx.scale(dpr, dpr);
                offCtx.drawImage(PortalImage.image, 0, 0, w, h);
                offCtx.globalCompositeOperation = 'source-in';
                offCtx.fillStyle = this.color;
                offCtx.fillRect(0, 0, w, h);
                this._portalCache = offscreen;
                this._portalCacheKey = cacheKey;
            }
            ctx.drawImage(this._portalCache, 0, 0, this._portalCache.width, this._portalCache.height, x, y, w, h);
        } else {
            // Fallback: circular portal appearance if image not loaded
            const radius = Math.min(w, h) * 0.4;
            
            // Outer glow
            const gradient = ctx.createRadialGradient(centerX, centerY, radius * 0.3, centerX, centerY, radius);
            gradient.addColorStop(0, this.color);
            gradient.addColorStop(0.7, this.color + '80');
            gradient.addColorStop(1, this.color + '00');
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.fill();
            
            // Inner swirl effect
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < 3; i++) {
                const startAngle = (i * Math.PI * 2 / 3);
                ctx.arc(centerX, centerY, radius * 0.6, startAngle, startAngle + Math.PI * 0.6);
            }
            ctx.stroke();
            
            // Center dot
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 0.15, 0, Math.PI * 2);
            ctx.fill();
            
            // Portal border
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    /**
     * Draw saw blade with origin at object center (caller must translate to screen center first).
     */
    renderSpinner(ctx, w, h, camera) {
        // Spin only when the object has 0° editor rotation. Non-zero rotation (e.g. 10°, 20°) is static
        // at that angle — matches design refs: horizontal blade animates at 0°, tilted placements do not spin.
        let rotNorm = Math.round(this.rotation) % 360;
        if (rotNorm < 0) rotNorm += 360;
        const spinAllowedByRotation = rotNorm === 0;

        const screenLeft = this.x - (camera ? camera.x : 0);
        const screenTop = this.y - (camera ? camera.y : 0);

        // Determine if spinning should be active:
        // 1. Not in editor mode
        // 2. Editor rotation is 0° (otherwise show fixed orientation only)
        // 3. Visible on screen (viewport check using camera dimensions and zoom)
        let shouldSpin = !WorldObject._editorMode && spinAllowedByRotation;
        if (shouldSpin && camera) {
            const vpW = camera.width / camera.zoom;
            const vpH = camera.height / camera.zoom;
            if (screenLeft + w < 0 || screenLeft > vpW || screenTop + h < 0 || screenTop > vpH) {
                shouldSpin = false;
            }
        }

        let rotationAngle = 0;
        if (shouldSpin) {
            const spinSpeed = this.spinSpeed || 1;
            const periodMs = 1000 / spinSpeed;
            rotationAngle = ((Date.now() % periodMs) / periodMs) * Math.PI * 2 * (this.spinDirection || 1);
        }
        
        ctx.save();
        if (rotationAngle !== 0) ctx.rotate(rotationAngle);
        
        if (SpinnerImage.loaded && SpinnerImage.image) {
            const dpr = window.devicePixelRatio || 1;
            const cacheKey = `${this.color}_${w}_${h}_${dpr}`;
            if (this._spinnerCacheKey !== cacheKey) {
                const offscreen = document.createElement('canvas');
                offscreen.width = w * dpr;
                offscreen.height = h * dpr;
                const offCtx = offscreen.getContext('2d');
                offCtx.scale(dpr, dpr);
                offCtx.drawImage(SpinnerImage.image, 0, 0, w, h);
                offCtx.globalCompositeOperation = 'source-in';
                offCtx.fillStyle = this.color;
                offCtx.fillRect(0, 0, w, h);
                this._spinnerCache = offscreen;
                this._spinnerCacheKey = cacheKey;
            }
            ctx.drawImage(this._spinnerCache, 0, 0, this._spinnerCache.width, this._spinnerCache.height, -w / 2, -h / 2, w, h);
        } else {
            // Fallback: draw a simple saw blade shape
            const radiusX = w / 2;
            const radiusY = h / 2;
            const teeth = 8;
            
            ctx.fillStyle = this.color;
            ctx.beginPath();
            
            for (let i = 0; i < teeth; i++) {
                const angle1 = (i / teeth) * Math.PI * 2;
                const angle2 = ((i + 0.5) / teeth) * Math.PI * 2;
                
                // Outer point (tooth tip)
                const outerX = Math.cos(angle1) * radiusX;
                const outerY = Math.sin(angle1) * radiusY;
                
                // Inner point (between teeth)
                const innerX = Math.cos(angle2) * radiusX * 0.7;
                const innerY = Math.sin(angle2) * radiusY * 0.7;
                
                if (i === 0) {
                    ctx.moveTo(outerX, outerY);
                } else {
                    ctx.lineTo(outerX, outerY);
                }
                ctx.lineTo(innerX, innerY);
            }
            
            ctx.closePath();
            ctx.fill();
            
            // Center hole
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.ellipse(0, 0, radiusX * 0.15, radiusY * 0.15, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.restore();
    }

    renderText(ctx, x, y, w, h) {
        ctx.textAlign = 'left';
        ctx.fillStyle = this.color;
        const scaleFactor = w / this.width;
        
        // Apply global font size setting (from Settings)
        const globalFontScale = (typeof Settings !== 'undefined' && Settings.get('fontSize')) 
            ? Settings.get('fontSize') / 100 
            : 1;
        
        const fontSize = this.fontSize * scaleFactor * globalFontScale;
        ctx.font = `${fontSize}px "${this.font}"`;
        
        // Apply letter spacing (hSpacing is a percentage)
        const letterSpacing = (this.hSpacing / 100) * fontSize;
        
        // Split content into lines
        const lines = this.content.split('\n');
        const lineHeight = fontSize * (1 + this.vSpacing / 100);
        const totalTextHeight = lines.length * lineHeight;
        
        // Calculate starting Y based on vertical alignment
        let startY = y;
        if (this.vAlign === 'center') {
            startY = y + (h - totalTextHeight) / 2 + fontSize * 0.8;
        } else if (this.vAlign === 'bottom') {
            startY = y + h - totalTextHeight + fontSize * 0.8;
        } else {
            startY = y + fontSize * 0.8; // top alignment
        }
        
        // Render each line
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineY = startY + i * lineHeight;
            
            // Calculate X based on horizontal alignment
            let lineX = x;
            if (this.hAlign === 'center') {
                const lineWidth = this.measureTextWithSpacing(ctx, line, letterSpacing);
                lineX = x + (w - lineWidth) / 2;
            } else if (this.hAlign === 'right') {
                const lineWidth = this.measureTextWithSpacing(ctx, line, letterSpacing);
                lineX = x + w - lineWidth;
            }
            
            // Draw text with letter spacing
            if (letterSpacing === 0) {
                ctx.fillText(line, lineX, lineY);
            } else {
                this.fillTextWithSpacing(ctx, line, lineX, lineY, letterSpacing);
            }
        }
    }
    
    measureTextWithSpacing(ctx, text, spacing) {
        if (spacing === 0) {
            return ctx.measureText(text).width;
        }
        let width = 0;
        for (let i = 0; i < text.length; i++) {
            width += ctx.measureText(text[i]).width;
            if (i < text.length - 1) {
                width += spacing;
            }
        }
        return width;
    }
    
    fillTextWithSpacing(ctx, text, x, y, spacing) {
        let currentX = x;
        for (let i = 0; i < text.length; i++) {
            ctx.fillText(text[i], currentX, y);
            currentX += ctx.measureText(text[i]).width + spacing;
        }
    }

    containsPoint(px, py) {
        return px >= this.x && px < this.x + this.width &&
               py >= this.y && py < this.y + this.height;
    }

    snapToGrid() {
        if (this.appearanceType === 'coin') {
            // Coins are smaller than a tile; snap them to tile center instead of tile top-left.
            const gx = Math.round(this.x / GRID_SIZE) * GRID_SIZE;
            const gy = Math.round(this.y / GRID_SIZE) * GRID_SIZE;
            this.x = gx + (GRID_SIZE - this.width) / 2;
            this.y = gy + (GRID_SIZE - this.height) / 2;
            return;
        }
        this.x = Math.round(this.x / GRID_SIZE) * GRID_SIZE;
        this.y = Math.round(this.y / GRID_SIZE) * GRID_SIZE;
    }

    clone() {
        return new WorldObject({
            ...this,
            id: this.generateId(),
            name: this.name + ' Copy'
        });
    }

    toJSON() {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            type: this.type,
            appearanceType: this.appearanceType,
            actingType: this.actingType,
            collision: this.collision,
            collisionShape: this.collisionShape,
            collisionPoints: this.collisionShape === 'polygon' ? this.collisionPoints.map(point => point.slice()) : null,
            polygonOneWay: this.polygonOneWay,
            oneWayPlatform: this.oneWayPlatform,
            color: this.color,
            opacity: this.opacity,
            layer: this.layer,
            rotation: this.rotation,
            flipHorizontal: this.flipHorizontal,
            texture: this.texture,
            spriteSheet: this.spriteSheet ? {
                ...this.spriteSheet,
                animations: this.spriteSheet.animations.map(animation => ({ ...animation }))
            } : null,
            content: this.content,
            font: this.font,
            fontSize: this.fontSize,
            hAlign: this.hAlign,
            vAlign: this.vAlign,
            hSpacing: this.hSpacing,
            vSpacing: this.vSpacing,
            spikeTouchbox: this.spikeTouchbox,
            dropHurtOnly: this.dropHurtOnly,
            zoneName: this.zoneName,
            bouncerStrength: this.bouncerStrength,
            bouncerDirection: this.bouncerDirection,
            bouncerMatchAppearance: this.bouncerMatchAppearance,
            bouncerAppearanceDirection: this.bouncerAppearanceDirection,
            coinAmount: this.coinAmount,
            coinActivityScope: this.coinActivityScope,
            endpointRequireCoins: this.endpointRequireCoins,
            endpointRequiredCoins: this.endpointRequiredCoins,
            spinSpeed: this.spinSpeed,
            displayName: this.displayName,
            displayDescription: this.displayDescription,
            buttonVisible: this.buttonVisible,
            buttonWidth: this.buttonWidth,
            buttonHeight: this.buttonHeight,
            buttonInteraction: this.buttonInteraction,
            buttonOnlyOnce: this.buttonOnlyOnce,
            buttonColor2: this.buttonColor2,
            teleportalName: this.teleportalName,
            sendTo: this.sendTo,
            receiveFrom: this.receiveFrom,
            particleOpacity: this.particleOpacity,
            name: this.name
        };
    }
}
WorldObject._spriteSheetImageCache = new Map();
WorldObject._editorMode = true;
WorldObject.normalizeCollisionPolygon = normalizeWorldCollisionPolygon;
WorldObject.normalizeSpriteAnimations = normalizeWorldObjectSpriteAnimations;
WorldObject.DEFAULT_COLLISION_POLYGON = DEFAULT_WORLD_COLLISION_POLYGON.map(point => point.slice());

const normalizeWorldObjectStamps = (stamps, maxSpriteDataLength = WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH) => {
    if (!Array.isArray(stamps)) return [];
    const result = [];
    const ids = new Set();
    const names = new Set();
    let spriteDataLength = 0;

    for (const rawStamp of stamps.slice(0, 32)) {
        if (!rawStamp || typeof rawStamp !== 'object' || Array.isArray(rawStamp)) continue;
        const name = typeof rawStamp.name === 'string' ? rawStamp.name.trim().slice(0, 40) : '';
        if (!name || names.has(name.toLowerCase()) || !Array.isArray(rawStamp.objects)) continue;
        const objects = [];
        for (const rawObject of rawStamp.objects.slice(0, 64)) {
            if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject) ||
                !Number.isFinite(rawObject.x) || Math.abs(rawObject.x) > 10000000 ||
                !Number.isFinite(rawObject.y) || Math.abs(rawObject.y) > 10000000 ||
                !Number.isFinite(rawObject.width) || rawObject.width <= 0 || rawObject.width > 100000 ||
                !Number.isFinite(rawObject.height) || rawObject.height <= 0 || rawObject.height > 100000 ||
                (rawObject.sendTo !== undefined && !Array.isArray(rawObject.sendTo)) ||
                (rawObject.receiveFrom !== undefined && !Array.isArray(rawObject.receiveFrom))) continue;

            const connectionsAreValid = ['sendTo', 'receiveFrom'].every(key =>
                (rawObject[key] || []).every(connection =>
                    typeof connection === 'string' ||
                    (!!connection && typeof connection === 'object' && !Array.isArray(connection) &&
                        (connection.name === undefined || typeof connection.name === 'string'))));
            if (!connectionsAreValid) continue;

            try {
                const snapshot = new WorldObject({ ...rawObject, id: undefined }).toJSON();
                if (!Number.isFinite(snapshot.x) || !Number.isFinite(snapshot.y) ||
                    !Number.isFinite(snapshot.width) || !Number.isFinite(snapshot.height)) continue;
                delete snapshot.id;
                if (snapshot.spriteSheet) {
                    if (spriteDataLength + snapshot.spriteSheet.data.length > maxSpriteDataLength) {
                        snapshot.spriteSheet = null;
                    } else {
                        spriteDataLength += snapshot.spriteSheet.data.length;
                    }
                }
                objects.push(snapshot);
            } catch (_) {
                // Skip malformed imported snapshots without rejecting the rest of the map.
            }
        }
        if (objects.length === 0) continue;

        let id = typeof rawStamp.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(rawStamp.id)
            ? rawStamp.id
            : '';
        if (!id || ids.has(id)) {
            id = `stamp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
            while (ids.has(id)) id += 'x';
        }
        ids.add(id);
        names.add(name.toLowerCase());
        result.push({ id, name, objects });
    }
    return result;
};

// ============================================
// WORLD CLASS
// ============================================
class SpatialHash {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.cells = new Map();
        this._stamp = 0;
    }

    clear() {
        this.cells.clear();
    }

    _key(cx, cy) {
        return (cx * 73856093) ^ (cy * 19349663);
    }

    insert(obj) {
        const cs = this.cellSize;
        const x0 = Math.floor(obj.x / cs);
        const y0 = Math.floor(obj.y / cs);
        const x1 = Math.floor((obj.x + obj.width) / cs);
        const y1 = Math.floor((obj.y + obj.height) / cs);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const k = this._key(cx, cy);
                let cell = this.cells.get(k);
                if (!cell) { cell = []; this.cells.set(k, cell); }
                cell.push(obj);
            }
        }
    }

    build(objects) {
        this.clear();
        for (let i = 0; i < objects.length; i++) {
            this.insert(objects[i]);
        }
    }

    query(x, y, w, h) {
        const cs = this.cellSize;
        const x0 = Math.floor(x / cs);
        const y0 = Math.floor(y / cs);
        const x1 = Math.floor((x + w) / cs);
        const y1 = Math.floor((y + h) / cs);
        // Use integer stamp for dedup — avoids Set allocation and hashing overhead
        const stamp = ++this._stamp;
        const result = this._result || (this._result = []);
        result.length = 0;
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const cell = this.cells.get(this._key(cx, cy));
                if (!cell) continue;
                for (let i = 0; i < cell.length; i++) {
                    const obj = cell[i];
                    if (obj._mechanicsEnabled === false) continue;
                    if (obj._spatialStamp !== stamp) {
                        obj._spatialStamp = stamp;
                        result.push(obj);
                    }
                }
            }
        }
        return result;
    }
}

const createMechanicsSaveId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

const normalizeWorldTilemapAnimation = (animation, atlas = null) => {
    if (!animation || typeof animation !== 'object' || Array.isArray(animation)) return null;
    if (atlas && Array.isArray(animation.atlasFrames)) {
        const atlasFrames = animation.atlasFrames.slice(0, 8).filter(frame =>
            Number.isInteger(frame) && frame >= 0 && frame < atlas.columns * atlas.rows
        );
        if (new Set(atlasFrames).size < 2) return null;
        const fps = typeof animation.fps === 'number' && Number.isFinite(animation.fps)
            ? Math.max(1, Math.min(12, Math.round(animation.fps))) : 4;
        return { atlasFrames, fps };
    }
    if (!Array.isArray(animation.textures)) return null;
    const textures = animation.textures.slice(0, 8).filter(texture =>
        typeof texture === 'string' && (texture === 'solid' || Object.hasOwn(BlockTextures, texture))
    );
    if (textures.length < 2 || new Set(textures).size < 2) return null;
    const fps = typeof animation.fps === 'number' && Number.isFinite(animation.fps)
        ? Math.max(1, Math.min(12, Math.round(animation.fps))) : 4;
    return { textures, fps };
};

const normalizeWorldTilemapAtlas = atlas => {
    if (!atlas || typeof atlas !== 'object' || Array.isArray(atlas)) return null;
    const data = typeof atlas.data === 'string' ? atlas.data : '';
    const frameWidth = Math.floor(atlas.frameWidth);
    const frameHeight = Math.floor(atlas.frameHeight);
    const columns = Math.floor(atlas.columns);
    const rows = Math.floor(atlas.rows);
    if (data.length > WORLD_TILEMAP_ATLAS_MAX_DATA_URL_LENGTH ||
        !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data) ||
        !Number.isInteger(frameWidth) || frameWidth < 1 || frameWidth > 512 ||
        !Number.isInteger(frameHeight) || frameHeight < 1 || frameHeight > 512 ||
        !Number.isInteger(columns) || columns < 1 || columns > 128 ||
        !Number.isInteger(rows) || rows < 1 || rows > 128 || columns * rows > 4096 ||
        frameWidth * columns * frameHeight * rows > WORLD_TILEMAP_ATLAS_MAX_PIXELS) return null;
    return { data, frameWidth, frameHeight, columns, rows };
};

const normalizeWorldTilemaps = (tilemaps, layerDefinitions, maxAtlasDataLength = WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH) => {
    if (!Array.isArray(tilemaps)) return [];
    const normalized = [];
    const usedLayers = new Set();
    const usedIds = new Set();
    let totalCells = 0;
    let totalAnimatedCells = 0;
    let totalAtlasDataLength = 0;
    let totalAtlasPixels = 0;
    const validLayers = new Set((Array.isArray(layerDefinitions) ? layerDefinitions : [])
        .map(layer => normalizeWorldLayerDepth(layer?.depth)).filter(depth => depth !== null));

    for (const rawTilemap of tilemaps) {
        if (normalized.length >= WORLD_TILEMAP_MAX_COUNT || totalCells >= WORLD_TILEMAP_MAX_CELLS) break;
        if (!rawTilemap || typeof rawTilemap !== 'object' || Array.isArray(rawTilemap)) continue;
        const layer = normalizeWorldLayerDepth(rawTilemap.layer);
        if (layer === null || !validLayers.has(layer) || usedLayers.has(layer)) continue;
        const rawId = typeof rawTilemap.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(rawTilemap.id)
            ? rawTilemap.id : `tilemap-${layer}`;
        let id = rawId;
        let idSuffix = 1;
        while (usedIds.has(id)) id = `${rawId}-${idSuffix++}`;
        const name = typeof rawTilemap.name === 'string' && rawTilemap.name.trim()
            ? rawTilemap.name.trim().slice(0, 40) : `Tilemap ${layer}`;
        let atlas = normalizeWorldTilemapAtlas(rawTilemap.atlas);
        if (atlas && totalAtlasDataLength + atlas.data.length > maxAtlasDataLength) atlas = null;
        const atlasPixels = atlas ? atlas.frameWidth * atlas.columns * atlas.frameHeight * atlas.rows : 0;
        if (atlas && totalAtlasPixels + atlasPixels > WORLD_TILEMAP_ATLAS_TOTAL_MAX_PIXELS) atlas = null;
        if (atlas) totalAtlasDataLength += atlas.data.length;
        if (atlas) totalAtlasPixels += atlasPixels;
        const cellsByPosition = new Map();
        if (Array.isArray(rawTilemap.cells)) {
            let rawCellCount = 0;
            for (const rawCell of rawTilemap.cells) {
                if (totalCells >= WORLD_TILEMAP_MAX_CELLS || rawCellCount++ >= WORLD_TILEMAP_MAX_CELLS) break;
                if (!rawCell || typeof rawCell !== 'object') continue;
                const x = rawCell.x;
                const y = rawCell.y;
                if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
                    x % GRID_SIZE !== 0 || y % GRID_SIZE !== 0 ||
                    Math.abs(x) > WORLD_TILEMAP_MAX_POSITION || Math.abs(y) > WORLD_TILEMAP_MAX_POSITION) continue;
                const color = typeof rawCell.color === 'string' && /^#[0-9a-f]{6}$/i.test(rawCell.color)
                    ? rawCell.color : '#787878';
                const texture = typeof rawCell.texture === 'string' &&
                    (rawCell.texture === 'solid' || Object.hasOwn(BlockTextures, rawCell.texture)) ? rawCell.texture : 'solid';
                const numericOpacity = rawCell.opacity;
                const opacity = typeof numericOpacity === 'number' && Number.isFinite(numericOpacity)
                    ? Math.max(0, Math.min(1, numericOpacity)) : 1;
                const key = `${x},${y}`;
                const collisionType = WORLD_TILEMAP_CELL_BEHAVIORS.has(rawCell.collisionType)
                    ? rawCell.collisionType
                    : (rawCell.collision === false ? 'decorative'
                        : rawCell.oneWayPlatform === true ? 'oneWay'
                            : rawCell.actingType === 'spike' ? 'hazard' : 'solid');
                const collisionPoints = rawCell.collisionShape === 'polygon' &&
                    !['rampUpRight', 'rampUpLeft', 'hazard', 'decorative'].includes(collisionType)
                    ? normalizeWorldCollisionPolygon(rawCell.collisionPoints) : null;
                const previousCell = cellsByPosition.get(key);
                const atlasFrame = atlas && Number.isInteger(rawCell.atlasFrame) &&
                    rawCell.atlasFrame >= 0 && rawCell.atlasFrame < atlas.columns * atlas.rows
                    ? rawCell.atlasFrame : null;
                let animation = normalizeWorldTilemapAnimation(rawCell.animation, atlas);
                if (animation && !previousCell?.animation && totalAnimatedCells >= WORLD_TILEMAP_MAX_ANIMATED_CELLS) {
                    animation = null;
                }
                const cell = {
                    x, y, color, texture, opacity,
                    collisionType,
                    collision: collisionType !== 'decorative',
                    oneWayPlatform: collisionType === 'oneWay' && !collisionPoints,
                    ...(collisionPoints ? {
                        collisionShape: 'polygon', collisionPoints,
                        polygonOneWay: collisionType === 'oneWay' || rawCell.polygonOneWay !== false
                    } : {}),
                    ...(atlasFrame !== null ? { atlasFrame } : {}),
                    ...(animation ? { animation } : {})
                };
                if (!previousCell) totalCells++;
                if (!previousCell?.animation && animation) totalAnimatedCells++;
                else if (previousCell?.animation && !animation) totalAnimatedCells--;
                cellsByPosition.set(key, cell);
            }
        }
        normalized.push({ id, name, layer, cells: Array.from(cellsByPosition.values()), ...(atlas ? { atlas } : {}) });
        usedLayers.add(layer);
        usedIds.add(id);
    }
    return normalized;
};

class World {
    constructor() {
        this.objects = [];
        this.tilemaps = [];
        this._tilemapCellCount = 0;
        this._tilemapCollisionCellCount = 0;
        this._tilemapAnimatedCellCount = 0;
        this._tilemapRenderCells = null;
        this._tilemapRenderDirty = true;
        this.objectStamps = [];
        this.playerSpriteSheet = null;
        this.layerDefinitions = DEFAULT_WORLD_LAYER_DEFINITIONS.map(layer => ({ ...layer }));
        this.spatialHash = new SpatialHash(128);
        this._spatialDirty = true;
        // Tile cache for static object rendering (play/test mode)
        this._tileSize = 512;
        this._tiles = new Map();
        this._tileCacheChunks = new Map();
        this._tileCacheReady = false;
        // Editor merged block cache
        this._editorMergedDirty = true;
        this._editorMergedCache = null;
        // Teleportal list cache
        this._teleportalListDirty = true;
        this._teleportalList = [];
        // Zone/button list cache
        this._zoneListDirty = true;
        this._zoneList = [];
        this.background = 'sky'; // sky, galaxy, custom
        
        // Music settings
        this.music = {
            type: 'none', // 'none', 'chill', 'adventure', 'retro', 'epic', 'peaceful', 'custom'
            customData: null, // base64 audio data for custom music
            customName: null, // filename of custom music
            volume: 50, // 0-100
            loop: true
        };
        
        // Custom background settings
        this.customBackground = {
            enabled: false,
            type: null, // 'image', 'gif', 'video'
            data: null, // base64 or URL
            playMode: 'loop', // 'once', 'loop', 'bounce'
            loopCount: -1, // -1 = infinite, otherwise number of times
            endType: 'freeze', // 'freeze', 'replace' (for play once)
            endBackground: null, // Another customBackground object for replacement
            sameAcrossScreens: false, // Sync playback across all players
            reverse: false // Play backwards
        };
        this.defaultBlockColor = '#787878';
        this.defaultSpikeColor = '#c45a3f';
        this.defaultTextColor = '#000000';
        this.defaultPortalColor = '#9b59b6';
        this.defaultBouncerColor = '#461A0C';
        this.showCoinCounter = true;
        
        // Cloud color settings (null = auto based on background)
        this.cloudColorSky = '#ffffff';      // White for sky background
        this.cloudColorGalaxy = '#9382a8';   // Grayish purple for galaxy background

        // Checkpoint color settings
        this.checkpointDefaultColor = '#808080'; // Gray - default state
        this.checkpointActiveColor = '#4CAF50';  // Green - current checkpoint
        this.checkpointTouchedColor = '#2196F3'; // Blue - already touched
        
        this.maxJumps = 1;
        this.infiniteJumps = false;
        this.additionalAirjump = false;
        this.collideWithEachOther = true;
        this.spawnPoint = null;
        this.checkpoints = [];
        this.endpoint = null;
        this.mapName = 'Untitled Map';
        this.mechanicsSaveId = createMechanicsSaveId();
        this.persistCheckpoints = false;
        this.dieLineY = 1000; // Y position below which players die (void death)
        
        // Physics settings
        this.playerSpeed = DEFAULT_MOVE_SPEED; // Horizontal movement speed (default: 5)
        this.horizontalAcceleration = DEFAULT_HORIZONTAL_ACCELERATION; // 0 preserves instant horizontal movement
        this.airControl = DEFAULT_AIR_CONTROL; // Multiplier applied to acceleration while airborne
        this.terminalFallSpeed = null; // null preserves the legacy gravity-scaled limit
        this.jumpForce = DEFAULT_JUMP_FORCE;   // Jump force/height (default: -14, negative = upward)
        this.gravity = DEFAULT_GRAVITY;         // Gravity strength (default: 0.8)
        this.cameraLerpX = CAMERA_LERP_X;       // Horizontal camera smoothness (default: 0.12)
        this.cameraLerpY = CAMERA_LERP_Y;       // Vertical camera smoothness (default: 0.12)
        this.cameraFollowMode = 'both';
        this.cameraBounds = { enabled: false, x: 0, y: 0, width: 2000, height: 1200 };
        
        // Spike touchbox mode
        // 'full' - Entire spike damages player
        // 'normal' - Flat part = ground, rest = damage (default)
        // 'tip' - Only spike tip damages, flat = ground, middle = nothing
        // 'ground' - Entire spike acts as ground (no damage)
        // 'flag' - Only flat part acts as ground, rest = air
        // 'air' - No interaction at all
        // 'all-spike' - No ground: both danger zone AND flat base damage the player
        this.spikeTouchbox = 'normal';
        
        // Drop Hurt Only - spikes only damage when player moves toward the spike tip
        this.dropHurtOnly = false;
        
        // Stored data type for .pkrn export
        // 'json' - Human-readable, larger file size
        // 'dat' - Binary format, smaller file size
        this.storedDataType = 'json';
        
        // Plugins system - configs are dynamically added when plugins are enabled
        this.plugins = {
            enabled: [] // Array of enabled plugin IDs
            // Plugin configs are added dynamically: this.plugins[pluginId] = {...}
        };
        
        // Code plugin data (triggers and events)
        this.codeData = {
            triggers: [],
            events: [],
            variables: []
        };
    }

    markSpatialDirty() {
        this._spatialDirty = true;
    }

    markEditorDirty() {
        this._editorMergedDirty = true;
        this._teleportalListDirty = true;
        this._zoneListDirty = true;
    }

    _rebuildTilemapCellLookups() {
        this._tilemapCellCount = 0;
        this._tilemapCollisionCellCount = 0;
        this._tilemapAnimatedCellCount = 0;
        for (const tilemap of this.tilemaps) {
            tilemap._cellLookup = new Map();
            tilemap._colliderCache = new Map();
            for (const cell of tilemap.cells) {
                tilemap._cellLookup.set(`${cell.x},${cell.y}`, cell);
                this._tilemapCellCount++;
                if (cell.collision) this._tilemapCollisionCellCount++;
                if (cell.animation) this._tilemapAnimatedCellCount++;
            }
        }
        this._tilemapRenderCells = null;
        this._tilemapRenderDirty = true;
    }

    _getTilemapForLayer(layer, create = false) {
        const depth = normalizeWorldLayerDepth(layer);
        if (depth === null) return null;
        let tilemap = this.tilemaps.find(item => item.layer === depth);
        if (!tilemap && create && this.tilemaps.length < WORLD_TILEMAP_MAX_COUNT) {
            const definition = this.getLayerDefinition(depth);
            tilemap = {
                id: `tilemap-${depth}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
                name: `${definition?.name || 'Layer'} Tilemap`.slice(0, 40),
                layer: depth,
                cells: [],
                _cellLookup: new Map(),
                _colliderCache: new Map()
            };
            this.tilemaps.push(tilemap);
        }
        return tilemap || null;
    }

    setTilemapCell(x, y, config = {}, layer = 1) {
        const cellX = Math.round(x / GRID_SIZE) * GRID_SIZE;
        const cellY = Math.round(y / GRID_SIZE) * GRID_SIZE;
        if (!Number.isSafeInteger(cellX) || !Number.isSafeInteger(cellY) ||
            Math.abs(cellX) > WORLD_TILEMAP_MAX_POSITION || Math.abs(cellY) > WORLD_TILEMAP_MAX_POSITION) return false;
        const color = typeof config.color === 'string' && /^#[0-9a-f]{6}$/i.test(config.color) ? config.color : '#787878';
        const collisionType = WORLD_TILEMAP_CELL_BEHAVIORS.has(config.collisionType)
            ? config.collisionType
            : (config.collision === false ? 'decorative'
                : config.oneWayPlatform === true ? 'oneWay'
                    : config.actingType === 'spike' ? 'hazard' : 'solid');
        const collisionPoints = config.collisionShape === 'polygon' &&
            !['rampUpRight', 'rampUpLeft', 'hazard', 'decorative'].includes(collisionType)
            ? normalizeWorldCollisionPolygon(config.collisionPoints) : null;
        const layerDefinition = this.getLayerDefinition(layer);
        if (collisionType !== 'decorative' && layerDefinition &&
            (layerDefinition.parallaxX !== 1 || layerDefinition.parallaxY !== 1)) return false;
        const tilemap = this._getTilemapForLayer(layer, true);
        if (!tilemap) return false;
        const key = `${cellX},${cellY}`;
        const previous = tilemap._cellLookup.get(key);
        if (!previous && this._tilemapCellCount >= WORLD_TILEMAP_MAX_CELLS) return false;
        const animation = normalizeWorldTilemapAnimation(config.animation, tilemap.atlas);
        if (animation && !previous?.animation && this._tilemapAnimatedCellCount >= WORLD_TILEMAP_MAX_ANIMATED_CELLS) return false;
        const cell = {
            x: cellX,
            y: cellY,
            color,
            texture: typeof config.texture === 'string' &&
                (config.texture === 'solid' || Object.hasOwn(BlockTextures, config.texture)) ? config.texture : 'solid',
            opacity: Number.isFinite(config.opacity) ? Math.max(0, Math.min(1, config.opacity)) : 1,
            collisionType,
            collision: collisionType !== 'decorative',
            oneWayPlatform: collisionType === 'oneWay' && !collisionPoints,
            ...(collisionPoints ? {
                collisionShape: 'polygon',
                collisionPoints,
                polygonOneWay: collisionType === 'oneWay' || config.polygonOneWay !== false
            } : {}),
            ...(Number.isInteger(config.atlasFrame) && config.atlasFrame >= 0 &&
                config.atlasFrame < ((tilemap.atlas?.columns || 0) * (tilemap.atlas?.rows || 0))
                ? { atlasFrame: config.atlasFrame } : {}),
            ...(animation ? { animation } : {})
        };
        if (previous && previous.color === cell.color && previous.texture === cell.texture &&
            previous.opacity === cell.opacity && previous.collision === cell.collision &&
            previous.oneWayPlatform === cell.oneWayPlatform && previous.collisionType === cell.collisionType &&
            previous.collisionShape === cell.collisionShape &&
            previous.polygonOneWay === cell.polygonOneWay &&
            JSON.stringify(previous.collisionPoints || null) === JSON.stringify(cell.collisionPoints || null) &&
            previous.atlasFrame === cell.atlasFrame &&
            JSON.stringify(previous.animation || null) === JSON.stringify(animation)) return false;
        if (previous) {
            this._tilemapCollisionCellCount += Number(cell.collision) - Number(previous.collision);
            this._tilemapAnimatedCellCount += Number(Boolean(animation)) - Number(Boolean(previous.animation));
            Object.assign(previous, cell);
            if (!Object.hasOwn(cell, 'atlasFrame')) delete previous.atlasFrame;
            if (!Object.hasOwn(cell, 'collisionPoints')) {
                delete previous.collisionShape;
                delete previous.collisionPoints;
                delete previous.polygonOneWay;
            }
            if (!animation) delete previous.animation;
        } else {
            tilemap.cells.push(cell);
            tilemap._cellLookup.set(key, cell);
            this._tilemapCellCount++;
            if (cell.collision) this._tilemapCollisionCellCount++;
            if (animation) this._tilemapAnimatedCellCount++;
        }
        tilemap._colliderCache.delete(key);
        this._tilemapRenderDirty = true;
        this._editorMergedDirty = true;
        this.invalidateTileCache();
        return true;
    }

    setTilemapAtlas(atlasData, layer = 1) {
        const normalizedAtlas = normalizeWorldTilemapAtlas(atlasData);
        if (!normalizedAtlas) return false;
        const depth = normalizeWorldLayerDepth(layer);
        if (depth === null || !this.getLayerDefinition(depth)) return false;
        let tilemap = this.tilemaps.find(item => item.layer === depth) || null;
        if (!tilemap && this.tilemaps.length >= WORLD_TILEMAP_MAX_COUNT) return false;
        const currentBytes = this.getSpriteSheetDataLength() - (tilemap?.atlas?.data?.length || 0);
        if (currentBytes + normalizedAtlas.data.length > WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH) return false;
        const currentPixels = this.tilemaps.reduce((total, item) => total +
            (item.atlas ? item.atlas.frameWidth * item.atlas.columns * item.atlas.frameHeight * item.atlas.rows : 0), 0) -
            (tilemap?.atlas ? tilemap.atlas.frameWidth * tilemap.atlas.columns * tilemap.atlas.frameHeight * tilemap.atlas.rows : 0);
        if (currentPixels + normalizedAtlas.frameWidth * normalizedAtlas.columns * normalizedAtlas.frameHeight * normalizedAtlas.rows >
            WORLD_TILEMAP_ATLAS_TOTAL_MAX_PIXELS) return false;
        if (tilemap && JSON.stringify(tilemap.atlas || null) === JSON.stringify(normalizedAtlas)) return true;
        if (!tilemap) tilemap = this._getTilemapForLayer(depth, true);
        if (!tilemap) return false;
        tilemap.atlas = normalizedAtlas;
        for (const cell of tilemap.cells) {
            if (cell.animation?.atlasFrames) {
                const animation = normalizeWorldTilemapAnimation(cell.animation, normalizedAtlas);
                if (animation) cell.animation = animation;
                else {
                    delete cell.animation;
                    this._tilemapAnimatedCellCount = Math.max(0, this._tilemapAnimatedCellCount - 1);
                }
            }
            if (Number.isInteger(cell.atlasFrame) && cell.atlasFrame >= normalizedAtlas.columns * normalizedAtlas.rows) {
                delete cell.atlasFrame;
            }
        }
        this._tilemapRenderDirty = true;
        this._editorMergedDirty = true;
        this.invalidateTileCache();
        return true;
    }

    clearTilemapAtlas(layer = 1) {
        const tilemap = this.tilemaps.find(item => item.layer === normalizeWorldLayerDepth(layer));
        if (!tilemap?.atlas) return false;
        delete tilemap.atlas;
        for (const cell of tilemap.cells) {
            delete cell.atlasFrame;
            if (cell.animation?.atlasFrames) {
                delete cell.animation;
                this._tilemapAnimatedCellCount = Math.max(0, this._tilemapAnimatedCellCount - 1);
            }
        }
        this._tilemapRenderDirty = true;
        this._editorMergedDirty = true;
        this.invalidateTileCache();
        return true;
    }

    hasTilemapCellsInArea(x, y, width, height) {
        if (!(width > 0 && height > 0)) return false;
        const firstX = Math.floor(x / GRID_SIZE) * GRID_SIZE;
        const lastX = (Math.ceil((x + width) / GRID_SIZE) - 1) * GRID_SIZE;
        const firstY = Math.floor(y / GRID_SIZE) * GRID_SIZE;
        const lastY = (Math.ceil((y + height) / GRID_SIZE) - 1) * GRID_SIZE;
        for (let cy = firstY; cy <= lastY; cy += GRID_SIZE) {
            for (let cx = firstX; cx <= lastX; cx += GRID_SIZE) {
                for (const tilemap of this.tilemaps) {
                    if (tilemap._cellLookup.has(`${cx},${cy}`)) return true;
                }
            }
        }
        return false;
    }

    removeTilemapCellsInArea(x, y, width, height) {
        if (!(width > 0 && height > 0)) return 0;
        const firstX = Math.floor(x / GRID_SIZE) * GRID_SIZE;
        const lastX = (Math.ceil((x + width) / GRID_SIZE) - 1) * GRID_SIZE;
        const firstY = Math.floor(y / GRID_SIZE) * GRID_SIZE;
        const lastY = (Math.ceil((y + height) / GRID_SIZE) - 1) * GRID_SIZE;
        let removed = 0;
        const keys = new Set();
        for (let cy = firstY; cy <= lastY; cy += GRID_SIZE) {
            for (let cx = firstX; cx <= lastX; cx += GRID_SIZE) {
                keys.add(`${cx},${cy}`);
            }
        }
        for (const tilemap of this.tilemaps) {
            const nextCells = [];
            for (const cell of tilemap.cells) {
                const key = `${cell.x},${cell.y}`;
                if (!keys.has(key)) {
                    nextCells.push(cell);
                    continue;
                }
                tilemap._cellLookup.delete(key);
                tilemap._colliderCache.delete(key);
                this._tilemapCellCount--;
                if (cell.collision) this._tilemapCollisionCellCount--;
                if (cell.animation) this._tilemapAnimatedCellCount--;
                removed++;
            }
            tilemap.cells = nextCells;
        }
        if (removed) {
            this._tilemapRenderDirty = true;
            this._editorMergedDirty = true;
            this.invalidateTileCache();
        }
        return removed;
    }

    _getTilemapCollider(tilemap, cell) {
        const key = `${cell.x},${cell.y}`;
        let collider = tilemap._colliderCache.get(key);
        const config = {
            id: `tile-${tilemap.id}-${cell.x}-${cell.y}`,
            x: cell.x,
            y: cell.y,
            width: GRID_SIZE,
            height: GRID_SIZE,
            type: 'block',
            appearanceType: cell.collisionType === 'hazard' ? 'spike' : 'ground',
            actingType: cell.collisionType === 'hazard' ? 'spike' : 'ground',
            collision: true,
            collisionShape: cell.collisionType === 'rampUpRight' ? 'slopeUpRight'
                : cell.collisionType === 'rampUpLeft' ? 'slopeUpLeft'
                    : cell.collisionShape === 'polygon' ? 'polygon' : 'box',
            collisionPoints: cell.collisionShape === 'polygon' ? cell.collisionPoints : undefined,
            polygonOneWay: cell.collisionShape === 'polygon' ? cell.polygonOneWay !== false : false,
            oneWayPlatform: cell.collisionType === 'oneWay' && cell.collisionShape !== 'polygon',
            spikeTouchbox: cell.collisionType === 'hazard' ? 'full' : null,
            color: cell.color,
            texture: cell.texture,
            opacity: cell.opacity,
            layer: tilemap.layer,
            name: tilemap.name
        };
        if (!collider) {
            collider = new WorldObject(config);
            collider._tilemapCell = true;
            collider._tilemapId = tilemap.id;
            tilemap._colliderCache.set(key, collider);
        } else {
            Object.assign(collider, config);
        }
        collider._tilemapCollisionType = cell.collisionType;
        return collider;
    }

    getTilemapColliderById(id) {
        if (typeof id !== 'string') return null;
        for (const tilemap of this.tilemaps) {
            const prefix = `tile-${tilemap.id}-`;
            if (!id.startsWith(prefix)) continue;
            const match = id.slice(prefix.length).match(/^(-?\d+)-(-?\d+)$/);
            if (!match) continue;
            const x = Number(match[1]);
            const y = Number(match[2]);
            const cell = tilemap._cellLookup.get(`${x},${y}`);
            if (cell?.collision && `tile-${tilemap.id}-${x}-${y}` === id) {
                return this._getTilemapCollider(tilemap, cell);
            }
        }
        return null;
    }

    _renderTilemapCell(ctx, camera, cell, atlas = null) {
        const x = cell.x - camera.x;
        const y = cell.y - camera.y;
        const animationFrames = cell.animation?.textures || cell.animation?.atlasFrames;
        const frame = cell.animation
            ? Math.floor(Date.now() * cell.animation.fps / 1000) % animationFrames.length
            : 0;
        const texture = cell.animation?.textures?.[frame] || cell.texture;
        const atlasFrame = cell.animation?.atlasFrames?.[frame] ?? cell.atlasFrame;
        let atlasDrawn = false;
        if (atlas && Number.isInteger(atlasFrame) && atlasFrame >= 0 &&
            atlasFrame < atlas.columns * atlas.rows) {
            const atlasImageCache = this._tilemapAtlasImages || (this._tilemapAtlasImages = new Map());
            let image = atlasImageCache.get(atlas.data);
            if (!image) {
                image = new Image();
                image.onload = () => {
                    this._tilemapRenderDirty = true;
                    this.invalidateTileCache();
                };
                image.src = atlas.data;
                atlasImageCache.set(atlas.data, image);
                if (atlasImageCache.size > 24) {
                    atlasImageCache.delete(atlasImageCache.keys().next().value);
                }
            }
            if (image.complete && image.naturalWidth > 0) {
                const sourceX = (atlasFrame % atlas.columns) * atlas.frameWidth;
                const sourceY = Math.floor(atlasFrame / atlas.columns) * atlas.frameHeight;
                if (sourceX + atlas.frameWidth <= image.naturalWidth && sourceY + atlas.frameHeight <= image.naturalHeight) {
                    ctx.save();
                    ctx.globalAlpha = cell.opacity;
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(image, sourceX, sourceY, atlas.frameWidth, atlas.frameHeight, x, y, GRID_SIZE, GRID_SIZE);
                    ctx.restore();
                    atlasDrawn = true;
                }
            }
        }
        if (!atlasDrawn) this._renderMergedBlock(ctx, x, y, GRID_SIZE, GRID_SIZE, cell.color, texture, cell.opacity);
        if (cell.collisionType === 'oneWay') {
            ctx.save();
            ctx.globalAlpha = cell.opacity;
            ctx.fillStyle = 'rgba(255, 224, 130, 0.95)';
            ctx.fillRect(x, y, GRID_SIZE, Math.min(3, GRID_SIZE));
            ctx.restore();
        } else if (cell.collisionType === 'rampUpRight' || cell.collisionType === 'rampUpLeft') {
            ctx.save();
            ctx.globalAlpha = cell.opacity;
            ctx.strokeStyle = 'rgba(255, 224, 130, 0.95)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            if (cell.collisionType === 'rampUpRight') {
                ctx.moveTo(x + 1, y + GRID_SIZE - 1);
                ctx.lineTo(x + GRID_SIZE - 1, y + 1);
            } else {
                ctx.moveTo(x + 1, y + 1);
                ctx.lineTo(x + GRID_SIZE - 1, y + GRID_SIZE - 1);
            }
            ctx.stroke();
            ctx.restore();
        } else if (cell.collisionType === 'hazard') {
            ctx.save();
            ctx.globalAlpha = cell.opacity;
            ctx.fillStyle = 'rgba(120, 20, 20, 0.88)';
            ctx.strokeStyle = '#ffe4e6';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x + GRID_SIZE / 2, y + 5);
            ctx.lineTo(x + GRID_SIZE - 5, y + GRID_SIZE - 5);
            ctx.lineTo(x + 5, y + GRID_SIZE - 5);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#fff7f7';
            ctx.font = 'bold 15px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('!', x + GRID_SIZE / 2, y + GRID_SIZE / 2 + 4);
            ctx.restore();
        }
    }

    _getTilemapRenderCells() {
        if (!this._tilemapRenderDirty && this._tilemapRenderCells) return this._tilemapRenderCells;
        this._tilemapRenderDirty = false;
        this._tilemapRenderCells = [];
        for (const tilemap of this.tilemaps) {
            for (const cell of tilemap.cells) {
                const renderCell = {
                    x: cell.x, y: cell.y, width: GRID_SIZE, height: GRID_SIZE,
                    type: 'block', appearanceType: 'ground', collisionShape: 'box',
                    rotation: 0, flipHorizontal: false,
                    color: cell.color, texture: cell.texture, opacity: cell.opacity,
                    layer: tilemap.layer
                };
                if (Number.isInteger(cell.atlasFrame) && tilemap.atlas) {
                    renderCell.render = (ctx, camera) => this._renderTilemapCell(ctx, camera, cell, tilemap.atlas);
                }
                if (cell.animation) {
                    renderCell._tilemapAnimated = true;
                    renderCell.render = (ctx, camera) => this._renderTilemapCell(ctx, camera, cell, tilemap.atlas);
                } else if (renderCell.render) {
                    // Atlas cells render into the static tile cache; the draw function
                    // is kept on the cell to avoid greedy-merging across atlas frames.
                } else if (['oneWay', 'rampUpRight', 'rampUpLeft', 'hazard'].includes(cell.collisionType)) {
                    renderCell.oneWayPlatform = true;
                    renderCell.render = (ctx, camera) => this._renderTilemapCell(ctx, camera, cell);
                }
                this._tilemapRenderCells.push(renderCell);
            }
        }
        return this._tilemapRenderCells;
    }

    getLayerDefinition(depth) {
        const normalizedDepth = normalizeWorldLayerDepth(depth);
        return this.layerDefinitions.find(layer => layer.depth === normalizedDepth) || null;
    }

    getLayerCamera(camera, depth) {
        const layer = this.getLayerDefinition(depth);
        if (!layer || (layer.parallaxX === 1 && layer.parallaxY === 1)) return camera;
        return {
            ...camera,
            x: camera.x * normalizeWorldLayerParallax(layer.parallaxX),
            y: camera.y * normalizeWorldLayerParallax(layer.parallaxY)
        };
    }

    layerHasColliders(depth) {
        if (this.objects.some(object => object.layer === depth && object.collision !== false &&
            object.appearanceType !== 'zone' && object.appearanceType !== 'button')) return true;
        return this.tilemaps.some(tilemap => tilemap.layer === depth && tilemap.cells.some(cell => cell.collision));
    }

    getRenderLayerDepths() {
        const isVisible = layer => this._mechanicsLayerVisibility?.get(layer.id) !== false;
        return {
            behindPlayer: this.layerDefinitions.filter(layer => isVisible(layer) && layer.depth <= 1).map(layer => layer.depth),
            abovePlayer: this.layerDefinitions.filter(layer => isVisible(layer) && layer.depth >= 2).map(layer => layer.depth)
        };
    }

    addDrawLayer(name, side) {
        const cleanName = typeof name === 'string' ? name.trim().slice(0, 40) : '';
        if (!cleanName) throw new Error('Enter a layer name');
        if (!['behind', 'above'].includes(side)) throw new Error('Choose whether the layer goes behind or above the player');
        if (this.layerDefinitions.length >= WORLD_LAYER_MAX_COUNT) throw new Error(`A map can have at most ${WORLD_LAYER_MAX_COUNT} draw layers`);
        if (this.layerDefinitions.some(layer => layer.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
            throw new Error('Layer names must be unique');
        }

        const customLayers = this.layerDefinitions.filter(layer => !layer.builtin);
        const depth = side === 'behind'
            ? Math.min(0, ...customLayers.filter(layer => layer.depth < 0).map(layer => layer.depth)) - 1
            : Math.max(2, ...customLayers.filter(layer => layer.depth > 2).map(layer => layer.depth)) + 1;
        if (depth < WORLD_LAYER_MIN_DEPTH || depth > WORLD_LAYER_MAX_DEPTH) throw new Error('No more draw depths are available on that side of the player');

        const layer = {
            id: `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
            name: cleanName,
            depth,
            builtin: false,
            parallaxX: 1,
            parallaxY: 1
        };
        this.layerDefinitions.push(layer);
        this.layerDefinitions.sort((a, b) => a.depth - b.depth);
        this._editorMergedDirty = true;
        this._tileCacheReady = false;
        return layer;
    }

    setDrawLayerParallax(layerId, parallaxX, parallaxY) {
        const layer = this.layerDefinitions.find(item => item.id === layerId && !item.builtin);
        if (!layer) throw new Error('Choose a custom draw layer');
        const x = parallaxX;
        const y = parallaxY;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 2 || y < 0 || y > 2) {
            throw new Error('Parallax values must be between 0 and 2');
        }
        if ((x !== 1 || y !== 1) && this.layerHasColliders(layer.depth)) {
            throw new Error('Move collidable objects and tilemap cells to another layer before enabling parallax');
        }
        layer.parallaxX = x;
        layer.parallaxY = y;
        return layer;
    }

    renameDrawLayer(layerId, name) {
        const layer = this.layerDefinitions.find(item => item.id === layerId && !item.builtin);
        const cleanName = typeof name === 'string' ? name.trim().slice(0, 40) : '';
        if (!layer) throw new Error('Built-in draw layers cannot be renamed');
        if (!cleanName) throw new Error('Enter a layer name');
        if (this.layerDefinitions.some(item => item.id !== layerId && item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
            throw new Error('Layer names must be unique');
        }
        layer.name = cleanName;
        return layer;
    }

    removeDrawLayer(layerId) {
        const index = this.layerDefinitions.findIndex(item => item.id === layerId && !item.builtin);
        if (index < 0) return false;
        const [layer] = this.layerDefinitions.splice(index, 1);
        const fallbackDepth = layer.depth <= 1 ? 1 : 2;
        for (const object of this.objects) {
            if (object.layer === layer.depth) object.layer = fallbackDepth;
        }
        const movedTilemap = this.tilemaps.find(tilemap => tilemap.layer === layer.depth);
        if (movedTilemap) {
            const fallbackTilemap = this.tilemaps.find(tilemap => tilemap.layer === fallbackDepth);
            if (fallbackTilemap && fallbackTilemap !== movedTilemap) {
                for (const cell of movedTilemap.cells) {
                    const key = `${cell.x},${cell.y}`;
                    const existing = fallbackTilemap._cellLookup.get(key);
                    if (existing) Object.assign(existing, cell);
                    else {
                        const copy = { ...cell };
                        fallbackTilemap.cells.push(copy);
                        fallbackTilemap._cellLookup.set(key, copy);
                    }
                }
                this.tilemaps = this.tilemaps.filter(tilemap => tilemap !== movedTilemap);
            } else {
                movedTilemap.layer = fallbackDepth;
            }
            this._rebuildTilemapCellLookups();
            this._tilemapRenderDirty = true;
        }
        this._editorMergedDirty = true;
        this._tileCacheReady = false;
        return true;
    }

    getTeleportals() {
        if (this._teleportalListDirty) {
            this._teleportalList.length = 0;
            for (let i = 0; i < this.objects.length; i++) {
                if (this.objects[i].type === 'teleportal' && this.objects[i]._mechanicsEnabled !== false) {
                    this._teleportalList.push(this.objects[i]);
                }
            }
            this._teleportalListDirty = false;
        }
        return this._teleportalList;
    }

    getZones() {
        if (this._zoneListDirty) {
            this._zoneList.length = 0;
            for (let i = 0; i < this.objects.length; i++) {
                const at = this.objects[i].appearanceType;
                if ((at === 'zone' || at === 'button') && this.objects[i]._mechanicsEnabled !== false) {
                    this._zoneList.push(this.objects[i]);
                }
            }
            this._zoneListDirty = false;
        }
        return this._zoneList;
    }

    rebuildSpatialHash() {
        if (!this._spatialDirty) return;
        this._spatialDirty = false;
        this.spatialHash.build(this.objects);
    }

    queryNear(x, y, w, h) {
        this.rebuildSpatialHash();
        const spatialResults = this.spatialHash.query(x, y, w, h);
        if (!(w > 0 && h > 0) || this._tilemapCollisionCellCount === 0) return spatialResults;
        // SpatialHash reuses its result buffer. Tilemap queries can nest during
        // collision resolution, so give this combined result its own array.
        const nearby = spatialResults.slice();
        const firstX = Math.floor(x / GRID_SIZE) * GRID_SIZE;
        const lastX = (Math.ceil((x + w) / GRID_SIZE) - 1) * GRID_SIZE;
        const firstY = Math.floor(y / GRID_SIZE) * GRID_SIZE;
        const lastY = (Math.ceil((y + h) / GRID_SIZE) - 1) * GRID_SIZE;
        for (let cy = firstY; cy <= lastY; cy += GRID_SIZE) {
            for (let cx = firstX; cx <= lastX; cx += GRID_SIZE) {
                const key = `${cx},${cy}`;
                for (const tilemap of this.tilemaps) {
                    const cell = tilemap._cellLookup.get(key);
                    if (cell?.collision) nearby.push(this._getTilemapCollider(tilemap, cell));
                }
            }
        }
        return nearby;
    }

    addObject(obj) {
        if (obj.spriteSheet && this.getSpriteSheetDataLength() + obj.spriteSheet.data.length > WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH) {
            obj.spriteSheet = null;
        }
        obj.layer = normalizeWorldLayerDepth(obj.layer) ?? 1;
        if (!this.layerDefinitions.some(layer => layer.depth === obj.layer)) {
            this.layerDefinitions = normalizeWorldLayerDefinitions(this.layerDefinitions, [obj]);
        }
        const layer = this.getLayerDefinition(obj.layer);
        if (obj.collision !== false && layer && (layer.parallaxX !== 1 || layer.parallaxY !== 1)) obj.layer = 1;
        this.objects.push(obj);
        this._spatialDirty = true;
        this._tileCacheReady = false;
        this._mergedBlockCache = null;
        this._editorMergedDirty = true;
        this._teleportalListDirty = true;
        this._zoneListDirty = true;
        this.updateSpecialPoints();
        return obj;
    }

    getSpriteSheetDataLength() {
        const objectBytes = this.objects.reduce((total, obj) => total + (obj.spriteSheet?.data?.length || 0), 0);
        const stampBytes = this.objectStamps.reduce((total, stamp) => total + stamp.objects.reduce(
            (stampTotal, obj) => stampTotal + (obj.spriteSheet?.data?.length || 0), 0), 0);
        const tilemapBytes = this.tilemaps.reduce((total, tilemap) => total + (tilemap.atlas?.data?.length || 0), 0);
        return objectBytes + stampBytes + tilemapBytes + (this.playerSpriteSheet?.data?.length || 0);
    }

    addObjectStamp(name, objects) {
        const cleanName = typeof name === 'string' ? name.trim() : '';
        if (!cleanName || cleanName.length > 40) throw new Error('Stamp names must contain 1 to 40 characters');
        if (this.objectStamps.length >= 32) throw new Error('This map already has the maximum of 32 Object Stamps');
        if (this.objectStamps.some(stamp => stamp.name.toLowerCase() === cleanName.toLowerCase())) {
            throw new Error('A stamp with that name already exists on this map');
        }
        if (!Array.isArray(objects) || objects.length < 1 || objects.length > 64) {
            throw new Error('A portable stamp must contain between 1 and 64 objects');
        }

        const normalized = normalizeWorldObjectStamps([{ name: cleanName, objects }]);
        if (normalized.length !== 1 || normalized[0].objects.length !== objects.length) {
            throw new Error('The stamp contains invalid object data');
        }
        const spriteBytes = normalized[0].objects.reduce((total, obj) => total + (obj.spriteSheet?.data?.length || 0), 0);
        if (this.getSpriteSheetDataLength() + spriteBytes > WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH) {
            throw new Error('Sprite sheets in a map and its Object Stamps are limited to 8 MiB total');
        }

        let id = `stamp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        while (this.objectStamps.some(stamp => stamp.id === id)) id += 'x';
        const stamp = {
            id,
            name: cleanName,
            objects: normalized[0].objects
        };
        this.objectStamps.push(stamp);
        return stamp;
    }

    removeObject(id) {
        const index = this.objects.findIndex(o => o.id === id);
        if (index !== -1) {
            this.objects.splice(index, 1);
            this._spatialDirty = true;
            this._tileCacheReady = false;
            this._mergedBlockCache = null;
            this._editorMergedDirty = true;
            this._teleportalListDirty = true;
            this._zoneListDirty = true;
            this.updateSpecialPoints();
            return true;
        }
        return false;
    }

    getObjectAt(x, y) {
        let topmost = null;
        let topmostIndex = -1;
        const drawOrder = object => object.appearanceType === 'zone' || object.appearanceType === 'button'
            ? Number.POSITIVE_INFINITY
            : (normalizeWorldLayerDepth(object.layer) ?? 1);
        for (let index = 0; index < this.objects.length; index++) {
            const object = this.objects[index];
            if (!object.containsPoint(x, y)) continue;
            if (!topmost || drawOrder(object) > drawOrder(topmost) ||
                (drawOrder(object) === drawOrder(topmost) && index > topmostIndex)) {
                topmost = object;
                topmostIndex = index;
            }
        }
        return topmost;
    }
    
    getObjectsAt(x, y) {
        // Return all objects at this point
        return this.objects.filter(obj => obj.containsPoint(x, y));
    }
    
    /**
     * Check if a spike is attached to a ground block
     * Returns true if the spike's flat side (determined by rotation) is touching a ground block
     * @param {WorldObject} spike - The spike to check
     * @returns {boolean}
     */
    isSpikeAttachedToGround(spike) {
        if (spike.appearanceType !== 'spike') return false;
        
        // Determine which side is the flat side based on rotation
        // rotation 0 = spike pointing up, flat side at bottom (y + height)
        // rotation 90 = spike pointing right, flat side at left (x - 1)
        // rotation 180 = spike pointing down, flat side at top (y - 1)
        // rotation 270 = spike pointing left, flat side at right (x + width)
        
        let checkX, checkY;
        const r = spike.rotation % 360;
        
        if (r === 0) {
            // Flat side at bottom
            checkX = spike.x + spike.width / 2;
            checkY = spike.y + spike.height + 1;
        } else if (r === 90) {
            // Flat side at left
            checkX = spike.x - 1;
            checkY = spike.y + spike.height / 2;
        } else if (r === 180) {
            // Flat side at top
            checkX = spike.x + spike.width / 2;
            checkY = spike.y - 1;
        } else if (r === 270) {
            // Flat side at right
            checkX = spike.x + spike.width + 1;
            checkY = spike.y + spike.height / 2;
        } else {
            return false;
        }
        
        // Check if there's a ground block at that position
        const objectsAtPoint = this.getObjectsAt(checkX, checkY);
        return objectsAtPoint.some(obj => 
            obj.id !== spike.id && 
            obj.actingType === 'ground' && 
            obj.collision
        );
    }

    getObjectById(id) {
        return this.objects.find(o => o.id === id);
    }

    setMechanicsObjectEnabled(id, enabled) {
        const object = this.getObjectById(id);
        if (!object) return false;
        const nextEnabled = enabled !== false;
        if ((object._mechanicsEnabled !== false) === nextEnabled) return true;
        object._mechanicsEnabled = nextEnabled;
        object._playerInside = false;
        this._teleportalListDirty = true;
        this._zoneListDirty = true;
        this._editorMergedDirty = true;
        this.invalidateTileCache();
        this.updateSpecialPoints();
        return true;
    }

    setMechanicsObjectPosition(id, x, y, options = {}) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10000000 || Math.abs(y) > 10000000) return false;
        const object = this.getObjectById(id);
        if (!object) return false;
        const moving = options?.moving === true;
        const wasMoving = object._mechanicsMoving === true;
        if (moving) object._mechanicsMoving = true;
        else delete object._mechanicsMoving;
        const oldX = object.x;
        const oldY = object.y;
        if (object.x === x && object.y === y) {
            object._mechanicsPosition = true;
            if (!object._mechanicsOriginalPosition) object._mechanicsOriginalPosition = { x, y };
            if (wasMoving !== moving) this.invalidateTileCache();
            return true;
        }
        if (!object._mechanicsOriginalPosition) object._mechanicsOriginalPosition = { x: object.x, y: object.y };
        object._mechanicsPosition = true;
        object.x = x;
        object.y = y;
        if (!moving && options?.preserveInside !== true) object._playerInside = false;
        const engine = typeof window !== 'undefined' ? window.engine : null;
        const player = options?.carryPlayer === true && object.collision && object.actingType === 'ground' &&
            engine?.world === this && (engine.state === 'playing' || engine.state === 'testing')
            ? engine.localPlayer : null;
        let oldSurfaceY = oldY;
        if (player && ['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(object.collisionShape)) {
            const footBox = player.getGroundTouchbox();
            oldSurfaceY = player.getSlopeSurfaceY(object, footBox.x + footBox.width / 2);
        } else if (player && object.collisionShape === 'capsule') {
            oldSurfaceY = player.getCapsuleVerticalContact({ ...object, x: oldX, y: oldY }, player.getGroundTouchbox(), 1);
        } else if (player && object.collisionShape === 'circle') {
            const footBox = player.getGroundTouchbox();
            const radius = Math.min(object.width, object.height) / 2;
            const centerX = oldX + object.width / 2;
            const centerY = oldY + object.height / 2;
            const closestX = Math.max(footBox.x, Math.min(centerX, footBox.x + footBox.width));
            const dx = centerX - closestX;
            const reachSquared = radius * radius - dx * dx;
            oldSurfaceY = reachSquared >= 0 ? centerY - Math.sqrt(reachSquared) : null;
        }
        if (player && player.isOnGround && Number.isFinite(oldSurfaceY) &&
            player.y + player.height >= oldSurfaceY - 2 && player.y + player.height <= oldSurfaceY + 3 &&
            player.x < oldX + object.width && player.x + player.width > oldX) {
            player.x += x - oldX;
            player.y += y - oldY;
        }
        this._spatialDirty = true;
        if (!moving) {
            this._mergedBlockCache = null;
            this._editorMergedDirty = true;
            this._teleportalListDirty = true;
            this._zoneListDirty = true;
        }
        if (wasMoving !== moving || !moving) this.invalidateTileCache();
        if (['spawnpoint', 'checkpoint', 'endpoint'].includes(object.actingType)) this.updateSpecialPoints();
        return true;
    }

    setMechanicsObjectDrawLayer(id, layerId) {
        const object = this.getObjectById(id);
        const layer = this.layerDefinitions.find(item => item.id === layerId);
        if (!object || !layer) return false;
        if (object.collision !== false && (layer.parallaxX !== 1 || layer.parallaxY !== 1)) return false;
        if (normalizeWorldLayerDepth(object.layer) === layer.depth &&
            (object._mechanicsDrawLayerId === layer.id || object._mechanicsOriginalLayer === undefined)) return true;
        if (object._mechanicsOriginalLayer === undefined) object._mechanicsOriginalLayer = object.layer;
        object.layer = layer.depth;
        const originalDepth = normalizeWorldLayerDepth(object._mechanicsOriginalLayer);
        if (originalDepth === layer.depth) {
            delete object._mechanicsOriginalLayer;
            delete object._mechanicsDrawLayerId;
        } else {
            object._mechanicsDrawLayerId = layer.id;
        }
        this._mergedBlockCache = null;
        this._editorMergedDirty = true;
        this.invalidateTileCache();
        return true;
    }

    resetMechanicsObjectDrawLayer(id) {
        const object = this.getObjectById(id);
        if (!object || object._mechanicsOriginalLayer === undefined) return false;
        object.layer = normalizeWorldLayerDepth(object._mechanicsOriginalLayer) ?? 1;
        delete object._mechanicsOriginalLayer;
        delete object._mechanicsDrawLayerId;
        this._mergedBlockCache = null;
        this._editorMergedDirty = true;
        this.invalidateTileCache();
        return true;
    }

    resetMechanicsObjectStates() {
        let changed = false;
        let positionChanged = false;
        for (const object of this.objects) {
            if (object._mechanicsEnabled !== undefined) {
                delete object._mechanicsEnabled;
                object._playerInside = false;
                changed = true;
            }
            if (object._mechanicsPosition === true) {
                const original = object._mechanicsOriginalPosition;
                if (original && Number.isFinite(original.x) && Number.isFinite(original.y)) {
                    object.x = original.x;
                    object.y = original.y;
                    object._playerInside = false;
                    positionChanged = true;
                }
                delete object._mechanicsPosition;
                delete object._mechanicsOriginalPosition;
                delete object._mechanicsMoving;
                changed = true;
            }
            if (object._mechanicsMotionDirection !== undefined) {
                delete object._mechanicsMotionDirection;
                changed = true;
            }
            if (object._mechanicsSpriteFrame !== undefined) {
                delete object._mechanicsSpriteFrame;
                changed = true;
            }
            if (object._mechanicsSpriteAnimation !== undefined) {
                delete object._mechanicsSpriteAnimation;
                changed = true;
            }
            if (object._mechanicsOpacity !== undefined) {
                delete object._mechanicsOpacity;
                changed = true;
            }
            if (object._mechanicsOriginalLayer !== undefined) {
                object.layer = normalizeWorldLayerDepth(object._mechanicsOriginalLayer) ?? 1;
                delete object._mechanicsOriginalLayer;
                delete object._mechanicsDrawLayerId;
                changed = true;
            }
        }
        if (changed) {
            if (positionChanged) {
                this._spatialDirty = true;
                this._mergedBlockCache = null;
            }
            this._teleportalListDirty = true;
            this._zoneListDirty = true;
            this._editorMergedDirty = true;
            this.invalidateTileCache();
        }
        this.updateSpecialPoints();
    }

    hasObjectAt(x, y, excludeId = null) {
        return this.objects.some(o => 
            o.id !== excludeId && o.containsPoint(x, y)
        );
    }

    updateSpecialPoints() {
        this.spawnPoint = null;
        this.checkpoints = [];
        this.endpoint = null;
        
        for (const obj of this.objects) {
            if (obj._mechanicsEnabled === false) continue;
            if (obj.actingType === 'spawnpoint') {
                this.spawnPoint = obj;
            } else if (obj.actingType === 'checkpoint') {
                this.checkpoints.push(obj);
            } else if (obj.actingType === 'endpoint') {
                this.endpoint = obj;
            }
        }
    }

    reorderLayers(fromIndex, toIndex) {
        const [item] = this.objects.splice(fromIndex, 1);
        this.objects.splice(toIndex, 0, item);
        this._editorMergedDirty = true;
    }

    clear() {
        this.objects = [];
        this.tilemaps = [];
        this._tilemapCellCount = 0;
        this._tilemapCollisionCellCount = 0;
        this._tilemapAnimatedCellCount = 0;
        this._tilemapRenderCells = null;
        this._tilemapRenderDirty = true;
        this._spatialDirty = true;
        this._editorMergedDirty = true;
        this._teleportalListDirty = true;
        this._zoneListDirty = true;
        this.invalidateTileCache();
        this.spawnPoint = null;
        this.checkpoints = [];
        this.endpoint = null;
    }

    // ---- Block merging (greedy meshing) ----

    _isMergeableBlock(obj) {
        const at = obj.appearanceType;
        if (typeof obj.render === 'function') return false;
        if (at !== 'ground') return false;
        if (obj.type !== 'block') return false;
        if (obj.collisionShape !== 'box') return false;
        if (obj.rotation !== 0) return false;
        if (obj.flipHorizontal) return false;
        if (obj.oneWayPlatform) return false;
        if (obj.width !== GRID_SIZE || obj.height !== GRID_SIZE) return false;
        if (Math.round(obj.x) % GRID_SIZE !== 0 || Math.round(obj.y) % GRID_SIZE !== 0) return false;
        return true;
    }

    _gridKey(gx, gy) {
        return (gx + 500000) * 1000000 + (gy + 500000);
    }

    _buildMergedBlocks(objects) {
        const mergeable = [];
        const nonMergeable = [];

        for (let i = 0; i < objects.length; i++) {
            const obj = objects[i];
            if (obj._mechanicsEnabled === false) continue;
            if (this._isMergeableBlock(obj)) {
                mergeable.push(obj);
            } else {
                nonMergeable.push(obj);
            }
        }

        if (mergeable.length === 0) return { merged: [], nonMerged: nonMergeable };

        const groups = new Map();
        for (let i = 0; i < mergeable.length; i++) {
            const obj = mergeable[i];
            const key = `${obj.color}|${obj.texture || 'solid'}|${obj.opacity}|${obj.layer ?? 1}`;
            let list = groups.get(key);
            if (!list) { list = []; groups.set(key, list); }
            list.push(obj);
        }

        const merged = [];

        for (const [, blocks] of groups) {
            const grid = new Set();
            for (let i = 0; i < blocks.length; i++) {
                const gx = Math.round(blocks[i].x / GRID_SIZE);
                const gy = Math.round(blocks[i].y / GRID_SIZE);
                grid.add(this._gridKey(gx, gy));
            }

            blocks.sort((a, b) => {
                const ay = Math.round(a.y / GRID_SIZE);
                const by = Math.round(b.y / GRID_SIZE);
                if (ay !== by) return ay - by;
                return Math.round(a.x / GRID_SIZE) - Math.round(b.x / GRID_SIZE);
            });

            const visited = new Set();
            const sample = blocks[0];

            for (let i = 0; i < blocks.length; i++) {
                const startGx = Math.round(blocks[i].x / GRID_SIZE);
                const startGy = Math.round(blocks[i].y / GRID_SIZE);
                const startKey = this._gridKey(startGx, startGy);

                if (visited.has(startKey)) continue;

                let endGx = startGx;
                while (grid.has(this._gridKey(endGx + 1, startGy)) && !visited.has(this._gridKey(endGx + 1, startGy))) {
                    endGx++;
                }

                let endGy = startGy;
                let canExtend = true;
                while (canExtend) {
                    const nextGy = endGy + 1;
                    for (let gx = startGx; gx <= endGx; gx++) {
                        const k = this._gridKey(gx, nextGy);
                        if (!grid.has(k) || visited.has(k)) {
                            canExtend = false;
                            break;
                        }
                    }
                    if (canExtend) endGy = nextGy;
                }

                for (let gy = startGy; gy <= endGy; gy++) {
                    for (let gx = startGx; gx <= endGx; gx++) {
                        visited.add(this._gridKey(gx, gy));
                    }
                }

                merged.push({
                    x: startGx * GRID_SIZE,
                    y: startGy * GRID_SIZE,
                    width: (endGx - startGx + 1) * GRID_SIZE,
                    height: (endGy - startGy + 1) * GRID_SIZE,
                    color: sample.color,
                    texture: sample.texture || 'solid',
                    opacity: sample.opacity,
                    layer: sample.layer ?? 1
                });
            }
        }

        return { merged, nonMerged: nonMergeable };
    }

    _renderMergedBlock(ctx, x, y, w, h, color, texture, opacity) {
        if (opacity !== 1) {
            ctx.save();
            ctx.globalAlpha = opacity;
        }

        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);

        if (texture !== 'solid' && BlockTextures[texture]?.loaded && BlockTextures[texture]?.image) {
            fillBlockSurfaceTexture(ctx, texture, x, y, w, h);
        } else if (texture === 'solid' && w >= 16 && h >= 16) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.fillRect(x + w - 4, y + 4, 4, h - 4);
            ctx.fillRect(x + 4, y + h - 4, w - 4, 4);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.fillRect(x, y, w - 4, 4);
            ctx.fillRect(x, y, 4, h - 4);
        }

        if (opacity !== 1) {
            ctx.restore();
        }
    }

    // ---- Tile cache for static world rendering ----

    _isStaticObject(obj) {
        if (obj._mechanicsEnabled === false) return false;
        if (obj._mechanicsMoving === true) return false;
        if (obj.spriteSheet) return false;
        const at = obj.appearanceType;
        if (at === 'zone' || at === 'button') return false;
        if (at === 'coin') return false;
        if (at === 'checkpoint') return false;
        if (obj.type === 'spinner' || at === 'spinner') return false;
        if (obj.type === 'text') return false;
        return true;
    }

    _isDynamicRenderable(obj) {
        const at = obj.appearanceType;
        if (at === 'zone' || at === 'button') return false;
        return obj._mechanicsMoving === true || !this._isStaticObject(obj);
    }

    invalidateTileCache() {
        this._tiles.clear();
        this._tileCacheChunks.clear();
        this._tileCacheReady = false;
        this._mergedBlockCache = null;
        this._editorMergedDirty = true;
    }

    buildTileCache() {
        this._tiles.clear();
        this._tileCacheChunks = new Map();
        const ts = this._tileSize;
        const cpColors = {
            default: this.checkpointDefaultColor,
            active: this.checkpointActiveColor,
            touched: this.checkpointTouchedColor
        };

        this._dynamicObjects = [];
        this._animatedTilemapCells = [];

        const staticObjects = [];
        for (let i = 0; i < this.objects.length; i++) {
            const obj = this.objects[i];
            if (!this._isStaticObject(obj)) {
                if (this._isDynamicRenderable(obj)) this._dynamicObjects.push(obj);
                continue;
            }
            staticObjects.push(obj);
        }

        for (const cell of this._getTilemapRenderCells()) {
            if (cell._tilemapAnimated) this._animatedTilemapCells.push(cell);
            else staticObjects.push(cell);
        }

        const { merged, nonMerged } = this._buildMergedBlocks(staticObjects);
        this._mergedBlockCache = merged;

        const addToChunk = (layer, tx, ty, object) => {
            const key = this._tileKey(layer, tx, ty);
            let chunkObjects = this._tileCacheChunks.get(key);
            if (!chunkObjects) {
                chunkObjects = [];
                this._tileCacheChunks.set(key, chunkObjects);
            }
            chunkObjects.push(object);
        };

        for (let i = 0; i < merged.length; i++) {
            const m = merged[i];
            const layer = m.layer;
            const tx0 = Math.floor(m.x / ts);
            const ty0 = Math.floor(m.y / ts);
            const tx1 = Math.floor((m.x + m.width - 1) / ts);
            const ty1 = Math.floor((m.y + m.height - 1) / ts);

            for (let tx = tx0; tx <= tx1; tx++) {
                for (let ty = ty0; ty <= ty1; ty++) {
                    addToChunk(layer, tx, ty, { ...m, _mergedTileBlock: true });
                }
            }
        }

        for (let i = 0; i < nonMerged.length; i++) {
            const obj = nonMerged[i];
            const layer = obj.layer ?? 1;
            const tx0 = Math.floor(obj.x / ts);
            const ty0 = Math.floor(obj.y / ts);
            const tx1 = Math.floor((obj.x + obj.width - 1) / ts);
            const ty1 = Math.floor((obj.y + obj.height - 1) / ts);

            for (let tx = tx0; tx <= tx1; tx++) {
                for (let ty = ty0; ty <= ty1; ty++) {
                    addToChunk(layer, tx, ty, obj);
                }
            }
        }

        this._tileCacheReady = true;
    }

    _getOrBuildRenderTile(layer, tx, ty) {
        const key = this._tileKey(layer, tx, ty);
        const cached = this._tiles.get(key);
        if (cached) {
            // Map insertion order is the LRU order; touching a chunk moves it
            // to the newest position without copying its bitmap.
            this._tiles.delete(key);
            this._tiles.set(key, cached);
            return cached;
        }

        const chunkObjects = this._tileCacheChunks.get(key);
        if (!chunkObjects?.length) return null;
        const tile = document.createElement('canvas');
        tile.width = this._tileSize;
        tile.height = this._tileSize;
        tile._ctx = tile.getContext('2d');
        const fakeCamera = { x: tx * this._tileSize, y: ty * this._tileSize, width: this._tileSize, height: this._tileSize, zoom: 1 };
        const cpColors = {
            default: this.checkpointDefaultColor,
            active: this.checkpointActiveColor,
            touched: this.checkpointTouchedColor
        };

        for (const object of chunkObjects) {
            if (object._mergedTileBlock) {
                this._renderMergedBlock(
                    tile._ctx,
                    object.x - fakeCamera.x,
                    object.y - fakeCamera.y,
                    object.width,
                    object.height,
                    object.color,
                    object.texture || 'solid',
                    object.opacity
                );
            } else {
                object.render(tile._ctx, fakeCamera, cpColors);
            }
        }

        this._tiles.set(key, tile);
        while (this._tiles.size > WORLD_TILE_RENDER_CACHE_MAX_CHUNKS) {
            this._tiles.delete(this._tiles.keys().next().value);
        }
        return tile;
    }

    _tileKey(layer, tx, ty) {
        return `${layer}:${tx}:${ty}`;
    }

    renderTiles(ctx, camera, layerArray) {
        const ts = this._tileSize;
        for (let li = 0; li < layerArray.length; li++) {
            const layer = layerArray[li];
            const layerCamera = this.getLayerCamera(camera, layer);
            const vLeft = layerCamera.x;
            const vRight = layerCamera.x + camera.width / camera.zoom;
            const vTop = layerCamera.y;
            const vBottom = layerCamera.y + camera.height / camera.zoom;
            const tx0 = Math.floor(vLeft / ts) - 1;
            const ty0 = Math.floor(vTop / ts) - 1;
            const tx1 = Math.floor(vRight / ts) + 1;
            const ty1 = Math.floor(vBottom / ts) + 1;
            for (let tx = tx0; tx <= tx1; tx++) {
                for (let ty = ty0; ty <= ty1; ty++) {
                    const tile = this._getOrBuildRenderTile(layer, tx, ty);
                    if (tile) {
                        ctx.drawImage(tile, tx * ts - layerCamera.x, ty * ts - layerCamera.y);
                    }
                }
            }
        }
    }

    renderDynamic(ctx, camera, layerArray, checkpointColors) {
        if (!this._dynamicObjects || this._dynamicObjects.length === 0) return;
        for (let i = 0; i < this._dynamicObjects.length; i++) {
            const obj = this._dynamicObjects[i];
            const layer = obj.layer ?? 1;
            let match = false;
            for (let li = 0; li < layerArray.length; li++) {
                if (layerArray[li] === layer) { match = true; break; }
            }
            if (!match) continue;
            const layerCamera = this.getLayerCamera(camera, layer);
            const margin = 100;
            const vLeft = layerCamera.x - margin;
            const vRight = layerCamera.x + camera.width / camera.zoom + margin;
            const vTop = layerCamera.y - margin;
            const vBottom = layerCamera.y + camera.height / camera.zoom + margin;
            if (obj.x + obj.width < vLeft || obj.x > vRight ||
                obj.y + obj.height < vTop || obj.y > vBottom) continue;
            obj.render(ctx, layerCamera, checkpointColors, this);
        }
    }

    renderAnimatedTilemaps(ctx, camera, layerArray) {
        if (!this._animatedTilemapCells?.length) return;
        for (const cell of this._animatedTilemapCells) {
            if (!layerArray.includes(cell.layer)) continue;
            const layerCamera = this.getLayerCamera(camera, cell.layer);
            const margin = 100;
            if (cell.x + cell.width < layerCamera.x - margin || cell.x > layerCamera.x + camera.width / camera.zoom + margin ||
                cell.y + cell.height < layerCamera.y - margin || cell.y > layerCamera.y + camera.height / camera.zoom + margin) continue;
            cell.render(ctx, layerCamera, null, this);
        }
    }

    // ---- Standard rendering (editor mode) ----

    _rebuildEditorMergedCache() {
        if (!this._editorMergedDirty && this._editorMergedCache) return;
        this._editorMergedDirty = false;

        const objectsByLayer = new Map();
        const addRenderable = obj => {
            const at = obj.appearanceType;
            if (at === 'zone' || at === 'button') return;
            const depth = normalizeWorldLayerDepth(obj.layer) ?? 1;
            let layerObjects = objectsByLayer.get(depth);
            if (!layerObjects) {
                layerObjects = [];
                objectsByLayer.set(depth, layerObjects);
            }
            layerObjects.push(obj);
        };
        for (let i = 0; i < this.objects.length; i++) addRenderable(this.objects[i]);
        for (const cell of this._getTilemapRenderCells()) addRenderable(cell);

        this._editorMergedCache = Array.from(objectsByLayer, ([depth, objects]) => ({
            depth,
            ...this._buildMergedBlocks(objects)
        })).sort((a, b) => a.depth - b.depth);
    }

    render(ctx, camera) {
        if (!this._cpColorsEditor) this._cpColorsEditor = {};
        this._cpColorsEditor.default = this.checkpointDefaultColor;
        this._cpColorsEditor.active = this.checkpointActiveColor;
        this._cpColorsEditor.touched = this.checkpointTouchedColor;
        const checkpointColors = this._cpColorsEditor;
        
        const margin = 100;
        const vLeft = camera.x - margin;
        const vRight = camera.x + camera.width / camera.zoom + margin;
        const vTop = camera.y - margin;
        const vBottom = camera.y + camera.height / camera.zoom + margin;
        
        this._rebuildEditorMergedCache();
        const cache = this._editorMergedCache;

        if (!this._zones) this._zones = [];
        this._zones.length = 0;
        for (let i = 0; i < this.objects.length; i++) {
            const obj = this.objects[i];
            const at = obj.appearanceType;
            if (at !== 'zone' && at !== 'button') continue;
            if (obj.x + obj.width < vLeft || obj.x > vRight ||
                obj.y + obj.height < vTop || obj.y > vBottom) continue;
            this._zones.push(obj);
        }

        const abovePlayer = [];
        for (const layer of cache) {
            if (layer.depth >= 2) {
                abovePlayer.push(layer);
            } else {
                this._renderMergedLayer(ctx, camera, layer.merged, layer.nonMerged, checkpointColors, vLeft, vRight, vTop, vBottom);
            }
        }
        this._editorAboveLayers = abovePlayer;

        return { layers: [[], [], []], checkpointColors };
    }

    _renderMergedLayer(ctx, camera, merged, nonMerged, checkpointColors, vL, vR, vT, vB) {
        for (let i = 0; i < merged.length; i++) {
            const m = merged[i];
            if (m.x + m.width < vL || m.x > vR || m.y + m.height < vT || m.y > vB) continue;
            this._renderMergedBlock(ctx, m.x - camera.x, m.y - camera.y, m.width, m.height, m.color, m.texture, m.opacity);
        }
        for (let i = 0; i < nonMerged.length; i++) {
            const obj = nonMerged[i];
            if (obj.x + obj.width < vL || obj.x > vR || obj.y + obj.height < vT || obj.y > vB) continue;
            obj.render(ctx, camera, checkpointColors, this);
        }
    }

    renderAbovePlayer(ctx, camera, checkpointColors) {
        const margin = 100;
        const vL = camera.x - margin;
        const vR = camera.x + camera.width / camera.zoom + margin;
        const vT = camera.y - margin;
        const vB = camera.y + camera.height / camera.zoom + margin;

        for (const layer of this._editorAboveLayers || []) {
            this._renderMergedLayer(ctx, camera, layer.merged, layer.nonMerged, checkpointColors, vL, vR, vT, vB);
        }
    }
    
    renderZones(ctx, camera) {
        for (let i = 0; i < this._zones.length; i++) {
            this._zones[i].render(ctx, camera);
        }
    }

    renderVisibleZones(ctx, camera) {
        const zones = this.getZones();
        if (zones.length === 0) return;
        const margin = 100;
        const vLeft = camera.x - margin;
        const vRight = camera.x + camera.width / camera.zoom + margin;
        const vTop = camera.y - margin;
        const vBottom = camera.y + camera.height / camera.zoom + margin;
        for (let i = 0; i < zones.length; i++) {
            const obj = zones[i];
            if (obj.x + obj.width < vLeft || obj.x > vRight ||
                obj.y + obj.height < vTop || obj.y > vBottom) continue;
            obj.render(ctx, camera, null, this);
        }
    }
    
    renderTeleportalConnections(ctx, camera, time) {
        const allPortals = this.getTeleportals();
        const portalByName = this._portalByName || (this._portalByName = new Map());
        portalByName.clear();
        if (!this._activePortals) this._activePortals = [];
        this._activePortals.length = 0;
        for (let i = 0; i < allPortals.length; i++) {
            const obj = allPortals[i];
            if (obj.actingType === 'portal' && obj.teleportalName) {
                portalByName.set(obj.teleportalName, obj);
                this._activePortals.push(obj);
            }
        }
        const portals = this._activePortals;
        
        for (const portal of portals) {
            const portalCenterX = portal.x + portal.width / 2 - camera.x;
            const portalCenterY = portal.y + portal.height / 2 - camera.y;
            
            for (const conn of portal.sendTo) {
                const targetName = conn?.name || conn;
                if (!targetName || conn?.enabled === false) continue;
                
                const targetPortal = portalByName.get(targetName);
                if (!targetPortal) continue;
                
                const targetCenterX = targetPortal.x + targetPortal.width / 2 - camera.x;
                const targetCenterY = targetPortal.y + targetPortal.height / 2 - camera.y;
                
                const receiveConn = targetPortal.receiveFrom.find(c => (c?.name || c) === portal.teleportalName);
                const isValid = receiveConn && receiveConn?.enabled !== false;
                
                if (isValid) {
                    this.renderValidTeleportalConnection(ctx, portalCenterX, portalCenterY, targetCenterX, targetCenterY, time);
                } else {
                    this.renderInvalidSendConnection(ctx, portalCenterX, portalCenterY, targetCenterX, targetCenterY, time);
                }
            }
            
            for (const conn of portal.receiveFrom) {
                const sourceName = conn?.name || conn;
                if (!sourceName || conn?.enabled === false) continue;
                
                const sourcePortal = portalByName.get(sourceName);
                if (!sourcePortal) continue;
                
                const sendConn = sourcePortal.sendTo.find(c => (c?.name || c) === portal.teleportalName);
                const isValid = sendConn && sendConn?.enabled !== false;
                
                if (!isValid) {
                    const sourceCenterX = sourcePortal.x + sourcePortal.width / 2 - camera.x;
                    const sourceCenterY = sourcePortal.y + sourcePortal.height / 2 - camera.y;
                    this.renderInvalidReceiveConnection(ctx, sourceCenterX, sourceCenterY, portalCenterX, portalCenterY, time);
                }
            }
        }
    }
    
    renderValidTeleportalConnection(ctx, x1, y1, x2, y2, time) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        
        // Green line (no shadow for performance)
        ctx.save();
        ctx.strokeStyle = '#4ade80';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        
        // Animated arrows along the line
        const arrowCount = Math.max(2, Math.floor(dist / 60));
        const animOffset = (time * 0.001) % 1; // 0 to 1 over 1 second
        
        for (let i = 0; i < arrowCount; i++) {
            const t = ((i / arrowCount) + animOffset) % 1;
            const ax = x1 + dx * t;
            const ay = y1 + dy * t;
            
            this.drawArrowHead(ctx, ax, ay, angle, '#4ade80', 8);
        }
        
        ctx.restore();
    }
    
    renderInvalidSendConnection(ctx, x1, y1, x2, y2, time) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        const maxDist = Math.min(dist * 0.4, 80); // Fade out distance
        
        ctx.save();
        
        // Animated arrows that fade out
        const arrowCount = 3;
        const animOffset = (time * 0.002) % 1;
        
        for (let i = 0; i < arrowCount; i++) {
            const t = ((i / arrowCount) + animOffset) % 1;
            const currentDist = t * maxDist;
            const ax = x1 + Math.cos(angle) * currentDist;
            const ay = y1 + Math.sin(angle) * currentDist;
            const opacity = 1 - t;
            
            ctx.globalAlpha = opacity;
            this.drawArrowHead(ctx, ax, ay, angle, '#f87171', 8);
        }
        
        ctx.restore();
    }
    
    renderInvalidReceiveConnection(ctx, x1, y1, x2, y2, time) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        const maxDist = Math.min(dist * 0.4, 80);
        
        ctx.save();
        
        // Animated arrows that fade IN toward the receiving portal
        const arrowCount = 3;
        const animOffset = (time * 0.002) % 1;
        
        for (let i = 0; i < arrowCount; i++) {
            const t = ((i / arrowCount) + animOffset) % 1;
            const startDist = dist - maxDist;
            const currentDist = startDist + t * maxDist;
            const ax = x1 + Math.cos(angle) * currentDist;
            const ay = y1 + Math.sin(angle) * currentDist;
            const opacity = t; // Fade IN as they approach
            
            ctx.globalAlpha = opacity;
            this.drawArrowHead(ctx, ax, ay, angle, '#f87171', 8);
        }
        
        ctx.restore();
    }
    
    drawArrowHead(ctx, x, y, angle, color, size) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(size, 0);
        ctx.lineTo(-size * 0.6, -size * 0.5);
        ctx.lineTo(-size * 0.6, size * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    toJSON() {
        const sourceCodeData = this.codeData && typeof this.codeData === 'object' && !Array.isArray(this.codeData)
            ? JSON.parse(JSON.stringify(this.codeData))
            : { triggers: [], events: [], variables: [] };
        const normalizeCodeData = globalThis.normalizeParkoreenCodeData;
        const codeDataSnapshot = typeof normalizeCodeData === 'function'
            ? normalizeCodeData(sourceCodeData)
            : sourceCodeData;
        return {
            objects: this.objects.map(o => o.toJSON()),
            tilemaps: this.tilemaps.map(tilemap => ({
                id: tilemap.id,
                name: tilemap.name,
                layer: tilemap.layer,
                ...(tilemap.atlas ? { atlas: { ...tilemap.atlas } } : {}),
                cells: tilemap.cells.map(cell => ({ ...cell }))
            })),
            objectStamps: this.objectStamps.map(stamp => ({
                id: stamp.id,
                name: stamp.name,
                objects: stamp.objects.map(obj => ({ ...obj }))
            })),
            playerSpriteSheet: this.playerSpriteSheet ? {
                ...this.playerSpriteSheet,
                animations: Object.fromEntries(Object.entries(this.playerSpriteSheet.animations).map(([name, animation]) => [name, { ...animation }]))
            } : null,
            layerDefinitions: this.layerDefinitions.map(layer => ({ ...layer })),
            mechanicsSaveId: this.mechanicsSaveId,
            persistCheckpoints: this.persistCheckpoints,
            background: this.background,
            defaultBlockColor: this.defaultBlockColor,
            defaultSpikeColor: this.defaultSpikeColor,
            defaultTextColor: this.defaultTextColor,
            defaultPortalColor: this.defaultPortalColor,
            defaultBouncerColor: this.defaultBouncerColor,
            showCoinCounter: this.showCoinCounter,
            cloudColorSky: this.cloudColorSky,
            cloudColorGalaxy: this.cloudColorGalaxy,
            checkpointDefaultColor: this.checkpointDefaultColor,
            checkpointActiveColor: this.checkpointActiveColor,
            checkpointTouchedColor: this.checkpointTouchedColor,
            maxJumps: this.maxJumps,
            infiniteJumps: this.infiniteJumps,
            additionalAirjump: this.additionalAirjump,
            collideWithEachOther: this.collideWithEachOther,
            mapName: this.mapName,
            dieLineY: this.dieLineY,
            // Physics settings
            playerSpeed: this.playerSpeed,
            horizontalAcceleration: this.horizontalAcceleration,
            airControl: this.airControl,
            terminalFallSpeed: this.terminalFallSpeed,
            jumpForce: this.jumpForce,
            gravity: this.gravity,
            cameraLerpX: this.cameraLerpX,
            cameraLerpY: this.cameraLerpY,
            cameraFollowMode: this.cameraFollowMode,
            cameraBounds: { ...this.cameraBounds },
            // Spike settings
            spikeTouchbox: this.spikeTouchbox,
            dropHurtOnly: this.dropHurtOnly,
            // Export/Import settings
            storedDataType: this.storedDataType,
            // Custom background
            customBackground: this.customBackground,
            // Music
            music: this.music,
            // Plugins
            plugins: this.plugins,
            // Code plugin data
            codeData: codeDataSnapshot
        };
    }

    fromJSON(data) {
        this.clear();
        this.playerSpriteSheet = normalizeWorldPlayerSpriteSheet(data?.playerSpriteSheet);
        const playerSpriteBytes = this.playerSpriteSheet?.data.length || 0;
        this.objectStamps = normalizeWorldObjectStamps(data?.objectStamps,
            Math.max(0, WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH - playerSpriteBytes));
        this.layerDefinitions = normalizeWorldLayerDefinitions(data?.layerDefinitions, data?.objects);
        const stampSpriteBytes = this.objectStamps.reduce((total, stamp) => total + stamp.objects.reduce(
            (stampTotal, obj) => stampTotal + (obj.spriteSheet?.data?.length || 0), 0), 0);
        this.tilemaps = normalizeWorldTilemaps(data?.tilemaps, this.layerDefinitions,
            Math.max(0, WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH - playerSpriteBytes - stampSpriteBytes));
        for (const tilemap of this.tilemaps) {
            if (!tilemap.cells.some(cell => cell.collision)) continue;
            const layer = this.getLayerDefinition(tilemap.layer);
            if (layer) {
                layer.parallaxX = 1;
                layer.parallaxY = 1;
            }
        }
        this._rebuildTilemapCellLookups();
        this.mechanicsSaveId = typeof data?.mechanicsSaveId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(data.mechanicsSaveId)
            ? data.mechanicsSaveId
            : createMechanicsSaveId();
        this.persistCheckpoints = data?.persistCheckpoints === true;
        this.background = data.background || 'sky';
        this.defaultBlockColor = data.defaultBlockColor || '#787878';
        this.defaultSpikeColor = data.defaultSpikeColor || '#c45a3f';
        this.defaultTextColor = data.defaultTextColor || '#000000';
        this.defaultPortalColor = data.defaultPortalColor || '#9b59b6';
        this.defaultBouncerColor = data.defaultBouncerColor || '#461A0C';
        this.showCoinCounter = data.showCoinCounter !== false;
        this.cloudColorSky = data.cloudColorSky || '#ffffff';
        this.cloudColorGalaxy = data.cloudColorGalaxy || '#9382a8';
        this.checkpointDefaultColor = data.checkpointDefaultColor || '#808080';
        this.checkpointActiveColor = data.checkpointActiveColor || '#4CAF50';
        this.checkpointTouchedColor = data.checkpointTouchedColor || '#2196F3';
        this.maxJumps = data.maxJumps || 1;
        this.infiniteJumps = data.infiniteJumps || false;
        this.additionalAirjump = data.additionalAirjump || false;
        this.collideWithEachOther = data.collideWithEachOther !== false;
        this.mapName = data.mapName || 'Untitled Map';
        this.dieLineY = data.dieLineY ?? 1000;
        
        // Physics settings with defaults for backward compatibility
        this.playerSpeed = (typeof data.playerSpeed === 'number' && data.playerSpeed > 0) ? data.playerSpeed : DEFAULT_MOVE_SPEED;
        this.horizontalAcceleration = typeof data.horizontalAcceleration === 'number' &&
            Number.isFinite(data.horizontalAcceleration) && data.horizontalAcceleration >= 0 &&
            data.horizontalAcceleration <= MAX_HORIZONTAL_ACCELERATION
            ? data.horizontalAcceleration : DEFAULT_HORIZONTAL_ACCELERATION;
        this.airControl = typeof data.airControl === 'number' && Number.isFinite(data.airControl) &&
            data.airControl >= 0 && data.airControl <= 1 ? data.airControl : DEFAULT_AIR_CONTROL;
        this.terminalFallSpeed = typeof data.terminalFallSpeed === 'number' &&
            Number.isFinite(data.terminalFallSpeed) && data.terminalFallSpeed > 0 &&
            data.terminalFallSpeed <= MAX_TERMINAL_FALL_SPEED ? data.terminalFallSpeed : null;
        this.jumpForce = (typeof data.jumpForce === 'number' && data.jumpForce < 0) ? data.jumpForce : DEFAULT_JUMP_FORCE;
        this.gravity = (typeof data.gravity === 'number' && data.gravity > 0) ? data.gravity : DEFAULT_GRAVITY;
        this.cameraLerpX = (typeof data.cameraLerpX === 'number' && data.cameraLerpX > 0 && data.cameraLerpX <= 1) ? data.cameraLerpX : CAMERA_LERP_X;
        this.cameraLerpY = (typeof data.cameraLerpY === 'number' && data.cameraLerpY > 0 && data.cameraLerpY <= 1) ? data.cameraLerpY : CAMERA_LERP_Y;
        this.cameraFollowMode = ['both', 'horizontal', 'vertical'].includes(data.cameraFollowMode) ? data.cameraFollowMode : 'both';
        const cameraBounds = data.cameraBounds;
        this.cameraBounds = cameraBounds &&
            Number.isFinite(cameraBounds.x) && Number.isFinite(cameraBounds.y) &&
            Number.isFinite(cameraBounds.width) && cameraBounds.width > 0 &&
            Number.isFinite(cameraBounds.height) && cameraBounds.height > 0 &&
            Number.isFinite(cameraBounds.x + cameraBounds.width) &&
            Number.isFinite(cameraBounds.y + cameraBounds.height)
            ? {
                enabled: cameraBounds.enabled === true,
                x: cameraBounds.x,
                y: cameraBounds.y,
                width: cameraBounds.width,
                height: cameraBounds.height
            }
            : { enabled: false, x: 0, y: 0, width: 2000, height: 1200 };
        
        // Spike touchbox mode
        const validSpikeModes = ['full', 'normal', 'tip', 'ground', 'flag', 'air', 'all-spike'];
        this.spikeTouchbox = validSpikeModes.includes(data.spikeTouchbox) ? data.spikeTouchbox : 'normal';
        
        // Drop Hurt Only
        this.dropHurtOnly = data.dropHurtOnly === true;
        
        // Stored data type for export
        const validDataTypes = ['json', 'dat'];
        this.storedDataType = validDataTypes.includes(data.storedDataType) ? data.storedDataType : 'json';
        
        // Custom background with defaults
        if (data.customBackground && data.customBackground.enabled) {
            this.customBackground = {
                enabled: true,
                type: data.customBackground.type || null,
                data: data.customBackground.data || null,
                playMode: ['once', 'loop', 'bounce'].includes(data.customBackground.playMode) ? data.customBackground.playMode : 'loop',
                loopCount: typeof data.customBackground.loopCount === 'number' ? data.customBackground.loopCount : -1,
                endType: ['freeze', 'replace'].includes(data.customBackground.endType) ? data.customBackground.endType : 'freeze',
                endBackground: data.customBackground.endBackground || null,
                sameAcrossScreens: !!data.customBackground.sameAcrossScreens,
                reverse: !!data.customBackground.reverse
            };
        } else {
            this.customBackground = {
                enabled: false,
                type: null,
                data: null,
                playMode: 'loop',
                loopCount: -1,
                endType: 'freeze',
                endBackground: null,
                sameAcrossScreens: false,
                reverse: false
            };
        }
        
        // Music settings with defaults
        const validMusicTypes = ['none', 'maccary-bay', 'reggae-party', 'custom'];
        if (data.music) {
            this.music = {
                type: validMusicTypes.includes(data.music.type) ? data.music.type : 'none',
                customData: data.music.customData || null,
                customName: data.music.customName || null,
                volume: (typeof data.music.volume === 'number' && data.music.volume >= 0 && data.music.volume <= 100) ? data.music.volume : 50,
                loop: data.music.loop !== false
            };
        } else {
            this.music = {
                type: 'none',
                customData: null,
                customName: null,
                volume: 50,
                loop: true
            };
        }
        
        // Reset plugin settings for every load so data from the previously
        // loaded map cannot leak into a map without plugin configuration.
        this.plugins = Object.create(null);
        this.plugins.enabled = [];
        if (data.plugins && typeof data.plugins === 'object' && !Array.isArray(data.plugins)) {
            this.plugins.enabled = Array.isArray(data.plugins.enabled) ? data.plugins.enabled : [];
            // Copy own config fields into a prototype-free dictionary. Plugin
            // ids come from map data, so keys such as "__proto__" must remain
            // ordinary data rather than changing this object's prototype.
            for (const key of Object.keys(data.plugins)) {
                const config = data.plugins[key];
                if (key !== 'enabled' && config && typeof config === 'object' && !Array.isArray(config)) {
                    this.plugins[key] = { ...config };
                }
            }
        }
        
        // Code plugin data and any legacy actions are migrated by one shared
        // normalizer used by import and runtime entry points too.
        const normalizeCodeData = globalThis.normalizeParkoreenCodeData;
        const savedCodeData = data?.codeData;
        this.codeData = typeof normalizeCodeData === 'function'
            ? normalizeCodeData(savedCodeData)
            : {
                ...(savedCodeData && typeof savedCodeData === 'object' && !Array.isArray(savedCodeData) ? savedCodeData : {}),
                triggers: Array.isArray(savedCodeData?.triggers) ? savedCodeData.triggers : [],
                events: [
                    ...(Array.isArray(savedCodeData?.events) ? savedCodeData.events : []),
                    ...(Array.isArray(savedCodeData?.actions) ? savedCodeData.actions : [])
                ].map(event => event && typeof event === 'object' && !Array.isArray(event) && event.type === 'action'
                    ? { ...event, type: 'event' }
                    : event),
                variables: Array.isArray(savedCodeData?.variables) ? savedCodeData.variables : []
            };
        delete this.codeData.actions;
        
        let spriteDataLength = playerSpriteBytes + this.objectStamps.reduce((total, stamp) => total + stamp.objects.reduce(
            (stampTotal, obj) => stampTotal + (obj.spriteSheet?.data?.length || 0), 0), 0);
        spriteDataLength += this.tilemaps.reduce((total, tilemap) => total + (tilemap.atlas?.data?.length || 0), 0);
        if (data.objects) {
            for (const objData of data.objects) {
                const object = new WorldObject(objData);
                if (object.spriteSheet) {
                    if (spriteDataLength + object.spriteSheet.data.length > WORLD_SPRITE_TOTAL_MAX_DATA_URL_LENGTH) {
                        object.spriteSheet = null;
                    } else {
                        spriteDataLength += object.spriteSheet.data.length;
                    }
                }
                this.addObject(object);
            }
        }
    }
    
    // Check if a plugin is enabled
    hasPlugin(pluginId) {
        return this.plugins.enabled.includes(pluginId);
    }
    
    // Enable a plugin (also enables via PluginManager if available)
    async enablePlugin(pluginId) {
        if (this.plugins.enabled.includes(pluginId)) return { success: true };
        // Only persist the plugin after its scripts and hooks initialized.
        if (window.PluginManager && !window.PluginManager.isEnabled(pluginId)) {
            const result = await window.PluginManager.enablePlugin(pluginId, this);
            if (!result?.success) return result || { success: false, error: 'Plugin initialization failed' };
        }
        if (!this.plugins.enabled.includes(pluginId)) this.plugins.enabled.push(pluginId);
        return { success: true };
    }
    
    // Disable a plugin (also disables via PluginManager if available)
    disablePlugin(pluginId) {
        if (window.PluginManager && window.PluginManager.isEnabled(pluginId)) {
            const result = window.PluginManager.disablePlugin(pluginId, this);
            if (!result?.success) return result || { success: false, error: 'Plugin could not be disabled' };
        }
        const index = this.plugins.enabled.indexOf(pluginId);
        if (index !== -1) {
            this.plugins.enabled.splice(index, 1);
        }
        return { success: true };
    }
    
    // Get objects using a specific plugin (metadata from each plugin's plugin.json)
    getPluginObjects(pluginId) {
        if (window.PluginManager) {
            return window.PluginManager.getPluginObjects(pluginId, this);
        }
        return [];
    }
}

// ============================================
// GAME ENGINE CLASS
// ============================================
const GAME_KEYS = new Set([
    'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'KeyX', 'KeyC', 'KeyF', 'KeyN',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Comma', 'Period',
    'ShiftLeft', 'ShiftRight'
]);

class GameEngine {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        
        this.world = new World();
        this.camera = new Camera(window.innerWidth, window.innerHeight);
        this.camera.setZoomLimits('editor'); // Start with editor zoom limits
        this.audioManager = new AudioManager();
        
        this.localPlayer = null;
        this.remotePlayers = new Map();
        this.playerScopedCoinCollections = new Map();
        this.globalCoinCollectionPending = new Set();
        this.globalCoinCollectionIds = new Set();
        
        this.state = GameState.EDITOR;
        WorldObject._editorMode = true;
        this.isRunning = false;
        this.lastTime = 0;
        this.editorSceneSnapshot = null;
        this._testSceneChanged = false;
        this._endedFromState = null;
        this._pendingEndGameData = null;
        this.mechanicsWorldPaused = false;
        this.mechanicsPauseNeedsRender = false;
        this.mechanicsPauseStartedAt = null;
        
        // Debug tools
        this.invincibilityEnabled = false;
        this._voidConfirmShowing = false;
        /** `performance.now()` of last void teleport confirm while invincible; null = not in void / reset */
        this._voidInvincibleLastPromptTime = null;
        
        // Editor state
        this.selectedObject = null;
        this.hoveredObject = null;
        
        // Input
        this.keys = {};
        this.mouse = { x: 0, y: 0, down: false };
        
        this.touchControlsEnabled = !!window.ParkoreenDevice?.isMobile();
        
        // Particle system
        this.particles = [];
        this._portalParticles = [];
        this._portalParticleTimer = 0;
        this._walkParticleTimer = 0;
        
        // Cloud system
        this.clouds = [];
        this.cloudsGenerated = false;
        this.cloudTime = 0; // For slow cloud drift
        
        this.setupCanvas();
        this.setupInput();
        this.audioManager.loadVolumeFromStorage();
    }
    
    // Spawn circular particles (for checkpoint touch effect)
    spawnCheckpointParticles(x, y, color = '#4CAF50') {
        const particleCount = 14;
        for (let i = 0; i < particleCount; i++) {
            const angle = (Math.PI * 2 / particleCount) * i + (Math.random() - 0.5) * 0.5;
            const speed = 70 + Math.random() * 50;
            const size = 3 + Math.random() * 4;

            this.particles.push({
                x: x,
                y: y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: size,
                color: color,
                alpha: 1,
                life: 1,
                decay: 0.018 + Math.random() * 0.01,
                shape: 'circle'
            });
        }
    }

    spawnWalkParticles(player) {
        if (!player.isOnGround || player.isFlying) return;
        const moving = Math.abs(player.vx) > 0.5;
        if (!moving) return;

        // Find the block directly under the player. We sample a strip the width of
        // the player's ground touchbox and pick the solid ground block with the
        // most vertical overlap (i.e. the one the player is actually standing on).
        // This avoids picking up checkpoints, teleportals, spikes, etc., and
        // avoids a side-block leak from spatial-hash bucket order.
        const footBox = player.getGroundTouchbox();
        const probeLeft = footBox.x;
        const probeRight = footBox.x + footBox.width;
        const probeY = footBox.y + footBox.height; // seam at bottom of feet
        const nearby = this.world.queryNear(probeLeft - 4, probeY - 2, footBox.width + 8, 4);

        let bestBlock = null;
        let bestOverlap = 0;
        for (const obj of nearby) {
            if (!obj.collision) continue;
            if (obj.actingType !== 'ground') continue;
            // Only true ground/solid block objects. Default `type` is 'block' but
            // we accept any unset `type` defensively (matches historical behavior
            // while still excluding portals/spikes/etc. via actingType).
            const objType = obj.type;
            if (objType && objType !== 'block') continue;

            let overlap;
            let coversCenter;
            const centerX = (probeLeft + probeRight) / 2;
            if (['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.collisionShape)) {
                const surfaceY = player.getSlopeSurfaceY(obj, centerX);
                const surfaceGap = Number.isFinite(surfaceY) ? Math.abs(probeY - surfaceY) : Infinity;
                if (surfaceGap > 3) continue;
                overlap = 3 - surfaceGap;
                coversCenter = true;
            } else if (obj.collisionShape === 'capsule') {
                const surfaceY = player.getCapsuleVerticalContact(obj, footBox, 1);
                const surfaceGap = Number.isFinite(surfaceY) ? Math.abs(probeY - surfaceY) : Infinity;
                if (surfaceGap > 3) continue;
                overlap = 3 - surfaceGap;
                coversCenter = centerX >= obj.x && centerX <= obj.x + obj.width;
            } else if (obj.collisionShape === 'circle') {
                const radius = Math.min(obj.width, obj.height) / 2;
                const circleX = obj.x + obj.width / 2;
                const circleY = obj.y + obj.height / 2;
                const closestX = Math.max(probeLeft, Math.min(circleX, probeRight));
                const dx = circleX - closestX;
                const reachSquared = radius * radius - dx * dx;
                if (reachSquared < 0) continue;
                const surfaceY = circleY - Math.sqrt(reachSquared);
                const surfaceGap = Math.abs(probeY - surfaceY);
                if (surfaceGap > 3) continue;
                overlap = 3 - surfaceGap;
                coversCenter = circleX >= probeLeft && circleX <= probeRight;
            } else {
                // Vertical overlap with the probe strip at the player's feet seam.
                const objTop = obj.y;
                const objBottom = obj.y + (obj.height || 0);
                overlap = Math.min(probeY, objBottom) - Math.max(probeY - 2, objTop);
                if (overlap <= 0) continue;

                // Prefer blocks whose horizontal range covers the player's center.
                const objLeft = obj.x;
                const objRight = obj.x + (obj.width || 0);
                coversCenter = centerX >= objLeft && centerX <= objRight;
            }

            // Score: prefer coverage, then deeper overlap.
            const score = (coversCenter ? 1000 : 0) + overlap;
            if (score > bestOverlap) {
                bestOverlap = score;
                bestBlock = obj;
            }
        }

        // No solid block directly under the player (e.g. standing on a portal,
        // checkpoint, or empty space) — don't spawn dust.
        if (!bestBlock) return;

        const blockColor = bestBlock.color || '#888888';
        const blockOpacity = (bestBlock.opacity !== undefined && bestBlock.opacity !== null) ? bestBlock.opacity : 1;

        // Spawn more particles with the block color & opacity
        const particleCount = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < particleCount; i++) {
            const px = player.x + player.width / 2 + (Math.random() - 0.5) * player.width * 0.8;
            const py = player.y + player.height;
            // Add brightness offset to the block color
            const brightnessOffset = -50 + Math.random() * 60; // -50 (50% darker) to +10 (10% brighter)
            const color = this.adjustColorBrightness(blockColor, brightnessOffset);
            this.particles.push({
                x: px,
                y: py,
                vx: (Math.random() - 0.5) * 40,
                vy: -(8 + Math.random() * 25),
                size: 2 + Math.random() * 3,
                color: color,
                alpha: blockOpacity,
                life: 0.4 + Math.random() * 0.3,
                decay: 0.04 + Math.random() * 0.02,
                maxAlpha: blockOpacity,
                shape: 'circle'
            });
        }
    }

    // Helper to adjust color brightness
    adjustColorBrightness(hexColor, amount) {
        hexColor = hexColor.replace('#', '');
        const r = Math.min(255, parseInt(hexColor.substr(0, 2), 16) + amount);
        const g = Math.min(255, parseInt(hexColor.substr(2, 2), 16) + amount);
        const b = Math.min(255, parseInt(hexColor.substr(4, 2), 16) + amount);
        const rr = Math.max(0, Math.min(255, r)).toString(16).padStart(2, '0');
        const gg = Math.max(0, Math.min(255, g)).toString(16).padStart(2, '0');
        const bb = Math.max(0, Math.min(255, b)).toString(16).padStart(2, '0');
        return '#' + rr + gg + bb;
    }

    updateParticles(dt) {
        const cam = this.camera;
        const vpL = cam.x - 200;
        const vpR = cam.x + cam.width / cam.zoom + 200;
        const vpT = cam.y - 200;
        const vpB = cam.y + cam.height / cam.zoom + 200;
        let writeIdx = 0;
        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 200 * dt;
            p.life -= p.decay;
            p.alpha = p.life * (p.maxAlpha !== undefined ? p.maxAlpha : 1);
            if (p.life > 0 && p.x >= vpL && p.x <= vpR && p.y >= vpT && p.y <= vpB) {
                this.particles[writeIdx++] = p;
            }
        }
        this.particles.length = writeIdx;
    }
    
    updatePortalParticles(dt) {
        const pad = GRID_SIZE * 3;
        const cam = this.camera;
        const vpL = cam.x - pad;
        const vpR = cam.x + cam.width / cam.zoom + pad;
        const vpT = cam.y - pad;
        const vpB = cam.y + cam.height / cam.zoom + pad;

        this._portalParticleTimer += dt;
        const spawnInterval = 0.08;

        if (this._portalParticleTimer >= spawnInterval) {
            this._portalParticleTimer -= spawnInterval;

            const portals = this.world.getTeleportals();
            for (let i = 0; i < portals.length; i++) {
                const obj = portals[i];
                const cx = obj.x + obj.width / 2;
                const cy = obj.y + obj.height / 2;
                if (cx + obj.width / 2 < vpL || cx - obj.width / 2 > vpR ||
                    cy + obj.height / 2 < vpT || cy - obj.height / 2 > vpB) continue;

                const radius = Math.min(obj.width, obj.height) * 0.5;
                const angle = Math.random() * Math.PI * 2;
                const dist = radius * (0.6 + Math.random() * 0.5);
                const px = cx + Math.cos(angle) * dist;
                const py = cy + Math.sin(angle) * dist;
                const orbitSpeed = (0.8 + Math.random() * 0.6) * (Math.random() < 0.5 ? 1 : -1);

                this._portalParticles.push({
                    x: px, y: py,
                    cx: cx, cy: cy,
                    angle: Math.atan2(py - cy, px - cx),
                    dist: dist,
                    orbitSpeed: orbitSpeed,
                    driftIn: -8 - Math.random() * 6,
                    size: 1.5 + Math.random() * 2,
                    color: obj.color,
                    life: 1,
                    decay: 0.008 + Math.random() * 0.006,
                    maxAlpha: (obj.particleOpacity !== undefined ? obj.particleOpacity : 100) / 100
                });
            }
        }

        let w = 0;
        for (let i = 0; i < this._portalParticles.length; i++) {
            const p = this._portalParticles[i];
            p.angle += p.orbitSpeed * dt;
            p.dist += p.driftIn * dt;
            if (p.dist < 0) p.dist = 0;
            p.x = p.cx + Math.cos(p.angle) * p.dist;
            p.y = p.cy + Math.sin(p.angle) * p.dist;
            p.life -= p.decay;
            if (p.life > 0) {
                this._portalParticles[w++] = p;
            }
        }
        this._portalParticles.length = w;
    }

    renderPortalParticles() {
        if (this._portalParticles.length === 0) return;
        const ctx = this.ctx;
        const cx = this.camera.x;
        const cy = this.camera.y;
        const zoom = this.camera.zoom;
        let lastColor = '';
        let lastAlpha = -1;
        for (let i = 0; i < this._portalParticles.length; i++) {
            const p = this._portalParticles[i];
            const alpha = p.life * (p.maxAlpha !== undefined ? p.maxAlpha : 1) * 0.7;
            if (alpha !== lastAlpha) { ctx.globalAlpha = alpha; lastAlpha = alpha; }
            if (p.color !== lastColor) { ctx.fillStyle = p.color; lastColor = p.color; }
            const sz = p.size * zoom;
            ctx.fillRect((p.x - cx) * zoom - sz, (p.y - cy) * zoom - sz, sz * 2, sz * 2);
        }
        ctx.globalAlpha = 1;
    }

    renderParticles() {
        if (this.particles.length === 0) return;
        const ctx = this.ctx;
        const cx = this.camera.x;
        const cy = this.camera.y;
        const zoom = this.camera.zoom;
        const TAU = Math.PI * 2;

        // First pass: square particles (fillRect — no path overhead)
        let lastColor = '';
        let lastAlpha = -1;
        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            if (p.shape === 'circle') continue;
            if (p.alpha !== lastAlpha) { ctx.globalAlpha = p.alpha; lastAlpha = p.alpha; }
            if (p.color !== lastColor) { ctx.fillStyle = p.color; lastColor = p.color; }
            const size = p.size * zoom;
            ctx.fillRect((p.x - cx) * zoom - size, (p.y - cy) * zoom - size, size * 2, size * 2);
        }

        // Second pass: circle particles — batch all circles of same color+alpha into one path
        lastColor = '';
        lastAlpha = -1;
        let pathOpen = false;
        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            if (p.shape !== 'circle') continue;
            if (p.alpha !== lastAlpha || p.color !== lastColor) {
                if (pathOpen) { ctx.fill(); pathOpen = false; }
                if (p.alpha !== lastAlpha) { ctx.globalAlpha = p.alpha; lastAlpha = p.alpha; }
                if (p.color !== lastColor) { ctx.fillStyle = p.color; lastColor = p.color; }
                ctx.beginPath();
                pathOpen = true;
            }
            const size = p.size * zoom;
            ctx.moveTo((p.x - cx) * zoom + size, (p.y - cy) * zoom);
            ctx.arc((p.x - cx) * zoom, (p.y - cy) * zoom, size, 0, TAU);
        }
        if (pathOpen) ctx.fill();
        ctx.globalAlpha = 1;
    }
    
    generateClouds() {
        this.clouds = [];
        if (!CloudImages.loaded) return;

        const numClouds = 10 + Math.floor(Math.random() * 6);

        const screenWidth = this.camera.width / this.camera.zoom;
        const screenHeight = this.camera.height / this.camera.zoom;

        const cloudAreaWidth = screenWidth * 3;
        const cloudAreaHeight = screenHeight * 0.45;

        let lastY = Math.random() * cloudAreaHeight + 15;

        for (let i = 0; i < numClouds; i++) {
            const imgIndex = Math.floor(Math.random() * CloudImages.images.length);
            const img = CloudImages.images[imgIndex];

            const screenX = (i / numClouds) * cloudAreaWidth - cloudAreaWidth / 3 + (Math.random() - 0.5) * 200;

            const yOffset = (50 + Math.random() * 1050) * (Math.random() < 0.5 ? -1 : 1);
            let screenY = lastY + yOffset;
            if (screenY < 15) screenY = 15 + Math.random() * 100;
            if (screenY > cloudAreaHeight) screenY = cloudAreaHeight - Math.random() * 100;
            lastY = screenY;

            const scale = 0.15 + Math.random() * 0.35;

            const normalizedScale = (scale - 0.15) / 0.35;
            const parallaxFactor = 0.15 + normalizedScale * 0.35;

            const opacity = 0.4 + normalizedScale * 0.35;

            const driftSpeed = -(14 + Math.random() * 22);

            this.clouds.push({
                screenX,
                screenY,
                scale,
                imgIndex,
                flipHorizontal: Math.random() < 0.5,
                sourceWidth: img.naturalWidth || img.width,
                sourceHeight: img.naturalHeight || img.height,
                parallaxFactor,
                opacity,
                driftSpeed,
                driftOffset: Math.random() * 5000
            });
        }

        this.clouds.sort((a, b) => a.scale - b.scale);
        this.cloudsGenerated = true;
    }

    renderClouds() {
        const background = this.world?.background;
        if (background === 'custom') return;
        if (!CloudImages.loaded) return;

        if (!this.cloudsGenerated) {
            this.generateClouds();
        }

        this.cloudTime += 1 / 60;

        let cloudColor;
        if (background === 'galaxy') {
            cloudColor = this.world?.cloudColorGalaxy || '#9382a8';
        } else {
            cloudColor = this.world?.cloudColorSky || '#ffffff';
        }

        if (!this._cloudCacheColor || this._cloudCacheColor !== cloudColor) {
            this._cloudCacheColor = cloudColor;
            this._preRenderCloudImages(cloudColor);
        }

        const viewWidth = this.camera.width / this.camera.zoom;
        const viewHeight = this.camera.height / this.camera.zoom;
        const cameraX = this.camera.x;
        const cameraY = this.camera.y;
        const wrapWidth = viewWidth * 3;

        let lastAlpha = -1;
        for (const cloud of this.clouds) {
            const cloudWidth = cloud._cachedWidth;
            const cloudHeight = cloud._cachedHeight;

            const driftX = cloud.driftOffset + this.cloudTime * cloud.driftSpeed;
            const parallaxX = -cameraX * cloud.parallaxFactor;
            const parallaxY = -cameraY * cloud.parallaxFactor;

            let screenX = cloud.screenX + driftX + parallaxX;
            const screenY = cloud.screenY + parallaxY;

            screenX = ((screenX % wrapWidth) + wrapWidth) % wrapWidth - viewWidth * 0.5;

            if (screenY + cloudHeight < -50 || screenY > viewHeight + 50) continue;
            if (screenX + cloudWidth < -50 || screenX > viewWidth + 50) continue;

            if (cloud.opacity !== lastAlpha) { this.ctx.globalAlpha = cloud.opacity; lastAlpha = cloud.opacity; }
            this.ctx.drawImage(cloud._cachedImage, 0, 0, cloud._cachedImage.width, cloud._cachedImage.height, screenX, screenY, cloud._cachedWidth, cloud._cachedHeight);
        }
        this.ctx.globalAlpha = 1;
    }

    _preRenderCloudImages(color) {
        const dpr = window.devicePixelRatio || 1;
        for (const cloud of this.clouds) {
            const w = Math.ceil(cloud.sourceWidth * cloud.scale) + 2;
            const h = Math.ceil(cloud.sourceHeight * cloud.scale) + 2;
            const offscreen = document.createElement('canvas');
            offscreen.width = w * dpr;
            offscreen.height = h * dpr;
            const offCtx = offscreen.getContext('2d');
            offCtx.scale(dpr, dpr);
            const img = CloudImages.images[cloud.imgIndex];
            const sw = img.naturalWidth || img.width;
            const sh = img.naturalHeight || img.height;
            if (cloud.flipHorizontal) {
                offCtx.save();
                offCtx.translate(w, 0);
                offCtx.scale(-1, 1);
                offCtx.drawImage(img, 0, 0, sw, sh, 0, 0, w, h);
                offCtx.restore();
            } else {
                offCtx.drawImage(img, 0, 0, sw, sh, 0, 0, w, h);
            }
            offCtx.globalCompositeOperation = 'source-in';
            offCtx.fillStyle = color;
            offCtx.fillRect(0, 0, w, h);
            cloud._cachedImage = offscreen;
            cloud._cachedWidth = w;
            cloud._cachedHeight = h;
        }
    }

    regenerateClouds() {
        this.cloudsGenerated = false;
        this.cloudTime = 0;
        this._cloudCacheColor = null;
    }

    setupCanvas() {
        // Make canvas always fill the viewport visually using CSS
        this.canvas.style.position = 'fixed';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100vw';
        this.canvas.style.height = '100vh';
        
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
        
        // Also handle visual viewport changes (for mobile and zoom)
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => this.resizeCanvas());
        }
        
        // Prevent browser zoom via Ctrl+wheel (use game zoom instead)
        document.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
            }
        }, { passive: false });
        
        // Prevent browser zoom via Ctrl+/- keys (use game zoom instead)
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '_')) {
                e.preventDefault();
            }
        });
    }

    resizeCanvas() {
        // Get the actual rendered size of the canvas (accounts for browser zoom)
        const rect = this.canvas.getBoundingClientRect();
        const dpr = 1;

        const width = Math.round(rect.width * dpr);
        const height = Math.round(rect.height * dpr);
        
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            
            // Scale the context to account for devicePixelRatio
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        
        // Camera uses CSS pixel dimensions (what the user sees)
        this.camera.width = rect.width;
        this.camera.height = rect.height;
    }

    setupInput() {
        // Keyboard
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        document.addEventListener('keyup', (e) => this.onKeyUp(e));
        window.addEventListener('blur', () => this.releaseKeyboardInput());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.releaseKeyboardInput();
        });
        
        // Mouse
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e));
        
        // Touch (passive: false to allow preventDefault for placement modes)
        this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        this.canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        
        // Prevent context menu
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    isTypingInInput() {
        const activeEl = document.activeElement;
        return activeEl && (
            activeEl.tagName === 'INPUT' || 
            activeEl.tagName === 'TEXTAREA' || 
            activeEl.contentEditable === 'true'
        );
    }

    onKeyDown(e) {
        // Don't capture keyboard for player/game when typing in input
        if (this.isTypingInInput()) {
            // Still emit for editor shortcuts (they have their own input check)
            if (this.onKeyPress) {
                this.onKeyPress(e);
            }
            return;
        }
        
        if (GAME_KEYS.has(e.code) || window.PluginManager?.hasEnabledControlKey(e.code)) {
            e.preventDefault();
        }
        
        this.keys[e.code] = true;
        
        // Let plugins handle keydown
        if (window.PluginManager && this.localPlayer) {
            window.PluginManager.executeHook('input.keydown', { 
                key: e.code, 
                player: this.localPlayer 
            });
        }
        
        // Update player input in all active modes (including editor)
        if (this.localPlayer) {
            this.updatePlayerInput();
        }
        
        // Emit for editor shortcuts
        if (this.onKeyPress) {
            this.onKeyPress(e);
        }
    }

    onKeyUp(e) {
        // Don't capture keyboard for player/game when typing in input
        if (this.isTypingInInput()) {
            if (this.keys[e.code] === true) this.releaseKeyboardKey(e.code);
            return;
        }
        this.releaseKeyboardKey(e.code);
    }

    releaseKeyboardKey(keyCode) {
        const wasPressed = this.keys[keyCode] === true;
        this.keys[keyCode] = false;
        if (!wasPressed) return;

        if (window.PluginManager && this.localPlayer) {
            window.PluginManager.executeHook('input.keyup', {
                key: keyCode,
                player: this.localPlayer
            });
        }
        if (this.localPlayer) this.updatePlayerInput();
    }

    releaseKeyboardInput() {
        const releasedKeys = Object.keys(this.keys).filter(keyCode => this.keys[keyCode] === true);
        if (releasedKeys.length === 0) return;

        for (const keyCode of releasedKeys) {
            this.keys[keyCode] = false;
            if (window.PluginManager && this.localPlayer) {
                window.PluginManager.executeHook('input.keyup', {
                    key: keyCode,
                    player: this.localPlayer
                });
            }
        }
        if (this.localPlayer) this.updatePlayerInput();
    }

    updatePlayerInput() {
        if (!this.localPlayer) return;
        
        const layout = (typeof Settings !== 'undefined' ? Settings.get('keyboardLayout') : null) || 'jimmyqrg';
        const k = this.keys;
        const inp = this.localPlayer.input;

        if (layout === 'hk') {
            inp.left = k['ArrowLeft'];
            inp.right = k['ArrowRight'];
            inp.up = k['ArrowUp'];
            inp.down = k['ArrowDown'];
            inp.jump = k['KeyZ'];
            inp.shift = k['ShiftLeft'] || k['ShiftRight'];
            inp.attack = k['KeyX'];
            inp.heal = k['KeyA'];
            inp.dash = k['KeyC'];
            inp.superDash = k['KeyS'];
        } else {
            inp.left = k['KeyA'];
            inp.right = k['KeyD'];
            inp.up = k['ArrowUp'];
            inp.down = k['ArrowDown'];
            inp.jump = k['KeyW'] || k['Space'];
            inp.shift = k['ShiftLeft'] || k['ShiftRight'];
            inp.attack = k['KeyN'];
            inp.heal = k['ShiftLeft'];
            inp.dash = k['Comma'];
            inp.superDash = k['KeyF'];
        }
        inp.space = !!k['Space'];

        // Flying always uses WASD regardless of layout
        if (this.localPlayer.isFlying) {
            inp.up = inp.up || k['KeyW'];
            inp.down = inp.down || k['KeyS'];
        }

        if (window.PluginManager) {
            window.PluginManager.updatePlayerControls(this.localPlayer, k);
        }
        
        if (window.PluginManager) {
            if (!this._inputHookData) this._inputHookData = {};
            this._inputHookData.player = this.localPlayer;
            this._inputHookData.keys = k;
            this._inputHookData.layout = layout;
            window.PluginManager.executeHook('input.update', this._inputHookData);
        }
    }

    onMouseMove(e) {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        
        if (this.onMouseMoveCallback) {
            this.onMouseMoveCallback(e);
        }
    }

    onMouseDown(e) {
        this.mouse.down = true;
        this.mouse.button = e.button;
        
        if (this.onMouseDownCallback) {
            this.onMouseDownCallback(e);
        }
    }

    onMouseUp(e) {
        this.mouse.down = false;
        
        if (this.onMouseUpCallback) {
            this.onMouseUpCallback(e);
        }
    }

    onWheel(e) {
        // Ctrl+Scroll zoom available in all modes (limits are set based on mode)
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            
            // Get the center point for zoom (player position if available, otherwise screen center)
            let centerX, centerY;
            if (this.localPlayer) {
                centerX = this.localPlayer.x + this.localPlayer.width / 2;
                centerY = this.localPlayer.y + this.localPlayer.height / 2;
            } else {
                // Use screen center as fallback
                centerX = this.camera.x + this.camera.width / 2 / this.camera.zoom;
                centerY = this.camera.y + this.camera.height / 2 / this.camera.zoom;
            }
            
            // Ctrl+Shift+Scroll: Reset zoom to default
            if (e.shiftKey) {
                this.camera.setZoom(this.camera.defaultZoom, centerX, centerY);
            } else {
                // Scale zoom amount based on deltaY for smoother trackpad zoom
                // Limit to small increments for smooth zooming
                const zoomAmount = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) * 0.002, 0.1);
                this.camera.setZoom(this.camera.zoom - zoomAmount, centerX, centerY);
            }
        }
        
        if (this.onWheelCallback) {
            this.onWheelCallback(e);
        }
    }

    onTouchStart(e) {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            this.mouse.x = touch.clientX;
            this.mouse.y = touch.clientY;
            this.mouse.down = true;
            this.mouse.button = 0; // Simulate left click
            
            // Store last touch position for movement calculation
            this._lastTouchX = touch.clientX;
            this._lastTouchY = touch.clientY;
            
            // Prevent scrolling in editor mode
            if (this.state === GameState.EDITOR) {
                e.preventDefault();
            }
            
            // Call editor callback with synthetic mouse event
            if (this.onMouseDownCallback) {
                const syntheticEvent = {
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    button: 0,
                    movementX: 0,
                    movementY: 0,
                    preventDefault: () => e.preventDefault(),
                    stopPropagation: () => e.stopPropagation()
                };
                this.onMouseDownCallback(syntheticEvent);
            }
        }
    }

    onTouchMove(e) {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            const movementX = touch.clientX - (this._lastTouchX || touch.clientX);
            const movementY = touch.clientY - (this._lastTouchY || touch.clientY);
            
            this.mouse.x = touch.clientX;
            this.mouse.y = touch.clientY;
            
            this._lastTouchX = touch.clientX;
            this._lastTouchY = touch.clientY;
            
            // Prevent scrolling in editor mode
            if (this.state === GameState.EDITOR) {
                e.preventDefault();
            }
            
            // Call editor callback with synthetic mouse event
            if (this.onMouseMoveCallback) {
                const syntheticEvent = {
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    movementX: movementX,
                    movementY: movementY,
                    preventDefault: () => e.preventDefault(),
                    stopPropagation: () => e.stopPropagation()
                };
                this.onMouseMoveCallback(syntheticEvent);
            }
        }
    }

    onTouchEnd(e) {
        this.mouse.down = false;
        
        // Prevent scrolling in editor mode
        if (this.state === GameState.EDITOR) {
            e.preventDefault();
        }
        
        // Call editor callback with synthetic mouse event
        if (this.onMouseUpCallback) {
            const syntheticEvent = {
                clientX: this._lastTouchX || this.mouse.x,
                clientY: this._lastTouchY || this.mouse.y,
                button: 0,
                preventDefault: () => e.preventDefault(),
                stopPropagation: () => e.stopPropagation()
            };
            this.onMouseUpCallback(syntheticEvent);
        }
        
        // Clear last touch position
        this._lastTouchX = null;
        this._lastTouchY = null;
    }

    setTouchInput(direction, pressed) {
        if (!this.localPlayer) return;
        
        switch (direction) {
            case 'up':
                this.localPlayer.input.up = pressed;
                this.localPlayer.input.jump = pressed;
                break;
            case 'down':
                this.localPlayer.input.down = pressed;
                break;
            case 'left':
                this.localPlayer.input.left = pressed;
                break;
            case 'right':
                this.localPlayer.input.right = pressed;
                break;
            case 'jump':
                this.localPlayer.input.jump = pressed;
                break;
            case 'attack':
                this.localPlayer.input.attack = pressed;
                break;
            case 'dash':
                this.localPlayer.input.dash = pressed;
                break;
            case 'heal':
                this.localPlayer.input.heal = pressed;
                break;
            default: {
                if (direction.startsWith('plugin:')) {
                    window.PluginManager?.setPlayerTouchControl(this.localPlayer, direction.slice('plugin:'.length), pressed);
                }
                break;
            }
        }
    }

    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.lastTime = null; // Will be set on first frame to match rAF timing
        this.accumulator = 0;
        // Fixed timestep: 60 ticks per second
        this.fixedDeltaTime = 1 / 60;
        // Maximum physics updates per frame to prevent spiral of death
        this.maxUpdatesPerFrame = 3;
        // Bind once to avoid creating new functions every frame
        this._boundGameLoop = this._boundGameLoop || this.gameLoop.bind(this);
        requestAnimationFrame(this._boundGameLoop);
    }

    stop() {
        this.isRunning = false;
    }

    gameLoop(currentTime) {
        if (!this.isRunning) return;
        
        if (this.lastTime === null) {
            this.lastTime = currentTime;
            this._fpsFrames = 0;
            this._fpsTime = currentTime;
            this._fpsDisplay = 0;
            requestAnimationFrame(this._boundGameLoop);
            return;
        }
        
        // FPS tracking
        this._fpsFrames++;
        if (currentTime - this._fpsTime >= 1000) {
            this._fpsDisplay = Math.round(this._fpsFrames * 1000 / (currentTime - this._fpsTime));
            this._fpsFrames = 0;
            this._fpsTime = currentTime;
        }
        
        let deltaTime = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;
        
        if (deltaTime > 0.1) deltaTime = 0.1;
        
        this.accumulator += deltaTime;
        
        const maxAccumulator = this.fixedDeltaTime * this.maxUpdatesPerFrame;
        if (this.accumulator > maxAccumulator) {
            this.accumulator = maxAccumulator;
        }
        
        let updateCount = 0;
        while (this.accumulator >= this.fixedDeltaTime && updateCount < this.maxUpdatesPerFrame) {
            this.update(this.fixedDeltaTime);
            this.accumulator -= this.fixedDeltaTime;
            updateCount++;
        }
        
        if (!this.mechanicsWorldPaused || this.mechanicsPauseNeedsRender) {
            this.render();
            this.mechanicsPauseNeedsRender = false;
        }
        
        requestAnimationFrame(this._boundGameLoop);
    }

    update(deltaTime) {
        if (this.mechanicsWorldPaused && [GameState.PLAYING, GameState.TESTING].includes(this.state)) return;
        // Rebuild spatial hash once per update (lazy — only if dirty)
        if (this.world) this.world.rebuildSpatialHash();
        
        const isPlaying = this.state === GameState.PLAYING || this.state === GameState.TESTING;
        
        if (isPlaying) {
            if (this.localPlayer) {
                if (this.localPlayer._mechanicsDialogueOpen) {
                    for (const key of Object.keys(this.localPlayer.input || {})) this.localPlayer.input[key] = false;
                    this.localPlayer.vx = 0;
                    this.localPlayer.vy = 0;
                }
                if (window.PluginManager) {
                    if (!this._updateHookData) this._updateHookData = {};
                    this._updateHookData.player = this.localPlayer;
                    this._updateHookData.world = this.world;
                    this._updateHookData.audioManager = this.audioManager;
                    this._updateHookData.deltaTime = deltaTime;
                    this._updateHookData.skipPhysics = false;
                    const result = window.PluginManager.executeHook('player.update', this._updateHookData);
                    if (this.mechanicsWorldPaused) return;
                    
                    if (!result.skipPhysics) {
                        this.localPlayer.update(this.world, this.audioManager);
                    } else {
                        this.localPlayer.moveWithCollision(this.world);
                    }
                } else {
                    this.localPlayer.update(this.world, this.audioManager);
                }
                
                // Die line check
                const dieLineY = this.world.dieLineY ?? 1000;
                const voidInvinciblePromptIntervalMs = 30000;
                if (!this.localPlayer._mechanicsDialogueOpen && this.localPlayer.y > dieLineY) {
                    if (this.invincibilityEnabled) {
                        const now = performance.now();
                        const due =
                            this._voidInvincibleLastPromptTime == null ||
                            now - this._voidInvincibleLastPromptTime >= voidInvinciblePromptIntervalMs;
                        if (due && !this._voidConfirmShowing) {
                            this._voidConfirmShowing = true;
                            const doTP = confirm('You fell into the void. Teleport back?');
                            this._voidConfirmShowing = false;
                            this._voidInvincibleLastPromptTime = performance.now();
                            if (doTP) {
                                this.respawnPlayer();
                                if (window.PluginManager) {
                                    if (!this._respawnData) this._respawnData = {};
                                    this._respawnData.player = this.localPlayer;
                                    this._respawnData.world = this.world;
                                    window.PluginManager.executeHook('player.respawn', this._respawnData);
                                }
                            }
                        }
                    } else if (window.PluginManager) {
                        if (!this._voidSource) this._voidSource = { type: 'void', actingType: 'void' };
                        if (!this._damageData) this._damageData = {};
                        this._damageData.player = this.localPlayer;
                        this._damageData.source = this._voidSource;
                        this._damageData.world = this.world;
                        this._damageData.preventDefault = false;
                        const result = window.PluginManager.executeHook('player.damage', this._damageData);
                        if (!result.preventDefault) {
                            this.localPlayer.die(this.world, this._voidSource);
                        }
                    } else {
                        this.localPlayer.die(this.world, this._voidSource);
                    }
                } else {
                    this._voidInvincibleLastPromptTime = null;
                }
                
                // Respawn
                if (!this.localPlayer._mechanicsDialogueOpen && this.localPlayer.isDead) {
                    this.respawnPlayer();
                    if (window.PluginManager) {
                        if (!this._respawnData) this._respawnData = {};
                        this._respawnData.player = this.localPlayer;
                        this._respawnData.world = this.world;
                        window.PluginManager.executeHook('player.respawn', this._respawnData);
                    }
                }
                
                if (!this.localPlayer._mechanicsDialogueOpen) this.checkSpecialCollisions();
                this.camera.follow(this.localPlayer,
                    this.world?._mechanicsCameraFollowMode || this.world?.cameraFollowMode || 'both');
            }
            
            // Remote player prediction
            for (const player of this.remotePlayers.values()) {
                if (player._adminDragged) continue;
                if (player.lastUpdateTime && player.vx !== undefined) {
                    const timeSinceUpdate = (performance.now() - player.lastUpdateTime) / 1000;
                    if (timeSinceUpdate < 0.2) {
                        const predictedX = player.serverX + player.vx * timeSinceUpdate;
                        const predictedY = player.serverY + player.vy * timeSinceUpdate;
                        player.x += (predictedX - player.x) * 0.2;
                        player.y += (predictedY - player.y) * 0.2;
                    }
                }
            }
            
            // Particles only in play mode
            this.updateParticles(deltaTime);
            this.updatePortalParticles(deltaTime);

            // Walking particles
            if (this.localPlayer && !this.localPlayer.isDead) {
                this._walkParticleTimer += deltaTime;
                if (this._walkParticleTimer >= 0.06) {
                    this._walkParticleTimer = 0;
                    this.spawnWalkParticles(this.localPlayer);
                }
            }
        } else if (this.state === GameState.EDITOR) {
            if (this.localPlayer) {
                if (this.localPlayer.isFlying) {
                    this.localPlayer.updateFlying(this.world, true);
                } else {
                    this.localPlayer.updatePhysics(this.world, null, true);
                    this.checkBouncerCollisions();
                }
                this.camera.follow(this.localPlayer);
            }
        }
        
        const activeCameraBounds = this.world && Object.prototype.hasOwnProperty.call(this.world, '_mechanicsCameraBounds')
            ? this.world._mechanicsCameraBounds
            : this.world?.cameraBounds;
        const cameraBounds = (this.state === GameState.PLAYING || this.state === GameState.TESTING) &&
            activeCameraBounds?.enabled === true
            ? activeCameraBounds
            : null;
        this.camera.update(
            this.world?.cameraLerpX ?? CAMERA_LERP_X,
            this.world?.cameraLerpY ?? CAMERA_LERP_Y,
            cameraBounds
        );
    }

    setPlayerCheckpoint(player, checkpoint, { playEffects = false, fireHook = true } = {}) {
        if (player !== this.localPlayer || !checkpoint || checkpoint.actingType !== 'checkpoint' ||
            checkpoint._mechanicsEnabled === false || this.world?.getObjectById?.(checkpoint.id) !== checkpoint) return false;

        const previousCheckpoint = this.lastCheckpoint;
        if (previousCheckpoint && previousCheckpoint !== checkpoint) previousCheckpoint.checkpointState = 'touched';
        checkpoint.checkpointState = 'active';
        this.lastCheckpoint = checkpoint;
        this._onCheckpointObj = checkpoint;
        if (this.state === GameState.PLAYING && this.world.persistCheckpoints && previousCheckpoint !== checkpoint) {
            window.ParkoreenLocalSave?.write?.(this.world, 'checkpoint', { checkpointId: checkpoint.id });
        }

        if (fireHook && window.PluginManager) {
            if (!this._cpHookData) this._cpHookData = {};
            this._cpHookData.player = player;
            this._cpHookData.world = this.world;
            this._cpHookData.checkpoint = checkpoint;
            window.PluginManager.executeHook('player.checkpoint', this._cpHookData);
        }
        if (playEffects) {
            const centerX = checkpoint.x + checkpoint.width / 2;
            const centerY = checkpoint.y + checkpoint.height / 2;
            this.spawnCheckpointParticles(centerX, centerY, this.world.checkpointActiveColor);
            this.audioManager?.play?.('checkpoint');
        }
        return true;
    }

    restoreSavedPlayerCheckpoint() {
        if (!this.world?.persistCheckpoints) return null;
        const saved = window.ParkoreenLocalSave?.read?.(this.world, 'checkpoint');
        const checkpoint = typeof saved?.checkpointId === 'string'
            ? this.world.getObjectById?.(saved.checkpointId)
            : null;
        if (!checkpoint || checkpoint.actingType !== 'checkpoint' || checkpoint._mechanicsEnabled === false) return null;
        checkpoint.checkpointState = 'active';
        this.lastCheckpoint = checkpoint;
        this._onCheckpointObj = null;
        return checkpoint;
    }

    checkSpecialCollisions() {
        if (!this.localPlayer || this.localPlayer.isDead) return;
        
        const playerBox = this.localPlayer.getGroundTouchbox();
        let onCheckpoint = false;
        
        // Checkpoint and endpoint hooks can run Mechanics events that query
        // the world again. queryNear may reuse its spatial-hash result array,
        // so keep this interaction scan stable across hook dispatch.
        const nearby = this.world.queryNear(playerBox.x, playerBox.y, playerBox.width, playerBox.height).slice();
        for (let ni = 0; ni < nearby.length; ni++) {
            const obj = nearby[ni];
            if (obj.actingType !== 'checkpoint' && obj.actingType !== 'endpoint') continue;
            if (obj._mechanicsEnabled === false) continue;
            if (!this.localPlayer.boxIntersects(playerBox, obj)) continue;
            
            if (obj.actingType === 'checkpoint') {
                onCheckpoint = true;

                const isNewContact = !this._onCheckpointObj || this._onCheckpointObj !== obj;
                // Fire the plugin hook every frame while touching (for continuous checkpoint effects).
                this.setPlayerCheckpoint(this.localPlayer, obj, { playEffects: isNewContact });
            } else if (obj.actingType === 'endpoint') {
                const requireCoins = !!obj.endpointRequireCoins;
                if (requireCoins) {
                    const totalCoins = this.world.objects.filter(o => o.appearanceType === 'coin' && o._mechanicsEnabled !== false).length;
                    let requiredCoins = Number.isFinite(obj.endpointRequiredCoins)
                        ? Math.max(0, Math.floor(obj.endpointRequiredCoins))
                        : totalCoins;
                    requiredCoins = Math.min(requiredCoins, totalCoins);
                    const collectedCoins = this.world.objects.filter(o => o.appearanceType === 'coin' && o._mechanicsEnabled !== false &&
                        this.isCoinCollectedForLocalPlayer(o, this.world)).length;
                    if (collectedCoins < requiredCoins) {
                        continue;
                    }
                }
                if (this.audioManager) this.audioManager.play('endpoint');
                this.onGameEnd();
            }
        }
        
        // Clear contact tracking when player leaves all checkpoints
        if (!onCheckpoint) {
            this._onCheckpointObj = null;
        }
        
        // Check for quick direction changes on checkpoint to reset jumps
        // Works for both left→right AND right→left direction changes
        if (onCheckpoint && this.localPlayer.directionChangeCount >= 1) {
            const now = Date.now();
            // If direction change within 500ms while on checkpoint, reset jumps
            if (now - this.localPlayer.directionChangeWindowStart <= 500) {
                this.localPlayer.resetJumps();
                this.localPlayer.directionChangeCount = 0;
                this.localPlayer.directionChangeWindowStart = now;
            }
        }
        
        // Check for button collisions
        this.checkButtonCollisions();

        // Check for teleportal collisions
        this.checkTeleportalCollisions();

        // Check for bouncer collisions
        this.checkBouncerCollisions();

        // Check for coin collisions
        this.checkCoinCollisions();
    }
    
    checkButtonCollisions() {
        if (!this.localPlayer || this.localPlayer.isDead) return;
        
        const playerBox = this.localPlayer.getGroundTouchbox();
        
        // A button hook may synchronously run an Event with nested world
        // queries; don't let those queries replace the remaining button hits.
        const nearby = this.world.queryNear(playerBox.x, playerBox.y, playerBox.width, playerBox.height).slice();
        for (let ni = 0; ni < nearby.length; ni++) {
            const obj = nearby[ni];
            if (obj.appearanceType !== 'button' || obj.actingType !== 'button') continue;
            if (obj._mechanicsEnabled === false) {
                obj._playerInside = false;
                if (document.getElementById('game-button-ui')?.dataset.objectId === obj.id) {
                    document.getElementById('game-button-ui')?.remove();
                }
                continue;
            }
            if (!this.localPlayer.boxIntersects(playerBox, obj)) {
                // Player left the button zone — mark as not inside
                if (obj._playerInside) {
                    obj._playerInside = false;
                }
                continue;
            }
            
            // Player is inside this button zone
            if (!obj._playerInside) {
                obj._playerInside = true;
                if (obj.buttonInteraction === 'collide') {
                    // Only trigger if not yet spent (for onlyOnce buttons)
                    if (!obj.buttonOnlyOnce || !obj._triggered) {
                        if (obj.buttonOnlyOnce) obj._triggered = true;
                        // Immediate trigger — no popup
                        if (this.audioManager) this.audioManager.play('button');
                        if (window.PluginManager) {
                            window.PluginManager.executeHook('button.pressed', {
                                button: obj,
                                player: this.localPlayer,
                                world: this.world
                            });
                        }
                    }
                } else {
                    this.showButtonUI(obj);
                }
            }
        }
    }
    
    showButtonUI(buttonObj) {
        // Don't show if this is a one-time button already triggered
        if (buttonObj.buttonOnlyOnce && buttonObj._triggered) return;
        // Don't show if one is already visible for this button
        if (document.getElementById('game-button-ui')) return;
        
        const overlay = document.createElement('div');
        overlay.id = 'game-button-ui';
        overlay.dataset.objectId = buttonObj.id;
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            display: flex; align-items: center; justify-content: center;
            z-index: 9999; pointer-events: none;
        `;
        
        const panel = document.createElement('div');
        panel.style.cssText = `
            background: rgba(15, 15, 30, 0.95); border: 1px solid rgba(59, 130, 246, 0.5);
            border-radius: 16px; padding: 32px 40px; max-width: 420px; width: 90%;
            box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 30px rgba(59, 130, 246, 0.15);
            pointer-events: all; cursor: pointer; position: relative;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
        `;
        
        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = `
            position: absolute; top: 12px; right: 12px; background: rgba(255,255,255,0.1);
            border: none; color: #aaa; width: 32px; height: 32px; border-radius: 8px;
            cursor: pointer; display: flex; align-items: center; justify-content: center;
            font-size: 18px; transition: background 0.15s;
        `;
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = 'rgba(255,255,255,0.2)'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'rgba(255,255,255,0.1)'; });
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            overlay.remove();
        });
        
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 12px; padding-right: 30px;';
        title.textContent = buttonObj.displayName || 'Button';
        
        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 14px; color: rgba(255,255,255,0.7); line-height: 1.6; white-space: pre-wrap;';
        desc.textContent = buttonObj.displayDescription || '';
        
        panel.appendChild(closeBtn);
        panel.appendChild(title);
        if (buttonObj.displayDescription) panel.appendChild(desc);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        
        // Hover effect
        panel.addEventListener('mouseenter', () => {
            panel.style.transform = 'scale(1.02)';
            panel.style.boxShadow = '0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(59, 130, 246, 0.25)';
        });
        panel.addEventListener('mouseleave', () => {
            panel.style.transform = '';
            panel.style.boxShadow = '';
        });
        
        // Click panel (not close) = trigger
        panel.addEventListener('click', () => {
            overlay.remove();
            if (buttonObj._mechanicsEnabled === false || this.world?.getObjectById?.(buttonObj.id) !== buttonObj) return;
            if (buttonObj.buttonOnlyOnce) buttonObj._triggered = true;
            if (this.audioManager) this.audioManager.play('button');
            // Fire button trigger via plugin hook
            if (window.PluginManager) {
                window.PluginManager.executeHook('button.pressed', {
                    button: buttonObj,
                    player: this.localPlayer,
                    world: this.world
                });
            }
        });
    }
    
    checkTeleportalCollisions() {
        if (!this.localPlayer || this.localPlayer.isDead) return;
        
        // Cooldown to prevent instant re-teleporting
        const now = Date.now();
        if (this.lastTeleportTime && now - this.lastTeleportTime < 500) return;
        
        const playerBox = this.localPlayer.getGroundTouchbox();
        const pad = 6;
        
        const nearby = this.world.queryNear(playerBox.x - pad, playerBox.y - pad, playerBox.width + pad * 2, playerBox.height + pad * 2);
        if (!this._tpBox) this._tpBox = { x: 0, y: 0, width: 0, height: 0 };
        for (let ni = 0; ni < nearby.length; ni++) {
            const obj = nearby[ni];
            if (obj._mechanicsEnabled === false) continue;
            if (obj.type !== 'teleportal') continue;
            if (obj.actingType !== 'portal') continue;
            if (!obj.teleportalName) continue;
            this._tpBox.x = obj.x - pad;
            this._tpBox.y = obj.y - pad;
            this._tpBox.width = obj.width + pad * 2;
            this._tpBox.height = obj.height + pad * 2;
            if (!this.localPlayer.boxIntersects(playerBox, this._tpBox)) continue;
            
            // Check if this portal has valid send connections
            for (const conn of obj.sendTo) {
                const targetName = conn?.name || conn;
                const isEnabled = conn?.enabled !== false;
                if (!targetName || !isEnabled) continue;
                
                const teleportals = this.world.getTeleportals();
                let targetPortal = null;
                for (let ti = 0; ti < teleportals.length; ti++) {
                    const p = teleportals[ti];
                    if (p.actingType === 'portal' && p.teleportalName === targetName) {
                        targetPortal = p;
                        break;
                    }
                }
                
                if (!targetPortal) continue;
                
                // Check if it's a valid two-way connection (target receives from this portal and is enabled)
                const receiveConn = targetPortal.receiveFrom.find(c => (c?.name || c) === obj.teleportalName);
                const isValid = receiveConn && receiveConn?.enabled !== false;
                
                if (isValid) {
                    // Teleport the player to the target portal
                    const targetX = targetPortal.x + targetPortal.width / 2 - this.localPlayer.width / 2;
                    const targetY = targetPortal.y + targetPortal.height / 2 - this.localPlayer.height / 2;
                    
                    this.localPlayer.x = targetX;
                    this.localPlayer.y = targetY;
                    this.localPlayer._mechanicsTeleportSerial = (this.localPlayer._mechanicsTeleportSerial || 0) + 1;
                    this.lastTeleportTime = now;
                    
                    // Spawn teleport particles at destination
                    const particleMaxAlpha = (obj.particleOpacity !== undefined ? obj.particleOpacity : 100) / 100;
                    this.spawnTeleportParticles(targetX + this.localPlayer.width / 2, targetY + this.localPlayer.height / 2, obj.color, particleMaxAlpha);
                    
                    return; // Only teleport once per frame
                }
            }
        }
    }

    getPlayerScopedCoinCollection(world = this.world) {
        const mapId = world?.mechanicsSaveId || world?.mapName || '__current-map__';
        let collection = this.playerScopedCoinCollections.get(mapId);
        if (!collection) {
            collection = new Set();
            this.playerScopedCoinCollections.set(mapId, collection);
        }
        return collection;
    }

    isCoinCollectedForLocalPlayer(coinOrId, world = this.world) {
        const coin = typeof coinOrId === 'string' ? world?.getObjectById?.(coinOrId) : coinOrId;
        if (!coin?.id) return false;
        return coin.coinActivityScope === 'player'
            ? this.getPlayerScopedCoinCollection(world).has(coin.id)
            : coin._collected === true || this.globalCoinCollectionIds.has(coin.id) || this.globalCoinCollectionPending.has(coin.id);
    }

    applyGlobalCoinCollection(coinId) {
        if (typeof coinId !== 'string' || !coinId || this.globalCoinCollectionIds.has(coinId)) return false;
        const coin = this.world.getObjectById(coinId);
        if (!coin || coin.appearanceType !== 'coin' || coin.coinActivityScope === 'player') return false;
        this.globalCoinCollectionPending.delete(coinId);
        this.globalCoinCollectionIds.add(coinId);
        coin._collected = true;
        this.coinsCollected = (this.coinsCollected || 0) + (typeof coin.coinAmount === 'number' ? coin.coinAmount : 1);
        if (this.audioManager) this.audioManager.play('coin');
        const cx = coin.x + coin.width / 2;
        const cy = coin.y + coin.height / 2;
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const speed = 50 + Math.random() * 50;
            this.particles.push({
                x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                life: 0.5 + Math.random() * 0.3, maxLife: 0.5 + Math.random() * 0.3,
                size: 3 + Math.random() * 3, color: '#f5c518'
            });
        }
        this.updateCoinCounterUI();
        return true;
    }

    applyGlobalCoinCollections(coinIds) {
        if (!Array.isArray(coinIds)) return;
        for (const coinId of coinIds) this.applyGlobalCoinCollection(coinId);
    }

    rejectGlobalCoinCollection(coinId) {
        if (typeof coinId === 'string') this.globalCoinCollectionPending.delete(coinId);
    }

    checkCoinCollisions() {
        if (!this.localPlayer || this.localPlayer.isDead) return;
        const playerBox = this.localPlayer.getGroundTouchbox();
        const nearby = this.world.queryNear(playerBox.x, playerBox.y, playerBox.width, playerBox.height);
        let anyCollected = false;
        for (let ni = 0; ni < nearby.length; ni++) {
            const obj = nearby[ni];
            if (obj.appearanceType !== 'coin') continue;
            if (obj._mechanicsEnabled === false) continue;
            if (this.isCoinCollectedForLocalPlayer(obj, this.world)) continue;
            if (!this.localPlayer.boxIntersects(playerBox, obj)) continue;
            if (obj.coinActivityScope !== 'player' && window.MultiplayerManager?.roomCode) {
                this.globalCoinCollectionPending.add(obj.id);
                if (!window.MultiplayerManager.requestGlobalCoinCollection?.(obj.id)) {
                    this.globalCoinCollectionPending.delete(obj.id);
                }
                continue;
            }
            if (obj.coinActivityScope === 'player') this.getPlayerScopedCoinCollection(this.world).add(obj.id);
            else obj._collected = true;
            this.coinsCollected = (this.coinsCollected || 0) + (typeof obj.coinAmount === 'number' ? obj.coinAmount : 1);
            anyCollected = true;
            // Play coin sound
            if (this.audioManager) this.audioManager.play('coin');
            // Collect sparkle particles
            const cx = obj.x + obj.width / 2;
            const cy = obj.y + obj.height / 2;
            for (let i = 0; i < 8; i++) {
                const angle = (i / 8) * Math.PI * 2;
                const speed = 50 + Math.random() * 50;
                this.particles.push({
                    x: cx, y: cy,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    life: 0.5 + Math.random() * 0.3,
                    maxLife: 0.5 + Math.random() * 0.3,
                    size: 3 + Math.random() * 3,
                    color: '#f5c518'
                });
            }
        }
        if (anyCollected) this.updateCoinCounterUI();
    }

    checkBouncerCollisions() {
        if (!this.localPlayer || this.localPlayer.isDead) return;

        const now = Date.now();
        // Per-object cooldown of 200ms to prevent immediate re-trigger
        const BOUNCER_COOLDOWN = 200;

        const playerBox = this.localPlayer.getGroundTouchbox();
        const nearby = this.world.queryNear(playerBox.x, playerBox.y, playerBox.width, playerBox.height);

        for (let ni = 0; ni < nearby.length; ni++) {
            const obj = nearby[ni];
            if (obj.actingType !== 'bouncer') continue;
            if (obj._mechanicsEnabled === false) continue;
            if (!this.localPlayer.boxIntersects(playerBox, obj)) continue;

            // Cooldown check
            if (obj._lastBounceTime && now - obj._lastBounceTime < BOUNCER_COOLDOWN) continue;

            const strength = typeof obj.bouncerStrength === 'number' ? obj.bouncerStrength : 20;
            const bouncerDir = typeof obj.bouncerDirection === 'number' ? obj.bouncerDirection : 0;

            // Reset any previous pogo/hit upward state when a bouncer redirects motion.
            // This ensures controlled jump logic can re-evaluate the new upward velocity.
            this.localPlayer._pogoJumping = false;
            this.localPlayer._hitUpward = false;

            if (bouncerDir === 90) { // right
                this.localPlayer.vx = strength;
                this.localPlayer.vy = 0;
                this.localPlayer.isOnGround = false;
            } else if (bouncerDir === 180) { // down
                this.localPlayer.vy = strength;
                this.localPlayer.isOnGround = false;
            } else if (bouncerDir === 270) { // left
                this.localPlayer.vx = -strength;
                this.localPlayer.vy = 0;
                this.localPlayer.isOnGround = false;
            } else { // 0 = up (default)
                this.localPlayer.vy = -strength;
                this.localPlayer.isOnGround = false;
            }

            // Spring animation state
            const BOUNCE_ANIM_DURATION = 700;
            if (obj._bounceAnimStart && now - obj._bounceAnimStart < BOUNCE_ANIM_DURATION) {
                obj._bounceIntensity = Math.min((obj._bounceIntensity || 1) + 0.6, 3.5);
            } else {
                obj._bounceIntensity = 1;
            }
            obj._bounceAnimStart = now;

            obj._lastBounceTime = now;
            if (this.audioManager) this.audioManager.play('bounce');

            // Spawn a small burst of particles at the bounce point
            const cx = obj.x + obj.width / 2;
            const cy = obj.y;
            const color = obj.color || '#f59e0b';
            for (let i = 0; i < 8; i++) {
                const angle = -Math.PI + (i / 8) * Math.PI; // upward arc
                const speed = 60 + Math.random() * 40;
                this.particles.push({
                    x: cx,
                    y: cy,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    life: 0.4 + Math.random() * 0.2,
                    maxLife: 0.4 + Math.random() * 0.2,
                    size: 3 + Math.random() * 3,
                    color: color
                });
            }

            break; // Only one bouncer per frame
        }
    }

    spawnTeleportParticles(x, y, color, maxAlpha = 1) {
        // Create a burst of particles at teleport destination
        const particleCount = 12;
        for (let i = 0; i < particleCount; i++) {
            const angle = (i / particleCount) * Math.PI * 2;
            const speed = 80 + Math.random() * 40;
            this.particles.push({
                x: x,
                y: y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1,
                decay: 0.018 + Math.random() * 0.01,
                maxAlpha: maxAlpha,
                size: 4 + Math.random() * 4,
                color: color || '#9b59b6',
                shape: 'circle'
            });
        }
    }

    respawnPlayer() {
        if (!this.localPlayer) return;
        
        let spawnX, spawnY;
        
        if (this.lastCheckpoint) {
            spawnX = this.lastCheckpoint.x + this.lastCheckpoint.width / 2 - PLAYER_SIZE / 2;
            spawnY = this.lastCheckpoint.y - PLAYER_SIZE;
        } else if (this.world.spawnPoint) {
            spawnX = this.world.spawnPoint.x + this.world.spawnPoint.width / 2 - PLAYER_SIZE / 2;
            spawnY = this.world.spawnPoint.y - PLAYER_SIZE;
        } else {
            spawnX = 100;
            spawnY = 100;
        }
        
        this._onCheckpointObj = null;
        this.localPlayer.respawn(spawnX, spawnY);
    }

    onGameEnd() {
        if (this.state === GameState.ENDED) return;
        // Set game state to ended
        const previousState = this.state;
        this._endedFromState = previousState;
        this.state = GameState.ENDED;
        if (typeof window.CodePluginReset === 'function') {
            window.CodePluginReset({ world: this.world, preserveTriggerState: true });
        }
        
        // Calculate time elapsed
        const endTime = Date.now();
        const elapsedMs = endTime - this.gameStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        const milliseconds = elapsedMs % 1000;

        // Completion triggers run once after runtime cleanup and before the
        // results callback is shown.
        if (window.PluginManager) {
            window.PluginManager.executeHook('game.ended', {
                player: this.localPlayer,
                world: this.world,
                elapsedMs,
                wasTestMode: previousState === GameState.TESTING
            });
        }
        
        const timeString = minutes > 0 
            ? `${minutes}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`
            : `${seconds}.${milliseconds.toString().padStart(3, '0')}s`;
        
        // Call callback with time info
        if (this.onGameEndCallback) {
            this.onGameEndCallback({
                time: timeString,
                elapsedMs: elapsedMs,
                wasTestMode: previousState === GameState.TESTING,
                playerName: this.localPlayer?.name || 'Player'
            });
        }
    }

    render() {
        this.ctx.clearRect(0, 0, this.camera.width, this.camera.height);
        
        this.ctx.save();
        this.ctx.scale(this.camera.zoom, this.camera.zoom);
        
        const isPlaying = this.state === GameState.PLAYING || this.state === GameState.TESTING;
        const isEditor = this.state === GameState.EDITOR;
        let cameraOffsetX = 0;
        let cameraOffsetY = 0;
        if (isPlaying && window.PluginManager) {
            const cameraFeedback = {
                camera: Object.freeze({ ...this.camera }),
                player: this.localPlayer,
                world: this.world,
                offsetX: 0,
                offsetY: 0
            };
            window.PluginManager.executeHook('render.camera', cameraFeedback);
            const maxCameraFeedback = 24;
            cameraOffsetX = Number.isFinite(cameraFeedback.offsetX)
                ? Math.max(-maxCameraFeedback, Math.min(maxCameraFeedback, cameraFeedback.offsetX)) : 0;
            cameraOffsetY = Number.isFinite(cameraFeedback.offsetY)
                ? Math.max(-maxCameraFeedback, Math.min(maxCameraFeedback, cameraFeedback.offsetY)) : 0;
            // Apply visual feedback to this frame's scene transform only. The
            // live camera stays stable for movement, editor state, and input.
            this.ctx.translate(cameraOffsetX / this.camera.zoom, cameraOffsetY / this.camera.zoom);
        }
        if (isPlaying && !this.world._tileCacheReady) this.world.buildTileCache();
        const useTileCache = isPlaying && this.world._tileCacheReady;
        
        if (isPlaying) {
            this.renderClouds();
        }
        
        if (useTileCache) {
            // Fast path: draw pre-rendered tiles + only dynamic objects per frame
            if (!this._cpColors) this._cpColors = {};
            this._cpColors.default = this.world.checkpointDefaultColor;
            this._cpColors.active = this.world.checkpointActiveColor;
            this._cpColors.touched = this.world.checkpointTouchedColor;
            
            const drawLayers = this.world.getRenderLayerDepths();
            
            // Draw every layer before the player, preserving the built-in depth split.
            for (const depth of drawLayers.behindPlayer) {
                this.world.renderTiles(this.ctx, this.camera, [depth]);
                this.world.renderAnimatedTilemaps(this.ctx, this.camera, [depth]);
                this.world.renderDynamic(this.ctx, this.camera, [depth], this._cpColors);
            }
            
            // Players
            if (this.localPlayer) {
                const showPosition = this.state === GameState.TESTING;
                for (const player of this.remotePlayers.values()) {
                    player.render(this.ctx, this.camera, showPosition, this.world);
                }
                this.localPlayer.render(this.ctx, this.camera, showPosition, this.world);
                if (window.PluginManager) {
                    if (!this._renderPlayerData) this._renderPlayerData = {};
                    this._renderPlayerData.ctx = this.ctx;
                    this._renderPlayerData.player = this.localPlayer;
                    this._renderPlayerData.camera = this.camera;
                    this._renderPlayerData.world = this.world;
                    window.PluginManager.executeHook('render.player', this._renderPlayerData);
                }
            }
            
            // Draw all foreground layers after the players.
            for (const depth of drawLayers.abovePlayer) {
                this.world.renderTiles(this.ctx, this.camera, [depth]);
                this.world.renderAnimatedTilemaps(this.ctx, this.camera, [depth]);
                this.world.renderDynamic(this.ctx, this.camera, [depth], this._cpColors);
            }
            
            // Zones/buttons
            this.world.renderVisibleZones(this.ctx, this.camera);
        } else {
            // Standard path: per-object rendering (editor mode)
            const { layers, checkpointColors } = this.world.render(this.ctx, this.camera);
            
            for (const obj of layers[1]) {
                obj.render(this.ctx, this.camera, checkpointColors);
            }
            
            if (this.localPlayer) {
                const showPosition = isEditor || this.state === GameState.TESTING;
                if (isPlaying) {
                    for (const player of this.remotePlayers.values()) {
                        player.render(this.ctx, this.camera, showPosition, this.world);
                    }
                }
                this.localPlayer.render(this.ctx, this.camera, showPosition, this.world);
                if (isPlaying && window.PluginManager) {
                    if (!this._renderPlayerData) this._renderPlayerData = {};
                    this._renderPlayerData.ctx = this.ctx;
                    this._renderPlayerData.player = this.localPlayer;
                    this._renderPlayerData.camera = this.camera;
                    this._renderPlayerData.world = this.world;
                    window.PluginManager.executeHook('render.player', this._renderPlayerData);
                }
            }
            
            this.world.renderAbovePlayer(this.ctx, this.camera, checkpointColors);
            this.world.renderZones(this.ctx, this.camera);
        }
        
        // Teleportal connections (editor & test only)
        if (isEditor || this.state === GameState.TESTING) {
            this.world.renderTeleportalConnections(this.ctx, this.camera, Date.now());
        }
        
        if ((isEditor || this.state === GameState.TESTING) && this.renderEditorOverlay) {
            this.renderEditorOverlay(this.ctx, this.camera);
        }
        
        this.ctx.restore();
        
        if (isPlaying) {
            this.ctx.save();
            this.ctx.translate(cameraOffsetX, cameraOffsetY);
            this.renderPortalParticles();
            this.renderParticles();
            this.ctx.restore();
            this.renderHUD();
        }
        
        // FPS counter (top-right corner)
        if (this._fpsDisplay !== undefined && this.state === GameState.TESTING) {
            const fps = this._fpsDisplay;
            this.ctx.save();
            this.ctx.font = '12px monospace';
            this.ctx.textAlign = 'right';
            this.ctx.fillStyle = fps < 30 ? '#ff4444' : fps < 50 ? '#ffaa00' : '#44ff44';
            this.ctx.fillText(`${fps} FPS`, this.camera.width - 8, 16);
            this.ctx.restore();
        }
    }
    
    renderHUD() {
        if (!this.localPlayer) return;
        
        if (window.PluginManager) {
            if (!this._hudData) this._hudData = {};
            this._hudData.ctx = this.ctx;
            this._hudData.canvas = this.canvas;
            this._hudData.player = this.localPlayer;
            this._hudData.world = this.world;
            this._hudData.xOffset = 20;
            this._hudData.yOffset = 20;
            window.PluginManager.executeHook('render.hud', this._hudData);
        }
        this.updateCoinCounterUI();
    }

    updateCoinCounterUI() {
        if (!this.world.showCoinCounter) {
            const existing = document.getElementById('coin-counter-ui');
            if (existing) existing.remove();
            return;
        }
        const totalCoins = this.world.objects
            .filter(o => o.appearanceType === 'coin' && o._mechanicsEnabled !== false)
            .reduce((total, coin) => total + (Number.isFinite(coin.coinAmount) ? Math.max(0, coin.coinAmount) : 1), 0);
        if (totalCoins === 0) {
            const existing = document.getElementById('coin-counter-ui');
            if (existing) existing.remove();
            return;
        }
        let el = document.getElementById('coin-counter-ui');
        if (!el) {
            el = document.createElement('div');
            el.id = 'coin-counter-ui';
            el.style.cssText = [
                'position:fixed',
                'left:50%',
                'transform:translateX(-50%)',
                'background:rgba(15,15,30,0.88)',
                'border:1px solid rgba(245,197,24,0.6)',
                'border-radius:20px',
                'padding:5px 16px',
                'display:flex',
                'align-items:center',
                'gap:6px',
                'font-size:15px',
                'font-weight:700',
                'color:#f5c518',
                'pointer-events:none',
                'z-index:9990',
                'transition:bottom 0.25s ease',
                'white-space:nowrap'
            ].join(';');
            el.innerHTML = '<span style="font-size:18px;">&#9678;</span><span id="coin-counter-text"></span>';
            document.body.appendChild(el);
        }
        // Position above the highest visible toolbar
        const toolbarEls = Array.from(document.querySelectorAll(
            '.toolbar:not(.hidden), .placement-toolbar.active, #admin-toolbar:not(.hidden)'
        ));
        let bottomOffset = 24;
        for (const tb of toolbarEls) {
            const rect = tb.getBoundingClientRect();
            if (rect.width === 0) continue;
            const spaceAbove = window.innerHeight - rect.top + 8;
            if (spaceAbove > bottomOffset) bottomOffset = spaceAbove;
        }
        el.style.bottom = bottomOffset + 'px';
        const collected = this.coinsCollected || 0;
        document.getElementById('coin-counter-text').textContent = `${collected} / ${totalCoins}`;
    }

    startGame(playerName, playerColor) {
        window.parkoreenActiveSceneMapId = null;
        this.editorSceneSnapshot = null;
        this._testSceneChanged = false;
        this._endedFromState = null;
        this._pendingEndGameData = null;
        this.mechanicsWorldPaused = false;
        this.mechanicsPauseNeedsRender = false;
        this.mechanicsPauseStartedAt = null;
        this.world.resetMechanicsObjectStates();
        if (typeof window.CodePluginReset === 'function') window.CodePluginReset({ world: this.world });
        this.state = GameState.PLAYING;
        WorldObject._editorMode = false;
        this.lastCheckpoint = null;
        this._onCheckpointObj = null;
        this.gameStartTime = Date.now();
        // Reset coin state
        this.coinsCollected = 0;
        this.playerScopedCoinCollections.clear();
        this.globalCoinCollectionPending.clear();
        this.globalCoinCollectionIds.clear();
        for (const obj of this.world.objects) {
            if (obj.appearanceType === 'coin') obj._collected = false;
            if (obj.appearanceType === 'button') obj._triggered = false;
        }
        window.CodePluginRestoreMechanicsObjectStates?.(this.world);
        
        // Regenerate clouds for new game session
        this.regenerateClouds();

        // Set zoom limits for play mode (can only zoom in from default)
        this.camera.setZoomLimits('play');
        this.camera.resetZoom();

        // Reset checkpoint states
        for (const obj of this.world.objects) {
            if (obj.actingType === 'checkpoint') {
                obj.checkpointState = 'default';
            }
        }
        const savedCheckpoint = this.restoreSavedPlayerCheckpoint();
        
        // Create local player at spawn point
        let spawnX = 100, spawnY = 100;
        if (savedCheckpoint) {
            spawnX = savedCheckpoint.x + savedCheckpoint.width / 2 - PLAYER_SIZE / 2;
            spawnY = savedCheckpoint.y - PLAYER_SIZE;
        } else if (this.world.spawnPoint) {
            spawnX = this.world.spawnPoint.x + this.world.spawnPoint.width / 2 - PLAYER_SIZE / 2;
            spawnY = this.world.spawnPoint.y - PLAYER_SIZE;
        }
        
        this.localPlayer = new Player(spawnX, spawnY, playerName, playerColor);
        this.localPlayer.isLocal = true;
        this.localPlayer.id = window.MultiplayerManager?.playerId || null;
        this.configureLocalPlayerIdentity(this.localPlayer);
        
        // Initialize plugins via hook
        if (window.PluginManager) {
            window.PluginManager.executeHook('player.init', { 
                player: this.localPlayer, 
                world: this.world 
            });
        }
        
        // Apply world settings
        if (this.world.infiniteJumps) {
            this.localPlayer.setMaxJumps(999, true);
        } else {
            this.localPlayer.setMaxJumps(this.world.maxJumps, this.world.additionalAirjump);
        }
        
        this.camera.x = this.localPlayer.x - this.camera.width / 2;
        this.camera.y = this.localPlayer.y - this.camera.height / 2;
        
        // Build tile cache for fast rendering
        this.world.buildTileCache();
    }

    startTestGame() {
        window.parkoreenActiveSceneMapId = null;
        if (!this.editorSceneSnapshot) {
            this.editorSceneSnapshot = this.world.toJSON();
            this._testSceneChanged = false;
        }
        this._endedFromState = null;
        this._pendingEndGameData = null;
        this.mechanicsWorldPaused = false;
        this.mechanicsPauseNeedsRender = false;
        this.mechanicsPauseStartedAt = null;
        this.world.resetMechanicsObjectStates();
        if (typeof window.CodePluginReset === 'function') window.CodePluginReset({ world: this.world });
        this.state = GameState.TESTING;
        WorldObject._editorMode = false;
        this.lastCheckpoint = null;
        this._onCheckpointObj = null;
        this.gameStartTime = Date.now();
        // Reset coin state
        this.coinsCollected = 0;
        this.playerScopedCoinCollections.clear();
        this.globalCoinCollectionPending.clear();
        this.globalCoinCollectionIds.clear();
        for (const obj of this.world.objects) {
            if (obj.appearanceType === 'coin') obj._collected = false;
            if (obj.appearanceType === 'button') obj._triggered = false;
        }
        
        // Regenerate clouds for test session
        this.regenerateClouds();
        
        // Set zoom limits for test mode (zoom freely)
        this.camera.setZoomLimits('test');
        
        // Reset checkpoint states
        for (const obj of this.world.objects) {
            if (obj.actingType === 'checkpoint') {
                obj.checkpointState = 'default';
            }
        }
        
        // Store current camera position and zoom for returning
        this.editorCameraX = this.camera.x;
        this.editorCameraY = this.camera.y;
        this.editorCameraZoom = this.camera.zoom;
        
        let spawnX = 100, spawnY = 100;
        if (this.world.spawnPoint) {
            spawnX = this.world.spawnPoint.x + this.world.spawnPoint.width / 2 - PLAYER_SIZE / 2;
            spawnY = this.world.spawnPoint.y - PLAYER_SIZE;
        }
        
        this.localPlayer = new Player(spawnX, spawnY, 'Tester', '#4ECDC4');
        this.localPlayer.isLocal = true;
        this.localPlayer.id = window.MultiplayerManager?.playerId || null;
        this.configureLocalPlayerIdentity(this.localPlayer);
        
        // Initialize plugins via hook
        if (window.PluginManager) {
            window.PluginManager.executeHook('player.init', { 
                player: this.localPlayer, 
                world: this.world 
            });
        }
        
        if (this.world.infiniteJumps) {
            this.localPlayer.setMaxJumps(999, true);
        } else {
            this.localPlayer.setMaxJumps(this.world.maxJumps, this.world.additionalAirjump);
        }
        
        // Build tile cache for fast rendering
        this.world.buildTileCache();
    }

    stopGame() {
        window.parkoreenActiveSceneMapId = null;
        this.state = GameState.EDITOR;
        this._endedFromState = null;
        this._pendingEndGameData = null;
        this.mechanicsWorldPaused = false;
        this.mechanicsPauseNeedsRender = false;
        this.mechanicsPauseStartedAt = null;
        WorldObject._editorMode = true;
        if (typeof window.CodePluginReset === 'function') window.CodePluginReset({ world: this.world });
        const restoreEditorScene = Boolean(this.editorSceneSnapshot && this._testSceneChanged);
        if (restoreEditorScene) this.world.fromJSON(this.editorSceneSnapshot);
        this.editorSceneSnapshot = null;
        this._testSceneChanged = false;
        this.world.resetMechanicsObjectStates();
        this.playerScopedCoinCollections.clear();
        this.globalCoinCollectionPending.clear();
        this.globalCoinCollectionIds.clear();
        this.localPlayer = null;
        this.remotePlayers.clear();
        this.particles = [];
        this._portalParticles = [];
        this._portalParticleTimer = 0;
        this.world.invalidateTileCache();

        const buttonUI = document.getElementById('game-button-ui');
        if (buttonUI) buttonUI.remove();
        const coinUI = document.getElementById('coin-counter-ui');
        if (coinUI) coinUI.remove();
        // Reset collected flags
        for (const obj of this.world.objects) { if (obj.appearanceType === 'coin') obj._collected = false; }
        
        for (const obj of this.world.objects) {
            if (obj.appearanceType === 'button') obj._playerInside = false;
            if (obj.actingType === 'checkpoint') obj.checkpointState = 'default';
        }
        this.lastCheckpoint = null;

        // Set zoom limits for editor mode (zoom freely)
        this.camera.setZoomLimits('editor');
        
        // Restore camera position and zoom if coming from test mode
        if (this.editorCameraX !== undefined) {
            this.camera.x = this.editorCameraX;
            this.camera.y = this.editorCameraY;
            if (this.editorCameraZoom !== undefined) {
                this.camera.zoom = this.editorCameraZoom;
            }
        }
        
        const restorePlugins = restoreEditorScene && window.PluginManager
            ? window.PluginManager.initFromWorld(this.world).then(() => {
                if (this.state === GameState.EDITOR && this.localPlayer) {
                    window.PluginManager.executeHook('player.init', { player: this.localPlayer, world: this.world });
                }
            })
            : null;

        // Recreate editor player
        this.createEditorPlayer();
        if (restorePlugins) {
            restorePlugins.catch(error => {
                console.warn('[Game] Could not restore editor map plugins after scene test:', error);
            });
        }
    }

    configureLocalPlayerIdentity(player) {
        if (!player) return;
        const user = window.Auth?.getUser?.() || null;
        const multiplayer = window.MultiplayerManager;
        player.displayName = player.name || user?.name || 'Player';
        player.username = typeof user?.username === 'string' ? user.username : '';
        player.tag = typeof user?.tag === 'string' ? user.tag : '';
        player.isHost = multiplayer?.getRoomCode?.()
            ? multiplayer.isHost === true
            : null;
    }

    createEditorPlayer() {
        // Create a player for editor mode (fly mode, no death)
        let spawnX = 100;
        let spawnY = 100;
        
        if (this.world.spawnPoint) {
            spawnX = this.world.spawnPoint.x + this.world.spawnPoint.width / 2 - PLAYER_SIZE / 2;
            spawnY = this.world.spawnPoint.y - PLAYER_SIZE;
        }
        
        this.localPlayer = new Player(spawnX, spawnY, 'Editor', '#45B7D1');
        this.localPlayer.isLocal = true;
        this.localPlayer.id = window.MultiplayerManager?.playerId || null;
        this.configureLocalPlayerIdentity(this.localPlayer);
        this.localPlayer.isFlying = true; // Start with fly mode in editor
        this.localPlayer.setMaxJumps(999, true); // Infinite jumps in editor mode
        
        this.state = GameState.EDITOR;
        WorldObject._editorMode = true;
    }

    addRemotePlayer(id, name, color, x, y) {
        const player = new Player(x, y, name, color);
        player.id = id;
        this.remotePlayers.set(id, player);
        return player;
    }

    updateRemotePlayer(id, x, y, vx = 0, vy = 0) {
        const player = this.remotePlayers.get(id);
        if (player) {
            if (player._adminDragged) return;
            // Store actual server position
            player.serverX = x;
            player.serverY = y;
            player.vx = vx;
            player.vy = vy;
            player.lastUpdateTime = performance.now();
            
            // Snap to actual position (with small lerp for smoothness)
            const lerpFactor = 0.3;
            player.x = player.x + (x - player.x) * lerpFactor;
            player.y = player.y + (y - player.y) * lerpFactor;
        }
    }

    removeRemotePlayer(id) {
        this.remotePlayers.delete(id);
    }

    getMouseWorldPos() {
        return this.camera.screenToWorld(this.mouse.x, this.mouse.y);
    }

    getGridAlignedPos(x, y) {
        return {
            x: Math.floor(x / GRID_SIZE) * GRID_SIZE,
            y: Math.floor(y / GRID_SIZE) * GRID_SIZE
        };
    }
}

GameEngine._invincible = false;

// Export for use in other modules
window.GameEngine = GameEngine;
window.Player = Player;
window.Camera = Camera;
window.World = World;
window.WorldObject = WorldObject;
window.AudioManager = AudioManager;
window.GameState = GameState;
window.GRID_SIZE = GRID_SIZE;
