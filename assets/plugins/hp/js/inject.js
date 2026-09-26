/**
 * HP Plugin - Injection Script
 * This script hooks into the game systems to add HP functionality
 */

(function(ctx) {
    const { pluginManager, pluginId, world, hooks } = ctx;
    
    // Get config from world or use defaults
    const config = world?.plugins?.hp || { defaultHP: 3 };
    
    // Load HP SVG images (full, empty)
    const hpFullImg = new Image();
    hpFullImg.src = 'assets/plugins/hp/svg/full.svg';
    
    const hpEmptyImg = new Image();
    hpEmptyImg.src = 'assets/plugins/hp/svg/empty.svg';
    
    // ============================================
    // PLAYER INITIALIZATION HOOK
    // ============================================
    pluginManager.registerHook('player.init', (data) => {
        const { player } = data;
        
        player.hp = config.defaultHP;
        player.maxHP = config.defaultHP;
        player.useHPSystem = true;
        player.invincibleUntil = 0;
        player.safeGroundHistory = [];
        player.damageStunUntil = 0; // Prevents movement during damage stun
        player.originalColor = player.color; // Store original color for flashing
        
        return data;
    }, pluginId);
    
    // Grid size for alignment
    const GRID_SIZE = 32;
    
    const _safeBox = { x: 0, y: 0, width: 0, height: 0 };
    function isPositionSafe(x, y, playerWidth, playerHeight, player) {
        const margin = 4;
        _safeBox.x = x - margin; _safeBox.y = y - margin;
        _safeBox.width = playerWidth + margin * 2; _safeBox.height = playerHeight + margin * 2;

        const nearby = world.queryNear ? world.queryNear(_safeBox.x, _safeBox.y, _safeBox.width, _safeBox.height) : world.objects;
        for (let i = 0; i < nearby.length; i++) {
            const obj = nearby[i];
            if (obj.actingType !== 'spike') continue;
            if (x < obj.x + obj.width + margin && x + playerWidth > obj.x - margin &&
                y < obj.y + obj.height + margin && y + playerHeight > obj.y - margin) {
                return false;
            }
        }

        const groundY = y + playerHeight;
        const gx1 = x + playerWidth * 0.25, gx2 = x + playerWidth * 0.75;
        const groundNearby = world.queryNear ? world.queryNear(x, groundY - 4, playerWidth, 12) : world.objects;
        let hasGround = false;
        const groundTouchbox = player?.groundTouchbox;
        const groundBox = {
            x: x + (groundTouchbox?.x || 0),
            y: y + (groundTouchbox?.y ?? playerHeight - 24),
            width: groundTouchbox?.width || playerWidth,
            height: groundTouchbox?.height || 24
        };
        for (let i = 0; i < groundNearby.length; i++) {
            const obj = groundNearby[i];
            if (!obj.collision || obj.actingType === 'spike') continue;
            if (obj.collisionShape === 'circle' && typeof player?.getCircleVerticalContact === 'function') {
                const surfaceY = player.getCircleVerticalContact(obj, groundBox, 1);
                if (surfaceY !== null && Math.abs(surfaceY - groundY) <= 8) {
                    hasGround = true;
                    break;
                }
                continue;
            }
            if (obj.collisionShape === 'capsule' && typeof player?.getCapsuleVerticalContact === 'function') {
                const surfaceY = player.getCapsuleVerticalContact(obj, groundBox, 1);
                if (surfaceY !== null && Math.abs(surfaceY - groundY) <= 8) {
                    hasGround = true;
                    break;
                }
                continue;
            }
            if (['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.collisionShape) &&
                typeof player?.getSlopeSurfaceY === 'function') {
                const surfaceY = player.getSlopeSurfaceY(obj, groundBox.x + groundBox.width / 2);
                if (surfaceY !== null && Math.abs(surfaceY - groundY) <= 8) {
                    hasGround = true;
                    break;
                }
                continue;
            }
            if (groundY >= obj.y && groundY <= obj.y + 8 &&
                ((gx1 >= obj.x && gx1 <= obj.x + obj.width) ||
                 (gx2 >= obj.x && gx2 <= obj.x + obj.width))) {
                hasGround = true;
                break;
            }
        }
        if (!hasGround) return false;

        for (let i = 0; i < groundNearby.length; i++) {
            const obj = groundNearby[i];
            if (obj.actingType !== 'spike') continue;
            if (x < obj.x + obj.width && x + playerWidth > obj.x &&
                groundY - 4 < obj.y + obj.height && groundY + 4 > obj.y) {
                return false;
            }
        }
        return true;
    }
    
    // Helper: Align to grid
    function alignToGrid(value) {
        return Math.round(value / GRID_SIZE) * GRID_SIZE;
    }
    
    // ============================================
    // PLAYER UPDATE HOOK - Record safe ground & handle stun
    // ============================================
    let lastSafeGroundCheck = 0;
    const SAFE_GROUND_CHECK_INTERVAL = 200; // Only check every 200ms to reduce lag
    
    pluginManager.registerHook('player.update', (data) => {
        const { player } = data;
        const now = Date.now();
        
        if (player.useHPSystem && player.damageStunUntil && now < player.damageStunUntil) {
            player.vx = 0;
            player.input.left = false;
            player.input.right = false;
            player.input.jump = false;
            player.input.up = false;
            player.input.down = false;
        }
        
        // Record safe ground when player is on ground (throttled)
        if (player.isOnGround && !player.isDead && player.useHPSystem) {
            const now = Date.now();
            
            // Throttle the check to reduce performance impact
            if (now - lastSafeGroundCheck < SAFE_GROUND_CHECK_INTERVAL) {
                return data;
            }
            lastSafeGroundCheck = now;
            
            // Grid-align the position
            const alignedX = alignToGrid(player.x);
            const alignedY = alignToGrid(player.y);
            
            // Avoid duplicate consecutive positions (fast check first)
            const lastEntry = player.safeGroundHistory[player.safeGroundHistory.length - 1];
            if (lastEntry && lastEntry.x === alignedX && lastEntry.y === alignedY) {
                return data;
            }
            
            // Only record if position is safe (not near spikes)
            if (isPositionSafe(alignedX, alignedY, player.width, player.height, player)) {
                player.safeGroundHistory.push({
                    x: alignedX,
                    y: alignedY,
                    time: now
                });
            }
            
            // Keep only last N entries
            if (player.safeGroundHistory.length > 20) {
                player.safeGroundHistory.shift();
            }
        }
        
        return data;
    }, pluginId);
    
    // ============================================
    // DAMAGE HOOK - Handle HP damage instead of instant death
    // ============================================
    pluginManager.registerHook('player.damage', (data) => {
        const { player, source } = data;
        
        if (!player.useHPSystem) return data;
        
        const now = Date.now();
        
        if (now < player.invincibleUntil) {
            data.preventDefault = true;
            return data;
        }
        
        const dmg = (source && source.damageAmount !== undefined) ? source.damageAmount : 1;
        player.hp -= dmg;
        player.invincibleUntil = now + 1000;
        player.damageStunUntil = now + 500;
        
        // Store original color if not already stored
        if (!player.originalColor) {
            player.originalColor = player.color;
        }
        
        if (player.hp <= 0) {
            // Player dies - don't prevent default
            return data;
        }
        
        // Player survives - teleport to a safe ground position
        // Search backward through history to find a truly safe spot
        let foundSafe = false;
        for (let i = player.safeGroundHistory.length - 1; i >= 0; i--) {
            const safeGround = player.safeGroundHistory[i];
            
            // Verify this position is still safe
            if (isPositionSafe(safeGround.x, safeGround.y, player.width, player.height, player)) {
                player.x = safeGround.x;
                player.y = safeGround.y;
                player.vx = 0;
                player.vy = 0;
                foundSafe = true;
                
                // Remove entries after this one (they might be unsafe)
                player.safeGroundHistory = player.safeGroundHistory.slice(0, i + 1);
                break;
            }
        }
        
        // If no safe ground found, use checkpoint or spawn point
        if (!foundSafe) {
            // Get the game engine's last checkpoint if available
            const engine = window.gameEngine || window.engine;
            const lastCheckpoint = engine?.lastCheckpoint;
            const dieLineY = world.dieLineY ?? 2000;
            
            let newX = 100, newY = 100; // Default fallback
            
            if (lastCheckpoint && (lastCheckpoint.y - player.height) < dieLineY) {
                // Use checkpoint (if it's above the void)
                newX = lastCheckpoint.x + lastCheckpoint.width / 2 - player.width / 2;
                newY = lastCheckpoint.y - player.height;
            } else if (world.spawnPoint && (world.spawnPoint.y - player.height) < dieLineY) {
                // Use spawn point (if it's above the void)
                newX = world.spawnPoint.x + world.spawnPoint.width / 2 - player.width / 2;
                newY = world.spawnPoint.y - player.height;
            }
            // else use default (100, 100) which should be safe
            
            player.x = newX;
            player.y = newY;
            player.vx = 0;
            player.vy = 0;
            // Clear history since we're at spawn/checkpoint
            player.safeGroundHistory = [];
        }
        
        data.preventDefault = true;
        return data;
    }, pluginId);
    
    // ============================================
    // CHECKPOINT HOOK - Restore HP to max
    // ============================================
    pluginManager.registerHook('player.checkpoint', (data) => {
        const { player } = data;
        
        if (player.useHPSystem) {
            player.hp = player.maxHP;
        }
        
        return data;
    }, pluginId);
    
    // ============================================
    // RESPAWN HOOK - Reset HP on respawn
    // ============================================
    pluginManager.registerHook('player.respawn', (data) => {
        const { player } = data;
        
        if (player.useHPSystem) {
            player.hp = player.maxHP;
            player.invincibleUntil = 0;
            player.damageStunUntil = 0;
            player.safeGroundHistory = [];
        }
        
        return data;
    }, pluginId);
    
    // ============================================
    // HUD RENDERING HOOK - Draw HP using SVG icons
    // ============================================
    pluginManager.registerHook('render.hud', (data) => {
        const { ctx, player, xOffset = 20, yOffset = 20 } = data;
        
        if (!player.useHPSystem) return data;
        
        const hpSize = 24;
        const hpSpacing = 28;
        let currentX = xOffset;
        
        for (let i = 0; i < player.maxHP; i++) {
            const hpX = currentX + i * hpSpacing;
            const hpY = yOffset;
            
            if (i < player.hp) {
                if (hpFullImg.complete) ctx.drawImage(hpFullImg, hpX, hpY, hpSize, hpSize);
            } else {
                if (hpEmptyImg.complete) ctx.drawImage(hpEmptyImg, hpX, hpY, hpSize, hpSize);
            }
        }
        
        data.xOffset = currentX + player.maxHP * hpSpacing + 10;
        return data;
    }, pluginId, 20);
    
    // ============================================
    // PLAYER RENDER HOOK - Flash player sprite during invincibility
    // ============================================
    pluginManager.registerHook('render.player', (data) => {
        const { ctx, player, camera } = data;
        
        if (!player.useHPSystem) return data;
        
        const now = Date.now();
        
        // During invincibility, flash between black overlay and normal
        if (player.invincibleUntil && now < player.invincibleUntil) {
            // Flash frequency: alternate every 100ms
            const flashPhase = Math.floor(now / 100) % 2;
            
            if (flashPhase === 0) {
                // Draw black overlay on the player
                const screenX = player.x - camera.x;
                const screenY = player.y - camera.y;
                
                ctx.fillStyle = '#000000';
                ctx.fillRect(screenX, screenY, player.width, player.height);
            }
            // On odd phase, player is shown normally (already rendered)
        }
        
        return data;
    }, pluginId);
    
})(ctx);
