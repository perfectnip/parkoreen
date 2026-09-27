/**
 * Hollow Knight Plugin - Injection Script
 * Hooks into game systems to add HK mechanics
 */

(function(ctx) {
    const { api, pluginManager, pluginId, world, hooks, sounds } = ctx;
    // Keep plugin-controlled movement aligned with GameEngine.updatePhysics.
    const HK_CORE_DEFAULT_GRAVITY = 0.71;
    const HK_CORE_DEFAULT_JUMP_FORCE = -13.2;
    const HK_CORE_DEFAULT_TERMINAL_FALL_SPEED = 16;
    const HK_CORE_MAX_TERMINAL_FALL_SPEED = 100;

    function getWorldGravity() {
        const gravity = Number.isFinite(world?._mechanicsGravity) ? world._mechanicsGravity : world?.gravity;
        return Number.isFinite(gravity) && gravity >= 0
            ? gravity
            : HK_CORE_DEFAULT_GRAVITY;
    }

    function getWorldTerminalFallSpeed(gravity = getWorldGravity()) {
        const terminalFallSpeed = Number.isFinite(world?._mechanicsTerminalFallSpeed)
            ? world._mechanicsTerminalFallSpeed : world?.terminalFallSpeed;
        return Number.isFinite(terminalFallSpeed) &&
            terminalFallSpeed > 0 && terminalFallSpeed <= HK_CORE_MAX_TERMINAL_FALL_SPEED
            ? terminalFallSpeed
            : HK_CORE_DEFAULT_TERMINAL_FALL_SPEED * (gravity / HK_CORE_DEFAULT_GRAVITY);
    }

    function getWorldJumpForce() {
        const jumpForce = Number.isFinite(world?._mechanicsJumpForce) ? world._mechanicsJumpForce : world?.jumpForce;
        return Number.isFinite(jumpForce) && jumpForce < 0
            ? jumpForce
            : HK_CORE_DEFAULT_JUMP_FORCE;
    }
    
    // Load soul container SVG images
    const soulEmptyImg = new Image();
    soulEmptyImg.src = 'assets/plugins/hk/svg/soulcontainer-empty.svg';
    
    const soulFullImg = new Image();
    soulFullImg.src = 'assets/plugins/hk/svg/soulcontainer-full.svg';
    
    // Helper to get current config (reads dynamically so changes are reflected)
    function getConfig() {
        return world?.plugins?.hk || HK_DEFAULTS;
    }

    function effectEnabled(key) {
        return getConfig()[key] !== false;
    }

    function getEffectColor(key, fallback) {
        const color = getConfig()[key];
        return typeof color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : fallback;
    }

    function triggerCameraShake(player, intensity, duration = 170) {
        if (!player || !effectEnabled('cameraShakeEffects')) return;
        const amount = Number(intensity);
        if (!Number.isFinite(amount) || amount <= 0) return;
        const now = Date.now();
        const current = player._hkCameraShake;
        if (current && now - current.startedAt < current.duration) {
            const remaining = current.intensity * (1 - Math.max(0, now - current.startedAt) / current.duration);
            if (remaining > amount * 0.8) return;
        }
        player._hkCameraShake = {
            startedAt: now,
            duration: Math.max(60, Math.min(500, Number(duration) || 170)),
            intensity: Math.min(24, amount)
        };
    }
    
    // ============================================
    // PLAYER INITIALIZATION
    // ============================================
    pluginManager.registerHook('player.init', (data) => {
        const { player } = data;
        const config = getConfig();
        
        // Add HK properties
        player.soul = 0;
        player.maxSoul = config.maxSoul || 99;
        player.facingDirection = 1;
        
        // Attack
        player.isAttacking = false;
        player.attackDirection = 'forward';
        player.attackStartTime = 0;
        player.attackCooldown = 0;
        
        // Monarch Wing - always set to true initially, reads from config during gameplay
        player.hasMonarchWing = config.monarchWing || false;
        player.monarchWingAmount = config.monarchWingAmount || 1;
        player.monarchWingsUsed = 0;
        
        // Dash
        player.hasDash = config.dash || false;
        player.isDashing = false;
        player.dashStartTime = 0;
        player.dashCooldown = 0;
        player.dashDirection = 1;
        player.dashTrail = []; // Trail of recent positions for dash effect
        player.superDashTrail = [];
        player._lastSuperDashTrailTime = 0;
        
        // Super Dash
        player.hasSuperDash = config.superDash || false;
        player.isSuperDashing = false;
        player.superDashCharging = false;
        player.superDashChargeStart = 0;
        player.superDashDirection = 1;
        player._playedCharge2 = false;
        player._superDashKeyReady = true;
        player.isSuperDashFrozen = false;
        player.superDashFreezeUntil = 0;
        
        // Heal
        player.isHealing = false;
        player.healStartTime = 0;
        player._healImpact = null;
        player._soulGainEffects = [];
        player._hkDamageFlash = null;
        player._hkObservedHp = Number.isFinite(player.hp) ? player.hp : null;
        player._hkDamageSource = null;
        
        // Mantis Claw (wall cling + wall jump)
        player.hasMantisClaw = config.mantisClaw || false;
        player.isWallClinging = false;
        player.wallClingDirection = 0; // -1 = left wall, 1 = right wall
        player.wallJumpCooldown = 0;
        player.wallSlideSpeed = 2; // Slower fall when clinging
        player._wallJumpReady = true; // Prevents repeated wall jumps from held key
        
        // Wall bounce state (horizontal push off wall)
        player.isWallBouncing = false;
        player.wallBounceEndTime = 0;
        player.wallBounceMidTime = 0; // Time when horizontal push stops (halfway through)
        player.wallBounceDirection = 0;
        player._monarchWingReady = true; // Must release and press jump to use monarch wing
        player._wasOnGround = true; // Track ground state for jump detection
        
        // Attack bounce invincibility (prevents damage during pogo bounce)
        player.attackBounceUntil = 0;
        
        // Attack hit flags (prevent variable jump height interference)
        player._pogoJumping = false;
        player._hitUpward = false;
        player._attackHitThisSwing = false;
        player._mechanicsAttackHitObjects = new Set();
        player._nailImpact = null;
        player._pogoBounceImpact = null;
        player._landingImpact = null;
        player._hkCameraShake = null;

        return data;
    }, pluginId, 5); // Run before HP plugin
    
    // ============================================
    // INPUT HANDLING
    // ============================================
    // Input is now handled by the game engine's keyboard layout system
    // The game sets player.input.attack, player.input.heal, etc.
    // We just need to update facing direction
    pluginManager.registerHook('input.keydown', (data) => {
        const { key, player } = data;
        if (!player) return data;
        
        // Update facing direction
        if (key === 'KeyA' || key === 'ArrowLeft') player.facingDirection = -1;
        if (key === 'KeyD' || key === 'ArrowRight') player.facingDirection = 1;
        
        return data;
    }, pluginId);
    
    // ============================================
    // PLAYER UPDATE - HK Mechanics
    // ============================================
    pluginManager.registerHook('player.update', (data) => {
        const { player, world, audioManager } = data;
        const now = Date.now();
        const config = getConfig();

        // Start the hurt effect only after HP actually falls. The damage hook
        // runs before the HP plugin, so observing the next update avoids
        // flashing for invincibility or damage canceled by another hook.
        const currentHp = Number(player.hp);
        if (Number.isFinite(currentHp)) {
            if (Number.isFinite(player._hkObservedHp) && currentHp < player._hkObservedHp) {
                const source = player._hkDamageSource;
                const playerX = player.x + player.width / 2;
                const playerY = player.y + player.height / 2;
                let directionX = Number.isFinite(source?.x) ? playerX - source.x : player.facingDirection;
                let directionY = Number.isFinite(source?.y) ? playerY - source.y : 0;
                const directionLength = Math.hypot(directionX, directionY) || 1;
                directionX /= directionLength;
                directionY /= directionLength;
                player._hkDamageFlash = { time: now, directionX, directionY };
            }
            player._hkObservedHp = currentHp;
            player._hkDamageSource = null;
        }
        
        // Sync abilities from config (allows dynamic enable/disable)
        player.hasMonarchWing = config.monarchWing || false;
        player.monarchWingAmount = config.monarchWingAmount || 1;
        player.hasDash = config.dash || false;
        player.hasSuperDash = config.superDash || false;
        player.hasMantisClaw = config.mantisClaw || false;
        
        // Update facing based on movement, but lock direction while dashing/super dashing
        if (!player.isDashing && !player.isSuperDashing) {
            if (player.input?.left && !player.input?.right) player.facingDirection = -1;
            if (player.input?.right && !player.input?.left) player.facingDirection = 1;
        }
        
        // Super dash wall-hit freeze: stay frozen until 1 second passes or player takes control
        if (player.isSuperDashFrozen) {
            const controlInput = player.input?.left || player.input?.right || player.input?.up || player.input?.down || player.input?.jump || player.input?.attack || player.input?.dash || player.input?.heal;
            if (now >= player.superDashFreezeUntil || controlInput) {
                player.isSuperDashFrozen = false;
                player.superDashFreezeUntil = 0;
            } else {
                player.vx = 0;
                player.vy = 0;
                data.skipPhysics = true;
                return data;
            }
        }
        
        // ===== MANTIS CLAW (Wall Cling) =====
        if (player.hasMantisClaw && !player.isOnGround && !player.isDashing && !player.isSuperDashing) {
            // Only check for wall contact if player is pressing toward a wall direction
            // This optimizes performance by avoiding collision checks when not needed
            const pressingLeft = player.input?.left && !player.input?.right;
            const pressingRight = player.input?.right && !player.input?.left;
            
            if ((pressingLeft || pressingRight) && player.vy >= 0) {
                // Player is pressing toward a wall and falling - check for wall contact
                const touchingWall = checkWallContact(player, world, pressingLeft ? -1 : 1);
                
                if (touchingWall !== 0) {
                    // Start or continue wall cling
                    if (!player.isWallClinging) {
                        player.isWallClinging = true;
                        player.wallClingDirection = touchingWall;
                        player.monarchWingsUsed = 0; // Reset double jump when grabbing wall
                    }
                } else {
                    player.isWallClinging = false;
                }
            } else if (player.isWallClinging) {
                // Not pressing toward wall anymore - release
                player.isWallClinging = false;
            }
        } else {
            player.isWallClinging = false;
        }
        
        // Reset wall cling on ground
        if (player.isOnGround) {
            player.isWallClinging = false;
        }
        
        // Track when player leaves ground via jump - disable monarch wing until jump released
        if (player._wasOnGround && !player.isOnGround && player.vy < 0 && player.input?.jump) {
            // Player just jumped from ground while holding jump
            player._monarchWingReady = false;
        }
        player._wasOnGround = player.isOnGround;
        
        // Handle wall bounce (horizontal push after wall jump)
        if (player.isWallBouncing) {
            if (now < player.wallBounceEndTime) {
                const playerSpeed = Number.isFinite(world?._mechanicsPlayerSpeed) ? world._mechanicsPlayerSpeed : (world?.playerSpeed ?? 5);
                
                // Horizontal push only happens during the first half of the bounce
                // Use reduced speed (30% of player speed) for gentler wall repel
                if (now < player.wallBounceMidTime) {
                    player.vx = player.wallBounceDirection * playerSpeed * 0.3;
                }
                // After midpoint, player regains horizontal control (vx handled by normal physics)
                
                // Apply the same gravity and terminal speed as core physics.
                const worldGravity = getWorldGravity();
                player.vy += worldGravity;
                const maxFallSpeed = getWorldTerminalFallSpeed(worldGravity);
                if (player.vy > maxFallSpeed) player.vy = maxFallSpeed;
                
                data.skipPhysics = true;
                return data;
            } else {
                player.isWallBouncing = false;
            }
        }
        
        // Handle wall cling physics - use skipPhysics to control fall speed
        if (player.isWallClinging) {
            const worldGravity = getWorldGravity();
            const worldJumpForce = getWorldJumpForce();
            const playerSpeed = Number.isFinite(world?._mechanicsPlayerSpeed) ? world._mechanicsPlayerSpeed : (world?.playerSpeed ?? 5);
            
            // Check for wall jump input
            if (player.input?.jump && player._wallJumpReady !== false) {
                // Wall jump: push away from wall + modest upward jump
                player.isWallClinging = false;
                player.isWallBouncing = true;
                player.wallBounceDirection = -player.wallClingDirection;
                const bounceDuration = 60; // Wall bounce total duration (60ms) - very short
                player.wallBounceEndTime = now + bounceDuration;
                player.wallBounceMidTime = now + bounceDuration / 2; // Horizontal push stops at half duration
                
                // Horizontal push away from wall (30% of player speed for gentle repel)
                player.vx = player.wallBounceDirection * playerSpeed * 0.3;
                
                // Wall jump matches normal jump height (no gravity scaling - consistent height)
                player.vy = worldJumpForce;
                
                player.facingDirection = player.wallBounceDirection;
                
                // Reset monarch wings (double jump) after wall jump
                player.monarchWingsUsed = 0;
                
                player._wallJumpReady = false; // Prevent repeated jumps from held key
                player._monarchWingReady = false; // Must release jump before monarch wing can trigger
                
                // Play normal jump sound
                if (audioManager) audioManager.play('jump');
                
                // Apply movement with collision
                player.moveWithCollision(world);
                
                data.skipPhysics = true;
                return data;
            }
            
            if (!player.input?.jump) {
                player._wallJumpReady = true;
            }
            
            player.vy += worldGravity * 0.1;
            player.vy = Math.min(player.vy, player.wallSlideSpeed);
            player.vx = 0;
            
            data.skipPhysics = true;
            return data;
        }
        
        // ===== ATTACK =====
        if (player.input?.attack && !player.isAttacking && now > player.attackCooldown) {
            // If wall clinging, force attack direction away from wall and detach
            if (player.isWallClinging) {
                player.facingDirection = -player.wallClingDirection;
                player.isWallClinging = false; // Detach from wall when attacking
            }
            
            let direction = 'forward';
            if (player.input?.up) direction = 'up';
            else if (player.input?.down && !player.isOnGround) direction = 'down';
            
            player.isAttacking = true;
            player.attackDirection = direction;
            player.attackStartTime = now;
            player._attackHitThisSwing = false; // Reset hit flag for new attack
            player._mechanicsAttackHitObjects = new Set();
        }
        
        if (player.isAttacking && !player._attackHitThisSwing) {
            const hitbox = getAttackHitbox(player, player.attackDirection);
            const worldJumpForce = getWorldJumpForce();

            // queryNear is a broadphase, so a down-slash must search the full
            // feet sweep as well as the nail hitbox. Otherwise a thin platform
            // can be crossed during the next physics step without entering
            // the attack hitbox's 90 px range.
            const groundTouchbox = player.getGroundTouchbox?.();
            const playerFeet = groundTouchbox && Number.isFinite(groundTouchbox.y) && Number.isFinite(groundTouchbox.height)
                ? groundTouchbox.y + groundTouchbox.height
                : player.y + player.height;
            const gravity = getWorldGravity();
            const terminalFallSpeed = getWorldTerminalFallSpeed(gravity);
            const nextFallSpeed = Math.min(Math.max(0, Number(player.vy) || 0) + gravity, terminalFallSpeed);
            const nextFallStep = Math.max(0, nextFallSpeed);
            const pogoContactTolerance = Math.min(102, nextFallStep + 2);
            const pogoQueryHeight = player.attackDirection === 'down'
                ? Math.max(hitbox.height, playerFeet + nextFallStep + pogoContactTolerance - hitbox.y)
                : hitbox.height;
            // Mechanics hit hooks can synchronously run events that query the
            // world again. queryNear() may return the spatial hash's reusable
            // result buffer, so keep a stable snapshot while dispatching hooks
            // or nested queries can replace the remaining attack candidates.
            const atkNearby = world.queryNear
                ? world.queryNear(hitbox.x, hitbox.y, hitbox.width, pogoQueryHeight).slice()
                : [...world.objects];
            for (let i = 0; i < atkNearby.length; i++) {
                const obj = atkNearby[i];
                const isAvailable = obj._mechanicsEnabled !== false && obj._collected !== true;
                const isSoulTarget = isAvailable && (obj.actingType === 'soulStatus' || obj.actingType === 'soulStatue' ||
                    obj.appearanceType === 'soulStatue' || obj.type === 'soulStatus');
                const pogoSurfaceTop = getPogoSurfaceTop(obj, player);
                // getGroundTouchbox() returns world-space coordinates; do not
                // add player.y a second time when deriving the feet position.
                // The attack hook runs before gravity and collision resolution.
                const pogoNailOverlapsSurfaceX = Number.isFinite(obj.x) && Number.isFinite(obj.width) && obj.width > 0 &&
                    hitbox.x < obj.x + obj.width && hitbox.x + hitbox.width > obj.x;
                const isSolidPogoSurface = player.attackDirection === 'down' &&
                    isAvailable && Boolean(obj.collision) && pogoNailOverlapsSurfaceX && obj.type === 'block' &&
                    obj.appearanceType === 'ground' && obj.actingType === 'ground' &&
                    Number.isFinite(player.vy) && player.vy >= 0 &&
                    Number.isFinite(pogoSurfaceTop) && Number.isFinite(playerFeet) &&
                    player.y < pogoSurfaceTop && playerFeet <= pogoSurfaceTop + pogoContactTolerance;
                const sweptPogoContact = isSolidPogoSurface &&
                    playerFeet <= pogoSurfaceTop + pogoContactTolerance &&
                    playerFeet + nextFallStep >= pogoSurfaceTop;
                const nailOverlapsObject = isAvailable && colliderIntersectsBox(player, hitbox, obj);
                // A solid platform only counts when the feet sweep reaches its
                // surface. The down-slash hitbox is deliberately long for
                // enemies/statues; using that overlap for platforms pogoes
                // while the player is still far above the floor.
                const attackHitsObject = isSolidPogoSurface ? sweptPogoContact : nailOverlapsObject;
                let isMechanicsPogoTarget = false;
                if (attackHitsObject && obj.id && player._mechanicsAttackHitObjects instanceof Set &&
                    !player._mechanicsAttackHitObjects.has(obj.id) && player._mechanicsAttackHitObjects.size < 64) {
                    player._mechanicsAttackHitObjects.add(obj.id);
                    const attackHit = pluginManager.executeHook('player.attack.hit', {
                        player,
                        world,
                        object: obj,
                        direction: player.attackDirection,
                        pogoable: false
                    }) || {};
                    isMechanicsPogoTarget = player.attackDirection === 'down' && attackHit.pogoable === true;
                }
                const isHittable = isSoulTarget || isSolidPogoSurface || isMechanicsPogoTarget ||
                    (isAvailable && obj.actingType === 'spike' && obj.collision !== false);
                if (!isHittable) continue;
                
                if (attackHitsObject) {
                    // The hook runs before physics. The projected feet sweep
                    // identifies the platform this frame would land on; move
                    // the player to that contact plane before the rebound so
                    // the skipped fall step is not converted into an early
                    // midair bounce. This also removes bounded overlap before
                    // the upward collision pass can treat the platform as a
                    // ceiling and clear the rebound velocity.
                    if (isSolidPogoSurface) {
                        const contactOffset = pogoSurfaceTop - playerFeet;
                        if (Math.abs(contactOffset) <= pogoContactTolerance) player.y += contactOffset;
                    }
                    player._attackHitThisSwing = true;
                    const impactShake = Number(config.impactShakeIntensity ?? HK_DEFAULTS.impactShakeIntensity);
                    triggerCameraShake(player, impactShake * (player.attackDirection === 'down' ? 1 : 0.7), 170);
                    player._nailImpact = {
                        x: hitbox.x + hitbox.width / 2,
                        y: player.attackDirection === 'down'
                            ? (Number.isFinite(pogoSurfaceTop) ? pogoSurfaceTop : obj.y)
                            : hitbox.y + hitbox.height / 2,
                        direction: player.attackDirection,
                        time: now
                    };
                    
                    // Soul Statue - hit sound now, soul + getSoul sound 0.5s later
                    if (isSoulTarget) {
                        pluginManager.playSound(pluginId, 'hitSoulStatus');
                        let soulRewardTimer;
                        const disposeSoulRewardTimer = api.onCleanup(() => clearTimeout(soulRewardTimer));
                        soulRewardTimer = setTimeout(() => {
                            disposeSoulRewardTimer();
                            const previousSoul = Number(player.soul) || 0;
                            const nextSoul = Math.min(Number(player.maxSoul), previousSoul + 16.5);
                            if (!Number.isFinite(nextSoul) || nextSoul <= previousSoul) return;
                            player.soul = nextSoul;
                            if (Number.isFinite(obj.x) && Number.isFinite(obj.y)) {
                                player._soulGainEffects ||= [];
                                player._soulGainEffects.push({
                                    x: obj.x + (Number(obj.width) || 0) / 2,
                                    y: obj.y + (Number(obj.height) || 0) / 2,
                                    time: Date.now()
                                });
                                if (player._soulGainEffects.length > 8) player._soulGainEffects.shift();
                            }
                            pluginManager.playSound(pluginId, 'getSoul');
                        }, 500);
                    }
                    
                    // Bounce based on attack direction
                    if (player.attackDirection === 'down') {
                        player._pogoBounceImpact = {
                            x: player._nailImpact.x,
                            y: player._nailImpact.y,
                            time: now
                        };
                        const configuredPogoPower = config.pogoBouncePower;
                        const pogoMultiplier = Number.isFinite(configuredPogoPower)
                            ? Math.max(0.5, Math.min(2, configuredPogoPower))
                            : HK_DEFAULTS.pogoBouncePower;
                        player.vy = worldJumpForce * pogoMultiplier;
                        player.monarchWingsUsed = 0;
                        player._pogoJumping = true;
                        player.isOnGround = false;
                        player.canJump = false;
                        // Preserve the bounce velocity for this simulation step.
                        // Normal player physics applies gravity and jump handling
                        // immediately after this hook and can otherwise cancel it.
                        data.skipPhysics = true;
                    } else if (player.attackDirection === 'up') {
                        player.vy = 2;
                        player._hitUpward = true;
                    } else {
                        player.vx = -player.facingDirection * 5;
                    }
                    player.attackBounceUntil = now + 200;
                    break;
                }
            }
        }
        
        // Update attack state
        const nailSpeed = config.nailSpeed || 'base';
        const attackDuration = 200;
        const attackCooldownMs = nailSpeed === 'quickSlash' ? 50 : 210;
        if (player.isAttacking && now - player.attackStartTime >= attackDuration) {
            player.isAttacking = false;
            player._attackHitThisSwing = false;
            player.attackCooldown = now + attackCooldownMs;
        }
        
        // ===== DASH =====
        if (player.input?.dash && player.hasDash && !player.isDashing && now > player.dashCooldown) {
            // If wall clinging, force dash direction away from wall and detach
            if (player.isWallClinging) {
                player.facingDirection = -player.wallClingDirection;
                player.isWallClinging = false;
            }
            
            player.isDashing = true;
            player.dashStartTime = now;
            player.dashDirection = player.facingDirection;
            player.facingDirection = player.dashDirection; // Lock facing to dash direction
            player.vx = player.dashDirection * 12;
            player.vy = 0;
            pluginManager.playSound(pluginId, 'dash');
        }
        
        if (player.isDashing) {
            const elapsed = now - player.dashStartTime;
            if (elapsed >= 150) { // Dash duration: 150ms
                player.isDashing = false;
                player.dashCooldown = now + 400;
            } else {
                if (effectEnabled('dashTrailEffects')) {
                    // Add trail position every 25ms (not every frame) - max 6 positions
                    const lastTrail = player.dashTrail[player.dashTrail.length - 1];
                    if (!lastTrail || now - lastTrail.time >= 25) {
                        // Limit to 6 trail positions max
                        if (player.dashTrail.length >= 6) {
                            player.dashTrail.shift();
                        }
                        player.dashTrail.push({
                            x: player.x,
                            y: player.y,
                            time: now
                        });
                    }
                }
                
                player.vx = player.dashDirection * 12;
                player.vy = 0;
                data.skipPhysics = true;
                return data;
            }
        } else if (player.dashTrail.length > 0) {
            // Clean up old trail only when there are items and not dashing
            const oldest = player.dashTrail[0];
            if (oldest && now - oldest.time > 200) {
                player.dashTrail.shift();
            }
        }
        
        // ===== SUPER DASH =====
        // Track key release to prevent instant re-charge after manual stop
        if (!player.input?.superDash) {
            player._superDashKeyReady = true;
        }
        
        if (player.input?.superDash && player.hasSuperDash && !player.isSuperDashing && !player.superDashCharging && player._superDashKeyReady) {
            // If wall clinging, force super dash direction away from wall and detach
            if (player.isWallClinging) {
                player.facingDirection = -player.wallClingDirection;
                player.isWallClinging = false;
            }
            
            player.superDashCharging = true;
            player.superDashChargeStart = now;
            player.superDashDirection = player.facingDirection;
            player._playedCharge2 = false;
            player._superDashKeyReady = false; // Require key release before next charge
            pluginManager.playSound(pluginId, 'superdashCharge1');
        }
        
        if (player.superDashCharging) {
            const elapsed = now - player.superDashChargeStart;
            
            // Play charge2 sound when charging finishes
            if (elapsed >= 800 && !player._playedCharge2) {
                player._playedCharge2 = true;
                pluginManager.playSound(pluginId, 'superdashCharge2');
            }
            
            // Release check - player releases key to burst
            if (!player.input?.superDash) {
                player.superDashCharging = false;
                if (elapsed >= 800) {
                    // Fully charged - burst!
                    player.isSuperDashing = true;
                    pluginManager.playSound(pluginId, 'superdashBurst');
                    pluginManager.playSound(pluginId, 'superdashFlying');
                }
            }
        }
        
        if (player.isSuperDashing) {
            if (effectEnabled('dashTrailEffects') && now - player._lastSuperDashTrailTime >= 18) {
                player._lastSuperDashTrailTime = now;
                player.superDashTrail.push({ x: player.x, y: player.y, time: now });
                if (player.superDashTrail.length > 10) player.superDashTrail.shift();
            } else if (!effectEnabled('dashTrailEffects')) {
                player.superDashTrail.length = 0;
            }
            player.vx = player.superDashDirection * 20;
            player.vy = 0;
            
            const collisions = checkCollisions(player, world, 'horizontal');
            if (collisions.length > 0) {
                stopSuperDash(player, 'wall');
            }
            
            if (player.input?.superDash || player.input?.attack || player.input?.jump) {
                stopSuperDash(player, 'manual');
            }
            
            data.skipPhysics = true;
            return data;
        }

        while (player.superDashTrail?.length && now - player.superDashTrail[0].time > 220) {
            player.superDashTrail.shift();
        }
        
        // ===== HEAL =====
        if (player.input?.heal && !player.isHealing && !player.isDashing && !player.isSuperDashing && player.isOnGround) {
            if (player.soul >= 33 && player.hp < player.maxHP) {
                player.isHealing = true;
                player.healStartTime = now;
                pluginManager.playSound(pluginId, 'healCharging');
            }
        }
        
        if (player.isHealing) {
            // Player cannot move while healing
            player.vx = 0;
            
            if (!player.input?.heal) {
                // Cancelled by releasing heal key
                player.isHealing = false;
                pluginManager.stopSound(pluginId, 'healCharging');
            } else if (!player.isOnGround) {
                // Cancelled by leaving ground (falling off edge, getting hit, etc.)
                player.isHealing = false;
                pluginManager.stopSound(pluginId, 'healCharging');
            } else if (now - player.healStartTime >= 900) {
                // Complete!
                const previousHp = Number(player.hp) || 0;
                player.soul -= 33;
                player.hp = Math.min(player.maxHP, player.hp + 1);
                if (player.hp > previousHp) {
                    player._healImpact = {
                        x: player.x + player.width / 2,
                        y: player.y + player.height / 2,
                        time: now
                    };
                }
                player.isHealing = false;
                pluginManager.playSound(pluginId, 'healComplete');
            }
        }
        
        // Reset pogo jumping flag when player starts falling or lands
        if (player._pogoJumping && (player.vy >= 0 || player.isOnGround)) {
            player._pogoJumping = false;
        }
        
        // Reset hit upward flag when player lands
        if (player._hitUpward && player.isOnGround) {
            player._hitUpward = false;
        }
        
        // Reset monarch wing ready when jump key is released (allows monarch wing on next press)
        if (!player.input?.jump) {
            player._monarchWingReady = true;
        }
        
        return data;
    }, pluginId);
    
    // ============================================
    // MONARCH WING JUMP HANDLING
    // (Mantis Claw wall jump is handled in player.update since it uses skipPhysics)
    // ============================================
    pluginManager.registerHook('player.jump', (data) => {
        const { player, canJump } = data;
        
        const worldJumpForce = getWorldJumpForce();
        
        // MONARCH WING - Double jump when out of normal jumps
        // Requires: jump key was released since last jump/wall jump (fresh press)
        if (!canJump && player.hasMonarchWing && !player.isOnGround && 
            player.monarchWingsUsed < player.monarchWingAmount &&
            player._monarchWingReady) {
            const configuredWingJumpPower = Number(getConfig().monarchWingJumpPower);
            const wingJumpPower = Number.isFinite(configuredWingJumpPower) &&
                configuredWingJumpPower >= 0.5 && configuredWingJumpPower <= 2
                ? configuredWingJumpPower
                : HK_DEFAULTS.monarchWingJumpPower;
            
            player.monarchWingsUsed++;
            player._monarchWingReady = false; // Must release jump again before next monarch wing
            
            // Keep Monarch Wing relative to the map's normal jump force.
            player.vy = worldJumpForce * wingJumpPower;
            
            pluginManager.playSound(pluginId, 'monarchWings');
            
            data.preventDefault = false;
            data.didJump = true;
            return data;
        }
        
        return data;
    }, pluginId);
    
    // Reset monarch wings on land
    pluginManager.registerHook('player.land', (data) => {
        const { player } = data;
        player.monarchWingsUsed = 0;
        player.isWallClinging = false;
        player.isWallBouncing = false;
        player._landingImpact = {
            x: player.x + player.width / 2,
            y: player.y + player.height,
            time: Date.now()
        };
        triggerCameraShake(player, Number(getConfig().landingShakeIntensity ?? HK_DEFAULTS.landingShakeIntensity), 130);
        return data;
    }, pluginId);
    
    // ============================================
    // ATTACK BOUNCE INVINCIBILITY - Prevent damage during pogo bounce
    // ============================================
    pluginManager.registerHook('player.damage', (data) => {
        const { player, source } = data;
        const now = Date.now();
        
        // If player is in attack bounce invincibility, prevent damage from spikes
        if (player.attackBounceUntil && now < player.attackBounceUntil) {
            if (source?.actingType === 'spike') {
                data.preventDefault = true;
                return data;
            }
        }

        player._hkDamageSource = {
            x: Number.isFinite(source?.x) ? source.x + (Number(source.width) || 0) / 2 : null,
            y: Number.isFinite(source?.y) ? source.y + (Number(source.height) || 0) / 2 : null
        };

        return data;
    }, pluginId, 1); // Priority 1 - run before HP plugin
    
    // ============================================
    // RESPAWN - Reset HK state
    // ============================================
    pluginManager.registerHook('player.respawn', (data) => {
        const { player } = data;
        
        player.soul = 0;
        player.isAttacking = false;
        player.isDashing = false;
        player.dashTrail = [];
        player.superDashTrail = [];
        player._nailImpact = null;
        player._pogoBounceImpact = null;
        player._landingImpact = null;
        player._healImpact = null;
        player._soulGainEffects = [];
        player._hkDamageFlash = null;
        player._hkObservedHp = Number.isFinite(player.hp) ? player.hp : null;
        player._hkDamageSource = null;
        player._hkCameraShake = null;
        player.isSuperDashing = false;
        player.superDashCharging = false;
        player._playedCharge2 = false;
        player._superDashKeyReady = true;
        player.isSuperDashFrozen = false;
        player.superDashFreezeUntil = 0;
        player.isHealing = false;
        player.monarchWingsUsed = 0;
        player.isWallClinging = false;
        player.isWallBouncing = false;
        player._wallJumpReady = true;
        player._monarchWingReady = true;
        player._wasOnGround = true;
        player.attackBounceUntil = 0;
        player._pogoJumping = false;
        player._hitUpward = false;
        
        return data;
    }, pluginId);
    
    // ============================================
    // PLAYER EFFECTS RENDERING - Attack slash, dash trail, etc.
    // ============================================
    pluginManager.registerHook('render.camera', (data) => {
        const { player } = data;
        const shake = player?._hkCameraShake;
        if (!effectEnabled('cameraShakeEffects') || !shake) return data;

        const age = Date.now() - shake.startedAt;
        if (age >= shake.duration) {
            player._hkCameraShake = null;
            return data;
        }

        const progress = Math.max(0, age / shake.duration);
        const envelope = (1 - progress) ** 2;
        const phase = age / 1000;
        const intensity = shake.intensity * envelope;
        data.offsetX = (Number(data.offsetX) || 0) + Math.sin(phase * 91) * intensity;
        data.offsetY = (Number(data.offsetY) || 0) + Math.cos(phase * 113) * intensity * 0.62;
        return data;
    }, pluginId);

    pluginManager.registerHook('render.player', (data) => {
        const { ctx, player, camera } = data;

        // A short directional hit flash makes HP damage readable without
        // tinting the shared canvas or changing invincibility behavior.
        if (effectEnabled('impactEffects') && player._hkDamageFlash) {
            const age = Date.now() - player._hkDamageFlash.time;
            const duration = 210;
            if (age >= duration) {
                player._hkDamageFlash = null;
            } else {
                const progress = Math.max(0, age / duration);
                const cx = player.x + player.width / 2 - camera.x;
                const cy = player.y + player.height / 2 - camera.y;
                const directionX = player._hkDamageFlash.directionX;
                const directionY = player._hkDamageFlash.directionY;
                const angle = Math.atan2(directionY, directionX);
                ctx.save();
                ctx.globalAlpha = (1 - progress) * 0.85;
                ctx.strokeStyle = getEffectColor('nailEffectColor', '#e9fbff');
                ctx.shadowColor = ctx.strokeStyle;
                ctx.shadowBlur = 8 * (1 - progress);
                ctx.lineWidth = 2 - progress;
                ctx.strokeRect(cx - player.width / 2 - 2, cy - player.height / 2 - 2, player.width + 4, player.height + 4);
                for (let i = 0; i < 6; i++) {
                    const shardAngle = angle + (i - 2.5) * 0.42;
                    const inner = 5 + progress * 7;
                    const outer = 12 + progress * 15 + (i % 2) * 3;
                    ctx.beginPath();
                    ctx.moveTo(cx + Math.cos(shardAngle) * inner, cy + Math.sin(shardAngle) * inner);
                    ctx.lineTo(cx + Math.cos(shardAngle) * outer, cy + Math.sin(shardAngle) * outer);
                    ctx.stroke();
                }
                ctx.restore();
            }
        }
        
        // Draw dash trail effect (optimized)
        if (effectEnabled('dashTrailEffects') && player.dashTrail && player.dashTrail.length > 0) {
            const now = Date.now();
            const color = getEffectColor('dashEffectColor', player.color || '#45B7D1');
            
            ctx.save();
            ctx.fillStyle = color;
            
            for (let i = 0; i < player.dashTrail.length; i++) {
                const trail = player.dashTrail[i];
                const age = now - trail.time;
                if (age > 200) continue; // Skip expired trails
                
                const alpha = (1 - age / 200) * 0.4;
                ctx.globalAlpha = alpha;
                ctx.fillRect(
                    trail.x - camera.x,
                    trail.y - camera.y,
                    player.width,
                    player.height
                );
            }
            
            ctx.restore();
        }

        // Crystal Heart afterimages use a cool, luminous palette.
        if (effectEnabled('dashTrailEffects') && player.superDashTrail?.length) {
            const now = Date.now();
            const color = getEffectColor('dashEffectColor', '#9cecff');
            ctx.save();
            for (const trail of player.superDashTrail) {
                const age = now - trail.time;
                if (age >= 220) continue;
                ctx.globalAlpha = (1 - age / 220) * 0.32;
                ctx.fillStyle = color;
                ctx.fillRect(trail.x - camera.x, trail.y - camera.y, player.width, player.height);
            }
            ctx.restore();
        }

        // Charge glow and Focus aura add readable feedback before and during abilities.
        if (effectEnabled('abilityAuraEffects') && (player.superDashCharging || player.isHealing)) {
            const elapsed = player.superDashCharging
                ? Date.now() - player.superDashChargeStart
                : Date.now() - player.healStartTime;
            const progress = player.superDashCharging
                ? Math.min(elapsed / 800, 1)
                : Math.min(elapsed / 900, 1);
            const cx = player.x + player.width / 2 - camera.x;
            const cy = player.y + player.height / 2 - camera.y;
            const pulse = Math.sin(Date.now() / 75) * 2;
            ctx.save();
            ctx.globalAlpha = 0.25 + progress * 0.5;
            ctx.strokeStyle = player.isHealing
                ? getEffectColor('healEffectColor', '#79f2cf')
                : getEffectColor('chargeEffectColor', '#9cecff');
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(player.width, player.height) * (0.65 + progress * 0.45) + pulse, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(progress, 0.18));
            ctx.stroke();
            ctx.restore();
        }

        // A completed Focus heal releases a brief pulse and radial motes.
        if (player._healImpact) {
            const age = Date.now() - player._healImpact.time;
            const duration = 420;
            if (age >= duration) {
                player._healImpact = null;
            } else if (effectEnabled('impactEffects')) {
                const progress = Math.max(0, age / duration);
                const cx = player._healImpact.x - camera.x;
                const cy = player._healImpact.y - camera.y;
                const radius = 7 + progress * 26;
                const color = getEffectColor('healEffectColor', '#79f2cf');
                ctx.save();
                ctx.globalAlpha = (1 - progress) * 0.8;
                ctx.strokeStyle = color;
                ctx.fillStyle = color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(cx, cy, radius, 0, Math.PI * 2);
                ctx.stroke();
                for (let i = 0; i < 8; i++) {
                    const angle = (Math.PI * 2 * i / 8) - Math.PI / 2;
                    const inner = radius * 0.45;
                    const outer = radius + 5 + (i % 2) * 4;
                    ctx.beginPath();
                    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
                    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
                    ctx.stroke();
                    const moteRadius = outer + progress * 8;
                    ctx.beginPath();
                    ctx.arc(cx + Math.cos(angle) * moteRadius, cy + Math.sin(angle) * moteRadius, 1.5, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        }

        // Soul released by a statue rises in small, fading motes.
        if (effectEnabled('impactEffects') && Array.isArray(player._soulGainEffects)) {
            const now = Date.now();
            const duration = 620;
            player._soulGainEffects = player._soulGainEffects.filter(effect => now - effect.time < duration);
            if (player._soulGainEffects.length) {
                const color = getEffectColor('healEffectColor', '#79f2cf');
                ctx.save();
                ctx.fillStyle = color;
                ctx.shadowColor = color;
                ctx.shadowBlur = 8;
                for (const effect of player._soulGainEffects) {
                    const progress = Math.max(0, (now - effect.time) / duration);
                    for (let i = 0; i < 5; i++) {
                        const phase = i * 1.31 + progress * 4.5;
                        const x = effect.x - camera.x + Math.sin(phase) * (3 + progress * 9);
                        const y = effect.y - camera.y - progress * (18 + (i % 3) * 5) + Math.cos(phase * 1.7) * 2;
                        ctx.globalAlpha = (1 - progress) * (0.55 + (i % 2) * 0.35);
                        ctx.beginPath();
                        ctx.arc(x, y, 1 + (i % 3) * 0.35, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
                ctx.restore();
            }
        }
        
        // Draw attack slash effect
        if (effectEnabled('slashEffects') && player.isAttacking) {
            const hitbox = getAttackHitbox(player, player.attackDirection);
            const screenX = hitbox.x - camera.x;
            const screenY = hitbox.y - camera.y;
            
            // Calculate attack progress for animation
            const elapsed = Date.now() - player.attackStartTime;
            const progress = Math.min(elapsed / 200, 1);
            
            ctx.save();
            ctx.globalAlpha = 1 - progress * 0.5; // Fade out as attack progresses
            
            const slashColor = getEffectColor('nailEffectColor', '#e9fbff');
            ctx.strokeStyle = slashColor;
            ctx.shadowColor = slashColor;
            ctx.shadowBlur = 9 * (1 - progress);
            ctx.lineWidth = 3 - progress;
            let arcX;
            let arcY;
            let arcRadiusX;
            let arcRadiusY;
            let arcStart;
            let arcEnd;

            if (player.attackDirection === 'up') {
                arcX = screenX + hitbox.width / 2;
                arcY = screenY + hitbox.height;
                arcRadiusX = hitbox.width / 2;
                arcRadiusY = hitbox.height;
                arcStart = Math.PI;
                arcEnd = Math.PI * 2;
                ctx.beginPath();
                ctx.ellipse(arcX, arcY, arcRadiusX, arcRadiusY, 0, arcStart, arcEnd);
                ctx.stroke();
            } else if (player.attackDirection === 'down') {
                arcX = screenX + hitbox.width / 2;
                arcY = screenY;
                arcRadiusX = hitbox.width / 2;
                arcRadiusY = hitbox.height;
                arcStart = 0;
                arcEnd = Math.PI;
                ctx.beginPath();
                ctx.ellipse(arcX, arcY, arcRadiusX, arcRadiusY, 0, arcStart, arcEnd);
                ctx.stroke();
            } else if (player.facingDirection > 0) {
                arcX = screenX;
                arcY = screenY + hitbox.height / 2;
                arcRadiusX = hitbox.width;
                arcRadiusY = hitbox.height / 2;
                arcStart = -Math.PI / 2;
                arcEnd = Math.PI / 2;
                ctx.beginPath();
                ctx.ellipse(arcX, arcY, arcRadiusX, arcRadiusY, 0, arcStart, arcEnd);
                ctx.stroke();
            } else {
                arcX = screenX + hitbox.width;
                arcY = screenY + hitbox.height / 2;
                arcRadiusX = hitbox.width;
                arcRadiusY = hitbox.height / 2;
                arcStart = Math.PI / 2;
                arcEnd = Math.PI * 1.5;
                ctx.beginPath();
                ctx.ellipse(arcX, arcY, arcRadiusX, arcRadiusY, 0, arcStart, arcEnd);
                ctx.stroke();
            }

            const tipAngle = arcStart + (arcEnd - arcStart) * progress;
            const tipX = arcX + Math.cos(tipAngle) * arcRadiusX;
            const tipY = arcY + Math.sin(tipAngle) * arcRadiusY;
            ctx.globalAlpha = 0.95 - progress * 0.45;
            ctx.fillStyle = '#fff';
            ctx.shadowColor = slashColor;
            ctx.shadowBlur = 12 * (1 - progress);
            ctx.beginPath();
            ctx.arc(tipX, tipY, 2.6 - progress * 1.1, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.restore();
        }

        // Nail impact sparks, with a wider horizontal burst for a pogo hit.
        if (effectEnabled('impactEffects') && player._nailImpact) {
            const age = Date.now() - player._nailImpact.time;
            const duration = player._nailImpact.direction === 'down' ? 190 : 140;
            if (age < duration) {
                const progress = age / duration;
                const cx = player._nailImpact.x - camera.x;
                const cy = player._nailImpact.y - camera.y;
                const radius = 4 + progress * 18;
                ctx.save();
                ctx.globalAlpha = 1 - progress;
                ctx.strokeStyle = getEffectColor('nailEffectColor', '#e9fbff');
                ctx.lineWidth = player._nailImpact.direction === 'down' ? 2.5 : 1.75;
                ctx.beginPath();
                ctx.ellipse(cx, cy, radius * (player._nailImpact.direction === 'down' ? 1.35 : 1), radius * 0.55, 0, 0, Math.PI * 2);
                ctx.stroke();
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI * 2 * i / 6) + (player._nailImpact.direction === 'down' ? -Math.PI / 2 : 0);
                    const inner = radius * 0.35;
                    const outer = radius + (i % 2 ? 3 : 7);
                    ctx.beginPath();
                    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
                    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
                    ctx.stroke();
                }
                if (player._nailImpact.direction === 'down') {
                    // Down-slash impacts kick bright nail shards sideways from
                    // the contact point, making the pogo hit read separately
                    // from the regular radial nail spark.
                    ctx.lineWidth = 2;
                    for (let i = 0; i < 8; i++) {
                        const side = i % 2 === 0 ? -1 : 1;
                        const lane = Math.floor(i / 2);
                        const spread = radius * (0.3 + lane * 0.18);
                        const lift = (lane % 2 ? -1 : 1) * (2 + progress * 7);
                        const shardLength = 4 + (1 - progress) * (lane % 2 ? 7 : 10);
                        ctx.globalAlpha = (1 - progress) * (0.7 + (lane % 2) * 0.3);
                        ctx.beginPath();
                        ctx.moveTo(cx + side * spread, cy + lift);
                        ctx.lineTo(cx + side * (spread + shardLength), cy + lift - (lane % 2 ? 3 : -2));
                        ctx.stroke();
                    }
                }
                ctx.restore();
            } else {
                player._nailImpact = null;
            }
        }

        // A short upward flare makes the bounce response distinct from the
        // nail's contact sparks while keeping the effect entirely cosmetic.
        if (effectEnabled('impactEffects') && player._pogoBounceImpact) {
            const age = Date.now() - player._pogoBounceImpact.time;
            const duration = 220;
            if (age < duration) {
                const progress = Math.max(0, age / duration);
                const cx = player._pogoBounceImpact.x - camera.x;
                const cy = player._pogoBounceImpact.y - camera.y;
                const radius = 4 + progress * 22;
                const color = getEffectColor('nailEffectColor', '#e9fbff');
                ctx.save();
                ctx.globalAlpha = (1 - progress) * 0.9;
                ctx.strokeStyle = color;
                ctx.shadowColor = color;
                ctx.shadowBlur = 10 * (1 - progress);
                ctx.lineWidth = 2 - progress;
                ctx.beginPath();
                ctx.ellipse(cx, cy, radius, radius * 0.62, 0, Math.PI, Math.PI * 2);
                ctx.stroke();
                for (let i = 0; i < 7; i++) {
                    const angle = Math.PI + Math.PI * i / 6;
                    const inner = radius * 0.45;
                    const outer = radius + (i % 2 ? 3 : 7);
                    ctx.beginPath();
                    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner * 0.62);
                    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * (outer * 0.62 + progress * 5));
                    ctx.stroke();
                }
                ctx.restore();
            } else {
                player._pogoBounceImpact = null;
            }
        }

        // A short dust plume makes landings feel weighty without changing physics.
        if (effectEnabled('impactEffects') && player._landingImpact) {
            const age = Date.now() - player._landingImpact.time;
            const duration = 240;
            if (age < duration) {
                const progress = age / duration;
                const cx = player._landingImpact.x - camera.x;
                const cy = player._landingImpact.y - camera.y;
                const puffSize = 2 + Math.sin(progress * Math.PI) * 4;
                ctx.save();
                ctx.globalAlpha = (1 - progress) * 0.65;
                ctx.fillStyle = getEffectColor('nailEffectColor', '#e9fbff');
                ctx.strokeStyle = ctx.fillStyle;
                ctx.lineWidth = 1.25;
                for (let i = 0; i < 5; i++) {
                    const side = i < 2 ? -1 : i > 2 ? 1 : 0;
                    const spread = side * (5 + progress * 13) + Math.sin(i * 2.1) * progress * 2;
                    const lift = progress * (5 + (i % 3) * 3);
                    const x = cx + spread;
                    const y = cy - lift;
                    ctx.beginPath();
                    ctx.ellipse(x, y, puffSize + (i % 2), Math.max(1, puffSize * 0.4), side * 0.12, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.moveTo(x - side * 2, y + 1);
                    ctx.lineTo(x + side * 2, y - 1);
                    ctx.stroke();
                }
                ctx.restore();
            } else {
                player._landingImpact = null;
            }
        }
        
        // Draw wall cling indicator
        if (player.isWallClinging) {
            const screenX = player.x - camera.x;
            const screenY = player.y - camera.y;
            
            ctx.save();
            ctx.globalAlpha = 0.6;
            ctx.fillStyle = '#88f';
            
            // Small particles near the wall
            const wallX = player.wallClingDirection === -1 ? screenX - 2 : screenX + player.width + 2;
            for (let i = 0; i < 3; i++) {
                const particleY = screenY + player.height * (0.2 + i * 0.3);
                ctx.fillRect(wallX - 2, particleY, 4, 4);
            }
            
            ctx.restore();
        }
        
        return data;
    }, pluginId);
    
    // ============================================
    // HUD RENDERING - Soul vessel using SVG icons (TOP RIGHT)
    // ============================================
    pluginManager.registerHook('render.hud', (data) => {
        const { ctx, player } = data;
        const yOffset = data.yOffset || 20;
        
        const containerSize = 60;
        const soulPercent = player.soul / player.maxSoul;
        
        // Position Soul on top-right (matching SVG layout)
        const canvasWidth = ctx.canvas.width;
        const soulX = canvasWidth - containerSize - 20;
        
        // Draw empty soul container
        if (soulEmptyImg.complete) {
            ctx.drawImage(soulEmptyImg, soulX, yOffset, containerSize, containerSize);
        }
        
        // Draw filled soul container with clipping based on soul percentage
        if (soulPercent > 0 && soulFullImg.complete) {
            ctx.save();
            // Clip from bottom up based on soul percentage
            const fillHeight = containerSize * soulPercent;
            ctx.beginPath();
            ctx.rect(soulX, yOffset + containerSize - fillHeight, containerSize, fillHeight);
            ctx.clip();
            ctx.drawImage(soulFullImg, soulX, yOffset, containerSize, containerSize);
            ctx.restore();
        }
        
        // Soul number - white text with black outline for visibility
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const soulText = Math.floor(player.soul).toString();
        const textX = soulX + containerSize / 2;
        const textY = yOffset + containerSize / 2;
        
        // Black outline
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeText(soulText, textX, textY);
        
        // White fill
        ctx.fillStyle = '#fff';
        ctx.fillText(soulText, textX, textY);
        
        // Heal progress indicator
        if (player.isHealing) {
            const elapsed = Date.now() - player.healStartTime;
            const progress = elapsed / 900;
            
            ctx.strokeStyle = '#4CAF50';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(soulX + containerSize / 2, yOffset + containerSize / 2, containerSize / 2 + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
            ctx.stroke();
        }
        
        // HP stays on left side - don't modify xOffset
        return data;
    }, pluginId, 10); // Priority 10, runs before HP plugin
    
    // ============================================
    // HELPER FUNCTIONS
    // ============================================
    
    const _atkBox = { x: 0, y: 0, width: 0, height: 0 };
    function getPogoSurfaceTop(object, player) {
        const y = Number(object?.y);
        const height = Number(object?.height);
        if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return null;
        if (['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(object.collisionShape)) {
            const box = player?.getGroundTouchbox?.();
            if (!box) return null;
            // Fully solid polygons use the player's expanded collider for
            // normal landing resolution. Match that plane here, then convert
            // its center coordinate back to the feet coordinate used by the
            // projected pogo sweep. One-way polygons and authored ramps use
            // their top surface directly, as they do in the physics resolver.
            if (object.collisionShape === 'polygon' && object.polygonOneWay === false &&
                typeof player.getPolygonAxisContact === 'function' && Number.isFinite(box.height)) {
                const contactCenterY = player.getPolygonAxisContact(object, box, 'y', 1);
                return Number.isFinite(contactCenterY) ? contactCenterY + box.height / 2 : null;
            }
            if (typeof player?.getSlopeSurfaceY !== 'function') return null;
            return player.getSlopeSurfaceY(object, box.x + box.width / 2);
        }
        if (object.collisionShape === 'capsule') {
            const box = player?.getGroundTouchbox?.();
            return box && typeof player?.getCapsuleVerticalContact === 'function'
                ? player.getCapsuleVerticalContact(object, box, 1) : null;
        }
        if (object.collisionShape !== 'circle') return y;
        const width = Number(object.width);
        if (!Number.isFinite(width) || width <= 0) return null;
        const radius = Math.min(width, height) / 2;
        const box = player?.getGroundTouchbox?.();
        if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.width) || box.width <= 0) return null;
        const centerX = object.x + width / 2;
        const centerY = y + height / 2;
        const closestX = Math.max(box.x, Math.min(centerX, box.x + box.width));
        const dx = centerX - closestX;
        const reachSquared = radius * radius - dx * dx;
        if (reachSquared < 0) return null;
        return centerY - Math.sqrt(reachSquared);
    }

    function getAttackHitbox(player, direction) {
        const attackLength = 90;
        const attackWidth = 26;

        if (direction === 'up') {
            _atkBox.x = player.x + (player.width - attackWidth) / 2;
            _atkBox.y = player.y - attackLength;
            _atkBox.width = attackWidth;
            _atkBox.height = attackLength;
        } else if (direction === 'down') {
            _atkBox.x = player.x + (player.width - attackWidth) / 2;
            // A small overlap lets the nail register on the first frame of
            // top contact, including the curved edge of circle colliders.
            _atkBox.y = player.y + player.height - 2;
            _atkBox.width = attackWidth;
            _atkBox.height = attackLength + 2;
        } else {
            _atkBox.x = player.facingDirection > 0 ? player.x + player.width : player.x - attackLength;
            _atkBox.y = player.y + (player.height - attackWidth) / 2;
            _atkBox.width = attackLength;
            _atkBox.height = attackWidth;
        }
        return _atkBox;
    }
    
    function boxIntersects(a, b) {
        return a.x < b.x + b.width &&
               a.x + a.width > b.x &&
               a.y < b.y + b.height &&
               a.y + a.height > b.y;
    }

    function colliderIntersectsBox(player, box, object) {
        return typeof player?.collisionShapeIntersectsBox === 'function'
            ? player.collisionShapeIntersectsBox(box, object)
            : boxIntersects(box, object);
    }
    
    const _wallBox = { x: 0, y: 0, width: 0, height: 0 };
    function checkWallContact(player, world, direction) {
        const margin = 2;
        if (direction === -1) {
            _wallBox.x = player.x - margin; _wallBox.y = player.y + 4;
            _wallBox.width = margin; _wallBox.height = player.height - 8;
        } else {
            _wallBox.x = player.x + player.width; _wallBox.y = player.y + 4;
            _wallBox.width = margin; _wallBox.height = player.height - 8;
        }
        
        const nearby = world.queryNear ? world.queryNear(_wallBox.x, _wallBox.y, _wallBox.width, _wallBox.height) : world.objects;
        for (let i = 0; i < nearby.length; i++) {
            const obj = nearby[i];
            if (!obj.collision) continue;
            if (obj.actingType === 'text' || obj.actingType === 'teleportal' || obj.actingType === 'bouncer' || obj.appearanceType === 'coin') continue;
            if (colliderIntersectsBox(player, _wallBox, obj)) return direction;
        }
        return 0;
    }
    
    const _collBox = { x: 0, y: 0, width: 0, height: 0 };
    const _collResult = [];
    function checkCollisions(player, world, direction) {
        _collResult.length = 0;
        if (direction === 'horizontal') {
            _collBox.x = player.x + (player.superDashDirection || player.facingDirection) * 5;
            _collBox.y = player.y;
        } else {
            _collBox.x = player.x;
            _collBox.y = player.y + 5;
        }
        _collBox.width = player.width;
        _collBox.height = player.height;
        
        const nearby = world.queryNear ? world.queryNear(_collBox.x, _collBox.y, _collBox.width, _collBox.height) : world.objects;
        for (let i = 0; i < nearby.length; i++) {
            const obj = nearby[i];
            if (!obj.collision) continue;
            if (obj.actingType === 'text' || obj.actingType === 'teleportal') continue;
            if (colliderIntersectsBox(player, _collBox, obj)) _collResult.push(obj);
        }
        return _collResult;
    }
    
    function stopSuperDash(player, reason) {
        player.isSuperDashing = false;
        pluginManager.stopSound(pluginId, 'superdashFlying');
        
        if (reason === 'wall') {
            triggerCameraShake(player, Number(getConfig().impactShakeIntensity ?? HK_DEFAULTS.impactShakeIntensity) * 1.25, 220);
            player.isSuperDashFrozen = true;
            player.superDashFreezeUntil = Date.now() + 1000;
            pluginManager.playSound(pluginId, 'superdashHitwallstop');
        } else if (reason === 'manual') {
            pluginManager.playSound(pluginId, 'superdashTriggerstop');
        }
    }

    // Soul statue sprite — only referenced from HK plugin folder
    let _soulStatueImg = null;
    function getSoulStatueImage() {
        if (!_soulStatueImg) {
            _soulStatueImg = new Image();
            const meta = pluginManager.plugins.get(pluginId);
            const base = (meta && meta.path) ? meta.path : '';
            _soulStatueImg.src = base + 'png/soul-statue.png';
        }
        return _soulStatueImg;
    }

    pluginManager.registerHook('render.soulStatue', (data) => {
        const { ctx, screenX, screenY, width, height, obj } = data;
        const img = getSoulStatueImage();
        if (typeof WorldObject !== 'undefined' && WorldObject.prototype._renderSoulStatueWithImage) {
            WorldObject.prototype._renderSoulStatueWithImage.call(obj, ctx, screenX, screenY, width, height, img);
        } else {
            ctx.fillStyle = '#3a3a4a';
            ctx.fillRect(screenX, screenY, width, height);
        }
        data.handled = true;
        return data;
    }, pluginId, 5);
    
})(ctx);
