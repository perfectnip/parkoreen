/**
 * PARKOREEN - Map Editor
 * Complete editor system with tools, panels, and placement
 */

// ============================================
// EDITOR TOOLS
// ============================================
const EditorTool = {
    NONE: 'none',
    FLY: 'fly',
    MOVE: 'move',
    DUPLICATE: 'duplicate',
    ROTATE: 'rotate',
    ROTATE_LEFT: 'rotate-left',
    ROTATE_RIGHT: 'rotate-right',
    ERASE: 'erase',
    SELECT: 'select'
};

const SelectionMode = {
    QUOT: 'quot',
    MULTI: 'multi',
    MOUSE: 'mouse'
};

const SelectionAction = {
    SELECT: 'select',
    DESELECT: 'deselect'
};

const PlacementMode = {
    NONE: 'none',
    BLOCK: 'block',
    OBSTACLE: 'obstacle',
    KOREEN: 'koreen',
    SPAWN_END: 'spawn_end',
    TEXT: 'text',
    TELEPORTAL: 'teleportal',
    BUTTON: 'button',
    OBJECT_STAMP: 'object_stamp',
    TILEMAP: 'tilemap'
};

const OBJECT_STAMP_MAX_TRANSFER_BYTES = 2 * 1024 * 1024;
const sanitizeObjectStampObjects = (objects) => {
    const portalNames = new Set((Array.isArray(objects) ? objects : [])
        .filter(object => object?.type === 'teleportal' && typeof object.teleportalName === 'string' && object.teleportalName)
        .map(object => object.teleportalName));
    return (Array.isArray(objects) ? objects : []).map(object => {
        const snapshot = { ...object };
        for (const key of ['sendTo', 'receiveFrom']) {
            snapshot[key] = (Array.isArray(snapshot[key]) ? snapshot[key] : [])
                .filter(connection => portalNames.has(typeof connection === 'string' ? connection : connection?.name))
                .map(connection => typeof connection === 'string' ? connection : { ...connection });
        }
        return snapshot;
    });
};

// ============================================
// BLOCK TEXTURES
// ============================================
const BLOCK_TEXTURES = [
    { id: 'solid', name: 'Solid', preview: null, pattern: null },
    { id: 'brick', name: 'Brick', preview: 'assets/svg/block-brick.svg', pattern: 'assets/svg/block-brick-pattern.svg' },
    { id: 'stone', name: 'Stone', preview: 'assets/svg/block-stone-pattern.svg', pattern: 'assets/svg/block-stone-pattern.svg' },
    { id: 'wood', name: 'Wood', preview: 'assets/svg/block-wood-pattern.svg', pattern: 'assets/svg/block-wood-pattern.svg' },
    { id: 'moss', name: 'Moss', preview: 'assets/svg/block-moss-pattern.svg', pattern: 'assets/svg/block-moss-pattern.svg' }
];

// ============================================
// CUSTOM FONTS (loaded from assets/ttf/)
// ============================================
const CUSTOM_FONTS = [
    'Parkoreen Game',  // assets/ttf/jersey10.ttf
    'Tektur'           // assets/ttf/tektur.ttf
];

// ============================================
// GOOGLE FONTS (Popular subset)
// ============================================
const GOOGLE_FONTS = [
    ...CUSTOM_FONTS,
    'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins',
    'Oswald', 'Raleway', 'Merriweather', 'Ubuntu', 'Playfair Display',
    'Nunito', 'PT Sans', 'Rubik', 'Work Sans', 'Quicksand',
    'Bebas Neue', 'Anton', 'Lobster', 'Pacifico', 'Dancing Script',
    'Satisfy', 'Indie Flower', 'Permanent Marker', 'Shadows Into Light',
    'Caveat', 'Abril Fatface', 'Alfa Slab One', 'Righteous', 'Bangers',
    'Press Start 2P', 'VT323', 'Silkscreen', 'Jersey 10', 'Pixelify Sans',
    'DotGothic16', 'Orbitron', 'Audiowide', 'Bungee', 'Creepster',
    'Special Elite', 'Courier Prime', 'Source Code Pro', 'Fira Code',
    'JetBrains Mono', 'Comic Neue', 'Fredoka One', 'Baloo 2', 'Cabin',
    'Titillium Web', 'Barlow', 'Archivo', 'Manrope', 'Inter'
];

// ============================================
// EDITOR CLASS
// ============================================
class Editor {
    constructor(engine) {
        this.engine = engine;
        this.world = engine.world;
        this.camera = engine.camera;

        // Tool state
        this.currentTool = EditorTool.NONE;
        this.placementMode = PlacementMode.NONE;
        this.objectStampPlacementId = null;
        this.isFlying = true; // Start with fly mode enabled by default
        this.isErasing = false;
        this.isPlacing = false; // Track if we're actively placing blocks (brush mode)
        this.flyClickStart = null; // Track mouse position for fly mode click detection
        
        // Selection state
        this.selectedObject = null;
        this.movingObject = null;
        this.isDragging = false;
        this.highlightedLayerObject = null; // Object highlighted from layers panel hover
        
        // Rotation drag state
        this.rotatingObject = null;
        this.rotationStartPos = null;
        
        // Placement settings
        this.placementSettings = {
            appearanceType: 'ground',
            actingType: 'ground',
            texture: 'solid', // solid, brick, stone, etc.
            collision: true,
            fillMode: 'add',
            color: '#787878',
            opacity: 1
        };
        this.tilemapLayer = 1;
        this.tilemapCellBehavior = 'solid';
        this.tilemapCollisionShape = 'box';
        this.tilemapCollisionPoints = WorldObject.DEFAULT_COLLISION_POLYGON.map(point => point.slice());
        this.tilemapPolygonOneWay = false;
        this.tilemapAnimation = 'none';
        this.tilemapAnimationFrames = ['brick', 'stone', 'wood', 'moss', 'brick', 'stone', 'wood', 'moss'];
        this.tilemapAtlasAnimationFrames = [0, 1, 2, 3, 4, 5, 6, 7];
        this.tilemapAnimationFrameCount = 2;
        this.tilemapAnimationFps = 4;
        this.tilemapAtlasFrame = 0;
        
        // Koreen settings
        this.koreenSettings = {
            appearanceType: 'checkpoint',
            actingType: 'checkpoint',
            collision: false, // Koreens don't have collision by default
            fillMode: 'add',
            opacity: 1,
            bouncerStrength: 20,
            coinSnapToGrid: true
        };

        // Spawn / end markers (dedicated tool — places koreen-type markers, same as former Koreen spawn/end)
        this.spawnEndSettings = {
            pointType: 'spawnpoint',
            fillMode: 'add',
            opacity: 1,
            color: '#4CAF50'
        };
        
        // Obstacle settings (spike or saw blade)
        this.obstacleSettings = {
            appearanceType: 'spike', // spike or spinner (saw blade)
            actingType: 'spike',
            collision: true,
            fillMode: 'add',
            width: 2,  // in grid units (for spinner)
            height: 2, // in grid units (for spinner)
            color: '#ff4444',
            opacity: 1,
            spinSpeed: 1 // rotations per second (for spinner)
        };

        // Zone placement state
        this.zonePlacement = {
            isPlacing: false,
            startX: 0,
            startY: 0,
            endX: 0,
            endY: 0
        };

        // Obstacle placement state for saw blade (similar to zone)
        this.obstaclePlacement = {
            isPlacing: false,
            startX: 0,
            startY: 0,
            endX: 0,
            endY: 0
        };
        
        // Zone adjustment mode
        this.zoneAdjustment = {
            active: false,
            zone: null,
            draggerHeld: null
        };
        
        // Spinner adjustment mode
        this.spinnerAdjustment = {
            active: false,
            spinner: null,
            draggerHeld: null
        };
        
        // Text settings
        this.textSettings = {
            content: 'Text',
            actingType: 'text',
            fillMode: 'add',
            font: 'Parkoreen Game',
            fontSize: 24,
            color: '#000000',
            opacity: 1,
            hAlign: 'center',
            vAlign: 'center',
            hSpacing: 0,
            vSpacing: 0
        };
        
        // Multi-selection state
        this.selectedObjects = new Set();
        this.selectionMode = SelectionMode.QUOT;
        this.selectionAction = SelectionAction.SELECT;
        this.selectionRect = null; // {startX, startY, endX, endY} for Quot mode drag
        this.isSelectionActive = false; // Whether we're in "select tool" mode
        this.selectionMovingObjects = null; // Array of {obj, offsetX, offsetY} during move
        this.selectionMoveStart = null; // {x, y} world pos where move started
        
        // Button placement state (drag-to-draw like zone)
        this.buttonPlacement = {
            isPlacing: false,
            startX: 0,
            startY: 0,
            endX: 0,
            endY: 0
        };
        
        // Grid visibility
        this.showGrid = true;
        
        // Debug tools
        this.invincibilityEnabled = false;
        // Pull persisted touchbox preference from per-account settings (falls
        // back to localStorage for the migration window, then defaults to off).
        let persistedTouchboxes = false;
        if (window.Settings && typeof window.Settings.get === 'function') {
            persistedTouchboxes = !!window.Settings.get('testerShowTouchboxes');
        } else {
            try {
                persistedTouchboxes = localStorage.getItem('parkoreen_tester_show_touchboxes') === '1';
            } catch (e) {}
        }
        this.showTouchboxes = false; // Always off in editor; restored per-tester-session via _testerTouchboxState
        this._testerTouchboxState = persistedTouchboxes; // Touchbox state remembered across tester sessions within the same page load
        
        // Erase settings
        this.eraseSettings = {
            eraseType: 'all', // 'all', 'top', 'bottom'
            width: 1,  // Width in grid units
            height: 1  // Height in grid units
        };
        
        // Teleportal settings
        this.teleportalSettings = {
            actingType: 'portal',
            fillMode: 'add',
            color: '#9b59b6', // Purple default for teleportals
            opacity: 1
        };

        this.buttonSettings = {
            fillMode: 'add'
        };
        
        // Teleportal names registry (must be unique)
        this.teleportalNames = new Set();
        
        // Pending teleportal (waiting for naming)
        this.pendingTeleportal = null;
        
        // Recent fonts — pull from EditorPrefs (server-backed, local cache fallback)
        this.recentFonts = (window.EditorPrefs && Array.isArray(window.EditorPrefs.fonts))
            ? window.EditorPrefs.fonts.slice()
            : JSON.parse(localStorage.getItem('parkoreen_recent_fonts') || '[]');
        
        // UI Elements (will be set by initUI)
        this.ui = {};
        
        // Callback for map changes (set by host.html for auto-save)
        this.onMapChange = null;

        // Undo / redo (map state snapshots via world.toJSON / fromJSON)
        this._undoStack = [];
        this._redoStack = [];
        this._maxUndo = 60;
        this._undoRedoActive = false;
        this._undoTxnDepth = 0;
        this._brushUndoActive = false;
        this._moveRotateUndoActive = false;
        this._selectionMoveUndoActive = false;
        this._zoneDragUndoActive = false;
        this._spinnerDragUndoActive = false;
        this._quickEraseUndoActive = false;
        
        // Audio elements for music
        this.previewAudio = null;
        this.bgMusic = null;
        
        // Bind engine callbacks
        this.setupEngineCallbacks();
    }
    
    // Trigger map change callback (for auto-save)
    triggerMapChange() {
        this.world.markSpatialDirty();
        this.world._tileCacheReady = false;
        this.world._editorMergedDirty = true;
        this.world._teleportalListDirty = true;
        if (typeof this.onMapChange === 'function') {
            this.onMapChange();
        }
    }

    playTileSound() {
        if (this.engine && this.engine.audioManager) {
            this.engine.audioManager.play('place');
        }
    }

    setupEngineCallbacks() {
        this.engine.onKeyPress = (e) => this.handleKeyPress(e);
        this.engine.onMouseMoveCallback = (e) => this.handleMouseMove(e);
        this.engine.onMouseDownCallback = (e) => this.handleMouseDown(e);
        this.engine.onMouseUpCallback = (e) => this.handleMouseUp(e);
        this.engine.renderEditorOverlay = (ctx, camera) => this.renderOverlay(ctx, camera);
        this.wrapWorldForUndo();
    }

    wrapWorldForUndo() {
        const world = this.world;
        if (world._parkoreenUndoWrapped) return;
        world._parkoreenUndoWrapped = true;
        const editor = this;
        const origAdd = world.addObject.bind(world);
        const origRemove = world.removeObject.bind(world);
        world.addObject = function (obj) {
            if (!editor._undoRedoActive && editor._undoTxnDepth === 0) {
                editor._pushUndoSnapshot();
            }
            return origAdd(obj);
        };
        world.removeObject = function (id) {
            if (!editor._undoRedoActive && editor._undoTxnDepth === 0) {
                editor._pushUndoSnapshot();
            }
            return origRemove(id);
        };
    }

    clearUndoHistory() {
        this._undoStack.length = 0;
        this._redoStack.length = 0;
        this._undoTxnDepth = 0;
        this._brushUndoActive = false;
        this._moveRotateUndoActive = false;
        this._selectionMoveUndoActive = false;
        this._zoneDragUndoActive = false;
        this._spinnerDragUndoActive = false;
        this._quickEraseUndoActive = false;
    }

    _pushUndoSnapshot() {
        if (this._undoRedoActive) return;
        try {
            this._undoStack.push(JSON.stringify(this.world.toJSON()));
            if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
            this._redoStack.length = 0;
        } catch (err) {
            console.warn('[Editor] Undo snapshot failed:', err);
        }
    }

    beginUndoTransaction() {
        if (this._undoRedoActive) return;
        this._undoTxnDepth++;
        if (this._undoTxnDepth === 1) {
            this._pushUndoSnapshot();
        }
    }

    endUndoTransaction() {
        if (this._undoTxnDepth > 0) this._undoTxnDepth--;
    }

    /** If the last pushed undo snapshot equals current world, drop it (no-op gesture). */
    _discardMatchingTopUndoIfUnchanged() {
        if (!this._undoStack.length || this._undoRedoActive) return;
        try {
            const cur = JSON.stringify(this.world.toJSON());
            const top = this._undoStack[this._undoStack.length - 1];
            if (top === cur) this._undoStack.pop();
        } catch (_) { /* ignore */ }
    }

    _isTypingTarget(el) {
        if (!el || !el.tagName) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true') return true;
        return !!el.closest?.('[contenteditable="true"]');
    }

    _isUndoKeyCombo(e) {
        return (e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ';
    }

    _isRedoKeyCombo(e) {
        if (!e.ctrlKey && !e.metaKey) return false;
        if (e.code === 'KeyY') return true;
        if (e.code === 'KeyZ' && e.shiftKey) return true;
        return false;
    }

    _handleUndoRedoKeys(e) {
        if (this._isUndoKeyCombo(e)) {
            this.undo();
            return true;
        }
        if (this._isRedoKeyCombo(e)) {
            this.redo();
            return true;
        }
        return false;
    }

    undo() {
        if (this.engine.state !== GameState.EDITOR || this._undoStack.length === 0) return;
        this._undoRedoActive = true;
        try {
            const current = JSON.stringify(this.world.toJSON());
            this._redoStack.push(current);
            const prev = this._undoStack.pop();
            this.world.fromJSON(JSON.parse(prev));
            this.selectedObjects?.clear?.();
            this.updateLayersList();
            this.triggerMapChange();
        } catch (err) {
            console.warn('[Editor] Undo failed:', err);
        } finally {
            this._undoRedoActive = false;
        }
    }

    redo() {
        if (this.engine.state !== GameState.EDITOR || this._redoStack.length === 0) return;
        this._undoRedoActive = true;
        try {
            const current = JSON.stringify(this.world.toJSON());
            this._undoStack.push(current);
            const next = this._redoStack.pop();
            this.world.fromJSON(JSON.parse(next));
            this.selectedObjects?.clear?.();
            this.updateLayersList();
            this.triggerMapChange();
        } catch (err) {
            console.warn('[Editor] Redo failed:', err);
        } finally {
            this._undoRedoActive = false;
        }
    }

    _placementUsesBrushStroke() {
        if (this.placementMode === PlacementMode.NONE) return false;
        if (this.placementMode === PlacementMode.TELEPORTAL) return false;
        if (this.placementMode === PlacementMode.BUTTON) return false;
        if (this.placementMode === PlacementMode.KOREEN && this.koreenSettings.appearanceType === 'zone') return false;
        if (this.placementMode === PlacementMode.KOREEN && this.koreenSettings.appearanceType === 'coin' && this.koreenSettings.coinSnapToGrid === false) return false;
        if (this.placementMode === PlacementMode.OBSTACLE && this.obstacleSettings.appearanceType === 'spinner') return false;
        return true;
    }

    // ========================================
    // INITIALIZATION
    // ========================================
    initUI() {
        this.createEditorUI();
        this.createAIAssistant();
        this.createToolbar();
        this.createPanels();
        this.createColorPicker();
        this.createFontDropdown();
        this.attachEventListeners();
        
        // Set fly tool button as active since fly mode is on by default
        const flyBtn = this.ui.toolbar.querySelector('[data-tool="fly"]');
        if (flyBtn) {
            flyBtn.classList.add('active');
        }
        const touchboxBtn = this.ui.toolbar.querySelector('[data-action="toggle-touchboxes"]');
        if (touchboxBtn) {
            touchboxBtn.classList.toggle('active', this.showTouchboxes);
        }
    }

    createEditorUI() {
        const container = document.createElement('div');
        container.id = 'editor-ui';
        container.className = 'editor-ui';
        container.innerHTML = `
            <!-- Corner Buttons -->
            <button class="btn btn-icon btn-secondary editor-btn-corner editor-btn-tl" id="btn-config" title="Config">
                <span class="material-symbols-outlined">build</span>
            </button>
            <button class="btn btn-icon btn-secondary editor-btn-corner editor-btn-tr" id="btn-settings" title="Settings">
                <span class="material-symbols-outlined">settings</span>
            </button>
            <button class="btn btn-secondary" id="btn-ai-assistant" type="button" title="Ask the Parkoreen AI map assistant" aria-label="Open AI map assistant" style="position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:50;display:flex;align-items:center;gap:7px;white-space:nowrap;border-color:#8069dc;background:rgba(47,35,90,.94);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.28);">
                <span class="material-symbols-outlined">auto_awesome</span><span>AI Assistant</span>
            </button>
            <button class="btn btn-icon btn-secondary editor-btn-corner editor-btn-bl" id="btn-add" title="Add">
                <span class="material-symbols-outlined">add</span>
            </button>
            <button class="btn btn-icon btn-secondary editor-btn-corner editor-btn-br" id="btn-layers" title="Layers">
                <span class="material-symbols-outlined">stacks</span>
            </button>
            
            <!-- Stop Test Button (hidden by default) -->
            <button class="btn btn-icon btn-danger editor-btn-corner editor-btn-br hidden" id="btn-stop-test" title="Stop Test">
                <span class="material-symbols-outlined">stop_circle</span>
            </button>
        `;
        document.body.appendChild(container);
        
        this.ui.container = container;
        this.ui.btnConfig = document.getElementById('btn-config');
        this.ui.btnSettings = document.getElementById('btn-settings');
        this.ui.btnAdd = document.getElementById('btn-add');
        this.ui.btnLayers = document.getElementById('btn-layers');
        this.ui.btnStopTest = document.getElementById('btn-stop-test');
    }

    createAIAssistant() {
        const overlay = document.createElement('section');
        overlay.className = 'ai-assistant-overlay';
        overlay.id = 'ai-assistant-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'ai-assistant-title');
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="ai-assistant-panel">
                <header class="ai-assistant-header">
                    <div><h2 id="ai-assistant-title"><span class="material-symbols-outlined">auto_awesome</span> Map Assistant</h2><p>GPT-5.6 Luna · edits are previewed before they change your map</p></div>
                    <button class="btn btn-icon btn-ghost" type="button" data-ai-close aria-label="Close assistant"><span class="material-symbols-outlined">close</span></button>
                </header>
                <div class="ai-assistant-suggestions" aria-label="Example requests">
                    <button type="button" data-ai-prompt="Build a beginner-friendly parkour level with a clear start, checkpoints, varied jumps, and an end goal.">Build a parkour level</button>
                    <button type="button" data-ai-prompt="Add a hide-and-seek game mode using triggers and events. Explain how it works.">Add a game mode</button>
                    <button type="button" data-ai-prompt="Review this map and suggest improvements to its flow and difficulty.">Review my map</button>
                </div>
                <div class="ai-assistant-messages" id="ai-assistant-messages" aria-live="polite"></div>
                <div class="ai-assistant-pending hidden" id="ai-assistant-pending">
                    <div><strong>Map changes ready</strong><span id="ai-assistant-change-count"></span></div>
                    <button type="button" class="btn btn-accent" id="ai-assistant-apply">Apply reviewed edits</button>
                    <ul class="ai-assistant-preview" id="ai-assistant-preview" aria-label="Proposed map edits"></ul>
                </div>
                <form class="ai-assistant-form" id="ai-assistant-form">
                    <textarea id="ai-assistant-input" rows="3" maxlength="2000" placeholder="Describe what you want to build or change…" aria-label="Message the map assistant" required></textarea>
                    <button type="submit" class="btn btn-accent" id="ai-assistant-send"><span class="material-symbols-outlined">send</span><span>Send</span></button>
                </form>
                <p class="ai-assistant-footnote">Your current map data is sent to the Parkoreen AI service for this request. Embedded image and audio data is omitted. Map changes are undoable.</p>
            </div>`;
        document.body.appendChild(overlay);
        this.ui.aiOverlay = overlay;
        this._aiConversation = [];
        this._aiPendingMap = null;
        this._aiPendingBase = null;
        this.addAIAssistantMessage('assistant', 'Tell me what you want to build or change. I can work with level layout, objects, physics, plugins, and the map mechanics stored in triggers, events, and variables.');

        document.getElementById('btn-ai-assistant').addEventListener('click', () => this.openAIAssistant());
        overlay.querySelector('[data-ai-close]').addEventListener('click', () => this.closeAIAssistant());
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) this.closeAIAssistant();
        });
        overlay.querySelectorAll('[data-ai-prompt]').forEach(button => button.addEventListener('click', () => {
            const input = document.getElementById('ai-assistant-input');
            input.value = button.dataset.aiPrompt || '';
            input.focus();
        }));
        document.getElementById('ai-assistant-form').addEventListener('submit', event => {
            event.preventDefault();
            this.sendAIAssistantMessage();
        });
        document.getElementById('ai-assistant-apply').addEventListener('click', () => this.applyAIAssistantChanges());
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.closeAIAssistant();
        });
    }

    openAIAssistant() {
        if (this.engine.state !== GameState.EDITOR) {
            this.showToast('Return to the editor before using the map assistant.', 'info');
            return;
        }
        this.ui.aiOverlay.hidden = false;
        document.getElementById('ai-assistant-input').focus();
    }

    closeAIAssistant() {
        if (this.ui.aiOverlay) this.ui.aiOverlay.hidden = true;
    }

    addAIAssistantMessage(role, content) {
        const list = document.getElementById('ai-assistant-messages');
        const message = document.createElement('article');
        message.className = `ai-assistant-message ${role}`;
        const label = document.createElement('strong');
        label.textContent = role === 'user' ? 'You' : 'Parkoreen AI';
        const text = document.createElement('p');
        text.textContent = content;
        message.append(label, text);
        list.appendChild(message);
        list.scrollTop = list.scrollHeight;
        return message;
    }

    stripAIAssistantMedia(value) {
        if (Array.isArray(value)) return value.map(item => this.stripAIAssistantMedia(item));
        if (!value || typeof value !== 'object') return value;
        const clean = {};
        for (const [key, item] of Object.entries(value)) {
            if (typeof item === 'string' && item.length > 1000 && /^data:[^,]+,/.test(item)) continue;
            clean[key] = this.stripAIAssistantMedia(item);
        }
        return clean;
    }

    applyAIAssistantOperations(map, operations) {
        if (!Array.isArray(operations) || operations.length > 250) throw new Error('The assistant returned too many changes. Ask it to make a smaller set of edits.');
        const next = JSON.parse(JSON.stringify(map));
        const allowedRoots = new Set(['objects', 'tilemaps', 'objectStamps', 'layerDefinitions', 'codeData', 'plugins', 'customBackground', 'music', 'background', 'defaultBlockColor', 'defaultSpikeColor', 'defaultTextColor', 'defaultPortalColor', 'defaultBouncerColor', 'showCoinCounter', 'cloudColorSky', 'cloudColorGalaxy', 'checkpointDefaultColor', 'checkpointActiveColor', 'checkpointTouchedColor', 'maxJumps', 'infiniteJumps', 'additionalAirjump', 'collideWithEachOther', 'mapName', 'dieLineY', 'playerSpeed', 'horizontalAcceleration', 'airControl', 'terminalFallSpeed', 'jumpForce', 'gravity', 'cameraLerpX', 'cameraLerpY', 'cameraFollowMode', 'cameraBounds', 'spikeTouchbox', 'dropHurtOnly', 'storedDataType', 'persistCheckpoints']);
        const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

        for (const operation of operations) {
            if (!operation || !['set', 'add', 'remove'].includes(operation.op) || !Array.isArray(operation.path) || operation.path.length < 1 || operation.path.length > 10) {
                throw new Error('The assistant returned a change that could not be applied safely. Please ask it to try again.');
            }
            const path = operation.path.map(segment => String(segment));
            if (!allowedRoots.has(path[0]) || path.some(segment => forbidden.has(segment))) throw new Error('The assistant tried to edit unsupported map data. Ask it to try again with map objects, settings, or mechanics.');
            let parent = next;
            for (const segment of path.slice(0, -1)) {
                if (Array.isArray(parent)) {
                    if (!/^\d+$/.test(segment) || Number(segment) >= parent.length) throw new Error('A suggested map object no longer exists.');
                    parent = parent[Number(segment)];
                } else if (parent && typeof parent === 'object' && Object.hasOwn(parent, segment)) {
                    parent = parent[segment];
                } else {
                    throw new Error('The assistant referenced map data that is not present. Ask it to try again.');
                }
            }
            const last = path[path.length - 1];
            if (operation.op === 'add') {
                if (!Array.isArray(parent?.[last])) throw new Error('The assistant can only add entries to map object, tilemap, or mechanics lists.');
                const item = JSON.parse(operation.valueJson);
                if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('The assistant returned an invalid list entry.');
                parent[last].push(item);
            } else if (Array.isArray(parent)) {
                if (!/^\d+$/.test(last) || Number(last) >= parent.length) throw new Error('The assistant referenced an invalid list entry.');
                if (operation.op === 'remove') parent.splice(Number(last), 1);
                else parent[Number(last)] = JSON.parse(operation.valueJson);
            } else if (parent && typeof parent === 'object') {
                if (operation.op === 'remove') {
                    if (!Object.hasOwn(parent, last)) throw new Error('The assistant referenced an invalid map setting.');
                    delete parent[last];
                } else {
                    parent[last] = JSON.parse(operation.valueJson);
                }
            } else {
                throw new Error('The assistant returned a change for invalid map data.');
            }
        }
        if (!Array.isArray(next.objects) || next.objects.length > 20000 || JSON.stringify(next).length > 8 * 1024 * 1024) throw new Error('The proposed map is too large or incomplete to apply.');
        return next;
    }

    async sendAIAssistantMessage() {
        const input = document.getElementById('ai-assistant-input');
        const sendButton = document.getElementById('ai-assistant-send');
        const prompt = input.value.trim();
        if (!prompt || sendButton.disabled) return;
        const token = window.Auth?.getToken?.();
        if (!token) {
            this.addAIAssistantMessage('assistant', 'Please sign in to use the Map Assistant.');
            return;
        }
        input.value = '';
        this.addAIAssistantMessage('user', prompt);
        this._aiPendingMap = null;
        this._aiPendingBase = null;
        document.getElementById('ai-assistant-pending').classList.add('hidden');
        const baseMap = this.world.toJSON();
        const mapForAI = this.stripAIAssistantMedia(baseMap);
        const waiting = this.addAIAssistantMessage('assistant', 'Thinking about your map…');
        sendButton.disabled = true;
        try {
            const response = await fetch(`${window.API_URL}/editor/ai-assist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ prompt, conversation: this._aiConversation.slice(-8), map: mapForAI })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.message || (response.status === 503 ? 'The AI service is not configured yet.' : 'The map assistant could not complete that request.'));
            const operations = Array.isArray(result.operations) ? result.operations : [];
            waiting.querySelector('p').textContent = result.message || (operations.length ? 'I prepared map changes for you to review.' : 'I could not produce map changes. Try describing the goal more specifically.');
            this._aiConversation.push({ role: 'user', content: prompt }, { role: 'assistant', content: (result.message || '').slice(0, 2000) });
            this._aiConversation = this._aiConversation.slice(-8);
            if (operations.length) {
                this._aiPendingMap = this.applyAIAssistantOperations(baseMap, operations);
                this._aiPendingBase = JSON.stringify(baseMap);
                document.getElementById('ai-assistant-change-count').textContent = `${operations.length} proposed edit${operations.length === 1 ? '' : 's'} · review before applying`;
                const preview = document.getElementById('ai-assistant-preview');
                preview.replaceChildren();
                for (const operation of operations.slice(0, 12)) {
                    const row = document.createElement('li');
                    const pathLabel = operation.path.map(part => /^\d+$/.test(part) ? `#${Number(part) + 1}` : part).join(' › ');
                    let description = `${operation.op.toUpperCase()} · ${pathLabel}`;
                    if (operation.op !== 'remove') {
                        try {
                            const value = JSON.parse(operation.valueJson);
                            const valueLabel = typeof value === 'object' ? (value?.name || value?.mapName || value?.appearanceType || value?.type || 'map entry') : JSON.stringify(value);
                            description += ` → ${String(valueLabel).slice(0, 90)}`;
                        } catch (_) {}
                    }
                    row.textContent = description;
                    preview.appendChild(row);
                }
                if (operations.length > 12) {
                    const more = document.createElement('li');
                    more.textContent = `…and ${operations.length - 12} more edits`;
                    preview.appendChild(more);
                }
                document.getElementById('ai-assistant-pending').classList.remove('hidden');
            }
        } catch (error) {
            waiting.querySelector('p').textContent = error.message || 'The map assistant could not complete that request.';
        } finally {
            sendButton.disabled = false;
            input.focus();
        }
    }

    async applyAIAssistantChanges() {
        if (!this._aiPendingMap) return;
        if (JSON.stringify(this.world.toJSON()) !== this._aiPendingBase) {
            this._aiPendingMap = null;
            document.getElementById('ai-assistant-pending').classList.add('hidden');
            this.addAIAssistantMessage('assistant', 'Your map changed after I prepared those edits, so I cleared that preview. Ask me to make the changes again against the latest map.');
            return;
        }
        const applyButton = document.getElementById('ai-assistant-apply');
        applyButton.disabled = true;
        try {
            this.beginUndoTransaction();
            this.world.fromJSON(this._aiPendingMap);
            if (window.PluginManager) await window.PluginManager.initFromWorld(this.world);
            this.updateBackground();
            this.syncConfigPanel?.();
            this.updateLayersList();
            this.triggerMapChange();
            this._aiPendingMap = null;
            this._aiPendingBase = null;
            document.getElementById('ai-assistant-pending').classList.add('hidden');
            this.addAIAssistantMessage('assistant', 'Applied the map changes. You can undo them with Ctrl+Z (or ⌘Z on Mac).');
        } catch (error) {
            this.showToast(error.message || 'Could not apply the assistant changes.', 'error');
        } finally {
            this.endUndoTransaction();
            applyButton.disabled = false;
        }
    }

    createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'toolbar';
        toolbar.id = 'toolbar';
        toolbar.innerHTML = `
            <button class="toolbar-btn" data-tool="fly" title="Fly (G)">
                <span class="material-symbols-outlined">flight</span>
                <span class="toolbar-btn-label">Fly (G)</span>
            </button>
            <button class="toolbar-btn" data-tool="move" title="Move (M)">
                <span class="material-symbols-outlined">open_with</span>
                <span class="toolbar-btn-label">Move (M)</span>
            </button>
            <button class="toolbar-btn" data-tool="duplicate" title="Duplicate (C)">
                <span class="material-symbols-outlined">content_copy</span>
                <span class="toolbar-btn-label">Duplicate (C)</span>
            </button>
            <button class="toolbar-btn" data-action="zoom-in" title="Zoom In">
                <span class="material-symbols-outlined">zoom_in</span>
                <span class="toolbar-btn-label">Zoom In</span>
            </button>
            <button class="toolbar-btn" data-action="zoom-out" title="Zoom Out">
                <span class="material-symbols-outlined">zoom_out</span>
                <span class="toolbar-btn-label">Zoom Out</span>
            </button>
            <button class="toolbar-btn" data-tool="erase" title="Quick Eraser">
                <span class="material-symbols-outlined">ink_eraser</span>
                <span class="toolbar-btn-label">Eraser</span>
            </button>
            <div class="toolbar-extra" id="toolbar-extra">
                <button class="toolbar-btn" data-tool="rotate-left" title="Rotate Left">
                    <span class="material-symbols-outlined">rotate_left</span>
                    <span class="toolbar-btn-label">Rotate Left</span>
                </button>
                <button class="toolbar-btn" data-tool="rotate-right" title="Rotate Right">
                    <span class="material-symbols-outlined">rotate_right</span>
                    <span class="toolbar-btn-label">Rotate Right</span>
                </button>
                <button class="toolbar-btn" data-tool="rotate" title="Rotate (drag)">
                    <span class="material-symbols-outlined">sync</span>
                    <span class="toolbar-btn-label">Rotate (R)</span>
                </button>
                <button class="toolbar-btn" data-tool="select" title="Select (V)">
                    <span class="material-symbols-outlined">select_all</span>
                    <span class="toolbar-btn-label">Select (V)</span>
                </button>
                <button class="toolbar-btn active" data-action="toggle-grid" title="Toggle Grid (H)">
                    <span class="material-symbols-outlined">grid_on</span>
                    <span class="toolbar-btn-label">Grid (H)</span>
                </button>
            </div>
            <button class="toolbar-btn toolbar-expand-btn" id="toolbar-expand-btn" title="More Tools">
                <span class="material-symbols-outlined toolbar-expand-icon">chevron_right</span>
            </button>
            <button class="toolbar-btn hidden test-mode-tool" data-action="toggle-invincibility" title="Invincibility">
                <span class="material-symbols-outlined">shield</span>
                <span class="toolbar-btn-label">Invincible</span>
            </button>
            <button class="toolbar-btn hidden test-mode-tool" data-action="toggle-touchboxes" title="Show Touchboxes">
                <span class="material-symbols-outlined">select</span>
                <span class="toolbar-btn-label">Touchbox</span>
            </button>
            <button class="toolbar-btn hidden test-mode-tool" data-action="respawn" title="Respawn at Checkpoint">
                <span class="material-symbols-outlined">restart_alt</span>
                <span class="toolbar-btn-label">Respawn</span>
            </button>
        `;
        document.body.appendChild(toolbar);
        this.ui.toolbar = toolbar;
        this.toolbarExpanded = false;
        
        // Expand/collapse toolbar toggle
        document.getElementById('toolbar-expand-btn').addEventListener('click', () => {
            this.toolbarExpanded = !this.toolbarExpanded;
            const extra = document.getElementById('toolbar-extra');
            const btn = document.getElementById('toolbar-expand-btn');
            extra.classList.toggle('expanded', this.toolbarExpanded);
            btn.classList.toggle('expanded', this.toolbarExpanded);
        });
        
        this.createSelectionToolbar();
    }
    
    createSelectionToolbar() {
        // Main selection toolbar (modes and selection actions)
        const selToolbar = document.createElement('div');
        selToolbar.className = 'toolbar selection-toolbar hidden';
        selToolbar.id = 'selection-toolbar';
        selToolbar.innerHTML = `
            <div class="sel-toolbar-section">
                <span class="sel-toolbar-label">Mode</span>
                <button class="toolbar-btn active" data-sel-mode="quot" title="Rectangle Select">
                    <span class="material-symbols-outlined">select</span>
                    <span class="toolbar-btn-label">Quot</span>
                </button>
                <button class="toolbar-btn" data-sel-mode="multi" title="Multi Select">
                    <span class="material-symbols-outlined">library_add_check</span>
                    <span class="toolbar-btn-label">Multi</span>
                </button>
                <button class="toolbar-btn" data-sel-mode="mouse" title="Mouse (interact)">
                    <span class="material-symbols-outlined">arrow_selector_tool</span>
                    <span class="toolbar-btn-label">Mouse</span>
                </button>
            </div>
            <div class="toolbar-divider"></div>
            <div class="sel-toolbar-section">
                <span class="sel-toolbar-label">Action</span>
                <button class="toolbar-btn active" data-sel-action="select" title="Select objects">
                    <span class="material-symbols-outlined">add_circle</span>
                    <span class="toolbar-btn-label">Select</span>
                </button>
                <button class="toolbar-btn" data-sel-action="deselect" title="Deselect objects">
                    <span class="material-symbols-outlined">remove_circle</span>
                    <span class="toolbar-btn-label">Deselect</span>
                </button>
            </div>
            <div class="toolbar-divider"></div>
            <button class="toolbar-btn" data-sel-cmd="select-all" title="Select All">
                <span class="material-symbols-outlined">select_all</span>
                <span class="toolbar-btn-label">All</span>
            </button>
            <button class="toolbar-btn" data-sel-cmd="deselect-all" title="Deselect All">
                <span class="material-symbols-outlined">deselect</span>
                <span class="toolbar-btn-label">None</span>
            </button>
            <button class="toolbar-btn" data-sel-cmd="reverse" title="Reverse Selection">
                <span class="material-symbols-outlined">swap_horiz</span>
                <span class="toolbar-btn-label">Reverse</span>
            </button>
            <div class="toolbar-divider"></div>
            <span class="sel-count" id="sel-count">0 selected</span>
            <button class="toolbar-btn" data-sel-cmd="save-stamp" title="Save selection as an Object Stamp" disabled>
                <span class="material-symbols-outlined">bookmark_add</span>
                <span class="toolbar-btn-label">Save Stamp</span>
            </button>
            <div class="toolbar-divider"></div>
            <button class="toolbar-btn sel-done-btn" data-sel-cmd="done" title="Done (exit selection)">
                <span class="material-symbols-outlined">check_circle</span>
                <span class="toolbar-btn-label">Done</span>
            </button>
        `;
        document.body.appendChild(selToolbar);
        this.ui.selectionToolbar = selToolbar;
        
        // Mouse mode action toolbar (appears above selection toolbar)
        const mouseToolbar = document.createElement('div');
        mouseToolbar.className = 'toolbar selection-mouse-toolbar hidden';
        mouseToolbar.id = 'selection-mouse-toolbar';
        mouseToolbar.innerHTML = `
            <button class="toolbar-btn" data-sel-mouse="move" title="Move Selected">
                <span class="material-symbols-outlined">open_with</span>
                <span class="toolbar-btn-label">Move</span>
            </button>
            <button class="toolbar-btn" data-sel-mouse="duplicate" title="Duplicate Selected">
                <span class="material-symbols-outlined">content_copy</span>
                <span class="toolbar-btn-label">Duplicate</span>
            </button>
            <div class="toolbar-divider"></div>
            <button class="toolbar-btn" data-sel-mouse="rotate-left" title="Rotate Left 90°">
                <span class="material-symbols-outlined">rotate_left</span>
                <span class="toolbar-btn-label">Left 90°</span>
            </button>
            <button class="toolbar-btn" data-sel-mouse="rotate-right" title="Rotate Right 90°">
                <span class="material-symbols-outlined">rotate_right</span>
                <span class="toolbar-btn-label">Right 90°</span>
            </button>
            <button class="toolbar-btn" data-sel-mouse="rotate-180" title="Rotate 180°">
                <span class="material-symbols-outlined">sync</span>
                <span class="toolbar-btn-label">180°</span>
            </button>
        `;
        document.body.appendChild(mouseToolbar);
        this.ui.selectionMouseToolbar = mouseToolbar;
        
        this.attachSelectionToolbarListeners();
    }
    
    attachSelectionToolbarListeners() {
        // Mode buttons
        this.ui.selectionToolbar.querySelectorAll('[data-sel-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setSelectionMode(btn.dataset.selMode);
            });
        });
        
        // Action buttons (Select / Deselect)
        this.ui.selectionToolbar.querySelectorAll('[data-sel-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setSelectionAction(btn.dataset.selAction);
            });
        });
        
        // Command buttons (All, None, Reverse)
        this.ui.selectionToolbar.querySelectorAll('[data-sel-cmd]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.handleSelectionCommand(btn.dataset.selCmd);
            });
        });
        
        // Mouse mode action buttons
        this.ui.selectionMouseToolbar.querySelectorAll('[data-sel-mouse]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.handleSelectionMouseAction(btn.dataset.selMouse);
            });
        });
    }

    createPanels() {
        // Config Panel
        const configPanel = document.createElement('div');
        configPanel.className = 'config-panel';
        configPanel.id = 'config-panel';
        configPanel.innerHTML = `
            <div class="panel-header">
                <span class="panel-title">Configuration</span>
                <button class="btn btn-icon btn-ghost" id="close-config">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="panel-body">
                <!-- Test Game Button -->
                <div class="config-section">
                    <button class="btn btn-primary" id="btn-test-game" style="width: 100%;">
                        <span class="material-symbols-outlined">play_arrow</span>
                        Test Game
                    </button>
                </div>
                
                <!-- Map Info -->
                <div class="config-section collapsible expanded">
                    <div class="config-section-header">
                        <span class="config-section-title">Map Info</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                    <div class="form-group">
                        <label class="form-label">Map Name</label>
                        <input type="text" class="form-input" id="config-map-name" placeholder="Enter map name">
                        </div>
                    </div>
                </div>
                
                <!-- Theme & Visuals -->
                <div class="config-section collapsible">
                    <div class="config-section-header">
                        <span class="config-section-title">Theme & Visuals</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                        <!-- Background -->
                    <div class="form-group">
                        <label class="form-label">Background</label>
                        <select class="form-select" id="config-background">
                            <option value="sky">Sky</option>
                            <option value="galaxy">Galaxy</option>
                                <option value="custom">Custom</option>
                        </select>
                    </div>
                    
                        <!-- Cloud Colors -->
                        <div class="form-group" style="margin-top: 12px;">
                            <label class="form-label">Cloud Colors</label>
                            <div style="display: flex; gap: 12px; margin-top: 8px;">
                                <div style="flex: 1;">
                                    <label style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px; display: block;">Sky</label>
                                    <div class="color-picker-option">
                                        <div class="color-preview" id="config-cloud-sky-preview" style="background: #ffffff"></div>
                                        <input type="text" class="form-input color-input" id="config-cloud-sky" value="#ffffff" style="font-size: 11px;">
                                    </div>
                                </div>
                                <div style="flex: 1;">
                                    <label style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px; display: block;">Galaxy</label>
                                    <div class="color-picker-option">
                                        <div class="color-preview" id="config-cloud-galaxy-preview" style="background: #9382a8"></div>
                                        <input type="text" class="form-input color-input" id="config-cloud-galaxy" value="#9382a8" style="font-size: 11px;">
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Custom Background Options -->
                        <div id="custom-bg-options" class="hidden" style="margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 8px;">
                    <div class="form-group">
                                <label class="form-label">Upload Background</label>
                                <div class="custom-bg-upload" id="custom-bg-dropzone" style="border: 2px dashed var(--surface-light); border-radius: 8px; padding: 20px; text-align: center; cursor: pointer; transition: all 0.2s;">
                                    <span class="material-symbols-outlined" style="font-size: 32px; color: var(--text-muted);">upload_file</span>
                                    <p style="margin: 8px 0 0; color: var(--text-muted); font-size: 12px;">Drop image, GIF, or video here<br>or click to browse</p>
                                    <input type="file" id="custom-bg-file" accept="image/*,video/*" style="display: none;">
                                </div>
                                <div id="custom-bg-preview" class="hidden" style="margin-top: 8px; position: relative;">
                                    <img id="custom-bg-preview-img" src="" style="width: 100%; border-radius: 6px; display: none;">
                                    <video id="custom-bg-preview-video" src="" style="width: 100%; border-radius: 6px; display: none;" muted loop></video>
                                    <button class="btn btn-icon btn-danger" id="custom-bg-remove" style="position: absolute; top: 4px; right: 4px; width: 24px; height: 24px;">
                                        <span class="material-symbols-outlined" style="font-size: 16px;">close</span>
                                    </button>
                                </div>
                            </div>
                            
                            <!-- Video/GIF Options -->
                            <div id="custom-bg-video-options" class="hidden">
                                <div class="form-group">
                                    <label class="form-label">Play Mode</label>
                                    <select class="form-select" id="custom-bg-playmode">
                                        <option value="once">Play Once</option>
                                        <option value="loop" selected>Loop</option>
                                        <option value="bounce">Bounce</option>
                                    </select>
                                </div>
                                
                                <div id="custom-bg-loop-options" class="form-group">
                                    <label class="form-label">Loop Amount</label>
                                    <div style="display: flex; gap: 8px; align-items: center;">
                                        <select class="form-select" id="custom-bg-loop-type" style="flex: 1;">
                                            <option value="infinite" selected>Infinite</option>
                                            <option value="set">Set Number</option>
                                        </select>
                                        <input type="number" class="form-input" id="custom-bg-loop-count" min="1" value="1" style="width: 80px; display: none;">
                                    </div>
                                </div>
                                
                                <div id="custom-bg-end-options" class="form-group hidden">
                                    <label class="form-label">End Type</label>
                                    <select class="form-select" id="custom-bg-endtype">
                                        <option value="freeze" selected>Freeze at Last Frame</option>
                                        <option value="replace">Replace with Another Background</option>
                                    </select>
                                </div>
                                
                                <div id="custom-bg-end-upload" class="form-group hidden">
                                    <label class="form-label">End Background</label>
                                    <div class="custom-bg-upload" id="custom-bg-end-dropzone" style="border: 2px dashed var(--surface-light); border-radius: 8px; padding: 12px; text-align: center; cursor: pointer;">
                                        <span class="material-symbols-outlined" style="font-size: 24px; color: var(--text-muted);">upload_file</span>
                                        <p style="margin: 4px 0 0; color: var(--text-muted); font-size: 11px;">Upload end background</p>
                                        <input type="file" id="custom-bg-end-file" accept="image/*,video/*" style="display: none;">
                                    </div>
                                </div>
                                
                                <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--surface-light);">
                                    <label class="form-label">Playback Options</label>
                                    <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                                        <div>
                                            <span style="font-size: 13px;">Same Across Screens</span>
                                            <p style="margin: 2px 0 0; font-size: 10px; color: var(--text-muted);">All players see same frame</p>
                                        </div>
                                        <label class="toggle">
                                            <input type="checkbox" id="custom-bg-sync">
                                            <span class="toggle-slider"></span>
                                        </label>
                                    </div>
                                    <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                                        <div>
                                            <span style="font-size: 13px;">Reverse</span>
                                            <p style="margin: 2px 0 0; font-size: 10px; color: var(--text-muted);">Play backwards</p>
                                        </div>
                                        <label class="toggle">
                                            <input type="checkbox" id="custom-bg-reverse">
                                            <span class="toggle-slider"></span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Default Colors -->
                        <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--surface-light);">
                            <label class="form-label" style="font-weight: 600; margin-bottom: 12px;">Default Colors</label>
                            <div class="form-group">
                                <label class="form-label">Block Color</label>
                        <div class="color-picker-option">
                            <div class="color-preview" id="config-block-color-preview" style="background: #787878"></div>
                            <input type="text" class="form-input color-input" id="config-block-color" value="#787878">
                        </div>
                    </div>
                    <div class="form-group">
                                <label class="form-label">Spike Color</label>
                        <div class="color-picker-option">
                            <div class="color-preview" id="config-spike-color-preview" style="background: #c45a3f"></div>
                            <input type="text" class="form-input color-input" id="config-spike-color" value="#c45a3f">
                        </div>
                    </div>
                    <div class="form-group">
                                <label class="form-label">Text Color</label>
                        <div class="color-picker-option">
                            <div class="color-preview" id="config-text-color-preview" style="background: #000000"></div>
                            <input type="text" class="form-input color-input" id="config-text-color" value="#000000">
                        </div>
                    </div>
                    <div class="form-group">
                                <label class="form-label">Portal Color</label>
                        <div class="color-picker-option">
                            <div class="color-preview" id="config-portal-color-preview" style="background: #9b59b6"></div>
                            <input type="text" class="form-input color-input" id="config-portal-color" value="#9b59b6">
                        </div>
                    </div>
                    <div class="form-group">
                                <label class="form-label">Bouncer Color</label>
                        <div class="color-picker-option">
                            <div class="color-preview" id="config-bouncer-color-preview" style="background: #f59e0b"></div>
                            <input type="text" class="form-input color-input" id="config-bouncer-color" value="#f59e0b">
                        </div>
                    </div>
                </div>
                
                        <!-- Checkpoint Colors -->
                        <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--surface-light);">
                            <label class="form-label" style="font-weight: 600; margin-bottom: 12px;">Checkpoint Colors</label>
                    <div class="form-group">
                                <label class="form-label">Default</label>
                                <div class="color-picker-option">
                                    <div class="color-preview" id="config-checkpoint-default-preview" style="background: #808080"></div>
                                    <input type="text" class="form-input color-input" id="config-checkpoint-default" value="#808080">
                                </div>
                                <small style="color: #888; font-size: 11px;">Untouched checkpoints</small>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Active</label>
                                <div class="color-picker-option">
                                    <div class="color-preview" id="config-checkpoint-active-preview" style="background: #4CAF50"></div>
                                    <input type="text" class="form-input color-input" id="config-checkpoint-active" value="#4CAF50">
                                </div>
                                <small style="color: #888; font-size: 11px;">Current/latest checkpoint</small>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Already Checked</label>
                                <div class="color-picker-option">
                                    <div class="color-preview" id="config-checkpoint-touched-preview" style="background: #2196F3"></div>
                                    <input type="text" class="form-input color-input" id="config-checkpoint-touched" value="#2196F3">
                                </div>
                                <small style="color: #888; font-size: 11px;">Previously touched checkpoints</small>
                            </div>
                            <div class="form-group">
                                <label class="form-label" style="display: flex; gap: 8px; align-items: center;">
                                    <input type="checkbox" id="config-persist-checkpoints">
                                    Remember the player's latest checkpoint
                                </label>
                                <small style="color: #888; font-size: 11px;">Saves in this browser under your account, or under this browser if signed out.</small>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Coins -->
                <div class="config-section collapsible">
                    <div class="config-section-header">
                        <span class="config-section-title">Coins</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                        <div class="form-group">
                            <label class="form-label">Show Coin Counter</label>
                            <label class="toggle">
                                <input type="checkbox" id="config-show-coin-counter" checked>
                                <span class="toggle-slider"></span>
                            </label>
                            <small style="color: #888; font-size: 11px; display: block; margin-top: 4px;">Shows collected / total coins during gameplay. Automatically hidden if the map has no coins.</small>
                        </div>
                    </div>
                </div>
                
                <!-- Music -->
                <div class="config-section collapsible">
                    <div class="config-section-header">
                        <span class="config-section-title">Music</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                        <div class="form-group">
                            <label class="form-label">Background Music</label>
                            <select class="form-select" id="config-music">
                                <option value="none">None</option>
                                <option value="maccary-bay">Maccary Bay</option>
                                <option value="reggae-party">Reggae Party</option>
                                <option value="custom">Custom (Upload)</option>
                            </select>
                        </div>
                        
                        <div id="custom-music-options" class="hidden" style="margin-top: 12px;">
                            <div class="form-group">
                                <label class="form-label">Upload Music</label>
                                <div class="custom-music-upload" id="custom-music-dropzone" style="border: 2px dashed var(--surface-light); border-radius: 8px; padding: 16px; text-align: center; cursor: pointer; transition: all 0.2s;">
                                    <span class="material-symbols-outlined" style="font-size: 28px; color: var(--text-muted);">music_note</span>
                                    <p style="margin: 6px 0 0; color: var(--text-muted); font-size: 11px;">Drop audio file here or click to browse<br>(MP3, WAV, OGG)</p>
                                    <input type="file" id="custom-music-file" accept="audio/*" style="display: none;">
                                </div>
                                <div id="custom-music-preview" class="hidden" style="margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                                    <div style="display: flex; align-items: center; gap: 10px;">
                                        <button class="btn btn-icon btn-sm" id="custom-music-play" title="Play/Pause">
                                            <span class="material-symbols-outlined">play_arrow</span>
                                        </button>
                                        <span id="custom-music-name" style="flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">No file selected</span>
                                        <button class="btn btn-icon btn-sm btn-danger" id="custom-music-remove" title="Remove">
                                            <span class="material-symbols-outlined">close</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="form-group" id="music-volume-group">
                            <label class="form-label">Volume</label>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <input type="range" class="form-range" id="config-music-volume" min="0" max="100" value="50" style="flex: 1;">
                                <span id="config-music-volume-label" style="font-size: 12px; color: var(--text-muted); min-width: 35px;">50%</span>
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">Loop</label>
                            <label class="toggle">
                                <input type="checkbox" id="config-music-loop" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>
                
                <!-- Player -->
                <div class="config-section collapsible">
                    <div class="config-section-header">
                        <span class="config-section-title">Player</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                        <div class="form-group">
                            <label class="form-label">Movement Speed</label>
                            <input type="number" class="form-input" id="config-player-speed" min="0.1" step="0.5" value="5">
                            <small style="color: #888; font-size: 11px;">Default: 5 - Higher = faster</small>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Jump Height</label>
                            <input type="number" class="form-input" id="config-jump-force" min="-50" max="-1" step="0.5" value="-14">
                            <small style="color: #888; font-size: 11px;">Default: -14 - Lower = higher jump</small>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Jump Count</label>
                        <select class="form-select" id="config-jumps">
                            <option value="set">Set Number</option>
                            <option value="infinite">Infinite</option>
                        </select>
                    </div>
                    <div class="form-group" id="config-jumps-number-group">
                        <label class="form-label">Number of Jumps</label>
                        <input type="number" class="form-input" id="config-jumps-number" min="0" value="1">
                    </div>
                    <div class="form-group" id="config-airjump-group">
                        <label class="form-label">Additional Airjump</label>
                        <label class="toggle">
                            <input type="checkbox" id="config-airjump">
                            <span class="toggle-slider"></span>
                        </label>
                            <small style="color: #888; font-size: 11px;">When enabled, all jumps available in air</small>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Collide with Each Other</label>
                        <label class="toggle">
                            <input type="checkbox" id="config-collide" checked>
                            <span class="toggle-slider"></span>
                        </label>
                        </div>
                    <div class="form-group" id="config-player-sprite-group">
                        <label class="form-label">Character Sprite Sheet</label>
                        <input type="file" id="config-player-sprite-file" accept="image/png,image/jpeg,image/webp" class="form-input">
                        <small style="display:block; margin-top:6px; color:#888; font-size:11px; line-height:1.4;">Upload a PNG, JPEG, or WebP up to 1 MB. Idle, run, jump, and fall use separate rows; frames run left to right. Optionally configure Attack, Hurt, and Dash rows for plugins that use those player states. Sprites replace the colored player, while the player name and collision box stay in place.</small>
                        <div style="display:flex; gap:8px; margin:10px 0;">
                            <label style="font-size:11px; color:#888;">Frame W<input type="number" id="config-player-sprite-frame-width" class="form-input" min="1" max="4096" step="1" value="32" style="width:90px;"></label>
                            <label style="font-size:11px; color:#888;">Frame H<input type="number" id="config-player-sprite-frame-height" class="form-input" min="1" max="4096" step="1" value="32" style="width:90px;"></label>
                        </div>
                        <div style="display:grid; grid-template-columns: repeat(4, minmax(48px, 1fr)); gap:6px; font-size:10px; color:#888; margin-bottom:4px;">
                            <span>State</span><span>Row</span><span>Frames</span><span>FPS</span>
                        </div>
                        ${['idle', 'run', 'jump', 'fall'].map((state, index) => `
                            <div style="display:grid; grid-template-columns: repeat(4, minmax(48px, 1fr)); gap:6px; align-items:center; margin-top:5px;">
                                <span style="font-size:11px; color:#bbb; text-transform:capitalize;">${state}</span>
                                <input type="number" class="form-input" id="config-player-sprite-${state}-row" min="0" max="127" step="1" value="${index}" aria-label="${state} animation row">
                                <input type="number" class="form-input" id="config-player-sprite-${state}-frames" min="1" max="256" step="1" value="1" aria-label="${state} animation frames">
                                <input type="number" class="form-input" id="config-player-sprite-${state}-fps" min="1" max="30" step="1" value="8" aria-label="${state} animation speed">
                            </div>
                        `).join('')}
                        ${[['attack', 'Attack'], ['hurt', 'Hurt'], ['dash', 'Dash']].map(([state, label], index) => `
                            <label style="display:flex;align-items:center;gap:8px;font-size:11px;color:#bbb;margin-top:8px;">
                                <input type="checkbox" id="config-player-sprite-${state}-enabled"> Configure ${label.toLowerCase()} animation
                            </label>
                            <div id="config-player-sprite-${state}-row" class="hidden" style="display:grid;grid-template-columns:repeat(4,minmax(48px,1fr));gap:6px;align-items:center;margin-top:5px;">
                                <span style="font-size:11px;color:#bbb;">${state}</span>
                                <input type="number" class="form-input" id="config-player-sprite-${state}-row-index" min="0" max="127" step="1" value="${4 + index}" aria-label="${label} animation row">
                                <input type="number" class="form-input" id="config-player-sprite-${state}-frames" min="1" max="256" step="1" value="1" aria-label="${label} animation frames">
                                <input type="number" class="form-input" id="config-player-sprite-${state}-fps" min="1" max="30" step="1" value="${state === 'attack' ? 12 : 8}" aria-label="${label} animation speed">
                            </div>
                        `).join('')}
                        <div id="config-player-sprite-status" style="font-size:11px; color:#888; margin-top:7px;">No character sprite sheet selected.</div>
                        <button type="button" class="btn btn-secondary" id="config-player-sprite-clear" style="margin-top:7px;">Clear Character Sprite</button>
                    </div>
                    </div>
                </div>
                
                <!-- World -->
                <div class="config-section collapsible">
                    <div class="config-section-header">
                        <span class="config-section-title">World</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                    <div class="form-group">
                            <label class="form-label">Gravity</label>
                            <input type="number" class="form-input" id="config-gravity" min="0.1" step="0.1" value="0.71">
                            <small style="color: #888; font-size: 11px;">Default: 0.71 - Higher = faster fall</small>
                    </div>
                    <div class="form-group">
                            <label class="form-label">Horizontal Acceleration</label>
                            <input type="number" class="form-input" id="config-horizontal-acceleration" min="0" max="20" step="0.1" value="0">
                            <small style="color: #888; font-size: 11px;">0 keeps instant movement; higher values build speed and brake more gradually.</small>
                    </div>
                    <div class="form-group">
                            <label class="form-label">Air Control</label>
                            <input type="number" class="form-input" id="config-air-control" min="0" max="1" step="0.05" value="1">
                            <small style="color: #888; font-size: 11px;">Scales acceleration and braking while airborne; 0 preserves momentum in the air.</small>
                    </div>
                    <div class="form-group">
                            <label class="form-label">Terminal Fall Speed</label>
                            <input type="number" class="form-input" id="config-terminal-fall-speed" min="1" max="100" step="0.5" value="16">
                            <small style="color: #888; font-size: 11px;">Maximum downward speed. Leave unchanged to keep the legacy gravity-scaled default.</small>
                    </div>
                        <div class="form-group">
                            <label class="form-label">Camera Horizontal Smoothness</label>
                            <input type="range" class="form-range" id="config-camera-lerp-x" min="0.02" max="1" step="0.01" value="0.12" style="width: 100%;">
                            <div style="display: flex; justify-content: space-between; font-size: 10px; color: #666;">
                                <span>Smooth</span>
                                <span id="config-camera-lerp-x-value">0.12</span>
                                <span>Snappy</span>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Camera Vertical Smoothness</label>
                            <input type="range" class="form-range" id="config-camera-lerp-y" min="0.02" max="1" step="0.01" value="0.12" style="width: 100%;">
                            <div style="display: flex; justify-content: space-between; font-size: 10px; color: #666;">
                                <span>Smooth</span>
                                <span id="config-camera-lerp-y-value">0.12</span>
                                <span>Snappy</span>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Camera Follow</label>
                            <select class="form-select" id="config-camera-follow-mode">
                                <option value="both">Follow both axes</option>
                                <option value="horizontal">Follow horizontally</option>
                                <option value="vertical">Follow vertically</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Camera Bounds</label>
                            <label class="toggle">
                                <input type="checkbox" id="config-camera-bounds-enabled">
                                <span class="toggle-slider"></span>
                            </label>
                            <small style="color: #888; font-size: 11px;">Keep the gameplay camera inside this world-space rectangle.</small>
                        </div>
                        <div id="config-camera-bounds-fields" style="display: none; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px;">
                            <div class="form-group">
                                <label class="form-label">Left (X)</label>
                                <input type="number" class="form-input" id="config-camera-bounds-x" step="1" value="0">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Top (Y)</label>
                                <input type="number" class="form-input" id="config-camera-bounds-y" step="1" value="0">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Width</label>
                                <input type="number" class="form-input" id="config-camera-bounds-width" min="1" step="1" value="2000">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Height</label>
                                <input type="number" class="form-input" id="config-camera-bounds-height" min="1" step="1" value="1200">
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Death Line Y</label>
                            <input type="number" class="form-input" id="config-die-line-y" value="2000">
                            <small style="color: #888; font-size: 11px;">Players die below this Y position</small>
                </div>
                
                        <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--surface-light);">
                            <label class="form-label" style="font-weight: 600; margin-bottom: 12px;">Spike Behavior</label>
                            <div class="form-group">
                                <label class="form-label">Touchbox Mode</label>
                                <select class="form-select" id="config-spike-touchbox">
                                    <option value="full">Full Spike</option>
                                    <option value="normal" selected>Normal Spike</option>
                                    <option value="tip">Tip Spike</option>
                                    <option value="all-spike">All Spike</option>
                                    <option value="ground">Ground</option>
                                    <option value="flag">Flag</option>
                                    <option value="air">Air</option>
                                </select>
                                <div id="spike-touchbox-description" style="margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 12px; color: #aaa; line-height: 1.5;">
                                    <strong style="color: #fff;">Normal Spike:</strong> The flat base acts as ground. Other parts damage the player.
                                </div>
                            </div>
                            
                            <div class="form-group" style="margin-top: 12px;">
                                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                                    <label class="toggle">
                                        <input type="checkbox" id="config-drop-hurt-only">
                                        <span class="toggle-slider"></span>
                                    </label>
                                    <label class="form-label" for="config-drop-hurt-only" style="margin: 0; cursor: pointer;">Drop Hurt Only</label>
                                </div>
                                <div id="drop-hurt-only-description" style="padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 12px; color: #aaa; line-height: 1.5;">
                                    <strong style="color: #fff;">Drop Hurt Only:</strong> Spikes only damage the player when they are moving <em>toward</em> the spike's tip direction. For example, a spike pointing up will only hurt a player who is falling down (or moving down-left/down-right). If the player jumps up through the spike, they won't be hurt.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Export & Import -->
                <div class="config-section collapsible">
                    <div class="config-section-header">
                        <span class="config-section-title">Export & Import</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                        <button class="btn btn-secondary" id="btn-export" style="flex: 1;">
                            <span class="material-symbols-outlined">download</span>
                            Export
                        </button>
                        <button class="btn btn-secondary" id="btn-import" style="flex: 1;">
                            <span class="material-symbols-outlined">upload</span>
                            Import
                        </button>
                    </div>
                    <input type="file" id="import-file" accept=".pkrn" style="display: none;">
                        
                        <div class="form-group">
                            <label class="form-label">Data Format <span style="color: #888; font-size: 11px;">(Advanced)</span></label>
                            <select class="form-select" id="config-stored-data-type">
                                <option value="json" selected>.json</option>
                                <option value="dat">.dat</option>
                            </select>
                            <div id="stored-data-type-description" style="margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 12px; color: #aaa; line-height: 1.5;">
                                <strong style="color: #fff;">.json:</strong> Human-readable. Recommended for smaller maps.
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Host Game -->
                <div class="config-section collapsible">
                    <div class="config-section-header">
                        <span class="config-section-title">Host Game</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                    <div class="form-group">
                            <label class="form-label">Max Players</label>
                        <input type="number" class="form-input" id="config-max-players" min="1" max="10" value="10">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="config-room-visibility">Room Visibility</label>
                        <select class="form-select" id="config-room-visibility">
                            <option value="private" selected>Private · join by code</option>
                            <option value="public">Public · show in Lobbies</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Use Password</label>
                        <label class="toggle">
                            <input type="checkbox" id="config-use-password">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="form-group hidden" id="config-password-group">
                            <label class="form-label">Password</label>
                        <div style="display: flex; gap: 8px;">
                            <input type="text" class="form-input" id="config-password" style="flex: 1;">
                            <button class="btn btn-icon btn-secondary" id="btn-regenerate-password" title="Regenerate">
                                <span class="material-symbols-outlined">replay</span>
                            </button>
                        </div>
                    </div>
                    <button class="btn btn-accent" id="btn-host-game" style="width: 100%; margin-top: 8px;">
                        <span class="material-symbols-outlined">videogame_asset</span>
                        Host Game
                    </button>
                </div>
                </div>
                
                <!-- Plugins -->
                <div class="config-section" style="margin-top: 16px; padding-top: 16px; border-top: 2px solid var(--surface-light);">
                    <button class="btn btn-secondary" id="btn-plugins" style="width: 100%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none; color: white;">
                        <span class="material-symbols-outlined">extension</span>
                        Plugins
                    </button>
                </div>
                
                <!-- Mechanics (always visible) -->
                <div class="config-section" style="margin-top: 12px;">
                    <button class="btn btn-secondary" id="btn-edit-mechanics" style="width: 100%; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); border: none; color: white;">
                        <span class="material-symbols-outlined">code</span>
                        Edit Mechanics
                    </button>
                </div>
                
                <!-- HP Section (hidden by default, shown when HP plugin enabled) -->
                <div class="config-section collapsible hidden" id="config-section-hp">
                    <div class="config-section-header">
                        <span class="config-section-title">❤️ HP Settings</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                        <div class="form-group">
                            <label class="form-label">Default HP</label>
                            <input type="number" class="form-input" id="config-hp-default" min="1" max="99" value="3">
                            <small style="color: #888; font-size: 11px;">Starting health points for players</small>
                        </div>
                    </div>
                </div>
                
                <!-- Hollow Knight Section (hidden by default, shown when HK plugin enabled) -->
                <div class="config-section collapsible hidden" id="config-section-hk">
                    <div class="config-section-header">
                        <span class="config-section-title">Hollow Knight</span>
                        <span class="material-symbols-outlined config-section-arrow">expand_more</span>
                    </div>
                    <div class="config-section-content">
                        <div class="form-group">
                            <label class="form-label">HK Gravity</label>
                            <input type="number" class="form-input" id="config-hk-gravity" min="0.1" max="3" step="0.01" value="1.14">
                            <small style="color: #888; font-size: 11px;">1.14 = 70% jump height (HK-style)</small>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Max Soul</label>
                            <input type="number" class="form-input" id="config-hk-maxsoul" min="33" max="198" value="99">
                            <small style="color: #888; font-size: 11px;">33 = one heal, 99 = three heals</small>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="config-hk-pogo-bounce-power">Pogo Bounce Strength</label>
                            <input type="number" class="form-input" id="config-hk-pogo-bounce-power" min="0.5" max="2" step="0.1" value="1.2">
                            <small style="color: #888; font-size: 11px;">Upward bounce after a downward nail hit, relative to normal jump strength.</small>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="config-hk-nail-speed">Nail Attack Speed</label>
                            <select class="form-select" id="config-hk-nail-speed">
                                <option value="base">Base (0.41s between attacks)</option>
                                <option value="quickSlash">Quick Slash (0.25s between attacks)</option>
                            </select>
                        </div>
                        <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <span style="font-size: 13px;">Monarch Wings</span>
                                <p style="margin: 2px 0 0; font-size: 10px; color: var(--text-muted);">Double jump ability</p>
                            </div>
                            <label class="toggle">
                                <input type="checkbox" id="config-hk-monarchwing">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="form-group" id="config-hk-monarchwing-amount-group">
                            <label class="form-label">Monarch Wing Amount</label>
                            <input type="number" class="form-input" id="config-hk-monarchwing-amount" min="1" max="99" value="1">
                        </div>
                        <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <span style="font-size: 13px;">Mothwing Cloak (Dash)</span>
                                <p style="margin: 2px 0 0; font-size: 10px; color: var(--text-muted);">Press comma (,) to dash</p>
                            </div>
                            <label class="toggle">
                                <input type="checkbox" id="config-hk-dash">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <span style="font-size: 13px;">Crystal Heart (Super Dash)</span>
                                <p style="margin: 2px 0 0; font-size: 10px; color: var(--text-muted);">Hold period (.) to charge</p>
                            </div>
                            <label class="toggle">
                                <input type="checkbox" id="config-hk-superdash">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <span style="font-size: 13px;">Mantis Claw (Wall Jump)</span>
                                <p style="margin: 2px 0 0; font-size: 10px; color: var(--text-muted);">Cling to walls and wall jump</p>
                            </div>
                            <label class="toggle">
                                <input type="checkbox" id="config-hk-mantisclaw">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--surface-light);">
                            <label class="form-label" style="font-weight: 600; margin-bottom: 12px;">Visual Effects</label>
                            <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                                <span style="font-size: 13px;">Nail Slash Effects</span>
                                <label class="toggle"><input type="checkbox" id="config-hk-slash-effects" checked><span class="toggle-slider"></span></label>
                            </div>
                            <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                                <span style="font-size: 13px;">Nail Impact Effects</span>
                                <label class="toggle"><input type="checkbox" id="config-hk-impact-effects" checked><span class="toggle-slider"></span></label>
                            </div>
                            <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                                <span style="font-size: 13px;">Camera Impact Effects</span>
                                <label class="toggle"><input type="checkbox" id="config-hk-camera-shake-effects" aria-label="Enable Hollow Knight camera impact effects" checked><span class="toggle-slider"></span></label>
                            </div>
                            <div id="config-hk-camera-shake-settings">
                                <div class="form-group">
                                    <label class="form-label" for="config-hk-impact-shake-intensity">Hit Shake Strength</label>
                                    <input type="number" class="form-input" id="config-hk-impact-shake-intensity" min="0" max="18" step="0.5" value="7">
                                    <small style="color: #888; font-size: 11px;">Maximum screen-pixel shake for nail hits and Super Dash impacts.</small>
                                </div>
                                <div class="form-group">
                                    <label class="form-label" for="config-hk-landing-shake-intensity">Landing Shake Strength</label>
                                    <input type="number" class="form-input" id="config-hk-landing-shake-intensity" min="0" max="8" step="0.5" value="2">
                                </div>
                            </div>
                            <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                                <span style="font-size: 13px;">Dash Trails</span>
                                <label class="toggle"><input type="checkbox" id="config-hk-dash-trail-effects" checked><span class="toggle-slider"></span></label>
                            </div>
                            <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
                                <span style="font-size: 13px;">Charge and Focus Auras</span>
                                <label class="toggle"><input type="checkbox" id="config-hk-ability-aura-effects" checked><span class="toggle-slider"></span></label>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Nail Effect Color</label>
                                <input type="color" class="form-input" id="config-hk-nail-effect-color" value="#e9fbff">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Dash Trail Color</label>
                                <input type="color" class="form-input" id="config-hk-dash-effect-color" value="#9cecff">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Super Dash Charge Color</label>
                                <input type="color" class="form-input" id="config-hk-charge-effect-color" value="#9cecff">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Focus Aura Color</label>
                                <input type="color" class="form-input" id="config-hk-heal-effect-color" value="#79f2cf">
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Code Section is now hidden (mechanics are built-in) -->
            </div>
        `;
        document.body.appendChild(configPanel);
        this.ui.configPanel = configPanel;
        
        // Plugins Library Popup
        const pluginsPopup = document.createElement('div');
        pluginsPopup.className = 'modal-overlay';
        pluginsPopup.id = 'plugins-popup';
        pluginsPopup.innerHTML = `
            <div class="modal" style="max-width: 700px; width: 95%; max-height: 85vh; display: flex; flex-direction: column;">
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 16px; border-bottom: 1px solid var(--surface-light);">
                    <h2 class="modal-title" style="margin: 0;">🧩 Plugins Library</h2>
                    <button class="btn btn-icon btn-ghost" id="close-plugins-popup">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div style="overflow-y: auto; padding: 16px 0; flex: 1;">
                    <!-- HP Plugin -->
                    <div class="plugin-card" data-plugin="hp" style="background: var(--bg-light); border-radius: 12px; overflow: hidden; margin-bottom: 16px;">
                        <img src="assets/plugins/hp/cover.png" alt="HP Plugin" style="width: 100%; height: auto; display: block;">
                        <div style="padding: 16px 20px 20px;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <div style="flex: 1;">
                                    <h3 style="margin: 0 0 8px 0; color: #FF6B6B;">
                                        HP (Health Points)
                                    </h3>
                                    <p style="margin: 0 0 12px 0; color: var(--text-muted); font-size: 13px; line-height: 1.5;">
                                        Adds a health system to the game. Players start with configurable HP. 
                                        Touching spikes removes 1 HP and teleports player to the last safe ground they stood on.
                                    </p>
                                </div>
                                <button class="btn plugin-toggle-btn" data-plugin="hp" style="min-width: 80px; margin-left: 16px;">
                                    Add
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Hollow Knight Plugin -->
                    <div class="plugin-card" data-plugin="hk" style="background: var(--bg-light); border-radius: 12px; overflow: hidden; margin-bottom: 16px;">
                        <img src="assets/plugins/hk/cover.png" alt="Hollow Knight Plugin" style="width: 100%; height: auto; display: block;">
                        <div style="padding: 16px 20px 20px;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <div style="flex: 1;">
                                    <h3 style="margin: 0 0 8px 0; color: #667eea; display: flex; align-items: center; gap: 8px;">
                                        Hollow Knight
                                        <span style="font-size: 11px; background: rgba(255,107,107,0.2); color: #FF6B6B; padding: 2px 8px; border-radius: 4px;">Requires HP</span>
                                    </h3>
                                    <p style="margin: 0 0 12px 0; color: var(--text-muted); font-size: 13px; line-height: 1.5;">
                                        Adds Hollow Knight-style mechanics: Soul system, nail attacks, 
                                        Monarch Wings (double jump), Mothwing Cloak (dash), Crystal Heart (super dash), 
                                        and Focus healing.
                                    </p>
                                    <div style="font-size: 11px; color: var(--text-muted); display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
                                        <span>X - Attack (+ ↑/↓ for direction)</span>
                                        <span>, (comma) - Dash</span>
                                        <span>. (period) - Super Dash (hold)</span>
                                        <span>F - Focus/Heal (hold)</span>
                                    </div>
                                </div>
                                <button class="btn plugin-toggle-btn" data-plugin="hk" style="min-width: 80px; margin-left: 16px;">
                                    Add
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <!-- CJ (Controllable Jump) Plugin -->
                    <div class="plugin-card" data-plugin="cj" style="background: var(--bg-light); border-radius: 12px; overflow: hidden; margin-bottom: 16px;">
                        <img src="assets/plugins/cj/cover.png" alt="Controllable Jump Plugin" style="width: 100%; height: auto; display: block;">
                        <div style="padding: 16px 20px 20px;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <div style="flex: 1;">
                                    <h3 style="margin: 0 0 8px 0; color: #4CAF50;">
                                        Controllable Jump
                                    </h3>
                                    <p style="margin: 0 0 12px 0; color: var(--text-muted); font-size: 13px; line-height: 1.5;">
                                        Adds variable jump height. Hold the jump key to jump higher, tap for a short hop.
                                        Release the jump key mid-air to cut upward velocity.
                                    </p>
                                </div>
                                <button class="btn plugin-toggle-btn" data-plugin="cj" style="min-width: 80px; margin-left: 16px;">
                                    Add
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Code Plugin is hidden (mechanics are built into the game) -->
                    <div id="plugins-dynamic-cards"></div>
                </div>
            </div>
        `;
        document.body.appendChild(pluginsPopup);
        this.ui.pluginsPopup = pluginsPopup;
        
        // Setup collapsible sections
        this.setupCollapsibleSections();

        // Layers Panel
        const layersPanel = document.createElement('div');
        layersPanel.className = 'layers-panel';
        layersPanel.id = 'layers-panel';
        layersPanel.innerHTML = `
            <div class="panel-header">
                <span class="panel-title">Layers</span>
                <div class="layer-panel-add-buttons">
                    <button class="btn btn-icon btn-ghost" id="add-layer-behind" title="Add a layer behind the player" aria-label="Add a layer behind the player">
                        <span class="material-symbols-outlined">add_to_queue</span>
                    </button>
                    <button class="btn btn-icon btn-ghost" id="add-layer-above" title="Add a layer above the player" aria-label="Add a layer above the player">
                        <span class="material-symbols-outlined">add_to_photos</span>
                    </button>
                </div>
                <button class="btn btn-icon btn-ghost" id="close-layers">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="panel-body" id="layers-list">
                <!-- Layer items will be dynamically added -->
            </div>
        `;
        document.body.appendChild(layersPanel);
        this.ui.layersPanel = layersPanel;
        this.ui.layersList = document.getElementById('layers-list');

        // Add Menu
        const addMenu = document.createElement('div');
        addMenu.className = 'add-menu';
        addMenu.id = 'add-menu';
        addMenu.innerHTML = `
            <button class="add-menu-btn" data-add="block">
                <span class="material-symbols-outlined">square</span>
                Block
            </button>
            <button class="add-menu-btn" data-add="tilemap">
                <span class="material-symbols-outlined">grid_on</span>
                Tilemap Brush
            </button>
            <button class="add-menu-btn" data-add="obstacle">
                <span class="material-symbols-outlined">warning</span>
                Obstacle
            </button>
            <button class="add-menu-btn" data-add="spawn_end">
                <span class="material-symbols-outlined">person_pin_circle</span>
                Spawn &amp; end
            </button>
            <button class="add-menu-btn" data-add="koreen">
                <span class="material-symbols-outlined">device_hub</span>
                Game Item
            </button>
            <button class="add-menu-btn" data-add="text">
                <span class="material-symbols-outlined">text_fields</span>
                Text Box
            </button>
            <button class="add-menu-btn" data-add="button">
                <span class="material-symbols-outlined">smart_button</span>
                Button
            </button>
            <button class="add-menu-btn" data-add="teleportal">
                <span class="material-symbols-outlined">move</span>
                Teleportal
            </button>
            <button class="add-menu-btn" data-add="object_stamp">
                <span class="material-symbols-outlined">collections</span>
                Object Stamp
            </button>
        `;
        document.body.appendChild(addMenu);
        this.ui.addMenu = addMenu;

        // Placement Toolbar
        this.createPlacementToolbar();

        // Settings Panel (ingame)
        this.createSettingsPanel();
    }

    createPlacementToolbar() {
        const placementToolbar = document.createElement('div');
        placementToolbar.className = 'placement-toolbar';
        placementToolbar.id = 'placement-toolbar';
        placementToolbar.innerHTML = `
            <!-- Block Texture Option -->
            <div class="placement-option" id="placement-texture">
                <span class="placement-option-label">Texture</span>
                <div class="texture-dropdown" id="texture-dropdown">
                    <button class="texture-dropdown-trigger" id="texture-dropdown-trigger">
                        <div class="texture-preview" id="texture-preview-solid" style="width: 24px; height: 24px; background: #787878; border-radius: 4px;"></div>
                        <span id="texture-dropdown-value">Solid</span>
                        <span class="material-symbols-outlined">expand_more</span>
                    </button>
                    <div class="texture-dropdown-menu" id="texture-dropdown-menu">
                        <!-- Will be populated dynamically -->
                    </div>
                </div>
            </div>

            <div class="placement-option hidden" id="placement-tilemap-layer">
                <label class="placement-option-label" for="placement-tilemap-layer-select">Tilemap layer</label>
                <select class="form-input form-input-sm" id="placement-tilemap-layer-select" style="max-width: 170px;"></select>
            </div>

            <div class="placement-option hidden" id="placement-tilemap-behavior">
                <label class="placement-option-label" for="placement-tilemap-behavior-select">Cell behavior</label>
                <select class="form-input form-input-sm" id="placement-tilemap-behavior-select" style="max-width: 170px;">
                    <option value="solid">Solid</option>
                    <option value="oneWay">One-way platform</option>
                    <option value="rampUpRight">Ramp rising to the right</option>
                    <option value="rampUpLeft">Ramp rising to the left</option>
                    <option value="hazard">Damage on touch</option>
                    <option value="decorative">Decorative (no collision)</option>
                </select>
            </div>

            <div class="placement-option hidden" id="placement-tilemap-collision-shape">
                <label class="placement-option-label" for="placement-tilemap-collision-shape-select">Collision shape</label>
                <select class="form-input form-input-sm" id="placement-tilemap-collision-shape-select" style="max-width:170px;">
                    <option value="box">Full cell</option>
                    <option value="polygon">Custom convex polygon</option>
                </select>
                <small>Polygon geometry applies to solid and one-way cells; tile artwork stays independent from collision.</small>
                <div id="placement-tilemap-polygon-settings" style="display:none;gap:8px;align-items:flex-start;flex-wrap:wrap;flex-basis:100%;">
                    <label class="placement-option-label" style="display:flex;align-items:center;gap:6px;">
                        <input type="checkbox" id="placement-tilemap-polygon-one-way">
                        One-way top surface
                    </label>
                    <label class="placement-option-label" for="placement-tilemap-collision-points">Normalized vertices</label>
                    <textarea class="form-input form-input-sm" id="placement-tilemap-collision-points" rows="3" spellcheck="false" style="min-width:min(320px,70vw);font-family:monospace;">${JSON.stringify(WorldObject.DEFAULT_COLLISION_POLYGON)}</textarea>
                    <small id="placement-tilemap-collision-points-status" role="status">3–12 ordered convex vertices from 0 to 1.</small>
                </div>
            </div>

            <div class="placement-option hidden" id="placement-tilemap-atlas" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <label class="placement-option-label" for="placement-tilemap-atlas-file">Tile atlas</label>
                <input class="form-input form-input-sm" id="placement-tilemap-atlas-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload tile atlas" style="max-width:210px;">
                <label class="placement-option-label" for="placement-tilemap-atlas-frame">Frame</label>
                <input class="form-input form-input-sm" id="placement-tilemap-atlas-frame" type="number" min="0" max="4095" step="1" value="0" style="width:78px;" aria-label="Tile atlas frame index">
                <label class="placement-option-label" for="placement-tilemap-frame-width">Frame size</label>
                <input class="form-input form-input-sm" id="placement-tilemap-frame-width" type="number" min="1" max="512" step="1" value="32" style="width:64px;" aria-label="Tile atlas frame width">
                <span aria-hidden="true">×</span>
                <input class="form-input form-input-sm" id="placement-tilemap-frame-height" type="number" min="1" max="512" step="1" value="32" style="width:64px;" aria-label="Tile atlas frame height">
                <canvas id="placement-tilemap-atlas-preview" width="32" height="32" aria-label="Selected tile atlas frame preview" style="width:32px;height:32px;image-rendering:pixelated;border:1px solid var(--border);"></canvas>
                <button type="button" class="btn btn-sm btn-ghost" id="placement-tilemap-atlas-clear">Clear atlas</button>
                <small id="placement-tilemap-atlas-status" role="status" style="flex-basis:100%;">No atlas selected. Cells use built-in textures.</small>
            </div>

            <div class="placement-option hidden" id="placement-tilemap-animation">
                <label class="placement-option-label" for="placement-tilemap-animation-select">Tile animation</label>
                <select class="form-input form-input-sm" id="placement-tilemap-animation-select" style="max-width: 170px;">
                    <option value="none">Static</option>
                    <option value="textureCycle">Texture cycle</option>
                    <option value="atlasCycle">Atlas frame cycle</option>
                </select>
                <div id="placement-tilemap-animation-settings" class="hidden" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;">
                    <label class="placement-option-label" for="placement-tilemap-frame-count">Frames</label>
                    <select class="form-input form-input-sm" id="placement-tilemap-frame-count" aria-label="Tile animation frame count" style="max-width:80px;">
                        <option value="2">2</option><option value="3">3</option><option value="4">4</option>
                        <option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option>
                    </select>
                    <div id="placement-tilemap-frame-selectors" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;"></div>
                    <label class="placement-option-label" for="placement-tilemap-animation-fps">FPS</label>
                    <input class="form-input form-input-sm" id="placement-tilemap-animation-fps" type="number" min="1" max="12" step="1" value="4" aria-label="Tile animation frames per second" style="width:70px;">
                </div>
            </div>
            
            <!-- Hidden appearance for backwards compatibility -->
            <div class="placement-option hidden" id="placement-appearance">
                <span class="placement-option-label">Appearance</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn active" data-appearance="ground">Ground</button>
                    <button class="placement-opt-btn" data-appearance="spike">Spike</button>
                </div>
            </div>
            
            <div class="placement-option" id="placement-acting">
                <span class="placement-option-label">Acting Type</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn active" data-acting="ground">Ground</button>
                    <button class="placement-opt-btn" data-acting="spike">Spike</button>
                    <button class="placement-opt-btn" data-acting="checkpoint">Check</button>
                    <button class="placement-opt-btn" data-acting="spawnpoint">Spawn</button>
                    <button class="placement-opt-btn" data-acting="endpoint">End</button>
                </div>
            </div>

            <div class="placement-option hidden" id="placement-spawn-end-marker">
                <span class="placement-option-label">Marker type</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn active" data-spawn-end-marker="spawnpoint">Spawn</button>
                    <button class="placement-opt-btn" data-spawn-end-marker="endpoint">End</button>
                </div>
            </div>
            
            <div class="placement-option" id="placement-collision">
                <span class="placement-option-label">Collision</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn active" data-collision="true">On</button>
                    <button class="placement-opt-btn" data-collision="false">Off</button>
                </div>
            </div>
            
            <div class="placement-option" id="placement-fill">
                <span class="placement-option-label">Add Type</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn active" data-fill="add">Add</button>
                    <button class="placement-opt-btn" data-fill="replace">Replace</button>
                    <button class="placement-opt-btn" data-fill="overlap">Overlap</button>
                </div>
            </div>

            <div class="placement-option hidden" id="placement-coin-snap">
                <span class="placement-option-label">Snap to Grid</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn active" data-coin-snap="true">True</button>
                    <button class="placement-opt-btn" data-coin-snap="false">False</button>
                </div>
            </div>
            
            <div class="placement-option" id="placement-color">
                <span class="placement-option-label">Color</span>
                <div class="color-picker-option">
                    <div class="color-preview" id="placement-color-preview" style="background: #787878"></div>
                    <input type="text" class="form-input form-input-sm color-input" id="placement-color-input" value="#787878">
                </div>
            </div>
            
            <div class="placement-option" id="placement-opacity">
                <span class="placement-option-label">Opacity</span>
                <input type="number" class="form-input form-input-sm" id="placement-opacity-input" min="0" max="100" value="100" style="width: 60px;">
                <span style="font-size: 12px; color: var(--text-muted);">%</span>
            </div>
            
            <!-- Text-specific options (hidden by default) -->
            <div class="placement-option hidden" id="placement-content" style="flex-direction: column; align-items: flex-start;">
                <span class="placement-option-label">Content</span>
                <textarea class="form-input form-input-sm" id="placement-content-input" rows="3" style="width: 180px; resize: vertical; font-family: 'Parkoreen Game';">Text</textarea>
            </div>
            
            <div class="placement-option hidden" id="placement-font">
                <span class="placement-option-label">Font</span>
                <div class="font-dropdown" id="font-dropdown">
                    <button class="font-dropdown-trigger" id="font-dropdown-trigger">
                        <span id="font-dropdown-value" style="font-family: 'Parkoreen Game';">Parkoreen Game</span>
                        <span class="material-symbols-outlined">expand_more</span>
                    </button>
                    <div class="font-dropdown-menu" id="font-dropdown-menu">
                        <!-- Will be populated dynamically -->
                    </div>
                </div>
            </div>
            
            <div class="placement-option hidden" id="placement-fontsize">
                <span class="placement-option-label">Font Size</span>
                <input type="number" class="form-input form-input-sm" id="placement-fontsize-input" min="8" max="200" value="24" style="width: 70px;">
                <span style="font-size: 12px; color: var(--text-muted);">px</span>
            </div>
            
            <div class="placement-option hidden" id="placement-font-preview" style="flex-direction: column; align-items: flex-start; width: 100%;">
                <span class="placement-option-label">Preview</span>
                <div id="font-preview-box" style="width: 100%; padding: 10px; background: rgba(0,0,0,0.3); border-radius: 6px; min-height: 36px; display: flex; align-items: center; justify-content: center;">
                    <span id="font-preview-text" style="font-family: 'Parkoreen Game'; font-size: 16px; color: #fff;">Text</span>
                </div>
            </div>
            
            <div class="placement-option hidden" id="placement-halign">
                <span class="placement-option-label">H-Align</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn" data-halign="left">
                        <span class="material-symbols-outlined" style="font-size: 16px;">format_align_left</span>
                    </button>
                    <button class="placement-opt-btn active" data-halign="center">
                        <span class="material-symbols-outlined" style="font-size: 16px;">format_align_center</span>
                    </button>
                    <button class="placement-opt-btn" data-halign="right">
                        <span class="material-symbols-outlined" style="font-size: 16px;">format_align_right</span>
                    </button>
                </div>
            </div>
            
            <div class="placement-option hidden" id="placement-valign">
                <span class="placement-option-label">V-Align</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn" data-valign="top">
                        <span class="material-symbols-outlined" style="font-size: 16px;">vertical_align_top</span>
                    </button>
                    <button class="placement-opt-btn active" data-valign="center">
                        <span class="material-symbols-outlined" style="font-size: 16px;">vertical_align_center</span>
                    </button>
                    <button class="placement-opt-btn" data-valign="bottom">
                        <span class="material-symbols-outlined" style="font-size: 16px;">vertical_align_bottom</span>
                    </button>
                </div>
            </div>
            
            <div class="placement-option hidden" id="placement-hspacing">
                <span class="placement-option-label" title="Space between characters">Char Spacing</span>
                <input type="number" class="form-input form-input-sm" id="placement-hspacing-input" value="0" style="width: 60px;">
                <span style="font-size: 12px; color: var(--text-muted);">%</span>
            </div>
            
            <div class="placement-option hidden" id="placement-vspacing">
                <span class="placement-option-label" title="Space between lines">Line Spacing</span>
                <input type="number" class="form-input form-input-sm" id="placement-vspacing-input" value="0" style="width: 60px;">
                <span style="font-size: 12px; color: var(--text-muted);">%</span>
            </div>
        `;
        document.body.appendChild(placementToolbar);
        this.ui.placementToolbar = placementToolbar;
        
        // Erase Toolbar
        this.createEraseToolbar();
    }
    
    createEraseToolbar() {
        // Erase options are now part of the placement toolbar
        // This creates a container that will be shown inside placement toolbar when erasing
        const eraseOptions = document.createElement('div');
        eraseOptions.id = 'erase-options';
        eraseOptions.className = 'erase-options';
        eraseOptions.style.display = 'none';
        eraseOptions.innerHTML = `
            <div class="placement-option">
                <span class="placement-option-label">Erase Type</span>
                <div class="placement-option-btns">
                    <button class="placement-opt-btn active" data-erase-type="all">All</button>
                    <button class="placement-opt-btn" data-erase-type="top">Top Layer</button>
                    <button class="placement-opt-btn" data-erase-type="bottom">Bottom Layer</button>
                </div>
            </div>
            <div class="placement-option">
                <span class="placement-option-label">Eraser Size</span>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <label style="font-size: 12px; color: var(--text-muted);">W:</label>
                    <input type="number" id="erase-width" class="form-input" style="width: 60px;" value="1" min="1" max="20">
                    <label style="font-size: 12px; color: var(--text-muted);">H:</label>
                    <input type="number" id="erase-height" class="form-input" style="width: 60px;" value="1" min="1" max="20">
                </div>
            </div>
        `;
        // Append to placement toolbar instead of body
        this.ui.placementToolbar.appendChild(eraseOptions);
        this.ui.eraseOptions = eraseOptions;
    }

    createSettingsPanel() {
        const settingsPanel = document.createElement('div');
        settingsPanel.className = 'settings-panel';
        settingsPanel.id = 'settings-panel';
        settingsPanel.innerHTML = `
            <div class="panel-header">
                <span class="panel-title">Settings</span>
                <button class="btn btn-icon btn-ghost" id="close-settings-panel">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="panel-body">
                <div class="form-group">
                    <label class="form-label">Volume</label>
                    <div class="settings-volume">
                        <input type="range" class="form-range" id="settings-volume-range" min="0" max="100" value="100">
                        <input type="number" class="form-input form-input-sm" id="settings-volume-number" min="0" max="100" value="100" style="width: 60px;">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Font Size</label>
                    <div class="settings-volume">
                        <input type="range" class="form-range" id="settings-fontsize-range" min="50" max="150" value="100">
                        <input type="number" class="form-input form-input-sm" id="settings-fontsize-number" min="50" max="150" value="100" style="width: 60px;">
                        <span style="font-size: 12px; color: var(--text-muted);">%</span>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Keyboard Layout</label>
                    <select class="form-select" id="settings-keyboard-layout">
                        <option value="jimmyqrg">JimmyQrg (Default)</option>
                        <option value="hk">Hollow Knight Original</option>
                    </select>
                    <div id="settings-keyboard-info" style="margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; font-size: 11px; color: #aaa; line-height: 1.5;">
                        <div id="settings-kb-jimmyqrg">
                            Move: A/D &nbsp; Jump: W &nbsp; Up/Down: ↑/↓<br>
                            Attack: N &nbsp; Heal: Shift &nbsp; Dash: , &nbsp; Super Dash: F
                        </div>
                        <div id="settings-kb-hk" style="display: none;">
                            Move: ←/→ &nbsp; Jump: Z &nbsp; Up/Down: ↑/↓<br>
                            Attack: X &nbsp; Heal: A &nbsp; Dash: C &nbsp; Super Dash: S
                        </div>
                    </div>
                </div>
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--surface-light);">
                    <button class="btn btn-secondary" id="settings-how-to-play" style="width: 100%; margin-bottom: 8px;">
                        <span class="material-symbols-outlined">help</span>
                        How To Play
                    </button>
                    <button class="btn btn-primary" id="settings-back-to-dashboard" style="width: 100%;">
                        <span class="material-symbols-outlined">home</span>
                        Back to Dashboard
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(settingsPanel);
        this.ui.settingsPanel = settingsPanel;
        
        // Object Edit Popup
        this.createObjectEditPopup();
    }
    
    createObjectEditPopup() {
        const popup = document.createElement('div');
        popup.className = 'object-edit-popup modal-overlay';
        popup.id = 'object-edit-popup';
        popup.innerHTML = `
            <div class="object-edit-panel">
                <div class="panel-header">
                    <span class="panel-title" id="object-edit-title">Edit Object</span>
                    <button class="btn btn-icon btn-ghost" id="close-object-edit">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="panel-body">
                    <div class="form-group">
                        <label class="form-label">Name</label>
                        <input type="text" class="form-input" id="object-edit-name" placeholder="Object Name">
                    </div>
                    
                    <div class="form-group">
                        <label class="form-label">Color</label>
                        <div class="color-picker-option">
                            <div class="color-preview" id="object-edit-color-preview" style="background: #787878"></div>
                            <input type="text" class="form-input form-input-sm color-input" id="object-edit-color" value="#787878">
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label class="form-label">Opacity</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="range" class="form-range" id="object-edit-opacity-range" min="0" max="100" value="100" style="flex: 1;">
                            <span id="object-edit-opacity-label" style="font-size: 12px; min-width: 35px;">100%</span>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label class="form-label">Rotation</label>
                        <div class="placement-option-btns" style="justify-content: flex-start;">
                            <button class="placement-opt-btn" id="object-edit-rotate-left" title="Rotate Left">
                                <span class="material-symbols-outlined" style="font-size: 16px;">rotate_left</span>
                            </button>
                            <button class="placement-opt-btn" id="object-edit-rotate-right" title="Rotate Right">
                                <span class="material-symbols-outlined" style="font-size: 16px;">rotate_right</span>
                            </button>
                            <span id="object-edit-rotation-label" style="font-size: 12px; margin-left: 8px;">0°</span>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label class="form-label">Collision</label>
                        <label class="toggle">
                            <input type="checkbox" id="object-edit-collision" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <div class="form-group" id="object-edit-collision-shape-group" style="display: none;">
                        <label class="form-label">Ground Collision Shape</label>
                        <select class="form-select" id="object-edit-collision-shape">
                            <option value="box">Box</option>
                            <option value="circle">Circle</option>
                            <option value="capsule">Capsule</option>
                            <option value="slopeUpRight">Ramp ↗</option>
                            <option value="slopeUpLeft">Ramp ↖</option>
                            <option value="polygon">Custom Convex Polygon</option>
                        </select>
                        <small style="display: block; margin-top: 6px; color: #aaa; line-height: 1.4;">Changes the solid collider. Ramps are one-way surfaces; custom polygons can be one-way or fully solid. Artwork stays the same. Circle radius is half the block’s shorter side. Capsule rounds both ends along the block’s longer axis.</small>
                    </div>

                    <div class="form-group" id="object-edit-collision-polygon-group" style="display: none;">
                        <label class="form-label" for="object-edit-collision-points">Polygon Vertices</label>
                        <textarea class="form-input" id="object-edit-collision-points" rows="4" spellcheck="false" style="font-family: monospace; resize: vertical;"></textarea>
                        <small style="display: block; margin-top: 6px; color: #aaa; line-height: 1.4;">Enter 3–12 convex vertices as normalized [x, y] pairs from 0 to 1, in order around the shape. Choose whether the collider is one-way or solid from every side below.</small>
                        <small id="object-edit-collision-points-status" style="display: block; margin-top: 4px; color: #aaa;"></small>
                    </div>

                    <div class="form-group" id="object-edit-polygon-one-way-group" style="display: none;">
                        <label class="form-label">One-Way Polygon Surface</label>
                        <label class="toggle">
                            <input type="checkbox" id="object-edit-polygon-one-way" checked>
                            <span class="toggle-slider"></span>
                        </label>
                        <small style="display: block; margin-top: 6px; color: #aaa; line-height: 1.4;">On: land and walk on the top from above. Off: the convex polygon is solid from every side.</small>
                    </div>

                    <div class="form-group" id="object-edit-one-way-group" style="display: none;">
                        <label class="form-label">One-Way Platform</label>
                        <label class="toggle">
                            <input type="checkbox" id="object-edit-one-way">
                            <span class="toggle-slider"></span>
                        </label>
                        <small style="display: block; margin-top: 6px; color: #aaa; line-height: 1.4;">Players land on the top while falling, and can pass through from below.</small>
                    </div>
                    
                    <div class="form-group" id="object-edit-flip-group">
                        <label class="form-label">Flip Horizontal</label>
                        <label class="toggle">
                            <input type="checkbox" id="object-edit-flip-horizontal">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <div class="form-group" id="object-edit-sprite-group">
                        <label class="form-label">Sprite Sheet</label>
                        <input type="file" id="object-edit-sprite-file" accept="image/png,image/jpeg,image/webp" class="form-input">
                        <small style="display:block; margin-top:6px; color:#aaa; line-height:1.4;">Use PNG, JPEG, or WebP up to 1 MB. Frames are read left to right, then top to bottom. This changes artwork only; collision stays attached to the object.</small>
                        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:end;">
                            <label style="font-size:11px; color:#aaa;">Frame W<input type="number" id="object-edit-sprite-frame-width" class="form-input form-input-sm" min="1" max="4096" step="1" value="32" style="width:76px; display:block;"></label>
                            <label style="font-size:11px; color:#aaa;">Frame H<input type="number" id="object-edit-sprite-frame-height" class="form-input form-input-sm" min="1" max="4096" step="1" value="32" style="width:76px; display:block;"></label>
                            <label style="font-size:11px; color:#aaa;">Frames<input type="number" id="object-edit-sprite-frame-count" class="form-input form-input-sm" min="1" max="256" step="1" value="1" style="width:76px; display:block;"></label>
                            <label style="font-size:11px; color:#aaa;">FPS<input type="number" id="object-edit-sprite-fps" class="form-input form-input-sm" min="1" max="30" step="1" value="8" style="width:76px; display:block;"></label>
                        </div>
                        <div id="object-edit-sprite-status" style="font-size:11px; color:#aaa; margin-top:6px;">No sprite sheet selected.</div>
                        <div id="object-edit-sprite-clips-group" style="margin-top:10px;">
                            <label class="form-label">Named animation clips</label>
                            <div id="object-edit-sprite-clips" style="display:grid; gap:8px;"></div>
                            <button type="button" class="btn btn-sm btn-secondary" id="object-edit-sprite-clip-add" style="margin-top:8px;">Add animation clip</button>
                            <small style="display:block; margin-top:6px; color:#aaa; line-height:1.4;">Name a frame range once, then play that clip from Mechanics Events. Each clip can loop or hold its last frame.</small>
                        </div>
                        <button type="button" class="btn btn-sm btn-secondary" id="object-edit-sprite-clear" style="margin-top:8px;">Clear Sprite Sheet</button>
                    </div>
                    
                    <div class="form-group" id="object-edit-spinner-group" style="display: none;">
                        <label class="form-label">Size</label>
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                            <span id="object-edit-spinner-size-label" style="font-size: 12px; color: #aaa;">2 × 2 blocks</span>
                        </div>
                        <button class="btn btn-secondary" id="spinner-edit-adjust" style="width: 100%; margin-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 6px;">
                            <span class="material-symbols-outlined" style="font-size: 16px;">open_with</span>
                            Adjust Size
                        </button>
                        <div style="margin-top: 8px;">
                            <label class="form-label">Spin Speed</label>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <input type="range" class="form-range" id="object-edit-spin-speed-range" min="0" max="50" step="1" value="10" style="flex: 1;">
                                <span id="object-edit-spin-speed-label" style="font-size: 12px; min-width: 40px;">1.0/s</span>
                            </div>
                        </div>
                        <div style="margin-top: 8px;">
                            <label class="form-label">Spin Direction</label>
                            <div style="display: flex; gap: 6px;">
                                <button class="placement-opt-btn active" id="object-edit-spin-dir-cw" data-spin-dir="1">Clockwise</button>
                                <button class="placement-opt-btn" id="object-edit-spin-dir-ccw" data-spin-dir="-1">Counter-CW</button>
                            </div>
                        </div>
                        <div style="margin-top: 8px;">
                            <label class="form-label">Damage Amount</label>
                            <input type="number" class="form-input form-input-sm" id="object-edit-spinner-damage" min="0" step="1" value="1" style="width: 72px;">
                        </div>
                    </div>

                    <div class="form-group" id="object-edit-spike-group" style="display: none;">
                        <label class="form-label">Spike Touchbox</label>
                        <select class="form-select" id="object-edit-spike-touchbox">
                            <option value="">Use World Default</option>
                            <option value="full">Full Spike</option>
                            <option value="normal">Normal Spike</option>
                            <option value="tip">Tip Spike</option>
                            <option value="all-spike">All Spike</option>
                            <option value="ground">Ground</option>
                            <option value="flag">Flag</option>
                            <option value="air">Air</option>
                        </select>
                        <div id="object-edit-spike-desc" style="margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 11px; color: #aaa; line-height: 1.4;"></div>
                        
                        <div style="margin-top: 12px;">
                            <label class="form-label" style="display: flex; align-items: center; gap: 8px;">
                                <select class="form-select" id="object-edit-drop-hurt-only" style="width: auto;">
                                    <option value="">Use World Default</option>
                                    <option value="true">Enabled</option>
                                    <option value="false">Disabled</option>
                                </select>
                                Drop Hurt Only
                            </label>
                            <div style="margin-top: 6px; padding: 6px 8px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 11px; color: #aaa; line-height: 1.4;">
                                When enabled, this spike only hurts the player when they move toward the spike's tip.
                            </div>
                        </div>
                        
                        <div id="object-edit-spike-attached" style="margin-top: 8px; padding: 8px; background: rgba(255,193,7,0.15); border-radius: 6px; font-size: 11px; color: #ffc107; line-height: 1.4; display: none;">
                            <span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">info</span>
                            This spike is attached to ground - its flat side will act as ground regardless of the touchbox setting.
                        </div>
                        <div style="margin-top: 12px;">
                            <label class="form-label">Damage Amount</label>
                            <input type="number" class="form-input form-input-sm" id="object-edit-spike-damage" min="0" step="1" value="1" style="width: 72px;">
                        </div>
                    </div>
                    
                    <div class="form-group" id="object-edit-text-group" style="display: none;">
                        <label class="form-label">Font</label>
                        <div class="font-dropdown" id="object-edit-font-dropdown" style="margin-bottom: 12px;">
                            <button type="button" class="font-dropdown-trigger" id="object-edit-font-trigger">
                                <span id="object-edit-font-value">Parkoreen Game</span>
                                <span class="material-symbols-outlined">expand_more</span>
                            </button>
                            <div class="font-dropdown-menu" id="object-edit-font-menu">
                                <!-- Will be populated dynamically -->
                            </div>
                        </div>
                        
                        <label class="form-label">Text Content</label>
                        <textarea class="form-input" id="object-edit-content" rows="3" style="resize: vertical;"></textarea>
                        
                        <div id="object-edit-font-preview" style="margin-top: 8px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; min-height: 40px; display: flex; align-items: center; justify-content: center;">
                            <span id="object-edit-font-preview-text" style="font-size: 18px;">Preview Text</span>
                        </div>
                    </div>
                    
                    <div class="form-group" id="object-edit-teleportal-group" style="display: none;">
                        <div class="teleportal-section">
                            <label class="form-label">
                                <span class="material-symbols-outlined" style="font-size: 16px; vertical-align: middle;">output</span>
                                Send To
                            </label>
                            <div id="teleportal-send-list" class="teleportal-connection-list"></div>
                            <button class="btn btn-sm btn-secondary" id="teleportal-add-send" style="margin-top: 8px;">
                                <span class="material-symbols-outlined" style="font-size: 16px;">add</span>
                                Add
                            </button>
                        </div>
                        
                        <div class="teleportal-section" style="margin-top: 16px;">
                            <label class="form-label">
                                <span class="material-symbols-outlined" style="font-size: 16px; vertical-align: middle;">input</span>
                                Receive From
                            </label>
                            <div id="teleportal-receive-list" class="teleportal-connection-list"></div>
                            <button class="btn btn-sm btn-secondary" id="teleportal-add-receive" style="margin-top: 8px;">
                                <span class="material-symbols-outlined" style="font-size: 16px;">add</span>
                                Add
                            </button>
                        </div>
                        
                        <div id="teleportal-connection-info" style="margin-top: 12px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 11px; color: #aaa; line-height: 1.4;">
                            <strong>Connection Guide:</strong><br>
                            • <span style="color: #4ade80;">Green</span> = Valid two-way connection (player will teleport)<br>
                            • <span style="color: #f87171;">Red</span> = One-way only (no teleport)
                        </div>

                        <hr style="border-color: var(--surface-light); margin: 12px 0;">
                        <label class="form-label">Particle Opacity</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="range" class="form-range" id="object-edit-teleportal-particle-opacity" min="0" max="100" step="1" value="100" style="flex: 1;">
                            <span id="object-edit-teleportal-particle-opacity-label" style="font-size: 13px; min-width: 36px; text-align: right; color: #fff;">100%</span>
                        </div>
                    </div>
                    
                    <div class="form-group" id="object-edit-bouncer-group" style="display: none;">
                        <hr style="border-color: var(--surface-light); margin: 8px 0;">
                        <label class="form-label" style="font-weight: 600;">Bounce Strength</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="range" class="form-range" id="object-edit-bouncer-strength" min="5" max="50" step="1" value="20" style="flex: 1;">
                            <span id="object-edit-bouncer-strength-label" style="font-size: 13px; min-width: 32px; text-align: right; color: #fff;">20</span>
                        </div>
                        <div style="margin-top: 6px; padding: 6px 8px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 11px; color: #aaa; line-height: 1.4;">
                            Higher values launch the player higher. Normal jump is ~13.
                        </div>
                    </div>

                    <div class="form-group" id="object-edit-endpoint-group" style="display: none;">
                        <hr style="border-color: var(--surface-light); margin: 8px 0;">
                        <label class="form-label">Require Coins</label>
                        <label class="toggle">
                            <input type="checkbox" id="object-edit-endpoint-require-coins">
                            <span class="toggle-slider"></span>
                        </label>
                        <div id="object-edit-endpoint-amount-wrap" style="margin-top: 10px; display: none;">
                            <label class="form-label">Amount</label>
                            <input type="number" class="form-input form-input-sm" id="object-edit-endpoint-amount" min="0" step="1" value="0" style="width: 96px;">
                            <div style="margin-top: 6px; font-size: 11px; color: #aaa; line-height: 1.4;">
                                Default is the total number of coins in the map.
                            </div>
                        </div>
                    </div>

                    <div class="form-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--surface-light);">
                        <button class="btn btn-danger" id="object-edit-delete" style="width: 100%;">
                            <span class="material-symbols-outlined">delete</span>
                            Delete Object
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(popup);
        this.ui.objectEditPopup = popup;
        
        // Track the currently editing object
        this.editingObject = null;
        
        // Setup event listeners for object edit popup
        this.setupObjectEditListeners();
    }
    
    setupObjectEditListeners() {
        const popup = this.ui.objectEditPopup;
        
        // Close button
        document.getElementById('close-object-edit').addEventListener('click', () => {
            this.closeObjectEditPopup();
        });
        
        // Click outside to close
        popup.addEventListener('click', (e) => {
            if (e.target === popup) {
                this.closeObjectEditPopup();
            }
        });
        
        // Name change
        document.getElementById('object-edit-name').addEventListener('change', (e) => {
            if (this.editingObject) {
                this.editingObject.name = e.target.value || this.editingObject.getDefaultName();
                this.updateLayersList();
                this.triggerMapChange();
            }
        });
        
        // Color preview click
        document.getElementById('object-edit-color-preview').addEventListener('click', () => {
            this.showColorPicker('object-edit');
        });
        
        // Color input change
        document.getElementById('object-edit-color').addEventListener('change', (e) => {
            if (this.editingObject) {
                let color = this.autoCorrectHex(e.target.value);
                const fullColor = '#' + color;
                e.target.value = fullColor;
                this.editingObject.color = fullColor;
                document.getElementById('object-edit-color-preview').style.background = fullColor;
                this.triggerMapChange();
            }
        });
        
        // Opacity range
        document.getElementById('object-edit-opacity-range').addEventListener('input', (e) => {
            if (this.editingObject) {
                const value = parseInt(e.target.value);
                this.editingObject.opacity = value / 100;
                document.getElementById('object-edit-opacity-label').textContent = value + '%';
                this.updateLayersList();
                this.triggerMapChange();
            }
        });
        
        // Rotation buttons
        document.getElementById('object-edit-rotate-left').addEventListener('click', () => {
            if (this.editingObject) {
                this.editingObject.rotation = (this.editingObject.rotation - 90 + 360) % 360;
                document.getElementById('object-edit-rotation-label').textContent = this.editingObject.rotation + '°';
                this.updateSpikeAttachedWarning();
                this.triggerMapChange();
            }
        });
        
        document.getElementById('object-edit-rotate-right').addEventListener('click', () => {
            if (this.editingObject) {
                this.editingObject.rotation = (this.editingObject.rotation + 90) % 360;
                document.getElementById('object-edit-rotation-label').textContent = this.editingObject.rotation + '°';
                this.updateSpikeAttachedWarning();
                this.triggerMapChange();
            }
        });
        
        // Collision toggle
        document.getElementById('object-edit-collision').addEventListener('change', (e) => {
            if (this.editingObject) {
                this.editingObject.collision = e.target.checked;
                this.triggerMapChange();
            }
        });

        document.getElementById('object-edit-collision-shape').addEventListener('change', (e) => {
            if (!this.editingObject) return;
            const previousShape = this.editingObject.collisionShape;
            this.editingObject.collisionShape = ['circle', 'capsule', 'slopeUpRight', 'slopeUpLeft', 'polygon'].includes(e.target.value) ? e.target.value : 'box';
            if (this.editingObject.collisionShape !== 'box') this.editingObject.oneWayPlatform = false;
            const polygonGroup = document.getElementById('object-edit-collision-polygon-group');
            polygonGroup.style.display = this.editingObject.collisionShape === 'polygon' ? 'block' : 'none';
            if (this.editingObject.collisionShape === 'polygon') {
                this.editingObject.collisionPoints = WorldObject.normalizeCollisionPolygon(this.editingObject.collisionPoints) ||
                    WorldObject.DEFAULT_COLLISION_POLYGON.map(point => point.slice());
                if (previousShape !== 'polygon') this.editingObject.polygonOneWay = true;
                document.getElementById('object-edit-collision-points').value = JSON.stringify(this.editingObject.collisionPoints, null, 2);
                document.getElementById('object-edit-collision-points-status').textContent = `${this.editingObject.collisionPoints.length} valid convex vertices`;
            }
            const polygonOneWayGroup = document.getElementById('object-edit-polygon-one-way-group');
            polygonOneWayGroup.style.display = this.editingObject.collisionShape === 'polygon' ? 'block' : 'none';
            document.getElementById('object-edit-polygon-one-way').checked = this.editingObject.polygonOneWay !== false;
            const oneWayGroup = document.getElementById('object-edit-one-way-group');
            const supportsOneWayPlatform = this.editingObject.type === 'block' &&
                this.editingObject.appearanceType === 'ground' && this.editingObject.actingType === 'ground' &&
                this.editingObject.collisionShape === 'box';
            oneWayGroup.style.display = supportsOneWayPlatform ? 'block' : 'none';
            document.getElementById('object-edit-one-way').checked = this.editingObject.oneWayPlatform === true;
            this.triggerMapChange();
        });

        document.getElementById('object-edit-collision-points').addEventListener('change', (e) => {
            if (!this.editingObject || this.editingObject.collisionShape !== 'polygon') return;
            let parsed;
            try {
                parsed = JSON.parse(e.target.value);
            } catch (error) {
                document.getElementById('object-edit-collision-points-status').textContent = 'Invalid JSON; the previous collider is kept.';
                return;
            }
            const normalized = WorldObject.normalizeCollisionPolygon(parsed);
            const status = document.getElementById('object-edit-collision-points-status');
            if (!normalized) {
                status.textContent = 'Use 3–12 ordered convex [x, y] pairs, each between 0 and 1; the previous collider is kept.';
                return;
            }
            this.editingObject.collisionPoints = normalized;
            e.target.value = JSON.stringify(normalized, null, 2);
            status.textContent = `${normalized.length} valid convex vertices`;
            this.triggerMapChange();
        });

        document.getElementById('object-edit-polygon-one-way').addEventListener('change', (e) => {
            if (!this.editingObject || this.editingObject.collisionShape !== 'polygon') return;
            this.editingObject.polygonOneWay = e.target.checked;
            this.triggerMapChange();
        });

        document.getElementById('object-edit-one-way').addEventListener('change', (e) => {
            if (this.editingObject) {
                this.editingObject.oneWayPlatform = e.target.checked;
                this.triggerMapChange();
            }
        });
        
        // Flip horizontal toggle
        document.getElementById('object-edit-flip-horizontal').addEventListener('change', (e) => {
            if (this.editingObject) {
                this.editingObject.flipHorizontal = e.target.checked;
                this.triggerMapChange();
            }
        });

        const spriteFileInput = document.getElementById('object-edit-sprite-file');
        spriteFileInput.addEventListener('change', (e) => this.loadObjectSpriteSheet(e.target.files?.[0]));
        document.getElementById('object-edit-sprite-clip-add').addEventListener('click', () => this.addObjectSpriteAnimationClip());
        const spriteClips = document.getElementById('object-edit-sprite-clips');
        spriteClips.addEventListener('change', () => this.saveObjectSpriteAnimationClips());
        spriteClips.addEventListener('click', (event) => {
            const removeButton = event.target.closest('.object-sprite-clip-remove');
            if (!removeButton) return;
            const index = Number(removeButton.closest('.object-sprite-clip')?.dataset.clipIndex);
            if (Number.isInteger(index)) this.saveObjectSpriteAnimationClips(this.editingObject, index);
        });
        for (const id of ['object-edit-sprite-frame-width', 'object-edit-sprite-frame-height',
            'object-edit-sprite-frame-count', 'object-edit-sprite-fps']) {
            document.getElementById(id).addEventListener('change', () => this.applyObjectSpriteSheetSettings());
        }
        document.getElementById('object-edit-sprite-clear').addEventListener('click', () => {
            if (!this.editingObject) return;
            this.setObjectSpriteSheet(null);
            spriteFileInput.value = '';
            this.updateObjectSpriteSheetStatus();
            this.renderObjectSpriteAnimationClips();
            this.triggerMapChange();
        });
        
        // Update singular/plural labels on input
        // Spinner spin speed
        document.getElementById('object-edit-spin-speed-range').addEventListener('input', (e) => {
            if (this.editingObject && (this.editingObject.type === 'spinner' || this.editingObject.appearanceType === 'spinner')) {
                const speed = parseInt(e.target.value) / 10;
                this.editingObject.spinSpeed = speed;
                document.getElementById('object-edit-spin-speed-label').textContent = speed.toFixed(1) + '/s';
                this.triggerMapChange();
            }
        });
        
        // Spinner spin direction
        document.querySelectorAll('[data-spin-dir]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.editingObject && (this.editingObject.type === 'spinner' || this.editingObject.appearanceType === 'spinner')) {
                    document.querySelectorAll('[data-spin-dir]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.editingObject.spinDirection = parseInt(btn.dataset.spinDir);
                    this.triggerMapChange();
                }
            });
        });

        // Spinner damage amount
        document.getElementById('object-edit-spinner-damage').addEventListener('change', (e) => {
            if (this.editingObject && (this.editingObject.type === 'spinner' || this.editingObject.appearanceType === 'spinner')) {
                this.editingObject.damageAmount = Math.max(0, parseInt(e.target.value) || 1);
                e.target.value = this.editingObject.damageAmount;
                this.triggerMapChange();
            }
        });

        // Spike damage amount
        document.getElementById('object-edit-spike-damage').addEventListener('change', (e) => {
            if (this.editingObject && (this.editingObject.appearanceType === 'spike' || this.editingObject.actingType === 'spike')) {
                this.editingObject.damageAmount = Math.max(0, parseInt(e.target.value) || 1);
                e.target.value = this.editingObject.damageAmount;
                this.triggerMapChange();
            }
        });

        // Spike touchbox
        document.getElementById('object-edit-spike-touchbox').addEventListener('change', (e) => {
            if (this.editingObject && this.editingObject.appearanceType === 'spike') {
                this.editingObject.spikeTouchbox = e.target.value || null;
                this.updateSpikeTouchboxEditDescription(e.target.value);
                this.triggerMapChange();
            }
        });
        
        // Object edit drop hurt only
        document.getElementById('object-edit-drop-hurt-only').addEventListener('change', (e) => {
            if (this.editingObject && (this.editingObject.appearanceType === 'spike' || this.editingObject.actingType === 'spike')) {
                const value = e.target.value;
                if (value === '') {
                    this.editingObject.dropHurtOnly = undefined;
                } else {
                    this.editingObject.dropHurtOnly = value === 'true';
                }
                this.triggerMapChange();
            }
        });
        
        // Text content
        document.getElementById('object-edit-content').addEventListener('input', (e) => {
            if (this.editingObject && this.editingObject.type === 'text') {
                this.editingObject.content = e.target.value;
                this.updateObjectEditFontPreview();
                this.triggerMapChange();
            }
        });
        
        // Object edit font dropdown
        document.getElementById('object-edit-font-trigger').addEventListener('click', (e) => {
            e.stopPropagation();
            const dropdown = document.getElementById('object-edit-font-dropdown');
            const trigger = document.getElementById('object-edit-font-trigger');
            const menu = document.getElementById('object-edit-font-menu');
            
            dropdown.classList.toggle('active');
            
            if (dropdown.classList.contains('active')) {
                // Position the menu to stay on screen
                const rect = trigger.getBoundingClientRect();
                const menuHeight = 300; // max-height
                const menuWidth = 200;
                
                // Calculate position
                let top = rect.bottom + 4;
                let left = rect.left;
                
                // Check if menu would go off bottom of screen
                if (top + menuHeight > window.innerHeight) {
                    // Open upwards instead
                    top = rect.top - menuHeight - 4;
                }
                
                // Check if menu would go off right of screen
                if (left + menuWidth > window.innerWidth) {
                    left = window.innerWidth - menuWidth - 10;
                }
                
                // Ensure it's not off the left
                if (left < 10) left = 10;
                
                // Ensure it's not off the top
                if (top < 10) top = 10;
                
                menu.style.top = top + 'px';
                menu.style.left = left + 'px';
                
                // Populate dropdown with current font
                const currentFont = this.editingObject?.font || 'Parkoreen Game';
                this.populateObjectEditFontDropdown(currentFont);
            }
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const dropdown = document.getElementById('object-edit-font-dropdown');
            if (dropdown && !dropdown.contains(e.target)) {
                dropdown.classList.remove('active');
            }
        });
        
        // Delete button
        document.getElementById('object-edit-delete').addEventListener('click', () => {
            if (this.editingObject) {
                this.world.removeObject(this.editingObject.id);
                this.closeObjectEditPopup();
                this.updateLayersList();
                this.triggerMapChange();
            }
        });
        
        // Teleportal: Add Send button
        document.getElementById('teleportal-add-send').addEventListener('click', () => {
            if (this.editingObject && this.editingObject.type === 'teleportal') {
                this.editingObject.sendTo.push({ name: '', enabled: true });
                this.updateTeleportalConnectionLists();
                this.triggerMapChange();
            }
        });
        
        // Teleportal: Add Receive button
        document.getElementById('teleportal-add-receive').addEventListener('click', () => {
            if (this.editingObject && this.editingObject.type === 'teleportal') {
                this.editingObject.receiveFrom.push({ name: '', enabled: true });
                this.updateTeleportalConnectionLists();
                this.triggerMapChange();
            }
        });

        // Teleportal particle opacity slider
        document.getElementById('object-edit-teleportal-particle-opacity').addEventListener('input', (e) => {
            if (this.editingObject && this.editingObject.type === 'teleportal') {
                const val = parseInt(e.target.value);
                this.editingObject.particleOpacity = val;
                document.getElementById('object-edit-teleportal-particle-opacity-label').textContent = val + '%';
                this.triggerMapChange();
            }
        });

        // Bouncer strength slider
        document.getElementById('object-edit-bouncer-strength').addEventListener('input', (e) => {
            if (this.editingObject && this.editingObject.actingType === 'bouncer') {
                const val = parseInt(e.target.value) || 20;
                this.editingObject.bouncerStrength = val;
                document.getElementById('object-edit-bouncer-strength-label').textContent = val;
                this.triggerMapChange();
            }
        });

        // Endpoint require coins toggle
        document.getElementById('object-edit-endpoint-require-coins').addEventListener('change', (e) => {
            if (this.editingObject && this.editingObject.actingType === 'endpoint') {
                const enabled = !!e.target.checked;
                this.editingObject.endpointRequireCoins = enabled;
                const amountWrap = document.getElementById('object-edit-endpoint-amount-wrap');
                if (amountWrap) amountWrap.style.display = enabled ? 'block' : 'none';

                if (enabled && !Number.isFinite(this.editingObject.endpointRequiredCoins)) {
                    const totalCoins = this.world.objects.filter(o => o.appearanceType === 'coin').length;
                    this.editingObject.endpointRequiredCoins = totalCoins;
                    document.getElementById('object-edit-endpoint-amount').value = totalCoins;
                }
                this.triggerMapChange();
            }
        });

        // Endpoint required coin amount
        document.getElementById('object-edit-endpoint-amount').addEventListener('change', (e) => {
            if (this.editingObject && this.editingObject.actingType === 'endpoint') {
                const raw = parseInt(e.target.value, 10);
                const amount = Number.isFinite(raw) ? Math.max(0, raw) : 0;
                this.editingObject.endpointRequiredCoins = amount;
                e.target.value = amount;
                this.triggerMapChange();
            }
        });
    }
    
    closeObjectEditPopup() {
        this.editingObject = null;
        this.ui.objectEditPopup.classList.remove('active');
        this.closeColorPicker();
    }

    setObjectSpriteSheet(spriteSheet) {
        if (!this.editingObject) return;
        this.editingObject._spriteSheetSettingsRequest = (this.editingObject._spriteSheetSettingsRequest || 0) + 1;
        this.editingObject._spriteSheetEditorValidationTarget = null;
        this.editingObject._spriteSheetValidationError = '';
        this.editingObject.spriteSheet = spriteSheet;
        this.editingObject._spriteSheetImage = null;
        this.editingObject._spriteSheetImageData = null;
        this.world.invalidateTileCache();
    }

    updateObjectSpriteSheetStatus(message = null) {
        const status = document.getElementById('object-edit-sprite-status');
        if (!status) return;
        const target = this.editingObject;
        const sprite = target?.spriteSheet;
        status.textContent = message || (sprite && target?._spriteSheetValidationError) || (sprite
            ? `${sprite.frameCount} frame${sprite.frameCount === 1 ? '' : 's'} · ${sprite.frameWidth} × ${sprite.frameHeight} px · ${sprite.fps} FPS · ${sprite.animations?.length || 0} named clips`
            : 'No sprite sheet selected.');
    }

    renderObjectSpriteAnimationClips(target = this.editingObject) {
        const container = document.getElementById('object-edit-sprite-clips');
        if (!container) return;
        const clips = target?.spriteSheet?.animations || [];
        container.innerHTML = clips.map((clip, index) => `
            <div class="object-sprite-clip" data-clip-index="${index}" style="display:grid; grid-template-columns:minmax(92px,1fr) 64px 64px 64px 92px 32px; gap:5px; align-items:end;">
                <label style="font-size:10px; color:#aaa;">Name<input class="form-input form-input-sm" data-clip-field="name" maxlength="32" value="${escapeHtml(clip.name)}"></label>
                <label style="font-size:10px; color:#aaa;">First<input type="number" class="form-input form-input-sm" data-clip-field="startFrame" min="0" max="${Math.max(0, (target?.spriteSheet?.frameCount || 1) - 1)}" step="1" value="${clip.startFrame}"></label>
                <label style="font-size:10px; color:#aaa;">Frames<input type="number" class="form-input form-input-sm" data-clip-field="frameCount" min="1" max="${target?.spriteSheet?.frameCount || 1}" step="1" value="${clip.frameCount}"></label>
                <label style="font-size:10px; color:#aaa;">FPS<input type="number" class="form-input form-input-sm" data-clip-field="fps" min="1" max="30" step="1" value="${clip.fps}"></label>
                <label style="font-size:10px; color:#aaa;">Playback<select class="form-input form-input-sm" data-clip-field="loop"><option value="false" ${clip.loop ? '' : 'selected'}>Once</option><option value="true" ${clip.loop ? 'selected' : ''}>Loop</option></select></label>
                <button type="button" class="btn btn-sm btn-danger object-sprite-clip-remove" aria-label="Remove ${escapeHtml(clip.name)} clip" title="Remove clip">×</button>
            </div>`).join('');
        const addButton = document.getElementById('object-edit-sprite-clip-add');
        if (addButton) addButton.disabled = !target?.spriteSheet || clips.length >= 32;
        const clipsGroup = document.getElementById('object-edit-sprite-clips-group');
        if (clipsGroup) clipsGroup.style.display = target?.spriteSheet ? 'block' : 'none';
    }

    saveObjectSpriteAnimationClips(target = this.editingObject, removeIndex = null) {
        const container = document.getElementById('object-edit-sprite-clips');
        const sprite = target?.spriteSheet;
        if (!container || !sprite) return false;
        const clips = Array.from(container.querySelectorAll('.object-sprite-clip')).map(row => {
            const read = key => row.querySelector(`[data-clip-field="${key}"]`);
            const name = read('name');
            const startFrame = read('startFrame');
            const frameCount = read('frameCount');
            const fps = read('fps');
            const loop = read('loop');
            return {
                name: name?.value || '',
                startFrame: startFrame?.value.trim() === '' ? '' : Number(startFrame?.value),
                frameCount: frameCount?.value.trim() === '' ? '' : Number(frameCount?.value),
                fps: fps?.value.trim() === '' ? '' : Number(fps?.value),
                loop: loop?.value === 'true'
            };
        });
        if (removeIndex !== null) clips.splice(removeIndex, 1);
        const normalized = WorldObject.normalizeSpriteAnimations(clips, sprite.frameCount);
        if (!normalized) {
            this.updateObjectSpriteSheetStatus('Use unique names, whole frame ranges within the sheet, and speeds from 1 to 30 FPS.');
            return false;
        }
        this.setObjectSpriteSheet({ ...sprite, animations: normalized });
        this.renderObjectSpriteAnimationClips(target);
        this.updateObjectSpriteSheetStatus();
        this.triggerMapChange();
        return true;
    }

    addObjectSpriteAnimationClip() {
        const target = this.editingObject;
        const sprite = target?.spriteSheet;
        if (!sprite || (sprite.animations || []).length >= 32) return;
        const clips = (sprite.animations || []).slice();
        let suffix = clips.length + 1;
        let name = `Clip ${suffix}`;
        const names = new Set(clips.map(clip => clip.name.toLowerCase()));
        while (names.has(name.toLowerCase())) name = `Clip ${++suffix}`;
        clips.push({ name, startFrame: 0, frameCount: 1, fps: 8, loop: false });
        this.setObjectSpriteSheet({ ...sprite, animations: clips });
        this.renderObjectSpriteAnimationClips(target);
        this.updateObjectSpriteSheetStatus();
        this.triggerMapChange();
        document.querySelector('#object-edit-sprite-clips .object-sprite-clip:last-child [data-clip-field="name"]')?.focus();
    }

    validateObjectSpriteSheetForEditor(target) {
        const sprite = target?.spriteSheet;
        if (!sprite || target._spriteSheetEditorValidationTarget === sprite) return;
        target._spriteSheetEditorValidationTarget = sprite;
        const image = new Image();
        image.onerror = () => {
            if (this.editingObject !== target || target.spriteSheet !== sprite) return;
            target._spriteSheetValidationError = 'The sprite-sheet image could not be decoded.';
            this.updateObjectSpriteSheetStatus();
        };
        image.onload = () => {
            if (this.editingObject !== target || target.spriteSheet !== sprite) return;
            const columns = Math.floor(image.naturalWidth / sprite.frameWidth);
            const rows = Math.floor(image.naturalHeight / sprite.frameHeight);
            const availableFrames = columns * rows;
            target._spriteSheetValidationError = image.naturalWidth > 4096 || image.naturalHeight > 4096 ||
                image.naturalWidth * image.naturalHeight > 16000000
                ? 'Image dimensions must be at most 4096 × 4096 and 16 megapixels.'
                : columns < 1 || rows < 1
                ? 'The configured frame size does not fit this image.'
                : sprite.frameCount > availableFrames
                    ? `This image contains ${availableFrames} whole frames; the sheet declares ${sprite.frameCount}.`
                    : '';
            this.updateObjectSpriteSheetStatus();
        };
        image.src = sprite.data;
    }

    loadObjectSpriteSheet(file) {
        const target = this.editingObject;
        if (!target || !file) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
            this.updateObjectSpriteSheetStatus('Choose a PNG, JPEG, or WebP image up to 1 MB.');
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => this.updateObjectSpriteSheetStatus('The image could not be read.');
        reader.onload = () => {
            if (this.editingObject !== target || typeof reader.result !== 'string') return;
            const image = new Image();
            image.onerror = () => this.updateObjectSpriteSheetStatus('The selected file is not a valid image.');
            image.onload = () => {
                if (this.editingObject !== target) return;
                if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 16000000) {
                    this.updateObjectSpriteSheetStatus('Image dimensions must be at most 4096 × 4096 and 16 megapixels.');
                    return;
                }
                const currentSpriteBytes = this.world.getSpriteSheetDataLength() - (target.spriteSheet?.data?.length || 0);
                if (currentSpriteBytes + reader.result.length > 8 * 1024 * 1024) {
                    this.updateObjectSpriteSheetStatus('Sprite sheets across this map and its Object Stamps are limited to 8 MiB total.');
                    return;
                }
                document.getElementById('object-edit-sprite-frame-width').value = image.naturalWidth;
                document.getElementById('object-edit-sprite-frame-height').value = image.naturalHeight;
                document.getElementById('object-edit-sprite-frame-count').value = 1;
                document.getElementById('object-edit-sprite-fps').value = 8;
                this.setObjectSpriteSheet({
                    data: reader.result,
                    frameWidth: image.naturalWidth,
                    frameHeight: image.naturalHeight,
                    frameCount: 1,
                    fps: 8,
                    animations: []
                });
                this.updateObjectSpriteSheetStatus(`${image.naturalWidth} × ${image.naturalHeight} px · set frame size and count for animation`);
                this.triggerMapChange();
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    applyObjectSpriteSheetSettings() {
        const target = this.editingObject;
        const sprite = target?.spriteSheet;
        if (!sprite) return;
        const frameWidth = Number(document.getElementById('object-edit-sprite-frame-width').value);
        const frameHeight = Number(document.getElementById('object-edit-sprite-frame-height').value);
        const frameCount = Number(document.getElementById('object-edit-sprite-frame-count').value);
        const fps = Number(document.getElementById('object-edit-sprite-fps').value);
        if (!Number.isInteger(frameWidth) || frameWidth < 1 || frameWidth > 4096 ||
            !Number.isInteger(frameHeight) || frameHeight < 1 || frameHeight > 4096 ||
            !Number.isInteger(frameCount) || frameCount < 1 || frameCount > 256 ||
            !Number.isFinite(fps) || fps < 1 || fps > 30) {
            this.updateObjectSpriteSheetStatus('Frames must be 1–256, dimensions 1–4096 px, and speed 1–30 FPS.');
            return;
        }
        const requestId = (target._spriteSheetSettingsRequest || 0) + 1;
        target._spriteSheetSettingsRequest = requestId;
        const applyIfValid = image => {
            if (this.editingObject !== target || target._spriteSheetSettingsRequest !== requestId ||
                target.spriteSheet?.data !== sprite.data) return;
            const columns = Math.floor(image.naturalWidth / frameWidth);
            const rows = Math.floor(image.naturalHeight / frameHeight);
            const availableFrames = columns * rows;
            if (columns < 1 || rows < 1 || frameCount > availableFrames) {
                this.updateObjectSpriteSheetStatus(`This image contains ${Math.max(0, availableFrames)} whole frames at the selected frame size.`);
                return;
            }
            const animations = WorldObject.normalizeSpriteAnimations(sprite.animations, frameCount);
            if (!animations) {
                this.updateObjectSpriteSheetStatus('The new frame count would invalidate a named clip. Adjust or remove that clip first.');
                return;
            }
            this.setObjectSpriteSheet({ ...sprite, frameWidth, frameHeight, frameCount, fps, animations });
            this.updateObjectSpriteSheetStatus();
            this.triggerMapChange();
        };
        const cachedImage = target._spriteSheetImage;
        if (cachedImage?.complete && cachedImage.naturalWidth > 0 && target._spriteSheetImageData === sprite.data) {
            applyIfValid(cachedImage);
            return;
        }
        const image = new Image();
        image.onload = () => applyIfValid(image);
        image.onerror = () => {
            if (this.editingObject === target && target._spriteSheetSettingsRequest === requestId) {
                this.updateObjectSpriteSheetStatus('The sprite-sheet image could not be decoded.');
            }
        };
        image.src = sprite.data;
    }
    
    updateSpikeTouchboxEditDescription(mode) {
        const descEl = document.getElementById('object-edit-spike-desc');
        if (!descEl) return;
        
        const descriptions = {
            '': 'Uses the world\'s default spike touchbox setting.',
            'full': 'The entire spike is dangerous. Any contact damages the player.',
            'normal': 'The flat base acts as ground. Other parts damage the player.',
            'tip': 'Only the peak is dangerous. Base is ground, middle has no collision.',
            'all-spike': 'No safe zone. The spike tip, danger zone, and flat base all damage the player.',
            'ground': 'Acts completely as solid ground. No damage.',
            'flag': 'Only the flat base acts as ground. Rest has no collision.',
            'air': 'No collision at all. Players pass through.'
        };
        
        descEl.textContent = descriptions[mode] || descriptions[''];
    }
    
    updateSpikeAttachedWarning() {
        const warningEl = document.getElementById('object-edit-spike-attached');
        if (!warningEl || !this.editingObject) return;
        
        if (this.editingObject.appearanceType === 'spike' || this.editingObject.actingType === 'spike') {
            const isAttached = this.world.isSpikeAttachedToGround(this.editingObject);
            warningEl.style.display = isAttached ? 'block' : 'none';
        } else {
            warningEl.style.display = 'none';
        }
    }
    
    // ========================================
    // TELEPORTAL CONNECTION MANAGEMENT
    // ========================================
    getOtherTeleportals() {
        // Get all teleportals except the currently editing one
        return this.world.objects.filter(obj => 
            obj.type === 'teleportal' && 
            obj.teleportalName && 
            obj !== this.editingObject
        );
    }
    
    isTeleportalConnectionValid(fromPortal, toPortalName, direction) {
        // Check if the connection forms a valid two-way link
        const toPortal = this.world.objects.find(obj => 
            obj.type === 'teleportal' && obj.teleportalName === toPortalName
        );
        
        if (!toPortal) return false;
        
        if (direction === 'send') {
            // fromPortal sends to toPortal - check if toPortal receives from fromPortal (and is enabled)
            const conn = toPortal.receiveFrom.find(c => (c?.name || c) === fromPortal.teleportalName);
            return conn && conn?.enabled !== false;
        } else {
            // fromPortal receives from toPortal - check if toPortal sends to fromPortal (and is enabled)
            const conn = toPortal.sendTo.find(c => (c?.name || c) === fromPortal.teleportalName);
            return conn && conn?.enabled !== false;
        }
    }
    
    updateTeleportalConnectionLists() {
        if (!this.editingObject || this.editingObject.type !== 'teleportal') return;
        
        const sendList = document.getElementById('teleportal-send-list');
        const receiveList = document.getElementById('teleportal-receive-list');
        const otherPortals = this.getOtherTeleportals();
        
        // Build Send list
        if (this.editingObject.sendTo.length === 0) {
            sendList.innerHTML = '<div class="teleportal-connection-empty">No outgoing connections</div>';
        } else {
            sendList.innerHTML = this.editingObject.sendTo.map((conn, index) => {
                const targetName = conn?.name || conn;
                const isEnabled = conn?.enabled !== false;
                const isConnected = this.isTeleportalConnectionValid(this.editingObject, targetName, 'send');
                const optionsHtml = otherPortals.map(p => 
                    `<option value="${p.teleportalName}" ${p.teleportalName === targetName ? 'selected' : ''}>${p.teleportalName}</option>`
                ).join('');
                
                return `
                    <div class="teleportal-connection-item ${isConnected && isEnabled ? 'connected' : ''} ${!isEnabled ? 'disabled' : ''}" data-index="${index}" data-type="send">
                        <button class="toggle-connection ${isEnabled ? 'enabled' : ''}" title="${isEnabled ? 'Disable' : 'Enable'}">
                            <span class="material-symbols-outlined" style="font-size: 14px;">${isEnabled ? 'toggle_on' : 'toggle_off'}</span>
                        </button>
                        <select ${!isEnabled ? 'disabled' : ''}>
                            <option value="">Select portal...</option>
                            ${optionsHtml}
                        </select>
                        <button class="remove-connection" title="Remove">
                            <span class="material-symbols-outlined" style="font-size: 16px;">close</span>
                        </button>
                    </div>
                `;
            }).join('');
        }
        
        // Build Receive list
        if (this.editingObject.receiveFrom.length === 0) {
            receiveList.innerHTML = '<div class="teleportal-connection-empty">No incoming connections</div>';
        } else {
            receiveList.innerHTML = this.editingObject.receiveFrom.map((conn, index) => {
                const sourceName = conn?.name || conn;
                const isEnabled = conn?.enabled !== false;
                const isConnected = this.isTeleportalConnectionValid(this.editingObject, sourceName, 'receive');
                const optionsHtml = otherPortals.map(p => 
                    `<option value="${p.teleportalName}" ${p.teleportalName === sourceName ? 'selected' : ''}>${p.teleportalName}</option>`
                ).join('');
                
                return `
                    <div class="teleportal-connection-item ${isConnected && isEnabled ? 'connected' : ''} ${!isEnabled ? 'disabled' : ''}" data-index="${index}" data-type="receive">
                        <button class="toggle-connection ${isEnabled ? 'enabled' : ''}" title="${isEnabled ? 'Disable' : 'Enable'}">
                            <span class="material-symbols-outlined" style="font-size: 14px;">${isEnabled ? 'toggle_on' : 'toggle_off'}</span>
                        </button>
                        <select ${!isEnabled ? 'disabled' : ''}>
                            <option value="">Select portal...</option>
                            ${optionsHtml}
                        </select>
                        <button class="remove-connection" title="Remove">
                            <span class="material-symbols-outlined" style="font-size: 16px;">close</span>
                        </button>
                    </div>
                `;
            }).join('');
        }
        
        // Attach event listeners
        this.attachTeleportalListeners();
    }
    
    attachTeleportalListeners() {
        // Select change listeners
        document.querySelectorAll('#teleportal-send-list .teleportal-connection-item select').forEach(select => {
            select.addEventListener('change', (e) => {
                const item = e.target.closest('.teleportal-connection-item');
                const index = parseInt(item.dataset.index);
                const conn = this.editingObject.sendTo[index];
                if (typeof conn === 'object') {
                    conn.name = e.target.value;
                } else {
                    this.editingObject.sendTo[index] = { name: e.target.value, enabled: true };
                }
                this.updateTeleportalConnectionLists();
                this.triggerMapChange();
            });
        });
        
        document.querySelectorAll('#teleportal-receive-list .teleportal-connection-item select').forEach(select => {
            select.addEventListener('change', (e) => {
                const item = e.target.closest('.teleportal-connection-item');
                const index = parseInt(item.dataset.index);
                const conn = this.editingObject.receiveFrom[index];
                if (typeof conn === 'object') {
                    conn.name = e.target.value;
                } else {
                    this.editingObject.receiveFrom[index] = { name: e.target.value, enabled: true };
                }
                this.updateTeleportalConnectionLists();
                this.triggerMapChange();
            });
        });
        
        // Toggle button listeners
        document.querySelectorAll('#teleportal-send-list .toggle-connection').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const item = e.target.closest('.teleportal-connection-item');
                const index = parseInt(item.dataset.index);
                const conn = this.editingObject.sendTo[index];
                if (typeof conn === 'object') {
                    conn.enabled = !conn.enabled;
                } else {
                    this.editingObject.sendTo[index] = { name: conn, enabled: false };
                }
                this.updateTeleportalConnectionLists();
                this.triggerMapChange();
            });
        });
        
        document.querySelectorAll('#teleportal-receive-list .toggle-connection').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const item = e.target.closest('.teleportal-connection-item');
                const index = parseInt(item.dataset.index);
                const conn = this.editingObject.receiveFrom[index];
                if (typeof conn === 'object') {
                    conn.enabled = !conn.enabled;
                } else {
                    this.editingObject.receiveFrom[index] = { name: conn, enabled: false };
                }
                this.updateTeleportalConnectionLists();
                this.triggerMapChange();
            });
        });
        
        // Remove button listeners
        document.querySelectorAll('#teleportal-send-list .remove-connection').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const item = e.target.closest('.teleportal-connection-item');
                const index = parseInt(item.dataset.index);
                this.editingObject.sendTo.splice(index, 1);
                this.updateTeleportalConnectionLists();
                this.triggerMapChange();
            });
        });
        
        document.querySelectorAll('#teleportal-receive-list .remove-connection').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const item = e.target.closest('.teleportal-connection-item');
                const index = parseInt(item.dataset.index);
                this.editingObject.receiveFrom.splice(index, 1);
                this.updateTeleportalConnectionLists();
                this.triggerMapChange();
            });
        });
    }
    
    // ========================================
    // ZONE METHODS
    // ========================================
    
    completeZonePlacement() {
        const { startX, startY, endX, endY } = this.zonePlacement;
        
        // Calculate rectangle bounds
        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        const width = Math.abs(endX - startX) + GRID_SIZE;
        const height = Math.abs(endY - startY) + GRID_SIZE;
        
        // Minimum zone size
        if (width < GRID_SIZE || height < GRID_SIZE) {
            return; // Too small, cancel
        }

        const zoneFill = this.koreenSettings.fillMode || 'add';
        const zoneOverlaps = this.getOverlappingObjectsInArea(x, y, width, height);
        if (zoneFill === 'add' && zoneOverlaps.length > 0) return;
        
        // Create the zone object
        const zone = new WorldObject({
            x: x,
            y: y,
            width: width,
            height: height,
            type: 'koreen',
            appearanceType: 'zone',
            actingType: 'zone',
            collision: false,
            color: 'rgba(255, 255, 255, 0.3)',
            opacity: this.koreenSettings.opacity,
            name: 'New Zone',
            zoneName: '' // Will be set by naming popup
        });
        zone._replaceIds = zoneFill === 'replace' ? zoneOverlaps.map((o) => o.id) : [];
        
        // Show naming popup
        this.pendingZone = zone;
        this.showZoneNamePopup();
    }

    completeSpinnerPlacement() {
        const { startX, startY, endX, endY } = this.obstaclePlacement;

        // Calculate rectangle bounds
        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        const width = Math.abs(endX - startX) + GRID_SIZE;
        const height = Math.abs(endY - startY) + GRID_SIZE;

        // Minimum spinner size (2x2 blocks default)
        const minSize = GRID_SIZE * 2;
        const finalWidth = Math.max(width, minSize);
        const finalHeight = Math.max(height, minSize);

        const spinnerFill = this.obstacleSettings.fillMode || 'add';
        if (!this.applyFillModeToArea(spinnerFill, x, y, finalWidth, finalHeight)) return;

        // Create the spinner object
        const spinner = new WorldObject({
            x: x,
            y: y,
            width: finalWidth,
            height: finalHeight,
            type: 'spinner',
            appearanceType: 'spinner',
            actingType: this.obstacleSettings.actingType || 'spike',
            collision: true,
            color: this.obstacleSettings.color || '#ff4444',
            opacity: this.obstacleSettings.opacity ?? 1,
            spinSpeed: this.obstacleSettings.spinSpeed || 1,
            rotation: 0
        });

        spinner.layer = 2; // Above player by default

        this.world.addObject(spinner);
        this.triggerMapChange();
        if (this.engine && this.engine.audioManager) this.engine.audioManager.play('place');
    }

    completeButtonPlacement() {
        const { startX, startY, endX, endY } = this.buttonPlacement;
        
        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        const width = Math.abs(endX - startX) + GRID_SIZE;
        const height = Math.abs(endY - startY) + GRID_SIZE;
        
        if (width < GRID_SIZE || height < GRID_SIZE) return;

        const buttonFill = this.buttonSettings.fillMode || 'add';
        if (!this.applyFillModeToArea(buttonFill, x, y, width, height)) return;
        
        const button = new WorldObject({
            x, y, width, height,
            type: 'koreen',
            appearanceType: 'button',
            actingType: 'button',
            collision: false,
            color: '#F52C2C',
            buttonColor2: '#CFCFCF',
            opacity: this.koreenSettings.opacity ?? 1,
            name: 'New Button',
            displayName: 'Button',
            displayDescription: '',
            buttonVisible: true,
            buttonInteraction: 'click',
            buttonOnlyOnce: false,
            buttonWidth: null,
            buttonHeight: null
        });
        
        this.world.addObject(button);
        this.updateLayersList();
        this.triggerMapChange();
        if (this.engine && this.engine.audioManager) this.engine.audioManager.play('place');
        
        // Open edit popup for the new button
        this.openButtonEditPopup(button);
    }

    showZoneNamePopup() {
        // Create popup if it doesn't exist
        let popup = document.getElementById('zone-name-popup');
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'zone-name-popup';
            popup.className = 'modal-overlay';
            popup.innerHTML = `
                <div class="zone-name-panel">
                    <div class="panel-header">
                        <span class="panel-title">Name Zone</span>
                        <button class="btn btn-icon btn-ghost" id="close-zone-name-popup">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="panel-body">
                        <div class="form-group">
                            <label class="form-label">Zone Name</label>
                            <input type="text" class="form-input" id="zone-name-input" placeholder="Enter unique zone name">
                            <div id="zone-name-error" style="color: #ff6b6b; font-size: 12px; margin-top: 4px; display: none;"></div>
                        </div>
                        <div class="form-group" style="margin-top: 16px;">
                            <button class="btn btn-primary" id="zone-name-confirm" style="width: 100%;">Create Zone</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(popup);
            
            // Event listeners
            document.getElementById('close-zone-name-popup').addEventListener('click', () => {
                this.closeZoneNamePopup();
            });
            
            popup.addEventListener('click', (e) => {
                if (e.target === popup) this.closeZoneNamePopup();
            });
            
            document.getElementById('zone-name-confirm').addEventListener('click', () => {
                this.confirmZoneName();
            });
            
            document.getElementById('zone-name-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.confirmZoneName();
                }
            });
        }
        
        // Reset and show
        document.getElementById('zone-name-input').value = '';
        document.getElementById('zone-name-error').style.display = 'none';
        popup.classList.add('active');
        document.getElementById('zone-name-input').focus();
    }
    
    closeZoneNamePopup() {
        const popup = document.getElementById('zone-name-popup');
        if (popup) popup.classList.remove('active');
        this.pendingZone = null;
    }
    
    confirmZoneName() {
        const input = document.getElementById('zone-name-input');
        const errorEl = document.getElementById('zone-name-error');
        const name = input.value.trim();
        
        if (!name) {
            errorEl.textContent = 'Please enter a zone name.';
            errorEl.style.display = 'block';
            return;
        }
        
        // Check for duplicate names
        const existingZone = this.world.objects.find(obj => 
            obj.appearanceType === 'zone' && obj.zoneName === name
        );
        
        if (existingZone) {
            errorEl.textContent = 'A zone with this name already exists.';
            errorEl.style.display = 'block';
            return;
        }
        
        // Set the zone name and add to world
        this.pendingZone.zoneName = name;
        this.pendingZone.name = 'Zone: ' + name;
        if (Array.isArray(this.pendingZone._replaceIds)) {
            for (const id of this.pendingZone._replaceIds) {
                this.world.removeObject(id);
            }
            delete this.pendingZone._replaceIds;
        }
        this.world.addObject(this.pendingZone);
        this.updateLayersList();
        this.triggerMapChange();
        if (this.engine && this.engine.audioManager) this.engine.audioManager.play('place');
        
        this.closeZoneNamePopup();
    }
    
    // Teleportal placement
    placeTeleportal(x, y) {
        const teleportalFill = this.teleportalSettings.fillMode || 'add';
        const teleportalOverlaps = this.getOverlappingObjectsInArea(x, y, GRID_SIZE, GRID_SIZE);
        if (teleportalFill === 'add' && teleportalOverlaps.length > 0) return;

        // Create the teleportal object
        const teleportal = new WorldObject({
            x: x,
            y: y,
            type: 'teleportal',
            appearanceType: 'teleportal',
            actingType: this.teleportalSettings.actingType || 'portal',
            collision: true,
            color: this.teleportalSettings.color || this.world.defaultPortalColor || '#9b59b6',
            opacity: this.teleportalSettings.opacity ?? 1,
            name: 'New Teleportal',
            teleportalName: '' // Will be set by naming popup
        });
        teleportal._replaceIds = teleportalFill === 'replace' ? teleportalOverlaps.map((o) => o.id) : [];
        
        // Show naming popup
        this.pendingTeleportal = teleportal;
        this.showTeleportalNamePopup();
    }
    
    showTeleportalNamePopup() {
        // Create popup if it doesn't exist
        let popup = document.getElementById('teleportal-name-popup');
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'teleportal-name-popup';
            popup.className = 'modal-overlay';
            popup.innerHTML = `
                <div class="zone-name-panel">
                    <div class="panel-header">
                        <span class="panel-title">Name Teleportal</span>
                        <button class="btn btn-icon btn-ghost" id="close-teleportal-name-popup">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="panel-body">
                        <div class="form-group">
                            <label class="form-label">Teleportal Name</label>
                            <input type="text" class="form-input" id="teleportal-name-input" placeholder="Enter unique teleportal name">
                            <div id="teleportal-name-error" style="color: #ff6b6b; font-size: 12px; margin-top: 4px; display: none;"></div>
                        </div>
                        <p style="font-size: 11px; color: #888; margin-top: 8px;">
                            Note: Teleportal names must be unique among other teleportals, but can share names with zones.
                        </p>
                        <div class="form-group" style="margin-top: 16px;">
                            <button class="btn btn-primary" id="teleportal-name-confirm" style="width: 100%;">Create Teleportal</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(popup);
            
            // Event listeners
            document.getElementById('close-teleportal-name-popup').addEventListener('click', () => {
                this.closeTeleportalNamePopup();
            });
            
            popup.addEventListener('click', (e) => {
                if (e.target === popup) this.closeTeleportalNamePopup();
            });
            
            document.getElementById('teleportal-name-confirm').addEventListener('click', () => {
                this.confirmTeleportalName();
            });
            
            document.getElementById('teleportal-name-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.confirmTeleportalName();
                }
            });
        }
        
        // Reset and show
        document.getElementById('teleportal-name-input').value = '';
        document.getElementById('teleportal-name-error').style.display = 'none';
        popup.classList.add('active');
        document.getElementById('teleportal-name-input').focus();
    }
    
    closeTeleportalNamePopup() {
        const popup = document.getElementById('teleportal-name-popup');
        if (popup) popup.classList.remove('active');
        this.pendingTeleportal = null;
    }
    
    confirmTeleportalName() {
        const input = document.getElementById('teleportal-name-input');
        const errorEl = document.getElementById('teleportal-name-error');
        const name = input.value.trim();
        
        if (!name) {
            errorEl.textContent = 'Please enter a teleportal name.';
            errorEl.style.display = 'block';
            return;
        }
        
        // Check for duplicate names among teleportals only
        const existingTeleportal = this.world.objects.find(obj => 
            obj.type === 'teleportal' && obj.teleportalName === name
        );
        
        if (existingTeleportal) {
            errorEl.textContent = 'A teleportal with this name already exists.';
            errorEl.style.display = 'block';
            return;
        }
        
        // Set the teleportal name and add to world
        this.pendingTeleportal.teleportalName = name;
        this.pendingTeleportal.name = 'Teleportal: ' + name;
        if (Array.isArray(this.pendingTeleportal._replaceIds)) {
            for (const id of this.pendingTeleportal._replaceIds) {
                this.world.removeObject(id);
            }
            delete this.pendingTeleportal._replaceIds;
        }
        this.world.addObject(this.pendingTeleportal);
        this.updateLayersList();
        this.triggerMapChange();
        
        this.closeTeleportalNamePopup();
    }
    
    // Override object edit popup for zones
    openObjectEditPopup(obj) {
        if (!obj) return;
        
        // Special handling for zones
        if (obj.appearanceType === 'zone') {
            this.openZoneEditPopup(obj);
            return;
        }
        
        // Special handling for buttons
        if (obj.appearanceType === 'button') {
            this.openButtonEditPopup(obj);
            return;
        }

        // Special handling for coins
        if (obj.appearanceType === 'coin') {
            this.openCoinEditPopup(obj);
            return;
        }

        // Special handling for bouncers
        if (obj.appearanceType === 'bouncer') {
            this.openBouncerEditPopup(obj);
            return;
        }
        
        this.editingObject = obj;
        const popup = this.ui.objectEditPopup;
        
        // Set title
        document.getElementById('object-edit-title').textContent = 'Edit ' + obj.name;
        
        // Set values
        document.getElementById('object-edit-name').value = obj.name;
        document.getElementById('object-edit-color').value = obj.color;
        document.getElementById('object-edit-color-preview').style.background = obj.color;
        document.getElementById('object-edit-opacity-range').value = Math.round(obj.opacity * 100);
        document.getElementById('object-edit-opacity-label').textContent = Math.round(obj.opacity * 100) + '%';
        document.getElementById('object-edit-rotation-label').textContent = obj.rotation + '°';
        document.getElementById('object-edit-collision').checked = obj.collision;
        const spriteGroup = document.getElementById('object-edit-sprite-group');
        const supportsSpriteSheet = obj.type !== 'spinner' && obj.appearanceType !== 'spinner';
        spriteGroup.style.display = supportsSpriteSheet ? 'block' : 'none';
        document.getElementById('object-edit-sprite-file').value = '';
        document.getElementById('object-edit-sprite-frame-width').value = obj.spriteSheet?.frameWidth || 32;
        document.getElementById('object-edit-sprite-frame-height').value = obj.spriteSheet?.frameHeight || 32;
        document.getElementById('object-edit-sprite-frame-count').value = obj.spriteSheet?.frameCount || 1;
        document.getElementById('object-edit-sprite-fps').value = obj.spriteSheet?.fps || 8;
        this.updateObjectSpriteSheetStatus();
        this.validateObjectSpriteSheetForEditor(obj);
        this.renderObjectSpriteAnimationClips(obj);
        const collisionShapeGroup = document.getElementById('object-edit-collision-shape-group');
        const supportsGroundCollisionShape = obj.type === 'block' && obj.appearanceType === 'ground' && obj.actingType === 'ground';
        collisionShapeGroup.style.display = supportsGroundCollisionShape ? 'block' : 'none';
        document.getElementById('object-edit-collision-shape').value = ['circle', 'capsule', 'slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.collisionShape) ? obj.collisionShape : 'box';
        const polygonGroup = document.getElementById('object-edit-collision-polygon-group');
        polygonGroup.style.display = obj.collisionShape === 'polygon' ? 'block' : 'none';
        const polygonOneWayGroup = document.getElementById('object-edit-polygon-one-way-group');
        polygonOneWayGroup.style.display = obj.collisionShape === 'polygon' ? 'block' : 'none';
        document.getElementById('object-edit-polygon-one-way').checked = obj.polygonOneWay !== false;
        const collisionPoints = WorldObject.normalizeCollisionPolygon(obj.collisionPoints) || WorldObject.DEFAULT_COLLISION_POLYGON;
        document.getElementById('object-edit-collision-points').value = JSON.stringify(collisionPoints, null, 2);
        document.getElementById('object-edit-collision-points-status').textContent = obj.collisionShape === 'polygon'
            ? `${collisionPoints.length} valid convex vertices` : '';
        const oneWayGroup = document.getElementById('object-edit-one-way-group');
        const supportsOneWayPlatform = supportsGroundCollisionShape && obj.collisionShape === 'box';
        oneWayGroup.style.display = supportsOneWayPlatform ? 'block' : 'none';
        document.getElementById('object-edit-one-way').checked = obj.oneWayPlatform === true;
        
        // Show/hide flip horizontal (not for zones)
        const flipGroup = document.getElementById('object-edit-flip-group');
        if (obj.appearanceType === 'zone') {
            flipGroup.style.display = 'none';
        } else {
            flipGroup.style.display = 'block';
            document.getElementById('object-edit-flip-horizontal').checked = obj.flipHorizontal || false;
        }
        
        // Show/hide spinner options (size + spin speed)
        const spinnerGroup = document.getElementById('object-edit-spinner-group');
        const isSpinner = obj.type === 'spinner' || obj.appearanceType === 'spinner';
        if (isSpinner) {
            spinnerGroup.style.display = 'block';
            // Show current size as read-only label
            const wBlocks = Math.round(obj.width / GRID_SIZE * 10) / 10;
            const hBlocks = Math.round(obj.height / GRID_SIZE * 10) / 10;
            const sizeLabel = document.getElementById('object-edit-spinner-size-label');
            if (sizeLabel) sizeLabel.textContent = `${wBlocks} × ${hBlocks} blocks (${obj.width} × ${obj.height} px)`;
            // Wire the Adjust Size button
            const adjustBtn = document.getElementById('spinner-edit-adjust');
            if (adjustBtn) {
                adjustBtn.onclick = () => {
                    this.editingObject = obj;
                    this.startSpinnerAdjustmentMode();
                };
            }
            const speed = obj.spinSpeed || 1;
            document.getElementById('object-edit-spin-speed-range').value = Math.round(speed * 10);
            document.getElementById('object-edit-spin-speed-label').textContent = speed.toFixed(1) + '/s';
            const dir = obj.spinDirection || 1;
            document.getElementById('object-edit-spin-dir-cw').classList.toggle('active', dir === 1);
            document.getElementById('object-edit-spin-dir-ccw').classList.toggle('active', dir === -1);
            document.getElementById('object-edit-spinner-damage').value = obj.damageAmount !== undefined ? obj.damageAmount : 1;
        } else {
            spinnerGroup.style.display = 'none';
        }

        // Show/hide spike options (not for spinners/saw blades)
        const spikeGroup = document.getElementById('object-edit-spike-group');
        if (!isSpinner && (obj.appearanceType === 'spike' || obj.actingType === 'spike')) {
            spikeGroup.style.display = 'block';
            document.getElementById('object-edit-spike-touchbox').value = obj.spikeTouchbox || '';
            this.updateSpikeTouchboxEditDescription(obj.spikeTouchbox || '');
            this.updateSpikeAttachedWarning();
            
            // Set dropHurtOnly value
            const dropHurtOnlySelect = document.getElementById('object-edit-drop-hurt-only');
            if (obj.dropHurtOnly === true) {
                dropHurtOnlySelect.value = 'true';
            } else if (obj.dropHurtOnly === false) {
                dropHurtOnlySelect.value = 'false';
            } else {
                dropHurtOnlySelect.value = '';
            }
            document.getElementById('object-edit-spike-damage').value = obj.damageAmount !== undefined ? obj.damageAmount : 1;
        } else {
            spikeGroup.style.display = 'none';
        }
        
        // Show/hide text options
        const textGroup = document.getElementById('object-edit-text-group');
        if (obj.type === 'text') {
            textGroup.style.display = 'block';
            document.getElementById('object-edit-content').value = obj.content || '';
            
            // Set font and populate font dropdown
            const fontValue = document.getElementById('object-edit-font-value');
            fontValue.textContent = obj.font || 'Parkoreen Game';
            fontValue.style.fontFamily = `"${obj.font || 'Parkoreen Game'}"`;
            
            // Set content textarea font
            document.getElementById('object-edit-content').style.fontFamily = `"${obj.font || 'Parkoreen Game'}"`;
            
            // Populate font dropdown
            this.populateObjectEditFontDropdown(obj.font || 'Parkoreen Game');
            
            // Update font preview
            this.updateObjectEditFontPreview();
        } else {
            textGroup.style.display = 'none';
        }
        
        // Show/hide teleportal options (only when actingType is 'portal')
        const teleportalGroup = document.getElementById('object-edit-teleportal-group');
        if (obj.type === 'teleportal' && obj.actingType === 'portal') {
            teleportalGroup.style.display = 'block';
            this.updateTeleportalConnectionLists();
            const particleOpacity = typeof obj.particleOpacity === 'number' ? obj.particleOpacity : 100;
            document.getElementById('object-edit-teleportal-particle-opacity').value = particleOpacity;
            document.getElementById('object-edit-teleportal-particle-opacity-label').textContent = particleOpacity + '%';
        } else {
            teleportalGroup.style.display = 'none';
        }

        // Show/hide bouncer options
        const bouncerGroup = document.getElementById('object-edit-bouncer-group');
        if (obj.actingType === 'bouncer') {
            bouncerGroup.style.display = 'block';
            const strength = typeof obj.bouncerStrength === 'number' ? obj.bouncerStrength : 20;
            document.getElementById('object-edit-bouncer-strength').value = strength;
            document.getElementById('object-edit-bouncer-strength-label').textContent = strength;
        } else {
            bouncerGroup.style.display = 'none';
        }

        // Show/hide endpoint options
        const endpointGroup = document.getElementById('object-edit-endpoint-group');
        if (obj.actingType === 'endpoint') {
            endpointGroup.style.display = 'block';
            if (!Number.isFinite(obj.endpointRequiredCoins)) {
                obj.endpointRequiredCoins = this.world.objects.filter(o => o.appearanceType === 'coin').length;
            }
            const requireCoins = !!obj.endpointRequireCoins;
            document.getElementById('object-edit-endpoint-require-coins').checked = requireCoins;
            document.getElementById('object-edit-endpoint-amount-wrap').style.display = requireCoins ? 'block' : 'none';
            document.getElementById('object-edit-endpoint-amount').value = Math.max(0, parseInt(obj.endpointRequiredCoins, 10) || 0);
        } else {
            endpointGroup.style.display = 'none';
        }

        // Show popup
        popup.classList.add('active');
    }
    
    openZoneEditPopup(zone) {
        // Create popup if it doesn't exist
        let popup = document.getElementById('zone-edit-popup');
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'zone-edit-popup';
            popup.className = 'modal-overlay';
            popup.innerHTML = `
                <div class="zone-edit-panel">
                    <div class="panel-header">
                        <span class="panel-title" id="zone-edit-title">Edit Zone</span>
                        <button class="btn btn-icon btn-ghost" id="close-zone-edit">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="panel-body">
                        <div class="form-group">
                            <label class="form-label">Zone Name</label>
                            <input type="text" class="form-input" id="zone-edit-name" placeholder="Zone name">
                            <div id="zone-edit-name-error" style="color: #ff6b6b; font-size: 12px; margin-top: 4px; display: none;"></div>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">Opacity</label>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <input type="range" class="form-range" id="zone-edit-opacity" min="0" max="100" value="30" style="flex: 1;">
                                <span id="zone-edit-opacity-label" style="font-size: 12px; min-width: 35px;">30%</span>
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <button class="btn btn-secondary" id="zone-edit-adjust" style="width: 100%;">
                                <span class="material-symbols-outlined">open_with</span>
                                Adjust Region
                            </button>
                        </div>
                        
                        <div class="form-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--surface-light);">
                            <button class="btn btn-danger" id="zone-edit-delete" style="width: 100%;">
                                <span class="material-symbols-outlined">delete</span>
                                Delete Zone
                            </button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(popup);
            
            // Event listeners
            document.getElementById('close-zone-edit').addEventListener('click', () => {
                this.closeZoneEditPopup();
            });
            
            popup.addEventListener('click', (e) => {
                if (e.target === popup) this.closeZoneEditPopup();
            });
            
            document.getElementById('zone-edit-name').addEventListener('change', (e) => {
                this.updateZoneName(e.target.value);
            });
            
            document.getElementById('zone-edit-opacity').addEventListener('input', (e) => {
                if (this.editingZone) {
                    const value = parseInt(e.target.value);
                    this.editingZone.opacity = value / 100;
                    document.getElementById('zone-edit-opacity-label').textContent = value + '%';
                    this.triggerMapChange();
                }
            });
            
            document.getElementById('zone-edit-adjust').addEventListener('click', () => {
                this.startZoneAdjustmentMode();
            });
            
            document.getElementById('zone-edit-delete').addEventListener('click', () => {
                if (this.editingZone) {
                    this.world.removeObject(this.editingZone.id);
                    this.closeZoneEditPopup();
                    this.updateLayersList();
                    this.triggerMapChange();
                }
            });
        }
        
        this.editingZone = zone;
        
        // Set values
        document.getElementById('zone-edit-title').textContent = 'Edit Zone: ' + (zone.zoneName || 'Unnamed');
        document.getElementById('zone-edit-name').value = zone.zoneName || '';
        document.getElementById('zone-edit-opacity').value = Math.round(zone.opacity * 100);
        document.getElementById('zone-edit-opacity-label').textContent = Math.round(zone.opacity * 100) + '%';
        document.getElementById('zone-edit-name-error').style.display = 'none';
        
        popup.classList.add('active');
    }
    
    closeZoneEditPopup() {
        const popup = document.getElementById('zone-edit-popup');
        if (popup) popup.classList.remove('active');
        this.editingZone = null;
    }
    
    openButtonEditPopup(button) {
        let popup = document.getElementById('button-edit-popup');
        if (popup) popup.remove();

        const col1 = button.color || '#F52C2C';
        const col2 = button.buttonColor2 || '#CFCFCF';
        
        popup = document.createElement('div');
        popup.id = 'button-edit-popup';
        popup.className = 'modal-overlay';
        popup.innerHTML = `
            <div class="object-edit-panel" style="max-width: 420px;">
                <div class="panel-header">
                    <span class="panel-title">Edit Button</span>
                    <button class="btn btn-icon btn-ghost" id="close-button-edit">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="panel-body">
                    <div class="form-group">
                        <label class="form-label">Object Name</label>
                        <input type="text" class="form-input" id="button-edit-name" value="${this.escapeAttr(button.name)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Interaction Type</label>
                        <div style="display: flex; gap: 8px;">
                            <button class="placement-opt-btn ${button.buttonInteraction !== 'collide' ? 'active' : ''}" id="btn-interact-click" style="flex: 1; padding: 8px 6px; font-size: 13px;">
                                Click
                            </button>
                            <button class="placement-opt-btn ${button.buttonInteraction === 'collide' ? 'active' : ''}" id="btn-interact-collide" style="flex: 1; padding: 8px 6px; font-size: 13px;">
                                Collide
                            </button>
                        </div>
                        <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;" id="button-interact-hint">${button.buttonInteraction === 'collide' ? 'Triggers when the player walks onto the button.' : 'Triggers when the player clicks the popup inside the zone.'}</div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">One-Time Trigger</label>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <label class="toggle">
                                <input type="checkbox" id="button-edit-only-once" ${button.buttonOnlyOnce ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                            <span style="font-size: 12px; color: var(--text-muted);">Button can only be triggered once per play session.</span>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Display Name</label>
                        <input type="text" class="form-input" id="button-edit-display-name" value="${this.escapeAttr(button.displayName)}" placeholder="Title shown to player">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Display Description</label>
                        <textarea class="form-input" id="button-edit-display-desc" rows="4" placeholder="Description shown to player" style="resize: vertical;">${this.escapeAttr(button.displayDescription)}</textarea>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Button Visible</label>
                        <label class="toggle">
                            <input type="checkbox" id="button-edit-visible" ${button.buttonVisible ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Colors</label>
                        <div style="display: flex; gap: 16px;">
                            <div style="flex:1;">
                                <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">Face Color</div>
                                <div style="display: flex; gap: 6px; align-items: center;">
                                    <div id="button-edit-color1-preview" style="width:28px;height:28px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:${col1};flex-shrink:0;"></div>
                                    <input type="text" class="form-input" id="button-edit-color1-input" value="${col1}" placeholder="#F52C2C" style="flex:1;font-size:12px;">
                                </div>
                            </div>
                            <div style="flex:1;">
                                <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">Base / Border Color</div>
                                <div style="display: flex; gap: 6px; align-items: center;">
                                    <div id="button-edit-color2-preview" style="width:28px;height:28px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:${col2};flex-shrink:0;"></div>
                                    <input type="text" class="form-input" id="button-edit-color2-input" value="${col2}" placeholder="#CFCFCF" style="flex:1;font-size:12px;">
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Button Display Size</label>
                        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">
                            Custom display size (leave empty to match zone size)
                        </div>
                        <div style="display: flex; gap: 12px;">
                            <div style="flex: 1;">
                                <label style="font-size: 11px; color: var(--text-muted);">Width (px)</label>
                                <input type="number" class="form-input" id="button-edit-width" value="${button.buttonWidth || ''}" placeholder="Auto" min="10" step="1">
                            </div>
                            <div style="flex: 1;">
                                <label style="font-size: 11px; color: var(--text-muted);">Height (px)</label>
                                <input type="number" class="form-input" id="button-edit-height" value="${button.buttonHeight || ''}" placeholder="Auto" min="10" step="1">
                            </div>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Opacity</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="range" class="form-range" id="button-edit-opacity" min="0" max="100" value="${Math.round(button.opacity * 100)}" style="flex: 1;">
                            <span id="button-edit-opacity-label" style="font-size: 12px; min-width: 35px;">${Math.round(button.opacity * 100)}%</span>
                        </div>
                    </div>
                    <div class="form-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--surface-light);">
                        <button class="btn btn-danger" id="button-edit-delete" style="width: 100%;">
                            <span class="material-symbols-outlined">delete</span>
                            Delete Button
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(popup);
        popup.classList.add('active');
        
        this.editingButton = button;

        // Close
        document.getElementById('close-button-edit').addEventListener('click', () => {
            this.closeButtonEditPopup();
        });
        popup.addEventListener('click', (e) => {
            if (e.target === popup) this.closeButtonEditPopup();
        });

        // Interaction type
        document.getElementById('btn-interact-click').addEventListener('click', () => {
            button.buttonInteraction = 'click';
            document.getElementById('btn-interact-click').classList.add('active');
            document.getElementById('btn-interact-collide').classList.remove('active');
            document.getElementById('button-interact-hint').textContent = 'Triggers when the player clicks the popup inside the zone.';
            this.triggerMapChange();
        });
        document.getElementById('btn-interact-collide').addEventListener('click', () => {
            button.buttonInteraction = 'collide';
            document.getElementById('btn-interact-collide').classList.add('active');
            document.getElementById('btn-interact-click').classList.remove('active');
            document.getElementById('button-interact-hint').textContent = 'Triggers when the player walks onto the button.';
            button.buttonVisible = true;
            document.getElementById('button-edit-visible').checked = true;
            this.triggerMapChange();
        });

        // Name
        document.getElementById('button-edit-name').addEventListener('change', (e) => {
            button.name = e.target.value || 'Button';
            this.updateLayersList();
            this.triggerMapChange();
        });
        
        // Display name
        document.getElementById('button-edit-display-name').addEventListener('input', (e) => {
            button.displayName = e.target.value;
            this.triggerMapChange();
        });
        
        // Display description
        document.getElementById('button-edit-display-desc').addEventListener('input', (e) => {
            button.displayDescription = e.target.value;
            this.triggerMapChange();
        });
        
        // Visible
        document.getElementById('button-edit-visible').addEventListener('change', (e) => {
            button.buttonVisible = e.target.checked;
            this.triggerMapChange();
        });

        // One-time trigger
        document.getElementById('button-edit-only-once').addEventListener('change', (e) => {
            button.buttonOnlyOnce = e.target.checked;
            this.triggerMapChange();
        });

        // Color 1 (face)
        const col1Preview = document.getElementById('button-edit-color1-preview');
        const col1Input = document.getElementById('button-edit-color1-input');
        col1Preview.addEventListener('click', () => col1Input.click());
        col1Input.addEventListener('change', (e) => {
            const c = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
                button.color = c;
                col1Preview.style.background = c;
                this.triggerMapChange();
            }
        });
        col1Input.addEventListener('input', (e) => {
            if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) col1Preview.style.background = e.target.value;
        });

        // Color 2 (base/border)
        const col2Preview = document.getElementById('button-edit-color2-preview');
        const col2Input = document.getElementById('button-edit-color2-input');
        col2Preview.addEventListener('click', () => col2Input.click());
        col2Input.addEventListener('change', (e) => {
            const c = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
                button.buttonColor2 = c;
                col2Preview.style.background = c;
                this.triggerMapChange();
            }
        });
        col2Input.addEventListener('input', (e) => {
            if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) col2Preview.style.background = e.target.value;
        });

        // Width
        document.getElementById('button-edit-width').addEventListener('change', (e) => {
            const val = parseInt(e.target.value);
            button.buttonWidth = val > 0 ? val : null;
            this.triggerMapChange();
        });
        
        // Height
        document.getElementById('button-edit-height').addEventListener('change', (e) => {
            const val = parseInt(e.target.value);
            button.buttonHeight = val > 0 ? val : null;
            this.triggerMapChange();
        });
        
        // Opacity
        document.getElementById('button-edit-opacity').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            button.opacity = val / 100;
            document.getElementById('button-edit-opacity-label').textContent = val + '%';
            this.triggerMapChange();
        });
        
        // Delete
        document.getElementById('button-edit-delete').addEventListener('click', () => {
            this.world.removeObject(button.id);
            this.closeButtonEditPopup();
            this.updateLayersList();
            this.triggerMapChange();
        });
    }
    
    closeButtonEditPopup() {
        const popup = document.getElementById('button-edit-popup');
        if (popup) {
            popup.classList.remove('active');
            setTimeout(() => popup.remove(), 200);
        }
        this.editingButton = null;
    }

    openCoinEditPopup(coin) {
        let popup = document.getElementById('coin-edit-popup');
        if (popup) popup.remove();

        popup = document.createElement('div');
        popup.id = 'coin-edit-popup';
        popup.className = 'modal-overlay';
        popup.innerHTML = `
            <div class="object-edit-panel" style="max-width: 400px;">
                <div class="panel-header">
                    <span class="panel-title">Edit Coin</span>
                    <button class="btn btn-icon btn-ghost" id="close-coin-edit">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="panel-body">
                    <div class="form-group">
                        <label class="form-label">Object Name</label>
                        <input type="text" class="form-input" id="coin-edit-name" value="${this.escapeAttr(coin.name)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Amount</label>
                        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">How much this coin is worth when collected.</div>
                        <input type="number" class="form-input" id="coin-edit-amount" value="${coin.coinAmount !== undefined ? coin.coinAmount : 1}" min="0" step="0.5" style="width: 100%;">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Activity Scope</label>
                        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">Whether collecting this coin affects all players or only the one who collected it.</div>
                        <div style="display: flex; gap: 8px;">
                            <button class="placement-opt-btn ${(coin.coinActivityScope || 'global') === 'global' ? 'active' : ''}" id="coin-scope-global" style="flex:1; padding: 8px 6px; font-size: 13px;">Global</button>
                            <button class="placement-opt-btn ${(coin.coinActivityScope || 'global') === 'player' ? 'active' : ''}" id="coin-scope-player" style="flex:1; padding: 8px 6px; font-size: 13px;">Player</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Color</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <div id="coin-edit-color-preview" style="width:32px;height:32px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:${coin.color || '#FFDD00'};flex-shrink:0;"></div>
                            <input type="text" class="form-input" id="coin-edit-color-input" value="${coin.color || '#FFDD00'}" placeholder="#FFDD00" style="flex:1;">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Opacity</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="range" class="form-range" id="coin-edit-opacity" min="0" max="100" value="${Math.round(coin.opacity * 100)}" style="flex: 1;">
                            <span id="coin-edit-opacity-label" style="font-size: 12px; min-width: 35px;">${Math.round(coin.opacity * 100)}%</span>
                        </div>
                    </div>
                    <div class="form-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--surface-light);">
                        <button class="btn btn-danger" id="coin-edit-delete" style="width: 100%;">
                            <span class="material-symbols-outlined">delete</span>
                            Delete Coin
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(popup);
        popup.classList.add('active');

        this.editingCoin = coin;

        document.getElementById('close-coin-edit').addEventListener('click', () => this.closeCoinEditPopup());
        popup.addEventListener('click', (e) => { if (e.target === popup) this.closeCoinEditPopup(); });

        document.getElementById('coin-edit-name').addEventListener('change', (e) => {
            coin.name = e.target.value || 'Coin';
            this.updateLayersList();
            this.triggerMapChange();
        });

        document.getElementById('coin-edit-amount').addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            coin.coinAmount = isNaN(val) ? 1 : Math.max(0, val);
            e.target.value = coin.coinAmount;
            this.triggerMapChange();
        });

        document.getElementById('coin-scope-global').addEventListener('click', () => {
            coin.coinActivityScope = 'global';
            document.getElementById('coin-scope-global').classList.add('active');
            document.getElementById('coin-scope-player').classList.remove('active');
            this.triggerMapChange();
        });
        document.getElementById('coin-scope-player').addEventListener('click', () => {
            coin.coinActivityScope = 'player';
            document.getElementById('coin-scope-player').classList.add('active');
            document.getElementById('coin-scope-global').classList.remove('active');
            this.triggerMapChange();
        });

        const colorPreview = document.getElementById('coin-edit-color-preview');
        const colorInput = document.getElementById('coin-edit-color-input');
        colorPreview.addEventListener('click', () => colorInput.click());
        colorInput.addEventListener('change', (e) => {
            const c = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
                coin.color = c;
                colorPreview.style.background = c;
                this.triggerMapChange();
            }
        });
        colorInput.addEventListener('input', (e) => {
            const c = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
                colorPreview.style.background = c;
            }
        });

        document.getElementById('coin-edit-opacity').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            coin.opacity = val / 100;
            document.getElementById('coin-edit-opacity-label').textContent = val + '%';
            this.triggerMapChange();
        });

        document.getElementById('coin-edit-delete').addEventListener('click', () => {
            this.world.removeObject(coin.id);
            this.closeCoinEditPopup();
            this.updateLayersList();
            this.triggerMapChange();
        });
    }

    closeCoinEditPopup() {
        const popup = document.getElementById('coin-edit-popup');
        if (popup) {
            popup.classList.remove('active');
            setTimeout(() => popup.remove(), 200);
        }
        this.editingCoin = null;
    }

    openBouncerEditPopup(bouncer) {
        let popup = document.getElementById('bouncer-edit-popup');
        if (popup) popup.remove();

        // Helper to build a direction picker widget HTML
        const buildDirPicker = (idPrefix, selectedDir, label) => {
            const dirs = [
                { dir: 0,   label: '▲', pos: 'top' },
                { dir: 90,  label: '▶', pos: 'right' },
                { dir: 180, label: '▼', pos: 'bottom' },
                { dir: 270, label: '◀', pos: 'left' }
            ];
            const btnStyle = (dir) => `
                padding: 6px 10px; font-size: 15px; border: 1px solid rgba(255,255,255,0.15);
                border-radius: 6px; cursor: pointer; background: ${dir === selectedDir ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.07)'};
                color: ${dir === selectedDir ? '#fff' : 'rgba(255,255,255,0.6)'};
                transition: background 0.15s;
            `.replace(/\s+/g, ' ');

            const rotDeg = selectedDir;
            return `
                <div style="margin-bottom: 6px; font-size: 12px; color: var(--text-muted);">${label}</div>
                <div style="display: grid; grid-template-columns: 40px 56px 40px; grid-template-rows: 40px 56px 40px; gap: 4px; width: fit-content; margin: 0 auto 8px;">
                    <div></div>
                    <button class="bouncer-dir-btn" data-picker="${idPrefix}" data-dir="0" style="${btnStyle(0)}">▲</button>
                    <div></div>
                    <button class="bouncer-dir-btn" data-picker="${idPrefix}" data-dir="270" style="${btnStyle(270)}">◀</button>
                    <div style="display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.1);border-radius:8px;overflow:hidden;background:rgba(0,0,0,0.2);">
                        <img src="/parkoreen/assets/svg/bouncer.svg" id="${idPrefix}-sprite" style="width:40px;height:40px;transform:rotate(${rotDeg}deg);transition:transform 0.2s;filter:sepia(0.3);" alt="bouncer">
                    </div>
                    <button class="bouncer-dir-btn" data-picker="${idPrefix}" data-dir="90" style="${btnStyle(90)}">▶</button>
                    <div></div>
                    <button class="bouncer-dir-btn" data-picker="${idPrefix}" data-dir="180" style="${btnStyle(180)}">▼</button>
                    <div></div>
                </div>
            `;
        };

        const matchApp = bouncer.bouncerMatchAppearance !== false;
        const launchDir = bouncer.bouncerDirection || 0;
        const appearDir = bouncer.bouncerAppearanceDirection || 0;
        const col1 = bouncer.color || '#461A0C';

        popup = document.createElement('div');
        popup.id = 'bouncer-edit-popup';
        popup.className = 'modal-overlay';
        popup.innerHTML = `
            <div class="object-edit-panel" style="max-width: 440px;">
                <div class="panel-header">
                    <span class="panel-title">Edit Bouncer</span>
                    <button class="btn btn-icon btn-ghost" id="close-bouncer-edit">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="panel-body">
                    <div class="form-group">
                        <label class="form-label">Object Name</label>
                        <input type="text" class="form-input" id="bouncer-edit-name" value="${this.escapeAttr(bouncer.name)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Match Appearance</label>
                        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">When enabled, the launch direction and appearance direction are the same.</div>
                        <label class="toggle">
                            <input type="checkbox" id="bouncer-edit-match-app" ${matchApp ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="form-group" id="bouncer-dir-unified" ${matchApp ? '' : 'style="display:none"'}>
                        ${buildDirPicker('bouncer-unified', matchApp ? launchDir : launchDir, 'Direction (launch &amp; appearance)')}
                    </div>
                    <div id="bouncer-dir-split" ${matchApp ? 'style="display:none"' : ''}>
                        <div class="form-group">
                            ${buildDirPicker('bouncer-launch', launchDir, 'Launch Direction')}
                        </div>
                        <div class="form-group">
                            ${buildDirPicker('bouncer-appear', appearDir, 'Appearance Direction')}
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Bounce Strength</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="range" class="form-range" id="bouncer-edit-strength" min="5" max="60" value="${bouncer.bouncerStrength !== undefined ? bouncer.bouncerStrength : 20}" style="flex: 1;">
                            <span id="bouncer-edit-strength-label" style="font-size: 12px; min-width: 28px;">${bouncer.bouncerStrength !== undefined ? bouncer.bouncerStrength : 20}</span>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Color</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <div id="bouncer-edit-color-preview" style="width:32px;height:32px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:${col1};flex-shrink:0;"></div>
                            <input type="text" class="form-input" id="bouncer-edit-color-input" value="${col1}" placeholder="#461A0C" style="flex:1;">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Opacity</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="range" class="form-range" id="bouncer-edit-opacity" min="0" max="100" value="${Math.round(bouncer.opacity * 100)}" style="flex: 1;">
                            <span id="bouncer-edit-opacity-label" style="font-size: 12px; min-width: 35px;">${Math.round(bouncer.opacity * 100)}%</span>
                        </div>
                    </div>
                    <div class="form-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--surface-light);">
                        <button class="btn btn-danger" id="bouncer-edit-delete" style="width: 100%;">
                            <span class="material-symbols-outlined">delete</span>
                            Delete Bouncer
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(popup);
        popup.classList.add('active');

        this.editingBouncer = bouncer;

        document.getElementById('close-bouncer-edit').addEventListener('click', () => this.closeBouncerEditPopup());
        popup.addEventListener('click', (e) => { if (e.target === popup) this.closeBouncerEditPopup(); });

        document.getElementById('bouncer-edit-name').addEventListener('change', (e) => {
            bouncer.name = e.target.value || 'Bouncer';
            this.updateLayersList();
            this.triggerMapChange();
        });

        // Match appearance toggle
        document.getElementById('bouncer-edit-match-app').addEventListener('change', (e) => {
            bouncer.bouncerMatchAppearance = e.target.checked;
            const unified = document.getElementById('bouncer-dir-unified');
            const split = document.getElementById('bouncer-dir-split');
            if (e.target.checked) {
                unified.style.display = '';
                split.style.display = 'none';
            } else {
                unified.style.display = 'none';
                split.style.display = '';
            }
            this.triggerMapChange();
        });

        // Direction picker button handler (delegated)
        popup.addEventListener('click', (e) => {
            const btn = e.target.closest('.bouncer-dir-btn');
            if (!btn) return;
            const picker = btn.dataset.picker;
            const dir = parseInt(btn.dataset.dir);

            // Update model
            if (picker === 'bouncer-unified') {
                bouncer.bouncerDirection = dir;
                bouncer.bouncerAppearanceDirection = dir;
            } else if (picker === 'bouncer-launch') {
                bouncer.bouncerDirection = dir;
            } else if (picker === 'bouncer-appear') {
                bouncer.bouncerAppearanceDirection = dir;
            }

            // Update sprite rotation
            const sprite = document.getElementById(picker + '-sprite');
            if (sprite) sprite.style.transform = `rotate(${dir}deg)`;

            // Update button highlight in picker
            popup.querySelectorAll(`.bouncer-dir-btn[data-picker="${picker}"]`).forEach(b => {
                const bDir = parseInt(b.dataset.dir);
                const active = bDir === dir;
                b.style.background = active ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.07)';
                b.style.color = active ? '#fff' : 'rgba(255,255,255,0.6)';
            });

            this.triggerMapChange();
        });

        // Strength
        document.getElementById('bouncer-edit-strength').addEventListener('input', (e) => {
            const val = parseInt(e.target.value) || 20;
            bouncer.bouncerStrength = val;
            document.getElementById('bouncer-edit-strength-label').textContent = val;
            this.triggerMapChange();
        });

        // Color
        const colorPreview = document.getElementById('bouncer-edit-color-preview');
        const colorInput = document.getElementById('bouncer-edit-color-input');
        colorPreview.addEventListener('click', () => colorInput.click());
        colorInput.addEventListener('change', (e) => {
            const c = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
                bouncer.color = c;
                colorPreview.style.background = c;
                this.triggerMapChange();
            }
        });
        colorInput.addEventListener('input', (e) => {
            const c = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
                colorPreview.style.background = c;
            }
        });

        document.getElementById('bouncer-edit-opacity').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            bouncer.opacity = val / 100;
            document.getElementById('bouncer-edit-opacity-label').textContent = val + '%';
            this.triggerMapChange();
        });

        document.getElementById('bouncer-edit-delete').addEventListener('click', () => {
            this.world.removeObject(bouncer.id);
            this.closeBouncerEditPopup();
            this.updateLayersList();
            this.triggerMapChange();
        });
    }

    closeBouncerEditPopup() {
        const popup = document.getElementById('bouncer-edit-popup');
        if (popup) {
            popup.classList.remove('active');
            setTimeout(() => popup.remove(), 200);
        }
        this.editingBouncer = null;
    }

    escapeAttr(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    
    updateZoneName(newName) {
        const errorEl = document.getElementById('zone-edit-name-error');
        const name = newName.trim();
        
        if (!name) {
            errorEl.textContent = 'Zone name cannot be empty.';
            errorEl.style.display = 'block';
            return;
        }
        
        // Check for duplicate names (excluding current zone)
        const existingZone = this.world.objects.find(obj => 
            obj.appearanceType === 'zone' && 
            obj.zoneName === name && 
            obj.id !== this.editingZone.id
        );
        
        if (existingZone) {
            errorEl.textContent = 'A zone with this name already exists.';
            errorEl.style.display = 'block';
            return;
        }
        
        errorEl.style.display = 'none';
        this.editingZone.zoneName = name;
        this.editingZone.name = 'Zone: ' + name;
        document.getElementById('zone-edit-title').textContent = 'Edit Zone: ' + name;
        this.updateLayersList();
        this.triggerMapChange();
    }
    
    startZoneAdjustmentMode() {
        if (!this.editingZone) return;
        
        this.zoneAdjustment.active = true;
        this.zoneAdjustment.zone = this.editingZone;
        
        // Close the edit popup
        this.closeZoneEditPopup();
        
        // Hide all UI except the stop button
        document.querySelectorAll('.toolbar, .panel, .add-menu, .placement-toolbar, .editor-btn-corner').forEach(el => {
            el.style.display = 'none';
        });
        
        // Create stop button
        let stopBtn = document.getElementById('zone-adjust-stop');
        if (!stopBtn) {
            stopBtn = document.createElement('button');
            stopBtn.id = 'zone-adjust-stop';
            stopBtn.className = 'btn btn-danger zone-adjust-stop';
            stopBtn.innerHTML = '<span class="material-symbols-outlined">close</span> Stop Adjusting';
            stopBtn.addEventListener('click', () => this.exitZoneAdjustmentMode());
            document.body.appendChild(stopBtn);
        }
        stopBtn.style.display = 'flex';
        
        // Enable fly mode for navigation
        this.isFlying = true;
    }
    
    exitZoneAdjustmentMode() {
        this.zoneAdjustment.active = false;
        this.zoneAdjustment.zone = null;
        this.zoneAdjustment.draggerHeld = null;
        
        // Hide stop button
        const stopBtn = document.getElementById('zone-adjust-stop');
        if (stopBtn) stopBtn.style.display = 'none';
        
        // Restore all UI
        document.querySelectorAll('.toolbar, .editor-btn-corner').forEach(el => {
            el.style.display = '';
        });
        
        // Re-show panels that were open (they'll handle their own visibility)
        this.updateLayersList();
        this.triggerMapChange();
    }
    
    handleZoneDraggerMove(gridX, gridY) {
        const zone = this.zoneAdjustment.zone;
        const dragger = this.zoneAdjustment.draggerHeld;
        if (!zone || !dragger) return;
        
        const minSize = GRID_SIZE;
        
        switch (dragger) {
            case 'top':
                const newTop = gridY;
                const maxTop = zone.y + zone.height - minSize;
                if (newTop <= maxTop) {
                    const diff = zone.y - newTop;
                    zone.y = newTop;
                    zone.height += diff;
                }
                break;
            case 'bottom':
                const newBottom = gridY + GRID_SIZE;
                const minBottom = zone.y + minSize;
                if (newBottom >= minBottom) {
                    zone.height = newBottom - zone.y;
                }
                break;
            case 'left':
                const newLeft = gridX;
                const maxLeft = zone.x + zone.width - minSize;
                if (newLeft <= maxLeft) {
                    const diff = zone.x - newLeft;
                    zone.x = newLeft;
                    zone.width += diff;
                }
                break;
            case 'right':
                const newRight = gridX + GRID_SIZE;
                const minRight = zone.x + minSize;
                if (newRight >= minRight) {
                    zone.width = newRight - zone.x;
                }
                break;
            case 'top-left':
                this.handleZoneDraggerMove(gridX, gridY); // This won't recurse properly, handle manually
                {
                    const newT = gridY;
                    const maxT = zone.y + zone.height - minSize;
                    if (newT <= maxT) {
                        const diffY = zone.y - newT;
                        zone.y = newT;
                        zone.height += diffY;
                    }
                    const newL = gridX;
                    const maxL = zone.x + zone.width - minSize;
                    if (newL <= maxL) {
                        const diffX = zone.x - newL;
                        zone.x = newL;
                        zone.width += diffX;
                    }
                }
                break;
            case 'top-right':
                {
                    const newT = gridY;
                    const maxT = zone.y + zone.height - minSize;
                    if (newT <= maxT) {
                        const diffY = zone.y - newT;
                        zone.y = newT;
                        zone.height += diffY;
                    }
                    const newR = gridX + GRID_SIZE;
                    const minR = zone.x + minSize;
                    if (newR >= minR) {
                        zone.width = newR - zone.x;
                    }
                }
                break;
            case 'bottom-left':
                {
                    const newB = gridY + GRID_SIZE;
                    const minB = zone.y + minSize;
                    if (newB >= minB) {
                        zone.height = newB - zone.y;
                    }
                    const newL = gridX;
                    const maxL = zone.x + zone.width - minSize;
                    if (newL <= maxL) {
                        const diffX = zone.x - newL;
                        zone.x = newL;
                        zone.width += diffX;
                    }
                }
                break;
            case 'bottom-right':
                {
                    const newB = gridY + GRID_SIZE;
                    const minB = zone.y + minSize;
                    if (newB >= minB) {
                        zone.height = newB - zone.y;
                    }
                    const newR = gridX + GRID_SIZE;
                    const minR = zone.x + minSize;
                    if (newR >= minR) {
                        zone.width = newR - zone.x;
                    }
                }
                break;
        }
    }
    
    getZoneDraggerAtPoint(worldX, worldY) {
        if (!this.zoneAdjustment.active || !this.zoneAdjustment.zone) return null;
        
        const zone = this.zoneAdjustment.zone;
        const handleSize = 12 / this.camera.zoom; // Size in world units
        
        const draggers = [
            { name: 'top-left', x: zone.x, y: zone.y },
            { name: 'top', x: zone.x + zone.width / 2, y: zone.y },
            { name: 'top-right', x: zone.x + zone.width, y: zone.y },
            { name: 'left', x: zone.x, y: zone.y + zone.height / 2 },
            { name: 'right', x: zone.x + zone.width, y: zone.y + zone.height / 2 },
            { name: 'bottom-left', x: zone.x, y: zone.y + zone.height },
            { name: 'bottom', x: zone.x + zone.width / 2, y: zone.y + zone.height },
            { name: 'bottom-right', x: zone.x + zone.width, y: zone.y + zone.height }
        ];
        
        for (const d of draggers) {
            if (Math.abs(worldX - d.x) < handleSize && Math.abs(worldY - d.y) < handleSize) {
                return d.name;
            }
        }
        
        return null;
    }

    startSpinnerAdjustmentMode() {
        if (!this.editingObject) return;
        
        this.spinnerAdjustment.active = true;
        this.spinnerAdjustment.spinner = this.editingObject;
        
        // Close the object edit popup
        const popup = document.getElementById('object-edit-popup');
        if (popup) popup.style.display = 'none';
        
        // Hide all UI except the stop button
        document.querySelectorAll('.toolbar, .panel, .add-menu, .placement-toolbar, .editor-btn-corner').forEach(el => {
            el.style.display = 'none';
        });
        
        // Create stop button
        let stopBtn = document.getElementById('spinner-adjust-stop');
        if (!stopBtn) {
            stopBtn = document.createElement('button');
            stopBtn.id = 'spinner-adjust-stop';
            stopBtn.className = 'btn btn-danger zone-adjust-stop spinner-adjust-stop';
            stopBtn.innerHTML = '<span class="material-symbols-outlined">close</span> Stop Adjusting';
            stopBtn.addEventListener('click', () => this.exitSpinnerAdjustmentMode());
            document.body.appendChild(stopBtn);
        }
        stopBtn.style.display = 'flex';
        
        // Enable fly mode for navigation
        this.isFlying = true;
    }

    exitSpinnerAdjustmentMode() {
        const spinner = this.spinnerAdjustment.spinner;
        
        this.spinnerAdjustment.active = false;
        this.spinnerAdjustment.spinner = null;
        this.spinnerAdjustment.draggerHeld = null;
        
        // Hide stop button
        const stopBtn = document.getElementById('spinner-adjust-stop');
        if (stopBtn) stopBtn.style.display = 'none';
        
        // Restore all UI
        document.querySelectorAll('.toolbar, .editor-btn-corner').forEach(el => {
            el.style.display = '';
        });
        
        this.updateLayersList();
        this.triggerMapChange();
        
        // Re-open the object edit popup
        if (spinner) {
            this.openObjectEditPopup(spinner);
        }
    }

    handleSpinnerDraggerMove(gridX, gridY) {
        const spinner = this.spinnerAdjustment.spinner;
        const dragger = this.spinnerAdjustment.draggerHeld;
        if (!spinner || !dragger) return;
        
        const minSize = GRID_SIZE;
        
        switch (dragger) {
            case 'top': {
                const newTop = gridY;
                const maxTop = spinner.y + spinner.height - minSize;
                if (newTop <= maxTop) {
                    const diff = spinner.y - newTop;
                    spinner.y = newTop;
                    spinner.height += diff;
                }
                break;
            }
            case 'bottom': {
                const newBottom = gridY + GRID_SIZE;
                const minBottom = spinner.y + minSize;
                if (newBottom >= minBottom) {
                    spinner.height = newBottom - spinner.y;
                }
                break;
            }
            case 'left': {
                const newLeft = gridX;
                const maxLeft = spinner.x + spinner.width - minSize;
                if (newLeft <= maxLeft) {
                    const diff = spinner.x - newLeft;
                    spinner.x = newLeft;
                    spinner.width += diff;
                }
                break;
            }
            case 'right': {
                const newRight = gridX + GRID_SIZE;
                const minRight = spinner.x + minSize;
                if (newRight >= minRight) {
                    spinner.width = newRight - spinner.x;
                }
                break;
            }
            case 'top-left': {
                const newT = gridY;
                const maxT = spinner.y + spinner.height - minSize;
                if (newT <= maxT) {
                    const diffY = spinner.y - newT;
                    spinner.y = newT;
                    spinner.height += diffY;
                }
                const newL = gridX;
                const maxL = spinner.x + spinner.width - minSize;
                if (newL <= maxL) {
                    const diffX = spinner.x - newL;
                    spinner.x = newL;
                    spinner.width += diffX;
                }
                break;
            }
            case 'top-right': {
                const newT = gridY;
                const maxT = spinner.y + spinner.height - minSize;
                if (newT <= maxT) {
                    const diffY = spinner.y - newT;
                    spinner.y = newT;
                    spinner.height += diffY;
                }
                const newR = gridX + GRID_SIZE;
                const minR = spinner.x + minSize;
                if (newR >= minR) {
                    spinner.width = newR - spinner.x;
                }
                break;
            }
            case 'bottom-left': {
                const newB = gridY + GRID_SIZE;
                const minB = spinner.y + minSize;
                if (newB >= minB) {
                    spinner.height = newB - spinner.y;
                }
                const newL = gridX;
                const maxL = spinner.x + spinner.width - minSize;
                if (newL <= maxL) {
                    const diffX = spinner.x - newL;
                    spinner.x = newL;
                    spinner.width += diffX;
                }
                break;
            }
            case 'bottom-right': {
                const newB = gridY + GRID_SIZE;
                const minB = spinner.y + minSize;
                if (newB >= minB) {
                    spinner.height = newB - spinner.y;
                }
                const newR = gridX + GRID_SIZE;
                const minR = spinner.x + minSize;
                if (newR >= minR) {
                    spinner.width = newR - spinner.x;
                }
                break;
            }
        }
    }

    getSpinnerDraggerAtPoint(worldX, worldY) {
        if (!this.spinnerAdjustment.active || !this.spinnerAdjustment.spinner) return null;
        
        const spinner = this.spinnerAdjustment.spinner;
        const handleSize = 12 / this.camera.zoom;
        
        const draggers = [
            { name: 'top-left', x: spinner.x, y: spinner.y },
            { name: 'top', x: spinner.x + spinner.width / 2, y: spinner.y },
            { name: 'top-right', x: spinner.x + spinner.width, y: spinner.y },
            { name: 'left', x: spinner.x, y: spinner.y + spinner.height / 2 },
            { name: 'right', x: spinner.x + spinner.width, y: spinner.y + spinner.height / 2 },
            { name: 'bottom-left', x: spinner.x, y: spinner.y + spinner.height },
            { name: 'bottom', x: spinner.x + spinner.width / 2, y: spinner.y + spinner.height },
            { name: 'bottom-right', x: spinner.x + spinner.width, y: spinner.y + spinner.height }
        ];
        
        for (const d of draggers) {
            if (Math.abs(worldX - d.x) < handleSize && Math.abs(worldY - d.y) < handleSize) {
                return d.name;
            }
        }
        
        return null;
    }

    renderSpinnerAdjustmentHandles(ctx, camera) {
        const spinner = this.spinnerAdjustment.spinner;
        const handleSize = 12 / camera.zoom;
        
        const screenX = spinner.x - camera.x;
        const screenY = spinner.y - camera.y;
        const screenW = spinner.width;
        const screenH = spinner.height;
        
        // Draw spinner highlight (orange to match spinner/saw blade theme)
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 3 / camera.zoom;
        ctx.setLineDash([]);
        ctx.strokeRect(screenX, screenY, screenW, screenH);
        
        // Dragger positions
        const draggers = [
            { x: screenX, y: screenY },
            { x: screenX + screenW / 2, y: screenY },
            { x: screenX + screenW, y: screenY },
            { x: screenX, y: screenY + screenH / 2 },
            { x: screenX + screenW, y: screenY + screenH / 2 },
            { x: screenX, y: screenY + screenH },
            { x: screenX + screenW / 2, y: screenY + screenH },
            { x: screenX + screenW, y: screenY + screenH }
        ];
        
        for (const d of draggers) {
            ctx.fillStyle = '#333';
            ctx.fillRect(d.x - handleSize / 2, d.y - handleSize / 2, handleSize, handleSize);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.strokeRect(d.x - handleSize / 2, d.y - handleSize / 2, handleSize, handleSize);
        }
    }

    createColorPicker() {
        const popup = document.createElement('div');
        popup.className = 'color-picker-popup';
        popup.id = 'color-picker-popup';
        popup.innerHTML = `
            <div class="color-picker-header">
                <span class="color-picker-title">Choose Color</span>
                <button class="btn btn-icon btn-ghost" id="close-color-picker">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="color-picker-gradient" id="color-picker-gradient">
                <div class="color-picker-cursor" id="color-picker-cursor"></div>
            </div>
            <input type="range" class="color-picker-hue" id="color-picker-hue" min="0" max="360" value="0">
            <div class="color-picker-preview">
                <div class="color-picker-preview-box" id="color-picker-preview-box"></div>
                <div class="hex-input-wrapper">
                    <span class="hex-prefix">#</span>
                    <input type="text" class="form-input hex-input" id="color-picker-hex" value="FF0000" maxlength="6">
                </div>
            </div>
        `;
        document.body.appendChild(popup);
        this.ui.colorPickerPopup = popup;
        
        this.colorPickerState = {
            hue: 0,
            saturation: 100,
            value: 100,
            target: null
        };
    }

    createFontDropdown() {
        // Will be populated when dropdown opens
    }

    attachEventListeners() {
        // Corner buttons - use explicit function calls with error handling
        this.ui.btnConfig.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePanel('config');
        });
        
        this.ui.btnSettings.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePanel('settings');
        });
        
        this.ui.btnAdd.addEventListener('click', (e) => {
            e.stopPropagation();
            // If in selection mode, exit it
            if (this.isSelectionActive) {
                this.exitSelectionMode();
                return;
            }
            // If in erase mode, stop it
            if (this.isErasing) {
                this.setTool(EditorTool.ERASE); // Toggle off
            }
            // If in placement mode, stop it
            else if (this.placementMode !== PlacementMode.NONE) {
                this.stopPlacement();
            } else {
                this.toggleAddMenu();
            }
        });
        
        this.ui.btnLayers.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePanel('layers');
        });
        
        this.ui.btnStopTest.addEventListener('click', (e) => {
            e.stopPropagation();
            this.stopTest();
        });

        // Close buttons
        document.getElementById('close-config').addEventListener('click', () => this.closePanel('config'));
        document.getElementById('close-layers').addEventListener('click', () => this.closePanel('layers'));
        document.getElementById('add-layer-behind').addEventListener('click', () => this.promptAddDrawLayer('behind'));
        document.getElementById('add-layer-above').addEventListener('click', () => this.promptAddDrawLayer('above'));
        document.getElementById('close-settings-panel').addEventListener('click', () => this.closePanel('settings'));
        document.getElementById('close-color-picker').addEventListener('click', () => this.closeColorPicker());

        // Toolbar buttons
        this.ui.toolbar.querySelectorAll('.toolbar-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => this.setTool(btn.dataset.tool));
        });
        
        this.ui.toolbar.querySelectorAll('.toolbar-btn[data-action]').forEach(btn => {
            btn.addEventListener('click', () => this.handleToolbarAction(btn.dataset.action));
        });

        // Add menu buttons
        this.ui.addMenu.querySelectorAll('.add-menu-btn').forEach(btn => {
            btn.addEventListener('click', () => this.startPlacement(btn.dataset.add));
        });

        // Placement toolbar
        this.attachPlacementListeners();
        
        // Erase toolbar
        this.attachEraseListeners();

        // Config panel
        this.attachConfigListeners();

        // Color picker
        this.attachColorPickerListeners();

        // Settings
        this.attachSettingsListeners();

        // Font dropdown
        this.attachFontDropdownListeners();
        
        // Texture dropdown
        this.attachTextureDropdownListeners();
    }

    attachPlacementListeners() {
        // Appearance type
        document.querySelectorAll('[data-appearance]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-appearance]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.placementSettings.appearanceType = btn.dataset.appearance;
                
                // Sync acting type with appearance type (spike looks like spike AND acts like spike)
                this.placementSettings.actingType = btn.dataset.appearance;
                this.syncActingTypeUI(btn.dataset.appearance);
                
                this.updateDefaultColor();
            });
        });

        // Acting type
        document.querySelectorAll('[data-acting]').forEach(btn => {
            btn.addEventListener('click', () => {
                const container = btn.closest('.placement-option-btns');
                container.querySelectorAll('.placement-opt-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (this.placementMode === PlacementMode.BLOCK) {
                    this.placementSettings.actingType = btn.dataset.acting;
                } else if (this.placementMode === PlacementMode.OBSTACLE) {
                    this.obstacleSettings.actingType = btn.dataset.acting;
                } else if (this.placementMode === PlacementMode.KOREEN) {
                    this.koreenSettings.actingType = btn.dataset.acting;
                } else if (this.placementMode === PlacementMode.TEXT) {
                    this.textSettings.actingType = btn.dataset.acting;
                } else if (this.placementMode === PlacementMode.TELEPORTAL) {
                    this.teleportalSettings.actingType = btn.dataset.acting;
                }
            });
        });

        // Collision
        document.querySelectorAll('[data-collision]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-collision]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const collision = btn.dataset.collision === 'true';
                if (this.placementMode === PlacementMode.OBSTACLE) {
                    this.obstacleSettings.collision = collision;
                } else {
                    this.placementSettings.collision = collision;
                }
            });
        });

        document.getElementById('placement-tilemap-layer-select')?.addEventListener('change', (e) => {
            const depth = Number(e.target.value);
            const layer = this.world.getLayerDefinition(depth);
            if (!Number.isSafeInteger(depth) || !layer) return;
            if (this.tilemapCellBehavior !== 'decorative' && (layer.parallaxX !== 1 || layer.parallaxY !== 1)) {
                this.showToast('Collidable tilemap cells need a layer with parallax set to 1.', 'error');
                e.target.value = String(this.tilemapLayer);
                return;
            }
            this.tilemapLayer = depth;
            this.tilemapAtlasFrame = 0;
            document.getElementById('placement-tilemap-atlas-frame').value = '0';
            this.updateTilemapAtlasStatus();
        });
        document.getElementById('placement-tilemap-atlas-file')?.addEventListener('change', e => {
            const file = e.target.files?.[0];
            if (file) this.loadTilemapAtlas(file);
            e.target.value = '';
        });
        document.getElementById('placement-tilemap-atlas-clear')?.addEventListener('click', () => {
            if (!this.world.clearTilemapAtlas(this.tilemapLayer)) return;
            this.updateTilemapAtlasStatus();
            this.triggerMapChange();
        });
        document.getElementById('placement-tilemap-atlas-frame')?.addEventListener('change', e => {
            const atlas = this.world.tilemaps.find(tilemap => tilemap.layer === this.tilemapLayer)?.atlas;
            const maxFrame = atlas ? atlas.columns * atlas.rows - 1 : 0;
            this.tilemapAtlasFrame = Math.max(0, Math.min(maxFrame, Math.floor(Number(e.target.value) || 0)));
            e.target.value = String(this.tilemapAtlasFrame);
            this.updateTilemapAtlasStatus();
        });
        document.getElementById('placement-tilemap-behavior-select')?.addEventListener('change', (e) => {
            if (['solid', 'oneWay', 'rampUpRight', 'rampUpLeft', 'hazard', 'decorative'].includes(e.target.value)) {
                const layer = this.world.getLayerDefinition(this.tilemapLayer);
                if (e.target.value !== 'decorative' && layer && (layer.parallaxX !== 1 || layer.parallaxY !== 1)) {
                    this.showToast('Collidable tilemap cells need a layer with parallax set to 1.', 'error');
                    e.target.value = 'decorative';
                    this.tilemapCellBehavior = 'decorative';
                    return;
                }
                this.tilemapCellBehavior = e.target.value;
                const supportsPolygon = ['solid', 'oneWay'].includes(this.tilemapCellBehavior);
                const shapeSelect = document.getElementById('placement-tilemap-collision-shape-select');
                if (shapeSelect) {
                    shapeSelect.disabled = !supportsPolygon;
                    if (!supportsPolygon) {
                        this.tilemapCollisionShape = 'box';
                        shapeSelect.value = 'box';
                        document.getElementById('placement-tilemap-polygon-settings').style.display = 'none';
                    }
                }
                const oneWayToggle = document.getElementById('placement-tilemap-polygon-one-way');
                if (oneWayToggle) {
                    oneWayToggle.disabled = this.tilemapCellBehavior === 'oneWay';
                    if (oneWayToggle.disabled) {
                        this.tilemapPolygonOneWay = true;
                        oneWayToggle.checked = true;
                    }
                }
            }
        });
        document.getElementById('placement-tilemap-collision-shape-select')?.addEventListener('change', (e) => {
            this.tilemapCollisionShape = e.target.value === 'polygon' ? 'polygon' : 'box';
            document.getElementById('placement-tilemap-polygon-settings')?.style.setProperty(
                'display', this.tilemapCollisionShape === 'polygon' ? 'flex' : 'none'
            );
        });
        document.getElementById('placement-tilemap-polygon-one-way')?.addEventListener('change', (e) => {
            this.tilemapPolygonOneWay = e.target.checked;
        });
        document.getElementById('placement-tilemap-collision-points')?.addEventListener('change', (e) => {
            let parsed;
            try { parsed = JSON.parse(e.target.value); } catch {
                document.getElementById('placement-tilemap-collision-points-status').textContent = 'Invalid JSON; the previous polygon is kept.';
                return;
            }
            const normalized = WorldObject.normalizeCollisionPolygon(parsed);
            if (!normalized) {
                document.getElementById('placement-tilemap-collision-points-status').textContent = 'Use 3–12 ordered convex vertices with coordinates from 0 to 1.';
                return;
            }
            this.tilemapCollisionPoints = normalized;
            e.target.value = JSON.stringify(normalized);
            document.getElementById('placement-tilemap-collision-points-status').textContent = `${normalized.length} valid convex vertices`;
        });
        document.getElementById('placement-tilemap-animation-select')?.addEventListener('change', e => {
            this.tilemapAnimation = ['textureCycle', 'atlasCycle'].includes(e.target.value) ? e.target.value : 'none';
            document.getElementById('placement-tilemap-animation-settings')?.classList.toggle('hidden', this.tilemapAnimation === 'none');
            this.updateTilemapAnimationFrameControls();
        });
        document.getElementById('placement-tilemap-frame-count')?.addEventListener('change', e => {
            this.tilemapAnimationFrameCount = Math.max(2, Math.min(8, Number(e.target.value) || 2));
            this.updateTilemapAnimationFrameControls();
        });
        document.getElementById('placement-tilemap-frame-selectors')?.addEventListener('change', e => {
            const index = Number(e.target.dataset.frameIndex);
            if (!Number.isInteger(index) || index < 0 || index >= 8) return;
            if (this.tilemapAnimation === 'atlasCycle') {
                const atlas = this.world.tilemaps.find(tilemap => tilemap.layer === this.tilemapLayer)?.atlas;
                const maxFrame = atlas ? atlas.columns * atlas.rows - 1 : 0;
                this.tilemapAtlasAnimationFrames[index] = Math.max(0, Math.min(maxFrame, Math.floor(Number(e.target.value) || 0)));
                e.target.value = String(this.tilemapAtlasAnimationFrames[index]);
            } else {
                this.tilemapAnimationFrames[index] = e.target.value;
            }
        });
        document.getElementById('placement-tilemap-animation-fps')?.addEventListener('change', e => {
            this.tilemapAnimationFps = Math.max(1, Math.min(12, Math.round(Number(e.target.value) || 4)));
            e.target.value = String(this.tilemapAnimationFps);
        });

        // Fill mode
        document.querySelectorAll('[data-fill]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-fill]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const fillMode = btn.dataset.fill;
                if (this.placementMode === PlacementMode.BLOCK) {
                    this.placementSettings.fillMode = fillMode;
                } else if (this.placementMode === PlacementMode.OBSTACLE) {
                    this.obstacleSettings.fillMode = fillMode;
                } else if (this.placementMode === PlacementMode.KOREEN) {
                    this.koreenSettings.fillMode = fillMode;
                } else if (this.placementMode === PlacementMode.SPAWN_END) {
                    this.spawnEndSettings.fillMode = fillMode;
                } else if (this.placementMode === PlacementMode.TEXT) {
                    this.textSettings.fillMode = fillMode;
                } else if (this.placementMode === PlacementMode.TELEPORTAL) {
                    this.teleportalSettings.fillMode = fillMode;
                } else if (this.placementMode === PlacementMode.BUTTON) {
                    this.buttonSettings.fillMode = fillMode;
                }
            });
        });

        document.querySelectorAll('[data-coin-snap]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-coin-snap]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.koreenSettings.coinSnapToGrid = btn.dataset.coinSnap === 'true';
            });
        });

        // Color preview click
        document.getElementById('placement-color-preview').addEventListener('click', () => {
            this.openColorPicker('placement');
        });

        // Color input
        document.getElementById('placement-color-input').addEventListener('change', (e) => {
            const color = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
                if (this.placementMode === PlacementMode.TEXT) {
                    this.textSettings.color = color;
                } else if (this.placementMode === PlacementMode.TELEPORTAL) {
                    this.teleportalSettings.color = color;
                } else if (this.placementMode === PlacementMode.OBSTACLE) {
                    this.obstacleSettings.color = color;
                } else if (this.placementMode === PlacementMode.KOREEN) {
                    this.koreenSettings.color = color;
                } else if (this.placementMode === PlacementMode.SPAWN_END) {
                    this.spawnEndSettings.color = color;
                } else {
                this.placementSettings.color = color;
                    // Update texture preview with new background color
                    this.updateTexturePreview();
                }
                document.getElementById('placement-color-preview').style.background = color;
            }
        });

        // Opacity
        document.getElementById('placement-opacity-input').addEventListener('change', (e) => {
            const _raw = parseInt(e.target.value);
            const opacity = Math.max(0, Math.min(100, isNaN(_raw) ? 100 : _raw));
            e.target.value = opacity;
            if (this.placementMode === PlacementMode.BLOCK || this.placementMode === PlacementMode.TILEMAP) {
                this.placementSettings.opacity = opacity / 100;
            } else if (this.placementMode === PlacementMode.OBSTACLE) {
                this.obstacleSettings.opacity = opacity / 100;
            } else if (this.placementMode === PlacementMode.KOREEN) {
                this.koreenSettings.opacity = opacity / 100;
            } else if (this.placementMode === PlacementMode.SPAWN_END) {
                this.spawnEndSettings.opacity = opacity / 100;
            } else if (this.placementMode === PlacementMode.TEXT) {
                this.textSettings.opacity = opacity / 100;
            } else if (this.placementMode === PlacementMode.TELEPORTAL) {
                this.teleportalSettings.opacity = opacity / 100;
            }
        });

        // Text content
        document.getElementById('placement-content-input').addEventListener('input', (e) => {
            this.textSettings.content = e.target.value;
            this.updatePlacementFontPreview();
        });
        
        // Font size
        document.getElementById('placement-fontsize-input').addEventListener('change', (e) => {
            const size = Math.max(8, Math.min(200, parseInt(e.target.value) || 24));
            e.target.value = size;
            this.textSettings.fontSize = size;
            this.updatePlacementFontPreview();
        });

        // Horizontal align
        document.querySelectorAll('[data-halign]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-halign]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.textSettings.hAlign = btn.dataset.halign;
            });
        });

        // Vertical align
        document.querySelectorAll('[data-valign]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-valign]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.textSettings.vAlign = btn.dataset.valign;
            });
        });

        // Spacing
        document.getElementById('placement-hspacing-input').addEventListener('change', (e) => {
            this.textSettings.hSpacing = parseInt(e.target.value) || 0;
        });
        
        document.getElementById('placement-vspacing-input').addEventListener('change', (e) => {
            this.textSettings.vSpacing = parseInt(e.target.value) || 0;
        });
    }
    
    attachEraseListeners() {
        // Erase type
        document.querySelectorAll('[data-erase-type]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-erase-type]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.eraseSettings.eraseType = btn.dataset.eraseType;
            });
        });
        
        // Eraser size
        const widthInput = document.getElementById('erase-width');
        const heightInput = document.getElementById('erase-height');
        
        if (widthInput) {
            widthInput.addEventListener('change', (e) => {
                this.eraseSettings.width = Math.max(1, Math.min(20, parseInt(e.target.value) || 1));
                e.target.value = this.eraseSettings.width;
            });
        }
        
        if (heightInput) {
            heightInput.addEventListener('change', (e) => {
                this.eraseSettings.height = Math.max(1, Math.min(20, parseInt(e.target.value) || 1));
                e.target.value = this.eraseSettings.height;
            });
        }
    }

    attachConfigListeners() {
        // Map Name
        document.getElementById('config-map-name').addEventListener('change', (e) => {
            this.world.mapName = e.target.value.trim() || 'Untitled Map';
            this.triggerMapChange();
        });

        // Background
        document.getElementById('config-background').addEventListener('change', (e) => {
            this.world.background = e.target.value;

            // Show/hide custom background options
            const customOptions = document.getElementById('custom-bg-options');
            if (e.target.value === 'custom') {
                customOptions.classList.remove('hidden');
            } else {
                customOptions.classList.add('hidden');
                // Disable custom background when switching away
                this.world.customBackground.enabled = false;
            }

            this.updateBackground();
            this.triggerMapChange();
        });
        
        // Cloud colors
        ['sky', 'galaxy'].forEach(type => {
            const preview = document.getElementById(`config-cloud-${type}-preview`);
            const input = document.getElementById(`config-cloud-${type}`);
            
            if (preview && input) {
                preview.addEventListener('click', () => {
                    this.openColorPicker(`config-cloud-${type}`);
                });
                
                input.addEventListener('change', (e) => {
                    const color = e.target.value;
                    if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
                        preview.style.background = color;
                        if (type === 'sky') this.world.cloudColorSky = color;
                        else if (type === 'galaxy') this.world.cloudColorGalaxy = color;
                        this.triggerMapChange();
                    }
                });
            }
        });
        
        // Custom background file upload
        this.setupCustomBackgroundListeners();

        // Default colors
        ['block', 'spike', 'text', 'portal', 'bouncer'].forEach(type => {
            const preview = document.getElementById(`config-${type}-color-preview`);
            const input = document.getElementById(`config-${type}-color`);
            
            preview.addEventListener('click', () => {
                this.openColorPicker(`config-${type}`);
            });
            
            input.addEventListener('change', (e) => {
                const color = e.target.value;
                if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
                    preview.style.background = color;
                    if (type === 'block') this.world.defaultBlockColor = color;
                    else if (type === 'spike') this.world.defaultSpikeColor = color;
                    else if (type === 'text') this.world.defaultTextColor = color;
                    else if (type === 'portal') this.world.defaultPortalColor = color;
                    else if (type === 'bouncer') this.world.defaultBouncerColor = color;
                    this.triggerMapChange();
                }
            });
        });
        
        // Checkpoint colors
        ['default', 'active', 'touched'].forEach(type => {
            const preview = document.getElementById(`config-checkpoint-${type}-preview`);
            const input = document.getElementById(`config-checkpoint-${type}`);
            
            if (preview && input) {
                preview.addEventListener('click', () => {
                    this.openColorPicker(`config-checkpoint-${type}`);
                });
                
                input.addEventListener('change', (e) => {
                    const color = e.target.value;
                    if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
                        preview.style.background = color;
                        if (type === 'default') this.world.checkpointDefaultColor = color;
                        else if (type === 'active') this.world.checkpointActiveColor = color;
                        else if (type === 'touched') this.world.checkpointTouchedColor = color;
                        this.triggerMapChange();
                    }
                });
            }
        });

        const persistCheckpoints = document.getElementById('config-persist-checkpoints');
        if (persistCheckpoints) {
            persistCheckpoints.addEventListener('change', (event) => {
                this.world.persistCheckpoints = event.target.checked;
                this.triggerMapChange();
            });
        }

        // Jumps
        document.getElementById('config-jumps').addEventListener('change', (e) => {
            const isInfinite = e.target.value === 'infinite';
            this.world.infiniteJumps = isInfinite;
            document.getElementById('config-jumps-number-group').classList.toggle('hidden', isInfinite);
            document.getElementById('config-airjump-group').classList.toggle('hidden', isInfinite);
            this.triggerMapChange();
        });

        document.getElementById('config-jumps-number').addEventListener('change', (e) => {
            this.world.maxJumps = Math.max(0, parseInt(e.target.value) || 1);
            this.triggerMapChange();
        });

        document.getElementById('config-airjump').addEventListener('change', (e) => {
            this.world.additionalAirjump = e.target.checked;
            this.triggerMapChange();
        });

        document.getElementById('config-collide').addEventListener('change', (e) => {
            this.world.collideWithEachOther = e.target.checked;
            this.triggerMapChange();
        });

        document.getElementById('config-player-sprite-file').addEventListener('change', (e) => {
            this.loadPlayerSpriteSheet(e.target.files?.[0]);
        });
        document.getElementById('config-player-sprite-clear').addEventListener('click', () => {
            this._playerSpriteSheetSettingsRequest = (this._playerSpriteSheetSettingsRequest || 0) + 1;
            this._playerSpriteSheetValidationError = '';
            this._playerSpriteSheetEditorValidationTarget = null;
            this.world.playerSpriteSheet = null;
            document.getElementById('config-player-sprite-file').value = '';
            this.updatePlayerSpriteSheetStatus();
            this.triggerMapChange();
        });
        for (const state of ['attack', 'hurt', 'dash']) {
            const enabled = document.getElementById(`config-player-sprite-${state}-enabled`);
            enabled.addEventListener('change', () => {
                document.getElementById(`config-player-sprite-${state}-row`)?.classList.toggle('hidden', !enabled.checked);
                this.applyPlayerSpriteSheetSettings();
            });
        }
        for (const id of ['config-player-sprite-frame-width', 'config-player-sprite-frame-height',
            ...['idle', 'run', 'jump', 'fall'].flatMap(state => [
                `config-player-sprite-${state}-row`,
                `config-player-sprite-${state}-frames`,
                `config-player-sprite-${state}-fps`
            ]), ...['attack', 'hurt', 'dash'].flatMap(state => [
                `config-player-sprite-${state}-row-index`,
                `config-player-sprite-${state}-frames`,
                `config-player-sprite-${state}-fps`
            ])]) {
            document.getElementById(id).addEventListener('change', () => this.applyPlayerSpriteSheetSettings());
        }

        document.getElementById('config-show-coin-counter').addEventListener('change', (e) => {
            this.world.showCoinCounter = e.target.checked;
            this.triggerMapChange();
        });

        // Die line Y
        document.getElementById('config-die-line-y').addEventListener('change', (e) => {
            this.world.dieLineY = parseInt(e.target.value) || 2000;
            this.triggerMapChange();
        });

        // Physics settings
        document.getElementById('config-player-speed').addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            this.world.playerSpeed = (value > 0) ? value : 5;
            e.target.value = this.world.playerSpeed;
            this.triggerMapChange();
        });

        document.getElementById('config-jump-force').addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            this.world.jumpForce = (value < 0) ? value : -14;
            e.target.value = this.world.jumpForce;
            this.triggerMapChange();
        });

        document.getElementById('config-gravity').addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            this.world.gravity = (value > 0) ? value : 0.71;
            e.target.value = this.world.gravity;
            if (this.world.terminalFallSpeed === null) {
                const fallSpeed = document.getElementById('config-terminal-fall-speed');
                if (fallSpeed) fallSpeed.value = (16 * this.world.gravity / 0.71).toFixed(1);
            }
            this.triggerMapChange();
        });

        document.getElementById('config-horizontal-acceleration').addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            this.world.horizontalAcceleration = Number.isFinite(value) && value >= 0 && value <= 20 ? value : 0;
            e.target.value = this.world.horizontalAcceleration;
            this.triggerMapChange();
        });

        document.getElementById('config-air-control').addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            this.world.airControl = Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
            e.target.value = this.world.airControl;
            this.triggerMapChange();
        });

        document.getElementById('config-terminal-fall-speed').addEventListener('change', (e) => {
            const value = parseFloat(e.target.value);
            this.world.terminalFallSpeed = Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
            e.target.value = this.world.terminalFallSpeed ?? (16 * this.world.gravity / 0.71).toFixed(1);
            this.triggerMapChange();
        });

        document.getElementById('config-camera-lerp-x').addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            this.world.cameraLerpX = (value > 0 && value <= 1) ? value : 0.12;
            document.getElementById('config-camera-lerp-x-value').textContent = this.world.cameraLerpX.toFixed(2);
            this.triggerMapChange();
        });

        document.getElementById('config-camera-lerp-y').addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            this.world.cameraLerpY = (value > 0 && value <= 1) ? value : 0.12;
            document.getElementById('config-camera-lerp-y-value').textContent = this.world.cameraLerpY.toFixed(2);
            this.triggerMapChange();
        });

        document.getElementById('config-camera-follow-mode').addEventListener('change', (e) => {
            this.world.cameraFollowMode = ['both', 'horizontal', 'vertical'].includes(e.target.value)
                ? e.target.value : 'both';
            this.triggerMapChange();
        });

        const cameraBoundsEnabled = document.getElementById('config-camera-bounds-enabled');
        const cameraBoundsFields = document.getElementById('config-camera-bounds-fields');
        const cameraBoundsInputs = ['x', 'y', 'width', 'height'].map(key =>
            document.getElementById(`config-camera-bounds-${key}`)
        );
        const setCameraBoundsInputsEnabled = (enabled) => {
            cameraBoundsFields.style.display = enabled ? 'grid' : 'none';
            cameraBoundsInputs.forEach(input => { input.disabled = !enabled; });
        };
        cameraBoundsEnabled.addEventListener('change', (e) => {
            this.world.cameraBounds.enabled = e.target.checked;
            setCameraBoundsInputsEnabled(e.target.checked);
            this.triggerMapChange();
        });
        cameraBoundsInputs.forEach(input => input.addEventListener('change', () => {
            const [x, y, width, height] = cameraBoundsInputs.map(field => Number(field.value));
            if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
                !Number.isFinite(x + width) || !Number.isFinite(y + height)) {
                const bounds = this.world.cameraBounds;
                cameraBoundsInputs.forEach((field, index) => {
                    field.value = [bounds.x, bounds.y, bounds.width, bounds.height][index];
                });
                return;
            }
            this.world.cameraBounds = { ...this.world.cameraBounds, x, y, width, height };
            this.triggerMapChange();
        }));

        // Spike touchbox mode
        document.getElementById('config-spike-touchbox').addEventListener('change', (e) => {
            this.world.spikeTouchbox = e.target.value;
            this.updateSpikeTouchboxDescription(e.target.value);
            this.triggerMapChange();
        });
        
        // Drop Hurt Only toggle
        document.getElementById('config-drop-hurt-only').addEventListener('change', (e) => {
            this.world.dropHurtOnly = e.target.checked;
            this.triggerMapChange();
        });
        
        // Stored data type
        document.getElementById('config-stored-data-type').addEventListener('change', (e) => {
            this.world.storedDataType = e.target.value;
            this.updateStoredDataTypeDescription(e.target.value);
            this.triggerMapChange();
        });
        
        // Music settings
        const musicSelect = document.getElementById('config-music');
        const customMusicOptions = document.getElementById('custom-music-options');
        const customMusicDropzone = document.getElementById('custom-music-dropzone');
        const customMusicFile = document.getElementById('custom-music-file');
        const customMusicPreview = document.getElementById('custom-music-preview');
        const customMusicName = document.getElementById('custom-music-name');
        const customMusicPlay = document.getElementById('custom-music-play');
        const customMusicRemove = document.getElementById('custom-music-remove');
        const musicVolume = document.getElementById('config-music-volume');
        const musicVolumeLabel = document.getElementById('config-music-volume-label');
        const musicLoop = document.getElementById('config-music-loop');
        
        // Audio element for preview
        this.previewAudio = new Audio();
        
        musicSelect.addEventListener('change', (e) => {
            this.world.music.type = e.target.value;
            if (e.target.value === 'custom') {
                customMusicOptions.classList.remove('hidden');
            } else {
                customMusicOptions.classList.add('hidden');
            }
            this.triggerMapChange();
            this.updateMusicPlayback();
        });
        
        // Custom music dropzone
        customMusicDropzone.addEventListener('click', () => {
            customMusicFile.click();
        });
        
        customMusicDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            customMusicDropzone.style.borderColor = 'var(--primary)';
            customMusicDropzone.style.background = 'rgba(99, 102, 241, 0.1)';
        });
        
        customMusicDropzone.addEventListener('dragleave', () => {
            customMusicDropzone.style.borderColor = 'var(--surface-light)';
            customMusicDropzone.style.background = '';
        });
        
        customMusicDropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            customMusicDropzone.style.borderColor = 'var(--surface-light)';
            customMusicDropzone.style.background = '';
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('audio/')) {
                this.handleMusicUpload(file);
            }
        });
        
        customMusicFile.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.handleMusicUpload(file);
            }
        });
        
        customMusicPlay.addEventListener('click', () => {
            if (this.previewAudio.paused) {
                this.previewAudio.play();
                customMusicPlay.querySelector('.material-symbols-outlined').textContent = 'pause';
            } else {
                this.previewAudio.pause();
                customMusicPlay.querySelector('.material-symbols-outlined').textContent = 'play_arrow';
            }
        });
        
        customMusicRemove.addEventListener('click', () => {
            this.world.music.customData = null;
            this.world.music.customName = null;
            this.previewAudio.pause();
            this.previewAudio.src = '';
            customMusicPreview.classList.add('hidden');
            customMusicDropzone.classList.remove('hidden');
            customMusicPlay.querySelector('.material-symbols-outlined').textContent = 'play_arrow';
            this.triggerMapChange();
            this.updateMusicPlayback();
        });
        
        musicVolume.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            this.world.music.volume = value;
            musicVolumeLabel.textContent = value + '%';
            this.previewAudio.volume = value / 100;
            this.triggerMapChange();
            this.updateMusicPlayback();
        });
        
        musicLoop.addEventListener('change', (e) => {
            this.world.music.loop = e.target.checked;
            this.triggerMapChange();
            this.updateMusicPlayback();
        });

        // Test game
        document.getElementById('btn-test-game').addEventListener('click', () => this.startTest());

        // Export/Import
        document.getElementById('btn-export').addEventListener('click', () => this.exportMap());
        document.getElementById('btn-import').addEventListener('click', () => {
            document.getElementById('import-file').click();
        });
        document.getElementById('import-file').addEventListener('change', (e) => this.importMap(e));

        // Password
        document.getElementById('config-use-password').addEventListener('change', (e) => {
            const isPrivate = document.getElementById('config-room-visibility')?.value !== 'public';
            document.getElementById('config-password-group').classList.toggle('hidden', !e.target.checked || !isPrivate);
            if (e.target.checked && !document.getElementById('config-password').value) {
                this.generatePassword();
            }
        });
        document.getElementById('config-room-visibility')?.addEventListener('change', (e) => {
            const wantsPassword = document.getElementById('config-use-password').checked;
            document.getElementById('config-password-group').classList.toggle('hidden', !wantsPassword || e.target.value === 'public');
        });

        document.getElementById('btn-regenerate-password').addEventListener('click', () => this.generatePassword());

        // Host game
        document.getElementById('btn-host-game').addEventListener('click', () => this.hostGame());
        
        // Plugins button
        document.getElementById('btn-plugins').addEventListener('click', () => this.openPluginsPopup());
        document.getElementById('close-plugins-popup').addEventListener('click', () => this.closePluginsPopup());
        document.getElementById('plugins-popup').addEventListener('click', (e) => {
            if (e.target.id === 'plugins-popup') this.closePluginsPopup();
        });
        
        // Plugin toggle buttons
        document.getElementById('plugins-popup').addEventListener('click', (e) => {
            const button = e.target.closest('.plugin-toggle-btn');
            if (!button || !button.dataset.plugin) return;
            this.togglePlugin(button.dataset.plugin);
        });
        document.getElementById('plugins-popup').addEventListener('change', (e) => {
            const input = e.target.closest('.custom-plugin-config');
            if (!input) return;
            const plugin = window.PluginManager?.plugins?.get(input.dataset.plugin);
            const field = plugin?.config?.[input.dataset.configKey];
            if (!plugin || !field) return;

            window.PluginManager.ensureWorldPluginConfig(plugin.id, plugin, this.world);
            let value;
            if (field.type === 'boolean') {
                value = input.checked;
            } else if (field.type === 'number') {
                value = input.value.trim() === '' ? field.default : Number(input.value);
                if (!Number.isFinite(value)) value = field.default;
                if (field.min !== undefined) value = Math.max(field.min, value);
                if (field.max !== undefined) value = Math.min(field.max, value);
                input.value = String(value);
            } else if (field.type === 'select') {
                value = field.options[Number(input.value)]?.value;
                if (value === undefined) value = field.default;
            } else {
                value = input.value.slice(0, 512);
                input.value = value;
            }
            this.world.plugins[plugin.id][input.dataset.configKey] = value;
            this.updateAdditionalPluginConfigVisibility(plugin.id);
            this.triggerMapChange();
        });
        
        // HP settings
        document.getElementById('config-hp-default')?.addEventListener('change', (e) => {
            if (!this.world.plugins.hp) this.world.plugins.hp = { defaultHP: 3 };
            this.world.plugins.hp.defaultHP = Math.max(1, Math.min(99, parseInt(e.target.value) || 3));
            e.target.value = this.world.plugins.hp.defaultHP;
            this.triggerMapChange();
        });
        
        // Hollow Knight settings
        document.getElementById('config-hk-gravity')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            const value = parseFloat(e.target.value) || 1.14;
            this.world.plugins.hk.defaultGravity = Math.max(0.1, Math.min(3, value));
            // Also apply to world gravity
            this.world.gravity = this.world.plugins.hk.defaultGravity;
            e.target.value = this.world.plugins.hk.defaultGravity;
            // Update the physics gravity input too
            const gravityInput = document.getElementById('config-gravity');
            if (gravityInput) gravityInput.value = this.world.gravity;
            this.triggerMapChange();
        });
        

        
        document.getElementById('config-hk-maxsoul')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            this.world.plugins.hk.maxSoul = Math.max(33, Math.min(198, parseInt(e.target.value) || 99));
            e.target.value = this.world.plugins.hk.maxSoul;
            this.triggerMapChange();
        });

        document.getElementById('config-hk-pogo-bounce-power')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            const value = Number.parseFloat(e.target.value);
            this.world.plugins.hk.pogoBouncePower = Math.max(0.5, Math.min(2, Number.isFinite(value) ? value : 1.2));
            e.target.value = this.world.plugins.hk.pogoBouncePower;
            this.triggerMapChange();
        });

        document.getElementById('config-hk-nail-speed')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            this.world.plugins.hk.nailSpeed = e.target.value === 'quickSlash' ? 'quickSlash' : 'base';
            e.target.value = this.world.plugins.hk.nailSpeed;
            this.triggerMapChange();
        });
        
        document.getElementById('config-hk-monarchwing')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            this.world.plugins.hk.monarchWing = e.target.checked;
            document.getElementById('config-hk-monarchwing-amount-group').classList.toggle('hidden', !e.target.checked);
            this.triggerMapChange();
        });
        
        document.getElementById('config-hk-monarchwing-amount')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            this.world.plugins.hk.monarchWingAmount = Math.max(1, Math.min(99, parseInt(e.target.value) || 1));
            e.target.value = this.world.plugins.hk.monarchWingAmount;
            this.triggerMapChange();
        });
        
        document.getElementById('config-hk-dash')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            this.world.plugins.hk.dash = e.target.checked;
            this.refreshTouchControls();
            this.triggerMapChange();
        });
        
        document.getElementById('config-hk-superdash')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            this.world.plugins.hk.superDash = e.target.checked;
            this.triggerMapChange();
        });
        
        document.getElementById('config-hk-mantisclaw')?.addEventListener('change', (e) => {
            this.ensureHKConfig();
            this.world.plugins.hk.mantisClaw = e.target.checked;
            this.triggerMapChange();
        });

        const hkEffectToggles = [
            ['config-hk-slash-effects', 'slashEffects'],
            ['config-hk-impact-effects', 'impactEffects'],
            ['config-hk-camera-shake-effects', 'cameraShakeEffects'],
            ['config-hk-dash-trail-effects', 'dashTrailEffects'],
            ['config-hk-ability-aura-effects', 'abilityAuraEffects']
        ];
        hkEffectToggles.forEach(([elementId, configKey]) => {
            document.getElementById(elementId)?.addEventListener('change', (e) => {
                this.ensureHKConfig();
                this.world.plugins.hk[configKey] = e.target.checked;
                if (configKey === 'cameraShakeEffects') {
                    document.getElementById('config-hk-camera-shake-settings')?.classList.toggle('hidden', !e.target.checked);
                }
                this.triggerMapChange();
            });
        });
        const hkShakeIntensities = [
            ['config-hk-impact-shake-intensity', 'impactShakeIntensity', 0, 18, 7],
            ['config-hk-landing-shake-intensity', 'landingShakeIntensity', 0, 8, 2]
        ];
        hkShakeIntensities.forEach(([elementId, configKey, min, max, fallback]) => {
            document.getElementById(elementId)?.addEventListener('change', (e) => {
                this.ensureHKConfig();
                const value = Number.parseFloat(e.target.value);
                this.world.plugins.hk[configKey] = Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
                e.target.value = this.world.plugins.hk[configKey];
                this.triggerMapChange();
            });
        });
        const hkEffectColors = [
            ['config-hk-nail-effect-color', 'nailEffectColor'],
            ['config-hk-dash-effect-color', 'dashEffectColor'],
            ['config-hk-charge-effect-color', 'chargeEffectColor'],
            ['config-hk-heal-effect-color', 'healEffectColor']
        ];
        hkEffectColors.forEach(([elementId, configKey]) => {
            document.getElementById(elementId)?.addEventListener('input', (e) => {
                if (!/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) return;
                this.ensureHKConfig();
                this.world.plugins.hk[configKey] = e.target.value;
                this.triggerMapChange();
            });
        });

        // Edit Mechanics button (always available)
        document.getElementById('btn-edit-mechanics')?.addEventListener('click', () => {
            if (typeof CodeEditor !== 'undefined' && CodeEditor.open) {
                CodeEditor.open();
            } else {
                console.warn('Mechanics Editor not available');
            }
        });
    }

    ensureCodeConfig() {
        // Ensure Code config object exists with defaults
        if (!this.world.plugins.code) {
            this.world.plugins.code = {
                autoRespawn: true
            };
        }
    }
    
    renderAdditionalPluginCards() {
        const container = document.getElementById('plugins-dynamic-cards');
        if (!container) return;
        const builtInCards = new Set(['hp', 'hk', 'cj', 'code']);
        const registeredPluginIds = new Set(window.PluginManager?.plugins?.keys?.() || []);
        const requestedPluginIds = Array.isArray(this.world.plugins?.enabled) ? this.world.plugins.enabled : [];
        const missingPluginIds = requestedPluginIds.filter(id => typeof id === 'string' && id && !registeredPluginIds.has(id));
        const failedPluginIds = requestedPluginIds.filter(id => typeof id === 'string' && id && registeredPluginIds.has(id) &&
            !window.PluginManager.isEnabled?.(id));
        const plugins = Array.from(window.PluginManager?.plugins?.values?.() || [])
            .filter(plugin => !builtInCards.has(plugin.id) && plugin.hideInPluginLibrary !== true)
            .sort((a, b) => a.name.localeCompare(b.name));

        const pluginStatusItems = [
            ...missingPluginIds.map(id => `<li><code>${escapeHtml(id)}</code> is not in the reviewed local library. Its map settings are preserved, but its features cannot run.</li>`),
            ...failedPluginIds.map(id => {
                const error = window.PluginManager.getLoadDiagnostic?.(id) || 'No initialization detail was recorded.';
                return `<li><code>${escapeHtml(id)}</code> did not initialize: ${escapeHtml(error)}</li>`;
            })
        ];
        const missingPluginNotice = pluginStatusItems.length
            ? `<div role="status" style="margin:16px 0;padding:12px 14px;border-radius:8px;border:1px solid rgba(245,158,11,.4);background:rgba(245,158,11,.12);color:var(--text-primary);font-size:13px;line-height:1.5;"><strong>Map plugin status</strong><ul style="margin:6px 0;padding-left:20px;">${pluginStatusItems.join('')}</ul><span>Importing a map never installs or executes plugin code.</span></div>`
            : '';
        if (plugins.length === 0) {
            container.innerHTML = missingPluginNotice;
            return;
        }

        const renderConfigField = (plugin, key, field) => {
            const savedConfig = this.world.plugins?.[plugin.id] || {};
            const savedValue = Object.hasOwn(savedConfig, key) ? savedConfig[key] : field.default;
            let value = field.default;
            if (field.type === 'boolean' && typeof savedValue === 'boolean') value = savedValue;
            else if (field.type === 'string' && typeof savedValue === 'string') value = savedValue;
            else if (field.type === 'number' && typeof savedValue === 'number' && Number.isFinite(savedValue) &&
                (field.min === undefined || savedValue >= field.min) && (field.max === undefined || savedValue <= field.max)) value = savedValue;
            else if (field.type === 'select' && field.options?.some(option => option.value === savedValue)) value = savedValue;

            const inputId = `plugin-config-${plugin.id}-${key}`;
            let control;
            if (field.type === 'boolean') {
                control = `<label class="toggle"><input id="${escapeHtml(inputId)}" class="custom-plugin-config" type="checkbox" data-plugin="${escapeHtml(plugin.id)}" data-config-key="${escapeHtml(key)}" ${value ? 'checked' : ''}><span class="toggle-slider"></span></label>`;
            } else if (field.type === 'number') {
                control = `<input id="${escapeHtml(inputId)}" class="form-input custom-plugin-config" type="number" data-plugin="${escapeHtml(plugin.id)}" data-config-key="${escapeHtml(key)}" value="${escapeHtml(String(value))}" min="${field.min ?? ''}" max="${field.max ?? ''}" step="any" style="max-width:180px;">`;
            } else if (field.type === 'select') {
                control = `<select id="${escapeHtml(inputId)}" class="form-input custom-plugin-config" data-plugin="${escapeHtml(plugin.id)}" data-config-key="${escapeHtml(key)}">${field.options.map((option, index) => `<option value="${index}" ${option.value === value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`;
            } else {
                control = `<input id="${escapeHtml(inputId)}" class="form-input custom-plugin-config" type="text" maxlength="512" data-plugin="${escapeHtml(plugin.id)}" data-config-key="${escapeHtml(key)}" value="${escapeHtml(value)}" style="max-width:240px;">`;
            }
            const showIf = typeof field.showIf === 'string' ? field.showIf : '';
            const showIfDefinition = showIf ? plugin.config?.[showIf] : null;
            const showIfValue = typeof savedConfig[showIf] === 'boolean' ? savedConfig[showIf] : showIfDefinition?.default;
            const visible = !showIf || showIfValue === true;
            return `
                <div class="plugin-config-field ${visible ? '' : 'hidden'}" data-plugin="${escapeHtml(plugin.id)}" data-show-if="${escapeHtml(showIf)}" style="margin-top:12px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                        <div style="flex:1; min-width:0;">
                            <label class="form-label" style="margin:0;" for="${escapeHtml(inputId)}">${escapeHtml(field.label || key)}</label>
                            ${field.description ? `<p style="margin:3px 0 0; color:var(--text-muted); font-size:12px;">${escapeHtml(field.description.slice(0, 256))}</p>` : ''}
                        </div>
                        ${control}
                    </div>
                </div>
            `;
        };

        container.innerHTML = `
            ${missingPluginNotice}
            <h3 style="margin:24px 0 12px;">Other Plugins</h3>
            ${plugins.map(plugin => {
                const coverUrl = plugin.cover
                    ? window.PluginManager.getPluginAssetUrl(plugin, plugin.cover)
                    : '';
                const cover = coverUrl
                    ? `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(plugin.name)}" style="width:100%; max-height:220px; object-fit:cover; display:block;">`
                    : '';
                const developmentBadge = plugin.localDevelopment
                    ? '<span style="font-size:11px; background:rgba(245,158,11,.18); color:#fbbf24; padding:3px 8px; border-radius:4px;">Local preview · trusted code</span>'
                    : '';
                const configFields = Object.entries(plugin.config || {})
                    .map(([key, field]) => renderConfigField(plugin, key, field))
                    .join('');
                const pluginControls = Object.entries(plugin.controls || {}).map(([, control]) => {
                    const keyLabel = control.key.replace(/^Key/, '').replace(/^Digit/, '');
                    return `
                    <div style="display:flex; gap:8px; align-items:baseline; font-size:12px; color:var(--text-muted);">
                        <strong style="color:var(--text-primary);">${escapeHtml(control.label)}</strong>
                        <kbd>${escapeHtml(keyLabel)}</kbd>
                        ${control.description ? `<span>${escapeHtml(control.description)}</span>` : ''}
                    </div>
                `;
                }).join('');
                const hookDiagnostics = window.PluginManager.getHookDiagnostics?.(plugin.id) || [];
                const hookDiagnosticsMarkup = hookDiagnostics.length
                    ? `<div role="status" style="margin-top:12px; padding:10px 12px; border-radius:8px; background:rgba(245,158,11,.12); color:#fbbf24; font-size:12px;"><strong>Plugin hook paused after repeated errors</strong><ul style="margin:6px 0 0; padding-left:18px;">${hookDiagnostics.map(item => `<li><code>${escapeHtml(item.hookName)}</code>: ${escapeHtml(item.message)}</li>`).join('')}</ul><span>Fix the hook, bump the plugin version if it is bundled, then reload to retry it.</span></div>`
                    : '';
                const loadDiagnostic = window.PluginManager.getLoadDiagnostic?.(plugin.id) || '';
                const loadDiagnosticMarkup = loadDiagnostic
                    ? `<div role="status" style="margin-top:12px; padding:10px 12px; border-radius:8px; background:rgba(220,53,69,.12); color:var(--text-primary); font-size:12px;"><strong>Plugin did not initialize</strong><p style="margin:6px 0 0;">${escapeHtml(loadDiagnostic)}</p><span>Fix the plugin or its dependencies, then reload the map to retry.</span></div>`
                    : '';
                return `
                    <div class="plugin-card" data-plugin="${escapeHtml(plugin.id)}" style="background:var(--bg-light); border-radius:12px; overflow:hidden; margin-bottom:16px;">
                        ${cover}
                        <div style="padding:16px 20px 20px;">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
                                <div style="flex:1; min-width:0;">
                                    <h3 style="margin:0 0 8px; color:var(--text-primary);">${escapeHtml(plugin.name)}</h3>
                                    <p style="margin:0 0 10px; color:var(--text-muted); font-size:13px; line-height:1.5;">${escapeHtml(plugin.description)}</p>
                                    <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:11px; color:var(--text-muted);">
                                        <span>API v${escapeHtml(String(plugin.apiVersion))}</span>
                                        <span>·</span>
                                        <span>Version ${escapeHtml(plugin.version)}</span>
                                        ${developmentBadge}
                                    </div>
                                </div>
                                <button type="button" class="btn plugin-toggle-btn" data-plugin="${escapeHtml(plugin.id)}" style="min-width:80px; flex-shrink:0;">Add</button>
                            </div>
                            ${pluginControls ? `<div style="display:grid; gap:4px; margin-top:12px;">${pluginControls}</div>` : ''}
                            ${configFields ? `<div style="margin-top:16px; padding-top:8px; border-top:1px solid var(--surface-light);">${configFields}</div>` : ''}
                            ${hookDiagnosticsMarkup}
                            ${loadDiagnosticMarkup}
                        </div>
                    </div>
                `;
            }).join('')}
        `;
    }

    async openPluginsPopup() {
        if (window.PluginManager) {
            try {
                await window.PluginManager.discoverPlugins();
            } catch (error) {
                console.warn('[Editor] Could not refresh plugin library:', error);
            }
        }
        this.renderAdditionalPluginCards();
        this.updatePluginsPopupState();
        document.getElementById('plugins-popup').classList.add('active');
    }

    closePluginsPopup() {
        document.getElementById('plugins-popup').classList.remove('active');
    }

    updatePluginsPopupState() {
        const enabledPlugins = this.world.plugins.enabled;

        document.querySelectorAll('.plugin-toggle-btn').forEach(btn => {
            const pluginId = btn.dataset.plugin;
            const isEnabled = enabledPlugins.includes(pluginId);

            if (isEnabled) {
                btn.textContent = 'Remove';
                btn.style.background = '#dc3545';
                btn.style.borderColor = '#dc3545';
                btn.style.color = 'white';
            } else {
                btn.textContent = 'Add';
                btn.style.background = '#28a745';
                btn.style.borderColor = '#28a745';
                btn.style.color = 'white';
            }
        });
    }

    updateAdditionalPluginConfigVisibility(pluginId) {
        const config = this.world.plugins?.[pluginId] || {};
        document.querySelectorAll('.plugin-config-field').forEach(field => {
            if (field.dataset.plugin !== pluginId) return;
            const showIf = field.dataset.showIf;
            field.classList.toggle('hidden', Boolean(showIf) && config[showIf] !== true);
        });
    }
    
    async togglePlugin(pluginId) {
        const isEnabled = this.world.plugins.enabled.includes(pluginId);
        
        if (isEnabled) {
            // Try to remove plugin
            // Check for dependencies first
            if (pluginId === 'hp' && this.world.plugins.enabled.includes('hk')) {
                this.showPluginError('Cannot remove HP plugin', 'The Hollow Knight plugin depends on HP. Remove Hollow Knight first.');
                return;
            }
            
            // Check for plugin objects in the map
            const pluginObjects = this.world.getPluginObjects(pluginId);
            if (pluginObjects.length > 0) {
                const locations = pluginObjects.map(o => `${o.section}/${o.name}`).join(', ');
                this.showPluginError('Cannot remove plugin', `There are still objects using this plugin at: ${locations}. Remove them first.`);
                return;
            }
            
            const result = this.world.disablePlugin(pluginId);
            if (!result?.success) {
                this.showPluginError('Cannot remove plugin', result?.error || 'The plugin could not be disabled.');
                return;
            }
        } else {
            // Enable plugin
            const result = await this.world.enablePlugin(pluginId);
            if (!result?.success) {
                this.showPluginError('Cannot enable plugin', result?.error || 'The plugin could not be initialized.');
                return;
            }
            
            // When enabling HK plugin, apply default gravity settings
            if (pluginId === 'hk') {
                this.ensureHKConfig();
                const hkGravity = this.world.plugins.hk.defaultGravity ?? 1.14;
                this.world.gravity = hkGravity;
                
                // Update UI
                const gravityInput = document.getElementById('config-gravity');
                if (gravityInput) gravityInput.value = this.world.gravity;
            }
        }
        
        this.engine?.updatePlayerInput();
        this.updatePluginsPopupState();
        this.syncPluginSettings();
        this.refreshTouchControls();
        this.updateTouchButtonVisibility();
        this.triggerMapChange();
    }
    
    showPluginError(title, message) {
        if (window.ModalManager?.alert) {
            window.ModalManager.alert(title, message);
        } else {
            alert(`${title}\n\n${message}`);
        }
    }
    
    updatePluginConfigSections() {
        const hpSection = document.getElementById('config-section-hp');
        const hkSection = document.getElementById('config-section-hk');
        
        if (hpSection) {
            hpSection.classList.toggle('hidden', !this.world.plugins.enabled.includes('hp'));
        }
        if (hkSection) {
            hkSection.classList.toggle('hidden', !this.world.plugins.enabled.includes('hk'));
        }
        // Code/Mechanics section is now always available (built into base game)
    }
    
    updateZoneButtonState() {
        // Zone is always available now (mechanics built into base game)
        const zoneBtn = document.querySelector('[data-appearance="zone"]');
        if (zoneBtn) {
            zoneBtn.disabled = false;
            zoneBtn.style.opacity = '1';
            zoneBtn.title = 'Zone';
        }
    }
    
    ensureHKConfig() {
        // Ensure HK config object exists with defaults
        if (!this.world.plugins.hk) {
            this.world.plugins.hk = {
                defaultGravity: 0.71,
                maxSoul: 99,
                monarchWing: false,
                monarchWingAmount: 1,
                dash: false,
                superDash: false,
                mantisClaw: false
            };
        }
    }

    attachColorPickerListeners() {
        const gradient = document.getElementById('color-picker-gradient');
        const hueSlider = document.getElementById('color-picker-hue');
        const hexInput = document.getElementById('color-picker-hex');
        const cursor = document.getElementById('color-picker-cursor');
        const preview = document.getElementById('color-picker-preview-box');

        let isDragging = false;

        const updateFromGradient = (e) => {
            const rect = gradient.getBoundingClientRect();
            const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            
            this.colorPickerState.saturation = (x / rect.width) * 100;
            this.colorPickerState.value = 100 - (y / rect.height) * 100;
            
            cursor.style.left = x + 'px';
            cursor.style.top = y + 'px';
            
            this.updateColorPickerPreview();
        };

        gradient.addEventListener('mousedown', (e) => {
            isDragging = true;
            updateFromGradient(e);
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) updateFromGradient(e);
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        hueSlider.addEventListener('input', (e) => {
            this.colorPickerState.hue = parseInt(e.target.value);
            gradient.style.background = `
                linear-gradient(to bottom, transparent, black),
                linear-gradient(to right, white, hsl(${this.colorPickerState.hue}, 100%, 50%))
            `;
            this.updateColorPickerPreview();
        });

        // Auto-correct and apply hex input on change or enter
        const handleHexInput = () => {
            const corrected = this.autoCorrectHex(hexInput.value);
            hexInput.value = corrected;
            this.setColorPickerFromHex('#' + corrected);
            this.applyColorPickerColor('#' + corrected);
        };
        
        hexInput.addEventListener('change', handleHexInput);
        
        hexInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleHexInput();
                hexInput.blur();
            }
        });

        // Close picker when clicking outside it
        document.addEventListener('mousedown', (e) => {
            const picker = this.ui.colorPickerPopup;
            if (picker && picker.classList.contains('active') && !picker.contains(e.target)) {
                this.closeColorPicker();
            }
        });
    }
    
    // Auto-correct hex input
    // f → F, F → FFFFFF, FF0 → FFFF00, abc → AABBCC
    autoCorrectHex(input) {
        // Remove # if present and trim
        let hex = input.replace(/^#/, '').trim().toUpperCase();
        
        // Remove any non-hex characters
        hex = hex.replace(/[^0-9A-F]/gi, '');
        
        if (hex.length === 0) {
            return '000000';
        }
        
        if (hex.length === 1) {
            // Single char: F → FFFFFF
            return hex.repeat(6);
        }
        
        if (hex.length === 2) {
            // Two chars: FF → FFFFFF (repeat 3 times)
            return hex.repeat(3);
        }
        
        if (hex.length === 3) {
            // Three chars: RGB → RRGGBB (expand each)
            return hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        
        if (hex.length === 4) {
            // Four chars: take first 3 and expand
            return hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        
        if (hex.length === 5) {
            // Five chars: pad with last char
            return hex + hex[4];
        }
        
        // Six or more: take first 6
        return hex.substring(0, 6);
    }

    attachSettingsListeners() {
        const volumeRange = document.getElementById('settings-volume-range');
        const volumeNumber = document.getElementById('settings-volume-number');
        const fontsizeRange = document.getElementById('settings-fontsize-range');
        const fontsizeNumber = document.getElementById('settings-fontsize-number');

        // Volume listeners
        volumeRange.addEventListener('input', (e) => {
            volumeNumber.value = e.target.value;
            this.engine.audioManager.setVolume(parseInt(e.target.value) / 100);
            Settings.set('volume', parseInt(e.target.value));
        });

        volumeNumber.addEventListener('change', (e) => {
            const vol = Math.max(0, Math.min(100, parseInt(e.target.value) || 100));
            volumeRange.value = vol;
            volumeNumber.value = vol;
            this.engine.audioManager.setVolume(vol / 100);
            Settings.set('volume', vol);
        });

        // Font size listeners
        fontsizeRange.addEventListener('input', (e) => {
            fontsizeNumber.value = e.target.value;
            if (typeof Settings !== 'undefined') {
                Settings.set('fontSize', parseInt(e.target.value));
            }
        });

        fontsizeNumber.addEventListener('change', (e) => {
            const size = Math.max(50, Math.min(150, parseInt(e.target.value) || 100));
            fontsizeRange.value = size;
            fontsizeNumber.value = size;
            if (typeof Settings !== 'undefined') {
                Settings.set('fontSize', size);
            }
        });

        const syncDeviceMode = (event) => {
            const isMobile = event?.detail?.isMobile ?? !!window.ParkoreenDevice?.isMobile();
            this.engine.touchControlsEnabled = isMobile;
            this.updateTouchControls();
        };
        syncDeviceMode();
        window.addEventListener('parkoreen-device-change', syncDeviceMode);

        // Volume now lives in SettingsManager (account-bound). Falls back to legacy
        // parkoreen_volume localStorage only if SettingsManager isn't ready.
        let vol = null;
        if (window.Settings && typeof window.Settings.get === 'function') {
            const v = window.Settings.get('volume');
            if (typeof v === 'number') vol = v;
        }
        if (vol === null) {
            const savedVolume = localStorage.getItem('parkoreen_volume');
            if (savedVolume !== null) vol = Math.round(parseFloat(savedVolume) * 100);
        }
        if (vol !== null) {
            volumeRange.value = vol;
            volumeNumber.value = vol;
        }
        
        // Load saved font size
        if (typeof Settings !== 'undefined') {
            const savedFontSize = Settings.get('fontSize') || 100;
            fontsizeRange.value = savedFontSize;
            fontsizeNumber.value = savedFontSize;
        }

        // Keyboard layout
        const kbSelect = document.getElementById('settings-keyboard-layout');
        if (kbSelect && typeof Settings !== 'undefined') {
            kbSelect.value = Settings.get('keyboardLayout') || 'jimmyqrg';
            this._updateSettingsKBInfo(kbSelect.value);
            kbSelect.addEventListener('change', (e) => {
                Settings.set('keyboardLayout', e.target.value);
                this._updateSettingsKBInfo(e.target.value);
            });
        }
        
        // How To Play button
        document.getElementById('settings-how-to-play').addEventListener('click', () => {
            if (typeof Navigation !== 'undefined') {
                Navigation.toHowToPlay();
            } else {
                window.location.href = '/parkoreen/howtoplay/';
            }
        });
        
        // Back to Dashboard button
        document.getElementById('settings-back-to-dashboard').addEventListener('click', () => {
            if (confirm('Are you sure you want to leave? Unsaved changes will be lost.')) {
                if (typeof Navigation !== 'undefined') {
                    Navigation.toDashboard();
                } else {
                    window.location.href = '/parkoreen/dashboard/';
                }
            }
        });
    }

    attachFontDropdownListeners() {
        const trigger = document.getElementById('font-dropdown-trigger');
        const dropdown = document.getElementById('font-dropdown');
        const menu = document.getElementById('font-dropdown-menu');

        trigger.addEventListener('click', () => {
            dropdown.classList.toggle('active');
            if (dropdown.classList.contains('active')) {
                // Position the menu to stay on screen
                const rect = trigger.getBoundingClientRect();
                const menuHeight = 300; // max-height
                const menuWidth = 200;
                
                // Calculate position
                let top = rect.bottom + 4;
                let left = rect.left;
                
                // Check if menu would go off bottom of screen
                if (top + menuHeight > window.innerHeight) {
                    // Open upwards instead
                    top = rect.top - menuHeight - 4;
                }
                
                // Check if menu would go off right of screen
                if (left + menuWidth > window.innerWidth) {
                    left = window.innerWidth - menuWidth - 10;
                }
                
                // Ensure it's not off the left
                if (left < 10) left = 10;
                
                // Ensure it's not off the top
                if (top < 10) top = 10;
                
                menu.style.top = top + 'px';
                menu.style.left = left + 'px';
                this.populateFontDropdown();
            }
        });

        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target)) {
                dropdown.classList.remove('active');
            }
        });
    }

    populateFontDropdown() {
        const menu = document.getElementById('font-dropdown-menu');
        
        let html = `
            <div class="font-dropdown-search">
                <input type="text" class="form-input form-input-sm" id="font-search" placeholder="Search fonts...">
            </div>
        `;

        // Recent fonts section
        if (this.recentFonts.length > 0) {
            html += `
                <div class="font-dropdown-section" id="font-section-recent">
                    <div class="font-dropdown-section-title">Recently Used</div>
            `;
            for (const font of this.recentFonts) {
                html += `
                    <div class="font-dropdown-item" data-font="${font}">
                        <span style="font-family: '${font}'">${font}</span>
                        <button class="btn btn-icon btn-ghost font-dropdown-item-remove" data-remove-font="${font}">
                            <span class="material-symbols-outlined" style="font-size: 16px;">close</span>
                        </button>
                    </div>
                `;
            }
            html += `</div>`;
        }

        // Custom fonts section (Parkoreen fonts)
        html += `
            <div class="font-dropdown-section" id="font-section-custom">
                <div class="font-dropdown-section-title">Parkoreen Fonts</div>
        `;
        for (const font of CUSTOM_FONTS) {
            html += `
                <div class="font-dropdown-item" data-font="${font}">
                    <span style="font-family: '${font}'">${font}</span>
                </div>
            `;
        }
        html += `</div>`;

        // Google fonts section
        const googleOnlyFonts = GOOGLE_FONTS.filter(f => !CUSTOM_FONTS.includes(f));
        html += `
            <div class="font-dropdown-section" id="font-section-all">
                <div class="font-dropdown-section-title">Google Fonts</div>
        `;
        for (const font of googleOnlyFonts) {
            html += `
                <div class="font-dropdown-item" data-font="${font}">
                    <span style="font-family: '${font}'">${font}</span>
                </div>
            `;
        }
        html += `</div>`;

        menu.innerHTML = html;

        // Attach event listeners
        menu.querySelectorAll('.font-dropdown-item[data-font]').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.font-dropdown-item-remove')) return;
                this.selectFont(item.dataset.font);
            });
        });

        menu.querySelectorAll('[data-remove-font]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeRecentFont(btn.dataset.removeFont);
            });
        });

        // Search functionality
        const searchInput = document.getElementById('font-search');
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            menu.querySelectorAll('.font-dropdown-item').forEach(item => {
                const font = item.dataset.font.toLowerCase();
                item.style.display = font.includes(query) ? '' : 'none';
            });
        });

        // Load fonts dynamically
        this.loadGoogleFonts();
    }

    loadGoogleFonts() {
        // Create link elements for Google Fonts (exclude custom fonts, they're loaded via CSS)
        const fontsToLoad = [...new Set([...this.recentFonts, ...GOOGLE_FONTS])]
            .filter(f => !CUSTOM_FONTS.includes(f));
        const fontFamilies = fontsToLoad.map(f => f.replace(/ /g, '+')).join('&family=');
        
        if (!document.getElementById('google-fonts-link') && fontFamilies) {
            const link = document.createElement('link');
            link.id = 'google-fonts-link';
            link.rel = 'stylesheet';
            link.href = `https://fonts.googleapis.com/css2?family=${fontFamilies}&display=swap`;
            document.head.appendChild(link);
        }
    }

    selectFont(font) {
        this.textSettings.font = font;
        document.getElementById('font-dropdown-value').textContent = font;
        document.getElementById('font-dropdown-value').style.fontFamily = `"${font}"`;
        document.getElementById('font-dropdown').classList.remove('active');
        
        // Update placement content textarea font
        const contentInput = document.getElementById('placement-content-input');
        if (contentInput) {
            contentInput.style.fontFamily = `"${font}"`;
        }
        
        // Update placement font preview
        this.updatePlacementFontPreview();
        
        // Add to recent fonts
        this.addRecentFont(font);
    }
    
    attachTextureDropdownListeners() {
        const trigger = document.getElementById('texture-dropdown-trigger');
        const dropdown = document.getElementById('texture-dropdown');
        const menu = document.getElementById('texture-dropdown-menu');

        if (!trigger || !dropdown || !menu) return;

        trigger.addEventListener('click', () => {
            dropdown.classList.toggle('active');
            if (dropdown.classList.contains('active')) {
                this.populateTextureDropdown();
            }
        });

        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target)) {
                dropdown.classList.remove('active');
            }
        });
    }
    
    populateTextureDropdown() {
        const menu = document.getElementById('texture-dropdown-menu');
        if (!menu) return;
        
        const currentColor = this.getTexturePreviewColor();
        
        let html = '<div class="texture-dropdown-grid">';
        
        for (const texture of BLOCK_TEXTURES) {
            const isSelected = this.placementSettings.texture === texture.id;
            
            const previewHtml = this.getTexturePreviewMarkup(texture, currentColor, '4px');
            
            html += `
                <div class="texture-dropdown-item ${isSelected ? 'selected' : ''}" data-texture="${texture.id}">
                    <div class="texture-dropdown-item-preview">
                        ${previewHtml}
                    </div>
                    <span class="texture-dropdown-item-name">${texture.name}</span>
                </div>
            `;
        }
        
        html += '</div>';
        menu.innerHTML = html;
        
        // Attach event listeners
        menu.querySelectorAll('.texture-dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                this.selectTexture(item.dataset.texture);
            });
        });
    }

    getTexturePreviewColor() {
        const color = this.placementSettings.color;
        return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#787878';
    }

    getTexturePreviewMarkup(texture, color, borderRadius) {
        if (texture?.id === 'solid') {
            return `<div style="width:100%; height:100%; background:${color}; border-radius:${borderRadius};"></div>`;
        }
        if (texture?.pattern) {
            return `<div style="width:100%; height:100%; background:${color}; border-radius:${borderRadius}; overflow:hidden;"><img src="${escapeHtml(texture.pattern)}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:${borderRadius};"></div>`;
        }
        if (texture?.preview) {
            return `<img src="${escapeHtml(texture.preview)}" alt="${escapeHtml(texture.name)}" style="width:100%; height:100%; object-fit:cover; border-radius:${borderRadius};">`;
        }
        return '';
    }
    
    selectTexture(textureId) {
        this.placementSettings.texture = textureId;
        
        const texture = BLOCK_TEXTURES.find(t => t.id === textureId);
        if (texture) {
            document.getElementById('texture-dropdown-value').textContent = texture.name;
            
            // Update preview
            const preview = document.querySelector('#texture-dropdown-trigger .texture-preview');
            if (preview) {
                const currentColor = this.getTexturePreviewColor();
                preview.style.background = texture.id === 'solid' ? currentColor : 'transparent';
                preview.innerHTML = this.getTexturePreviewMarkup(texture, currentColor, '2px');
            }
        }
        
        document.getElementById('texture-dropdown').classList.remove('active');
    }
    
    updateTexturePreview() {
        const currentColor = this.getTexturePreviewColor();
        const currentTexture = this.placementSettings.texture || 'solid';
        
        const preview = document.querySelector('#texture-dropdown-trigger .texture-preview');
        if (preview) {
            const texture = BLOCK_TEXTURES.find(t => t.id === currentTexture);
            preview.style.background = texture?.id === 'solid' ? currentColor : 'transparent';
            preview.innerHTML = this.getTexturePreviewMarkup(texture, currentColor, '2px');
        }
    }
    
    populateObjectEditFontDropdown(currentFont) {
        const menu = document.getElementById('object-edit-font-menu');
        if (!menu) return;
        
        let html = `
            <div class="font-dropdown-search">
                <input type="text" class="form-input form-input-sm" id="object-edit-font-search" placeholder="Search fonts...">
            </div>
        `;

        // Recent fonts section
        if (this.recentFonts.length > 0) {
            html += `
                <div class="font-dropdown-section">
                    <div class="font-dropdown-section-title">Recently Used</div>
            `;
            for (const font of this.recentFonts) {
                const isSelected = font === currentFont ? 'font-selected' : '';
                html += `
                    <div class="font-dropdown-item ${isSelected}" data-font="${font}">
                        <span style="font-family: '${font}'">${font}</span>
                    </div>
                `;
            }
            html += `</div>`;
        }

        // Custom fonts section
        html += `
            <div class="font-dropdown-section">
                <div class="font-dropdown-section-title">Parkoreen Fonts</div>
        `;
        for (const font of CUSTOM_FONTS) {
            const isSelected = font === currentFont ? 'font-selected' : '';
            html += `
                <div class="font-dropdown-item ${isSelected}" data-font="${font}">
                    <span style="font-family: '${font}'">${font}</span>
                </div>
            `;
        }
        html += `</div>`;

        // Google fonts section
        const googleOnlyFonts = GOOGLE_FONTS.filter(f => !CUSTOM_FONTS.includes(f));
        html += `
            <div class="font-dropdown-section">
                <div class="font-dropdown-section-title">Google Fonts</div>
        `;
        for (const font of googleOnlyFonts) {
            const isSelected = font === currentFont ? 'font-selected' : '';
            html += `
                <div class="font-dropdown-item ${isSelected}" data-font="${font}">
                    <span style="font-family: '${font}'">${font}</span>
                </div>
            `;
        }
        html += `</div>`;

        menu.innerHTML = html;

        // Attach event listeners
        menu.querySelectorAll('.font-dropdown-item[data-font]').forEach(item => {
            item.addEventListener('click', (e) => {
                this.selectObjectEditFont(item.dataset.font);
            });
        });

        // Search functionality
        const searchInput = document.getElementById('object-edit-font-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase();
                menu.querySelectorAll('.font-dropdown-item').forEach(item => {
                    const font = item.dataset.font.toLowerCase();
                    item.style.display = font.includes(query) ? '' : 'none';
                });
            });
        }
    }
    
    selectObjectEditFont(font) {
        if (!this.editingObject || this.editingObject.type !== 'text') return;
        
        this.editingObject.font = font;
        
        // Update UI
        const fontValue = document.getElementById('object-edit-font-value');
        fontValue.textContent = font;
        fontValue.style.fontFamily = `"${font}"`;
        
        document.getElementById('object-edit-content').style.fontFamily = `"${font}"`;
        document.getElementById('object-edit-font-dropdown').classList.remove('active');
        
        // Update preview
        this.updateObjectEditFontPreview();
        
        // Mark all items
        document.querySelectorAll('#object-edit-font-menu .font-dropdown-item').forEach(item => {
            item.classList.toggle('font-selected', item.dataset.font === font);
        });
        
        // Add to recent fonts
        this.addRecentFont(font);
        this.triggerMapChange();
    }
    
    updateObjectEditFontPreview() {
        if (!this.editingObject || this.editingObject.type !== 'text') return;
        
        const previewText = document.getElementById('object-edit-font-preview-text');
        if (!previewText) return;
        
        const content = document.getElementById('object-edit-content').value || 'Preview Text';
        const font = this.editingObject.font || 'Parkoreen Game';
        const color = this.editingObject.color || '#FFFFFF';
        
        previewText.textContent = content.split('\n')[0].substring(0, 30) || 'Preview Text';
        previewText.style.fontFamily = `"${font}"`;
        previewText.style.color = color;
        
        const box = document.getElementById('object-edit-font-preview');
        if (box) box.style.background = this.contrastBackground(color);
    }

    addRecentFont(font) {
        const index = this.recentFonts.indexOf(font);
        if (index !== -1) {
            this.recentFonts.splice(index, 1);
        }
        this.recentFonts.unshift(font);
        if (this.recentFonts.length > 6) {
            this.recentFonts.pop();
        }
        if (window.EditorPrefs) {
            window.EditorPrefs.fonts = this.recentFonts.slice();
            window.EditorPrefs._saveLocal();
            // Push the full current list to the server (EditorPrefs.add rebuilds
            // the list from a single font — we want the trimmed 6-item list).
            window.EditorPrefs._syncList();
        } else {
            localStorage.setItem('parkoreen_recent_fonts', JSON.stringify(this.recentFonts));
        }
    }

    removeRecentFont(font) {
        const index = this.recentFonts.indexOf(font);
        if (index !== -1) {
            this.recentFonts.splice(index, 1);
            if (window.EditorPrefs) {
                window.EditorPrefs.fonts = this.recentFonts.slice();
                window.EditorPrefs._saveLocal();
                window.EditorPrefs._syncList();
            } else {
                localStorage.setItem('parkoreen_recent_fonts', JSON.stringify(this.recentFonts));
            }
            this.populateFontDropdown();
        }
    }

    // ========================================
    // TOOL MANAGEMENT
    // ========================================
    setTool(tool) {
        // Fly is a special mode that can be combined with other tools
        if (tool === EditorTool.FLY) {
            this.toggleFlyMode();
            return;
        }

        if (this.engine.state === GameState.TESTING) {
            return;
        }
        
        // Select tool enters selection mode
        if (tool === EditorTool.SELECT) {
            if (this.isSelectionActive) {
                this.exitSelectionMode();
            } else {
                this.enterSelectionMode();
            }
            return;
        }

        // If in placement mode, non-fly tools are disabled
        if (this.placementMode !== PlacementMode.NONE) {
            return;
        }
        
        // Exit selection mode if switching to another tool
        if (this.isSelectionActive) {
            this.exitSelectionMode();
        }

        const isToggleOff = (tool === this.currentTool);
        
        // Always clean up current tool state first
        if (this.currentTool === EditorTool.ERASE) {
            this.isErasing = false;
            this.hideEraseMode();
        }
        this.movingObject = null;
        this.rotatingObject = null;

        // Update non-fly button states
        this.ui.toolbar.querySelectorAll('.toolbar-btn[data-tool]').forEach(btn => {
            if (btn.dataset.tool !== 'fly') {
            btn.classList.remove('active');
            }
        });

        if (isToggleOff) {
            this.currentTool = EditorTool.NONE;
        } else {
            this.currentTool = tool;
            const btn = this.ui.toolbar.querySelector(`[data-tool="${tool}"]`);
            if (btn) btn.classList.add('active');

            if (tool === EditorTool.ERASE) {
                this.isErasing = true;
                this.showEraseMode();
            }
        }
    }
    
    showEraseMode() {
        // Show placement toolbar with erase options
        this.ui.placementToolbar.classList.add('active');
        
        // Hide all placement options
        this.ui.placementToolbar.querySelectorAll('.placement-option').forEach(opt => {
            if (!opt.closest('#erase-options')) {
                opt.style.display = 'none';
            }
        });
        
        // Show erase options
        if (this.ui.eraseOptions) {
            this.ui.eraseOptions.style.display = 'block';
        }
        
        // Change Add button to Close button
        const addBtnIcon = this.ui.btnAdd.querySelector('.material-symbols-outlined');
        if (addBtnIcon) {
            addBtnIcon.textContent = 'close';
        }
        this.ui.btnAdd.title = 'Stop Erasing (Q or Esc)';
    }
    
    hideEraseMode() {
        // Hide erase options
        if (this.ui.eraseOptions) {
            this.ui.eraseOptions.style.display = 'none';
        }
        
        // Show all placement options again
        this.ui.placementToolbar.querySelectorAll('.placement-option').forEach(opt => {
            opt.style.display = '';
        });
        
        // Hide placement toolbar if not in placement mode
        if (this.placementMode === PlacementMode.NONE) {
            this.ui.placementToolbar.classList.remove('active');
        }
        
        // Restore Add button
        const addBtnIcon = this.ui.btnAdd.querySelector('.material-symbols-outlined');
        if (addBtnIcon) {
            addBtnIcon.textContent = 'add';
        }
        this.ui.btnAdd.title = 'Add';
    }
    
    toggleFlyMode() {
        this.isFlying = !this.isFlying;
        
        const flyBtn = this.ui.toolbar.querySelector('[data-tool="fly"]');
        if (flyBtn) {
            flyBtn.classList.toggle('active', this.isFlying);
        }
        
                if (this.engine.localPlayer) {
            this.engine.localPlayer.isFlying = this.isFlying;
            // Reset velocity when toggling fly mode
                    this.engine.localPlayer.vx = 0;
                    this.engine.localPlayer.vy = 0;
            
            if (!this.isFlying) {
                // Reset jumps so player can jump again when leaving fly mode
                this.engine.localPlayer.resetJumps();
            }
        }
    }
    
    disableNonFlyTools() {
        if (this.currentTool !== EditorTool.NONE && this.currentTool !== EditorTool.FLY) {
            if (this.currentTool === EditorTool.ERASE) {
                this.isErasing = false;
                this.hideEraseMode();
            }
            this.movingObject = null;
            this.rotatingObject = null;
            this.currentTool = EditorTool.NONE;
            
            this.ui.toolbar.querySelectorAll('.toolbar-btn[data-tool]').forEach(btn => {
                if (btn.dataset.tool !== 'fly') {
                    btn.classList.remove('active');
                }
            });
        }
    }

    handleToolbarAction(action) {
        // Get center point for zoom (player position if available)
        let centerX, centerY;
        if (this.engine.localPlayer) {
            centerX = this.engine.localPlayer.x + this.engine.localPlayer.width / 2;
            centerY = this.engine.localPlayer.y + this.engine.localPlayer.height / 2;
        } else {
            centerX = this.camera.x + this.camera.width / 2 / this.camera.zoom;
            centerY = this.camera.y + this.camera.height / 2 / this.camera.zoom;
        }
        
        switch (action) {
            case 'zoom-in':
                this.camera.zoomIn(centerX, centerY);
                break;
            case 'zoom-out':
                this.camera.zoomOut(centerX, centerY);
                break;
            case 'toggle-grid':
                this.toggleGrid();
                break;
            case 'toggle-invincibility':
                this.toggleInvincibility();
                break;
            case 'toggle-touchboxes':
                this.toggleTouchboxes();
                break;
            case 'respawn':
                this.respawnAtCheckpoint();
                break;
        }
    }
    
    toggleGrid() {
        this.showGrid = !this.showGrid;
        const gridBtn = this.ui.toolbar.querySelector('[data-action="toggle-grid"]');
        if (gridBtn) {
            gridBtn.classList.toggle('active', this.showGrid);
        }
    }

    toggleInvincibility() {
        this.invincibilityEnabled = !this.invincibilityEnabled;
        this.engine.invincibilityEnabled = this.invincibilityEnabled;
        GameEngine._invincible = this.invincibilityEnabled;
        const btn = this.ui.toolbar.querySelector('[data-action="toggle-invincibility"]');
        if (btn) btn.classList.toggle('active', this.invincibilityEnabled);
    }

    toggleTouchboxes() {
        this.showTouchboxes = !this.showTouchboxes;
        // If toggled while in tester mode, keep the tester-session state in sync
        if (this.engine.state === GameState.TESTING) {
            this._testerTouchboxState = this.showTouchboxes;
        }
        try {
            // Persist to per-account settings (falls back to localStorage if
            // SettingsManager isn't available yet).
            if (window.Settings && typeof window.Settings.set === 'function') {
                window.Settings.set('testerShowTouchboxes', this.showTouchboxes);
            } else {
                localStorage.setItem('parkoreen_tester_show_touchboxes', this.showTouchboxes ? '1' : '0');
            }
        } catch (e) { /* ignore quota / private mode */ }
        const btn = this.ui.toolbar.querySelector('[data-action="toggle-touchboxes"]');
        if (btn) btn.classList.toggle('active', this.showTouchboxes);
    }

    respawnAtCheckpoint() {
        if (this.engine.state !== GameState.TESTING || !this.engine.localPlayer) return;
        this.engine.respawnPlayer();
        this.engine.localPlayer.isFlying = this.isFlying;
        if (window.PluginManager) {
            if (!this.engine._respawnData) this.engine._respawnData = {};
            this.engine._respawnData.player = this.engine.localPlayer;
            this.engine._respawnData.world = this.engine.world;
            window.PluginManager.executeHook('player.respawn', this.engine._respawnData);
        }
    }

    rotateObjectUnderMouse(degrees) {
        const worldPos = this.engine.getMouseWorldPos();
        const obj = this.world.getObjectAt(worldPos.x, worldPos.y);
        if (obj) {
            this.rotateObjectWithBouncerSync(obj, degrees);
            this.triggerMapChange();
        }
    }

    isBouncerObject(obj) {
        return !!obj && (obj.appearanceType === 'bouncer' || obj.actingType === 'bouncer');
    }

    rotateObjectWithBouncerSync(obj, degrees) {
        if (!obj) return;
        const normalized = ((degrees % 360) + 360) % 360;
        if (this.isBouncerObject(obj)) {
            const baseDir = typeof obj.bouncerDirection === 'number' ? obj.bouncerDirection : 0;
            const baseAppear = typeof obj.bouncerAppearanceDirection === 'number' ? obj.bouncerAppearanceDirection : baseDir;
            obj.bouncerDirection = (baseDir + normalized) % 360;
            obj.bouncerAppearanceDirection = (baseAppear + normalized) % 360;
            obj.rotation = 0;
            return;
        }
        obj.rotation = (obj.rotation + normalized) % 360;
    }

    setBouncerDirectionFromAbsoluteRotation(obj, rotation) {
        const snapped = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
        obj.bouncerDirection = snapped;
        obj.bouncerAppearanceDirection = snapped;
        obj.rotation = 0;
    }

    // ========================================
    // MULTI-SELECTION SYSTEM
    // ========================================
    enterSelectionMode() {
        this.isSelectionActive = true;
        this.selectedObjects.clear();
        this.selectionMode = SelectionMode.QUOT;
        this.selectionAction = SelectionAction.SELECT;
        this.selectionRect = null;
        this.selectionMovingObjects = null;
        
        // Show selection toolbar above main toolbar
        this.ui.selectionToolbar.classList.remove('hidden');
        
        // Replace Add button with Cancel button
        this.ui.btnAdd.querySelector('.material-symbols-outlined').textContent = 'close';
        this.ui.btnAdd.title = 'Exit Selection';
        this.ui.btnAdd.classList.add('sel-cancel-btn');
        
        // Close any open panels/menus
        this.ui.addMenu.classList.remove('active');
        if (this.placementMode !== PlacementMode.NONE) {
            this.stopPlacement();
        }
        
        this.updateSelectionCount();
        this.updateSelectionModeUI();
    }
    
    exitSelectionMode() {
        this.isSelectionActive = false;
        this.selectedObjects.clear();
        this.selectionRect = null;
        this.selectionMovingObjects = null;
        this.selectionMoveStart = null;
        
        // Hide secondary toolbars
        this.ui.selectionToolbar.classList.add('hidden');
        this.ui.selectionMouseToolbar.classList.add('hidden');
        
        // Restore Add button
        this.ui.btnAdd.querySelector('.material-symbols-outlined').textContent = 'add';
        this.ui.btnAdd.title = 'Add';
        this.ui.btnAdd.classList.remove('sel-cancel-btn');
        
        // Restore tool
        this.setTool(EditorTool.NONE);
    }
    
    setSelectionMode(mode) {
        this.selectionMode = mode;
        this.selectionRect = null;
        this.selectionMovingObjects = null;
        this.selectionMoveStart = null;
        this.updateSelectionModeUI();
    }
    
    setSelectionAction(action) {
        this.selectionAction = action;
        // Update UI
        this.ui.selectionToolbar.querySelectorAll('[data-sel-action]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.selAction === action);
        });
    }
    
    updateSelectionModeUI() {
        // Update mode button active states
        this.ui.selectionToolbar.querySelectorAll('[data-sel-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.selMode === this.selectionMode);
        });
        
        // Show/hide mouse action toolbar
        if (this.selectionMode === SelectionMode.MOUSE) {
            this.ui.selectionMouseToolbar.classList.remove('hidden');
        } else {
            this.ui.selectionMouseToolbar.classList.add('hidden');
        }
    }
    
    updateSelectionCount() {
        const countEl = document.getElementById('sel-count');
        if (countEl) {
            countEl.textContent = `${this.selectedObjects.size} selected`;
        }
        const saveStampButton = this.ui.selectionToolbar?.querySelector('[data-sel-cmd="save-stamp"]');
        if (saveStampButton) {
            saveStampButton.disabled = this.selectedObjects.size === 0 || this.selectedObjects.size > 64 || (this.world.objectStamps || []).length >= 32;
            saveStampButton.title = this.selectedObjects.size > 64
                ? 'Select at most 64 objects to save a stamp'
                : (this.world.objectStamps || []).length >= 32
                    ? 'This map already has the maximum of 32 Object Stamps'
                    : 'Save selection as an Object Stamp';
        }
    }
    
    handleSelectionCommand(cmd) {
        switch (cmd) {
            case 'select-all':
                for (const obj of this.world.objects) {
                    this.selectedObjects.add(obj);
                }
                break;
            case 'deselect-all':
                this.selectedObjects.clear();
                break;
            case 'reverse': {
                const newSelection = new Set();
                for (const obj of this.world.objects) {
                    if (!this.selectedObjects.has(obj)) {
                        newSelection.add(obj);
                    }
                }
                this.selectedObjects = newSelection;
                break;
            }
            case 'save-stamp':
                this.saveObjectStampFromSelection();
                return;
            case 'done':
                this.exitSelectionMode();
                return;
        }
        this.updateSelectionCount();
    }

    saveObjectStampFromSelection() {
        const selected = this.world.objects.filter(obj => this.selectedObjects.has(obj));
        if (selected.length === 0) return;
        if (selected.length > 64) {
            this.showToast('An Object Stamp can contain up to 64 objects.', 'error');
            return;
        }
        this.world.objectStamps ||= [];
        if (this.world.objectStamps.length >= 32) {
            this.showToast('This map already has the maximum of 32 Object Stamps.', 'error');
            this.updateSelectionCount();
            return;
        }

        const requestedName = window.prompt('Name this Object Stamp:');
        if (requestedName === null) return;
        const name = requestedName.trim();
        if (!name || name.length > 40) {
            this.showToast('Stamp names must contain 1 to 40 characters.', 'error');
            return;
        }
        if (this.world.objectStamps.some(stamp => stamp.name.toLowerCase() === name.toLowerCase())) {
            this.showToast('A stamp with that name already exists on this map.', 'error');
            return;
        }

        const originX = Math.min(...selected.map(obj => obj.x));
        const originY = Math.min(...selected.map(obj => obj.y));
        const objects = sanitizeObjectStampObjects(selected.map(obj => {
            const snapshot = obj.toJSON();
            snapshot.x -= originX;
            snapshot.y -= originY;
            delete snapshot.id;
            return snapshot;
        }));

        this.beginUndoTransaction();
        this.world.objectStamps.push({
            id: `stamp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
            name,
            objects
        });
        this.endUndoTransaction();
        this.triggerMapChange();
        this.updateSelectionCount();
        this.showToast(`Saved “${name}” with ${objects.length} objects.`, 'success');
    }

    openObjectStampPicker() {
        let overlay = document.getElementById('object-stamp-picker');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'object-stamp-picker';
            overlay.className = 'modal-overlay';
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML = `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                    <h2 class="modal-title" style="margin:0;">Object Stamps</h2>
                    <button type="button" class="btn btn-secondary" id="object-stamp-import">Import</button>
                </div>
                <input type="file" id="object-stamp-import-file" accept=".pkrstamp,application/json" hidden>
                <p class="modal-text">Place saved object groups or import a portable <code>.pkrstamp</code> asset. Stamps copy object data only; mechanics and external object-ID references are not copied.</p>
                <div id="object-stamp-list" style="display:flex; flex-direction:column; gap:8px;"></div>
                <button type="button" class="btn btn-secondary" id="object-stamp-close" style="width:100%; margin-top:16px;">Close</button>
            `;
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            overlay.addEventListener('click', event => {
                if (event.target === overlay) overlay.classList.remove('active');
            });
            modal.querySelector('#object-stamp-close').addEventListener('click', () => overlay.classList.remove('active'));
            const importInput = modal.querySelector('#object-stamp-import-file');
            modal.querySelector('#object-stamp-import').addEventListener('click', () => importInput.click());
            importInput.addEventListener('change', async () => {
                const file = importInput.files?.[0];
                importInput.value = '';
                if (file) await this.importObjectStampFile(file);
            });
        }
        this.renderObjectStampPicker();
        overlay.classList.add('active');
    }

    renderObjectStampPicker() {
        const list = document.getElementById('object-stamp-list');
        if (!list) return;
        list.replaceChildren();
        const stamps = this.world.objectStamps || [];
        if (stamps.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'modal-text';
            empty.textContent = 'No stamps saved yet. Select objects and choose Save Stamp in the selection toolbar.';
            list.appendChild(empty);
            return;
        }

        for (const stamp of stamps) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:10px; border:1px solid var(--surface-light); border-radius:8px;';
            const label = document.createElement('div');
            label.style.cssText = 'flex:1; min-width:0;';
            const title = document.createElement('strong');
            title.textContent = stamp.name;
            const detail = document.createElement('div');
            detail.style.cssText = 'font-size:12px; color:var(--text-secondary); margin-top:3px;';
            detail.textContent = `${stamp.objects.length} objects`;
            label.append(title, detail);

            const placeButton = document.createElement('button');
            placeButton.type = 'button';
            placeButton.className = 'btn btn-primary';
            placeButton.textContent = 'Place';
            placeButton.addEventListener('click', () => this.startObjectStampPlacement(stamp.id));

            const exportButton = document.createElement('button');
            exportButton.type = 'button';
            exportButton.className = 'btn btn-secondary';
            exportButton.textContent = 'Export';
            exportButton.title = 'Download this stamp as a portable .pkrstamp asset';
            exportButton.addEventListener('click', () => this.exportObjectStamp(stamp.id));

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'btn btn-secondary';
            deleteButton.textContent = 'Delete';
            deleteButton.addEventListener('click', () => {
                if (!window.confirm(`Delete the “${stamp.name}” Object Stamp?`)) return;
                const index = this.world.objectStamps.findIndex(item => item.id === stamp.id);
                if (index === -1) return;
                this.beginUndoTransaction();
                this.world.objectStamps.splice(index, 1);
                this.endUndoTransaction();
                this.triggerMapChange();
                this.updateSelectionCount();
                this.renderObjectStampPicker();
            });
            row.append(label, exportButton, placeButton, deleteButton);
            list.appendChild(row);
        }
    }

    exportObjectStamp(stampId) {
        const stamp = (this.world.objectStamps || []).find(item => item.id === stampId);
        if (!stamp) {
            this.showToast('That Object Stamp is no longer available.', 'error');
            return;
        }

        const portableStamp = {
            format: 'parkoreen-object-stamp',
            version: 1,
            name: stamp.name,
            objects: sanitizeObjectStampObjects(stamp.objects)
        };
        const blob = new Blob([JSON.stringify(portableStamp, null, 2)], { type: 'application/json' });
        if (blob.size > OBJECT_STAMP_MAX_TRANSFER_BYTES) {
            this.showToast('This stamp is too large to export; portable files must be 2 MiB or smaller.', 'error');
            return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeName = stamp.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'object-stamp';
        link.href = url;
        link.download = `${safeName}.pkrstamp`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async importObjectStampFile(file) {
        if (file.size > OBJECT_STAMP_MAX_TRANSFER_BYTES) {
            this.showToast('Portable Object Stamps must be 2 MiB or smaller.', 'error');
            return;
        }
        if ((this.world.objectStamps || []).length >= 32) {
            this.showToast('This map already has the maximum of 32 Object Stamps.', 'error');
            return;
        }

        let data;
        try {
            data = JSON.parse(await file.text());
        } catch (_) {
            this.showToast('That file is not valid Object Stamp JSON.', 'error');
            return;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            data.format !== 'parkoreen-object-stamp' || data.version !== 1 ||
            Object.keys(data).some(key => !['format', 'version', 'name', 'objects'].includes(key)) ||
            typeof data.name !== 'string' || !Array.isArray(data.objects)) {
            this.showToast('That file is not a supported Parkoreen Object Stamp (version 1).', 'error');
            return;
        }

        let name = data.name.trim();
        if (!name || name.length > 40) {
            this.showToast('Stamp names must contain 1 to 40 characters.', 'error');
            return;
        }
        const baseName = name;
        let suffix = 2;
        while ((this.world.objectStamps || []).some(stamp => stamp.name.toLowerCase() === name.toLowerCase())) {
            const tail = ` ${suffix++}`;
            name = `${baseName.slice(0, 40 - tail.length)}${tail}`;
        }

        try {
            this.beginUndoTransaction();
            const stamp = this.world.addObjectStamp(name, sanitizeObjectStampObjects(data.objects));
            this.endUndoTransaction();
            this.triggerMapChange();
            this.updateSelectionCount();
            this.renderObjectStampPicker();
            this.showToast(`Imported “${stamp.name}” with ${stamp.objects.length} objects.`, 'success');
        } catch (error) {
            this.endUndoTransaction();
            this._discardMatchingTopUndoIfUnchanged();
            this.showToast(error?.message || 'That Object Stamp could not be imported.', 'error');
        }
    }

    startObjectStampPlacement(stampId) {
        const stamp = (this.world.objectStamps || []).find(item => item.id === stampId);
        if (!stamp) {
            this.showToast('That Object Stamp is no longer available.', 'error');
            return;
        }
        if (this.isSelectionActive) this.exitSelectionMode();
        document.getElementById('object-stamp-picker')?.classList.remove('active');
        this.closeAddMenu();
        this.objectStampPlacementId = stampId;
        this.placementMode = PlacementMode.OBJECT_STAMP;
        this.disableNonFlyTools();
        this.ui.btnAdd.innerHTML = '<span class="material-symbols-outlined">close</span>';
        this.ui.placementToolbar.classList.remove('active');
        this.showToast(`Click the map to place “${stamp.name}”.`, 'info');
    }

    placeObjectStamp(x, y) {
        const stamp = (this.world.objectStamps || []).find(item => item.id === this.objectStampPlacementId);
        if (!stamp) {
            this.showToast('That Object Stamp is no longer available.', 'error');
            this.stopPlacement();
            return;
        }

        const takenPortalNames = new Set(this.world.objects
            .filter(obj => obj.type === 'teleportal' && obj.teleportalName)
            .map(obj => obj.teleportalName));
        const portalNameMap = new Map();
        const stampObjects = sanitizeObjectStampObjects(stamp.objects);
        const spriteBytes = stampObjects.reduce((total, obj) => total + (obj.spriteSheet?.data?.length || 0), 0);
        if (this.world.getSpriteSheetDataLength() + spriteBytes > 8 * 1024 * 1024) {
            this.showToast('Placing this stamp would exceed the map’s 8 MiB sprite sheet limit.', 'error');
            this.stopPlacement();
            return;
        }
        for (const source of stampObjects) {
            if (source.type !== 'teleportal' || !source.teleportalName || portalNameMap.has(source.teleportalName)) continue;
            const base = `${source.teleportalName} Copy`;
            let candidate = base;
            let suffix = 2;
            while (takenPortalNames.has(candidate)) candidate = `${base} ${suffix++}`;
            takenPortalNames.add(candidate);
            portalNameMap.set(source.teleportalName, candidate);
        }

        for (const source of stampObjects) {
            const clone = new WorldObject({
                ...source,
                id: undefined,
                x: x + source.x,
                y: y + source.y
            });
            if (clone.type === 'teleportal' && clone.teleportalName && portalNameMap.has(clone.teleportalName)) {
                clone.teleportalName = portalNameMap.get(clone.teleportalName);
                clone.name = `Teleportal: ${clone.teleportalName}`;
            }
            for (const connectionType of ['sendTo', 'receiveFrom']) {
                clone[connectionType] = clone[connectionType].map(connection => ({
                    ...connection,
                    name: portalNameMap.get(connection.name) || connection.name
                }));
            }
            this.world.addObject(clone);
        }

        this.updateLayersList();
        this.triggerMapChange();
        this.playTileSound();
    }
    
    handleSelectionMouseAction(action) {
        if (this.selectedObjects.size === 0) return;
        
        switch (action) {
            case 'move':
                this.showToast('Click and drag to move selected objects', 'info');
                break;
            case 'duplicate':
                this.duplicateSelectedObjects();
                break;
            case 'rotate-left':
                this.rotateSelectedObjects(-90);
                break;
            case 'rotate-right':
                this.rotateSelectedObjects(90);
                break;
            case 'rotate-180':
                this.rotateSelectedObjects(180);
                break;
        }
    }
    
    duplicateSelectedObjects() {
        if (this.selectedObjects.size === 0) return;
        
        const newSelection = new Set();
        let teleportalClones = [];
        for (const obj of this.selectedObjects) {
            const clone = obj.clone();
            clone.x += GRID_SIZE;
            clone.y += GRID_SIZE;
            if (clone.type === 'teleportal') {
                clone.teleportalName = '';
                teleportalClones.push(clone);
            } else {
                this.world.addObject(clone);
                newSelection.add(clone);
            }
        }
        
        // Handle teleportal clones
        if (teleportalClones.length > 0) {
            // For now, handle the first one (or last, since loop)
            this.pendingTeleportal = teleportalClones[teleportalClones.length - 1];
            this.showTeleportalNamePopup();
            // Add the others with default name or something, but for simplicity, add them with empty name
            for (const clone of teleportalClones.slice(0, -1)) {
                clone.teleportalName = 'Unnamed Copy';
                this.world.addObject(clone);
                newSelection.add(clone);
            }
        }
        
        this.selectedObjects = newSelection;
        this.updateSelectionCount();
        this.updateLayersList();
        this.triggerMapChange();
        this.playTileSound();
        this.showToast(`Duplicated ${newSelection.size + teleportalClones.length} objects`, 'success');
    }
    
    rotateSelectedObjects(degrees) {
        for (const obj of this.selectedObjects) {
            this.rotateObjectWithBouncerSync(obj, degrees);
        }
        this.triggerMapChange();
    }
    
    // Handle Quot mode rectangle selection
    handleQuotSelectionDown(worldX, worldY) {
        const gridPos = this.engine.getGridAlignedPos(worldX, worldY);
        this.selectionRect = {
            startX: gridPos.x,
            startY: gridPos.y,
            endX: gridPos.x,
            endY: gridPos.y
        };
    }
    
    handleQuotSelectionMove(worldX, worldY) {
        if (!this.selectionRect) return;
        const gridPos = this.engine.getGridAlignedPos(worldX, worldY);
        this.selectionRect.endX = gridPos.x;
        this.selectionRect.endY = gridPos.y;
    }
    
    handleQuotSelectionUp() {
        if (!this.selectionRect) return;
        
        const { startX, startY, endX, endY } = this.selectionRect;
        const rectX = Math.min(startX, endX);
        const rectY = Math.min(startY, endY);
        const rectW = Math.abs(endX - startX) + GRID_SIZE;
        const rectH = Math.abs(endY - startY) + GRID_SIZE;
        
        const rect = { x: rectX, y: rectY, width: rectW, height: rectH };
        
        for (const obj of this.world.objects) {
            const objRect = { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
            if (this.rectsOverlap(rect, objRect)) {
                if (this.selectionAction === SelectionAction.SELECT) {
                    this.selectedObjects.add(obj);
                } else {
                    this.selectedObjects.delete(obj);
                }
            }
        }
        
        this.selectionRect = null;
        this.updateSelectionCount();
    }
    
    rectsOverlap(a, b) {
        return a.x < b.x + b.width && a.x + a.width > b.x &&
               a.y < b.y + b.height && a.y + a.height > b.y;
    }
    
    // Handle Multi-Select mode click
    handleMultiSelectClick(worldX, worldY) {
        const obj = this.world.getObjectAt(worldX, worldY);
        if (!obj) return;
        
        if (this.selectionAction === SelectionAction.SELECT) {
            this.selectedObjects.add(obj);
        } else {
            this.selectedObjects.delete(obj);
        }
        this.updateSelectionCount();
    }
    
    // Handle Mouse mode click (config or move)
    handleMouseModeDown(worldX, worldY) {
        const obj = this.world.getObjectAt(worldX, worldY);
        
        if (obj && this.selectedObjects.has(obj)) {
            // Start moving all selected objects
            this.beginUndoTransaction();
            this._selectionMoveUndoActive = true;
            const gridPos = this.engine.getGridAlignedPos(worldX, worldY);
            this.selectionMoveStart = { x: gridPos.x, y: gridPos.y };
            this.selectionMovingObjects = [];
            for (const selObj of this.selectedObjects) {
                this.selectionMovingObjects.push({
                    obj: selObj,
                    offsetX: selObj.x - gridPos.x,
                    offsetY: selObj.y - gridPos.y
                });
            }
        }
    }
    
    handleMouseModeMove(worldX, worldY) {
        if (!this.selectionMovingObjects) return;
        const gridPos = this.engine.getGridAlignedPos(worldX, worldY);
        for (const item of this.selectionMovingObjects) {
            item.obj.x = gridPos.x + item.offsetX;
            item.obj.y = gridPos.y + item.offsetY;
        }
        this.world._spatialDirty = true;
        this.world._editorMergedDirty = true;
    }
    
    handleMouseModeUp(worldX, worldY) {
        if (this.selectionMovingObjects) {
            // Check if we actually moved
            const gridPos = this.engine.getGridAlignedPos(worldX, worldY);
            const didMove = this.selectionMoveStart && 
                (gridPos.x !== this.selectionMoveStart.x || gridPos.y !== this.selectionMoveStart.y);
            
            if (!didMove) {
                if (this._selectionMoveUndoActive) {
                    this._selectionMoveUndoActive = false;
                    this._discardMatchingTopUndoIfUnchanged();
                    this.endUndoTransaction();
                }
                // It was a click, not a drag — open config for selected objects
                const obj = this.world.getObjectAt(worldX, worldY);
                if (obj && this.selectedObjects.has(obj)) {
                    this.openMultiObjectEditPopup();
                }
            } else {
                // Snap all moved objects to grid
                for (const item of this.selectionMovingObjects) {
                    item.obj.snapToGrid();
                }
                if (this._selectionMoveUndoActive) {
                    this._selectionMoveUndoActive = false;
                    this.endUndoTransaction();
                }
                this.triggerMapChange();
                this.playTileSound();
            }
            
            this.selectionMovingObjects = null;
            this.selectionMoveStart = null;
        }
    }
    
    // ========================================
    // MULTI-OBJECT CONFIG POPUP
    // ========================================
    openMultiObjectEditPopup() {
        const objects = Array.from(this.selectedObjects);
        if (objects.length === 0) return;
        
        if (objects.length === 1) {
            this.openObjectEditPopup(objects[0]);
            return;
        }
        
        // Build a popup for editing common properties
        let popup = document.getElementById('multi-object-edit-popup');
        if (popup) popup.remove();
        
        popup = document.createElement('div');
        popup.className = 'object-edit-popup modal-overlay';
        popup.id = 'multi-object-edit-popup';
        
        // Determine which fields are common across all selected objects
        const commonFields = this.getCommonEditFields(objects);
        
        // Track which fields the user has touched
        const touchedFields = new Set();
        
        let fieldsHTML = '';
        
        for (const field of commonFields) {
            fieldsHTML += this.renderMultiEditField(field, objects);
        }
        
        popup.innerHTML = `
            <div class="object-edit-panel">
                <div class="panel-header">
                    <span class="panel-title">Edit ${objects.length} Objects</span>
                    <button class="btn btn-icon btn-ghost" id="multi-edit-close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="panel-body">
                    ${fieldsHTML}
                    <div class="form-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--surface-light);">
                        <button class="btn btn-danger" id="multi-edit-delete" style="width: 100%;">
                            <span class="material-symbols-outlined">delete</span>
                            Delete ${objects.length} Objects
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(popup);
        popup.classList.add('active');
        
        // Attach listeners
        document.getElementById('multi-edit-close').addEventListener('click', () => {
            popup.classList.remove('active');
            setTimeout(() => popup.remove(), 200);
        });
        
        popup.addEventListener('click', (e) => {
            if (e.target === popup) {
                popup.classList.remove('active');
                setTimeout(() => popup.remove(), 200);
            }
        });
        
        document.getElementById('multi-edit-delete').addEventListener('click', () => {
            this.beginUndoTransaction();
            try {
                for (const obj of objects) {
                    this.world.removeObject(obj.id);
                }
            } finally {
                this.endUndoTransaction();
            }
            this.selectedObjects.clear();
            this.updateSelectionCount();
            this.updateLayersList();
            this.triggerMapChange();
            popup.classList.remove('active');
            setTimeout(() => popup.remove(), 200);
            this.showToast(`Deleted ${objects.length} objects`, 'success');
        });
        
        // Attach field-specific listeners
        this.attachMultiEditListeners(popup, objects, commonFields, touchedFields);
    }
    
    getCommonEditFields(objects) {
        const fields = [];
        
        // Name is always available
        fields.push({ key: 'name', label: 'Name', type: 'text' });
        
        // Color — available on all objects
        fields.push({ key: 'color', label: 'Color', type: 'color' });
        
        // Opacity — available on all objects
        fields.push({ key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 100, toValue: v => Math.round(v * 100), fromValue: v => v / 100 });
        
        // Rotation — available on all objects
        fields.push({ key: 'rotation', label: 'Rotation', type: 'rotation' });
        
        // Collision — available on all objects
        fields.push({ key: 'collision', label: 'Collision', type: 'boolean' });

        const allGroundBlocks = objects.every(o =>
            o.type === 'block' && o.appearanceType === 'ground' && o.actingType === 'ground'
        );
        if (allGroundBlocks) {
            fields.push({ key: 'collisionShape', label: 'Ground Collision Shape', type: 'select', options: [
                { value: 'box', label: 'Box' },
                { value: 'circle', label: 'Circle' },
                { value: 'capsule', label: 'Capsule' },
                { value: 'slopeUpRight', label: 'Ramp ↗' },
                { value: 'slopeUpLeft', label: 'Ramp ↖' },
                { value: 'polygon', label: 'Custom Convex Polygon' }
            ] });
        }
        const allPolygonColliders = objects.every(o => o.type === 'block' && o.appearanceType === 'ground' &&
            o.actingType === 'ground' && o.collisionShape === 'polygon');
        if (allPolygonColliders) {
            fields.push({ key: 'polygonOneWay', label: 'One-Way Polygon Surface', type: 'boolean' });
        }
        
        // Flip — available on non-zone objects
        const allNonZone = objects.every(o => o.appearanceType !== 'zone');
        if (allNonZone) {
            fields.push({ key: 'flipHorizontal', label: 'Flip Horizontal', type: 'boolean' });
        }
        
        // Spike touchbox — only if ALL objects are spikes (and not spinners)
        const allSpikesNotSpinner = objects.every(o => 
            (o.appearanceType === 'spike' || o.actingType === 'spike') && 
            o.type !== 'spinner' && o.appearanceType !== 'spinner'
        );
        if (allSpikesNotSpinner) {
            fields.push({ key: 'spikeTouchbox', label: 'Spike Touchbox', type: 'select', options: [
                { value: '', label: 'Use World Default' },
                { value: 'full', label: 'Full Spike' },
                { value: 'normal', label: 'Normal Spike' },
                { value: 'tip', label: 'Tip Spike' },
                { value: 'all-spike', label: 'All Spike' },
                { value: 'ground', label: 'Ground' },
                { value: 'flag', label: 'Flag' },
                { value: 'air', label: 'Air' }
            ]});
            fields.push({ key: 'dropHurtOnly', label: 'Drop Hurt Only', type: 'select', options: [
                { value: '', label: 'Use World Default' },
                { value: 'true', label: 'Enabled' },
                { value: 'false', label: 'Disabled' }
            ]});
        }
        
        // Damage amount — if ALL objects are spikes or spinners (anything that can deal damage)
        const allDamaging = objects.every(o =>
            o.appearanceType === 'spike' || o.actingType === 'spike' ||
            o.type === 'spinner' || o.appearanceType === 'spinner'
        );
        if (allDamaging) {
            fields.push({ key: 'damageAmount', label: 'Damage Amount', type: 'number', min: 0, step: 1, defaultValue: 1 });
        }

        // Width / Height / Spin direction / speed — only if ALL objects are spinners (saw blades)
        const allSpinners = objects.every(o => o.type === 'spinner' || o.appearanceType === 'spinner');
        if (allSpinners) {
            fields.push({
                key: 'width', label: 'Width (blocks)', type: 'number',
                min: 1, step: 0.5, float: true, defaultValue: 2,
                toValue: v => Math.round((v / GRID_SIZE) * 10) / 10,
                fromValue: v => Math.max(GRID_SIZE, Math.round(v * GRID_SIZE))
            });
            fields.push({
                key: 'height', label: 'Height (blocks)', type: 'number',
                min: 1, step: 0.5, float: true, defaultValue: 2,
                toValue: v => Math.round((v / GRID_SIZE) * 10) / 10,
                fromValue: v => Math.max(GRID_SIZE, Math.round(v * GRID_SIZE))
            });
            fields.push({ key: 'spinDirection', label: 'Spin Direction', type: 'select', castInt: true, options: [
                { value: '1', label: 'Clockwise' },
                { value: '-1', label: 'Counter-CW' }
            ]});
            fields.push({ key: 'spinSpeed', label: 'Spin Speed', type: 'number', min: 0, step: 0.1, float: true, defaultValue: 1 });
        }

        // Button fields — only if ALL objects are buttons
        const allButtons = objects.every(o => o.appearanceType === 'button');
        if (allButtons) {
            fields.push({ key: 'displayName', label: 'Display Name', type: 'text' });
            fields.push({ key: 'displayDescription', label: 'Display Description', type: 'textarea' });
            fields.push({ key: 'buttonInteraction', label: 'Interaction (click/collide)', type: 'text' });
            fields.push({ key: 'buttonVisible', label: 'Button Visible', type: 'boolean' });
        }

        // Text content — only if ALL objects are text
        const allText = objects.every(o => o.type === 'text');
        if (allText) {
            fields.push({ key: 'content', label: 'Text Content', type: 'textarea' });
            fields.push({ key: 'font', label: 'Font', type: 'text' });
        }
        
        return fields;
    }
    
    getMultiFieldValue(objects, field) {
        const key = field.key;
        const toValue = field.toValue || (v => v);
        const normalize = v => (v === undefined || v === null) ? '' : v;
        
        let firstVal = toValue(objects[0][key]);
        let allSame = true;
        for (let i = 1; i < objects.length; i++) {
            if (normalize(toValue(objects[i][key])) !== normalize(firstVal)) {
                allSame = false;
                break;
            }
        }
        return { value: firstVal, isMixed: !allSame };
    }
    
    renderMultiEditField(field, objects) {
        const { value, isMixed } = this.getMultiFieldValue(objects, field);
        const mixedStr = isMixed ? 'MIXED' : '';
        
        switch (field.type) {
            case 'text':
                return `
                    <div class="form-group">
                        <label class="form-label">${field.label}</label>
                        <input type="text" class="form-input" data-multi-field="${field.key}" 
                            value="${isMixed ? '' : (value || '')}" placeholder="${isMixed ? 'MIXED' : ''}">
                    </div>`;
                    
            case 'textarea':
                return `
                    <div class="form-group">
                        <label class="form-label">${field.label}</label>
                        <textarea class="form-input" data-multi-field="${field.key}" rows="3" 
                            placeholder="${isMixed ? 'MIXED' : ''}" style="resize: vertical;">${isMixed ? '' : (value || '')}</textarea>
                    </div>`;
                    
            case 'color':
                return `
                    <div class="form-group">
                        <label class="form-label">${field.label}</label>
                        <div class="color-picker-option">
                            <div class="color-preview" data-multi-color-preview="${field.key}" 
                                style="background: ${isMixed ? 'linear-gradient(135deg, #ff6b6b 25%, #4ecdc4 25%, #4ecdc4 50%, #ff6b6b 50%, #ff6b6b 75%, #4ecdc4 75%)' : value}"></div>
                            <input type="text" class="form-input form-input-sm color-input" data-multi-field="${field.key}" 
                                value="${isMixed ? '' : value}" placeholder="${isMixed ? 'MIXED' : ''}">
                        </div>
                    </div>`;
                    
            case 'range': {
                const displayVal = isMixed ? 'MIXED' : `${value}%`;
                const rangeVal = isMixed ? field.min : value;
                return `
                    <div class="form-group">
                        <label class="form-label">${field.label}</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="range" class="form-range" data-multi-field="${field.key}" 
                                min="${field.min}" max="${field.max}" value="${rangeVal}" style="flex: 1;">
                            <span data-multi-range-label="${field.key}" style="font-size: 12px; min-width: 45px;">${displayVal}</span>
                        </div>
                    </div>`;
            }
            
            case 'rotation':
                return `
                    <div class="form-group">
                        <label class="form-label">${field.label}</label>
                        <div class="placement-option-btns" style="justify-content: flex-start;">
                            <button class="placement-opt-btn" data-multi-rotate="-90" title="Rotate Left">
                                <span class="material-symbols-outlined" style="font-size: 16px;">rotate_left</span>
                            </button>
                            <button class="placement-opt-btn" data-multi-rotate="90" title="Rotate Right">
                                <span class="material-symbols-outlined" style="font-size: 16px;">rotate_right</span>
                            </button>
                            <span data-multi-rotation-label style="font-size: 12px; margin-left: 8px;">${isMixed ? 'MIXED' : value + '°'}</span>
                        </div>
                    </div>`;
            
            case 'boolean': {
                const checked = isMixed ? false : !!value;
                return `
                    <div class="form-group" style="position: relative;">
                        <label class="form-label">${field.label}</label>
                        <label class="toggle" style="position: relative;">
                            <input type="checkbox" data-multi-field="${field.key}" ${checked ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                            ${isMixed ? `<div class="multi-mixed-overlay" data-multi-mixed="${field.key}">MIXED</div>` : ''}
                        </label>
                    </div>`;
            }
            
            case 'select': {
                const normalizeVal = v => v === undefined || v === null ? '' : String(v);
                const optionsHTML = field.options.map(o => 
                    `<option value="${o.value}" ${!isMixed && normalizeVal(value) === normalizeVal(o.value) ? 'selected' : ''}>${o.label}</option>`
                ).join('');
                return `
                    <div class="form-group" style="position: relative;">
                        <label class="form-label">${field.label}</label>
                        <select class="form-select" data-multi-field="${field.key}">
                            ${optionsHTML}
                        </select>
                        ${isMixed ? `<div class="multi-mixed-overlay multi-mixed-select" data-multi-mixed="${field.key}">MIXED</div>` : ''}
                    </div>`;
            }
            
            case 'number': {
                const numVal = isMixed ? '' : (value !== undefined ? value : (field.defaultValue ?? ''));
                return `
                    <div class="form-group">
                        <label class="form-label">${field.label}</label>
                        <input type="number" class="form-input form-input-sm" data-multi-field="${field.key}"
                            value="${numVal}" min="${field.min ?? ''}" step="${field.step ?? 1}"
                            placeholder="${isMixed ? 'MIXED' : ''}" style="width: 90px;">
                    </div>`;
            }

            default:
                return '';
        }
    }
    
    attachMultiEditListeners(popup, objects, fields, touchedFields) {
        // Text / textarea / color inputs
        popup.querySelectorAll('input[data-multi-field], textarea[data-multi-field]').forEach(input => {
            const key = input.dataset.multiField;
            const field = fields.find(f => f.key === key);
            if (!field) return;
            
            const handler = () => {
                touchedFields.add(key);
                let val = input.type === 'checkbox' ? input.checked : input.value;
                
                // Remove mixed overlay if present
                const mixedOverlay = popup.querySelector(`[data-multi-mixed="${key}"]`);
                if (mixedOverlay) mixedOverlay.remove();
                
                if (field.type === 'number') {
                    const _parsed = field.float ? parseFloat(val) : parseInt(val);
                    val = Math.max(field.min ?? -Infinity, isNaN(_parsed) ? (field.defaultValue ?? 0) : _parsed);
                    input.value = val;
                    if (field.fromValue) val = field.fromValue(val);
                }

                if (field.type === 'range') {
                    const fromValue = field.fromValue || (v => v);
                    const rangeLabel = popup.querySelector(`[data-multi-range-label="${key}"]`);
                    if (rangeLabel) rangeLabel.textContent = val + '%';
                    val = fromValue(parseFloat(val));
                }
                
                if (field.type === 'color') {
                    const preview = popup.querySelector(`[data-multi-color-preview="${key}"]`);
                    if (preview) preview.style.background = val;
                }
                
                for (const obj of objects) {
                    obj[key] = val;
                }
                this.triggerMapChange();
            };
            
            if (input.type === 'range') {
                input.addEventListener('input', handler);
            } else if (input.type === 'checkbox') {
                input.addEventListener('change', handler);
            } else {
                input.addEventListener('change', handler);
            }
        });
        
        // Select fields
        popup.querySelectorAll('select[data-multi-field]').forEach(select => {
            const key = select.dataset.multiField;
            select.addEventListener('change', () => {
                touchedFields.add(key);
                const mixedOverlay = popup.querySelector(`[data-multi-mixed="${key}"]`);
                if (mixedOverlay) mixedOverlay.remove();
                
                const _selField = fields.find(f => f.key === key);
                let val = select.value;
                if (val === 'true') val = true;
                else if (val === 'false') val = false;
                else if (val === '') val = undefined;
                else if (_selField?.castInt) val = parseInt(val);
                
                for (const obj of objects) {
                    const previousShape = obj[key];
                    obj[key] = val;
                    if (key === 'collisionShape' && val !== 'box') obj.oneWayPlatform = false;
                    if (key === 'collisionShape' && val === 'polygon' && previousShape !== 'polygon') obj.polygonOneWay = true;
                    if (key === 'collisionShape' && val === 'polygon' && !WorldObject.normalizeCollisionPolygon(obj.collisionPoints)) {
                        obj.collisionPoints = WorldObject.DEFAULT_COLLISION_POLYGON.map(point => point.slice());
                    }
                }
                this.triggerMapChange();
            });
        });
        
        // Mixed overlays — clicking removes them and marks field as touched
        popup.querySelectorAll('[data-multi-mixed]').forEach(overlay => {
            overlay.addEventListener('click', () => {
                const key = overlay.dataset.multiMixed;
                touchedFields.add(key);
                overlay.remove();
            });
        });
        
        // Rotation buttons
        popup.querySelectorAll('[data-multi-rotate]').forEach(btn => {
            btn.addEventListener('click', () => {
                touchedFields.add('rotation');
                const deg = parseInt(btn.dataset.multiRotate);
                for (const obj of objects) {
                    this.rotateObjectWithBouncerSync(obj, deg);
                }
                // Update label
                const label = popup.querySelector('[data-multi-rotation-label]');
                if (label) {
                    const { value: newVal, isMixed: newMixed } = this.getMultiFieldValue(objects, { key: 'rotation' });
                    label.textContent = newMixed ? 'MIXED' : newVal + '°';
                }
                this.triggerMapChange();
            });
        });
        
        // Color preview click to open color picker
        popup.querySelectorAll('[data-multi-color-preview]').forEach(preview => {
            preview.addEventListener('click', () => {
                const key = preview.dataset.multiColorPreview;
                const input = popup.querySelector(`input[data-multi-field="${key}"]`);
                if (input) {
                    // Create a temporary color input
                    const colorPicker = document.createElement('input');
                    colorPicker.type = 'color';
                    colorPicker.value = input.value || '#787878';
                    colorPicker.style.position = 'fixed';
                    colorPicker.style.opacity = '0';
                    document.body.appendChild(colorPicker);
                    colorPicker.click();
                    colorPicker.addEventListener('input', () => {
                        input.value = colorPicker.value;
                        preview.style.background = colorPicker.value;
                        for (const obj of objects) {
                            obj[key] = colorPicker.value;
                        }
                        this.triggerMapChange();
                    });
                    colorPicker.addEventListener('change', () => {
                        setTimeout(() => colorPicker.remove(), 100);
                    });
                }
            });
        });
    }

    // ========================================
    // PANEL MANAGEMENT
    // ========================================
    togglePanel(panel) {
        const panels = {
            config: this.ui.configPanel,
            layers: this.ui.layersPanel,
            settings: this.ui.settingsPanel
        };

        const targetPanel = panels[panel];
        const isActive = targetPanel.classList.contains('active');

        // Close all panels and add menu
        Object.values(panels).forEach(p => p.classList.remove('active'));
        this.ui.addMenu.classList.remove('active');

        // Toggle target panel
        if (!isActive) {
            targetPanel.classList.add('active');
            if (panel === 'layers') {
                this.updateLayersList();
            }
        }
    }

    closePanel(panel) {
        const panels = {
            config: this.ui.configPanel,
            layers: this.ui.layersPanel,
            settings: this.ui.settingsPanel
        };
        panels[panel]?.classList.remove('active');
    }

    _updateSettingsKBInfo(layout) {
        const ids = ['jimmyqrg', 'hk'];
        ids.forEach(id => {
            const el = document.getElementById('settings-kb-' + id);
            if (el) el.style.display = id === layout ? 'block' : 'none';
        });
    }

    _updateSpinnerUnitLabels() {
        const wUnit = document.getElementById('object-edit-spinner-width-unit');
        const hUnit = document.getElementById('object-edit-spinner-height-unit');
        const wInput = document.getElementById('object-edit-spinner-width');
        const hInput = document.getElementById('object-edit-spinner-height');
        if (wUnit) {
            const wVal = parseFloat(wInput.value) || 0;
            const wOpts = wUnit.options;
            wOpts[0].text = wVal === 1 ? 'Block' : 'Blocks';
            wOpts[1].text = wVal === 1 ? 'Unit' : 'Units';
        }
        if (hUnit) {
            const hVal = parseFloat(hInput.value) || 0;
            const hOpts = hUnit.options;
            hOpts[0].text = hVal === 1 ? 'Block' : 'Blocks';
            hOpts[1].text = hVal === 1 ? 'Unit' : 'Units';
        }
    }

    toggleAddMenu() {
        const isActive = this.ui.addMenu.classList.contains('active');
        
        // Close all panels
        this.ui.configPanel.classList.remove('active');
        this.ui.layersPanel.classList.remove('active');
        this.ui.settingsPanel.classList.remove('active');
        
        // Toggle add menu
        if (!isActive) {
            this.ui.addMenu.classList.add('active');
        } else {
            this.ui.addMenu.classList.remove('active');
        }
    }

    closeAddMenu() {
        this.ui.addMenu.classList.remove('active');
    }

    // ========================================
    // PLACEMENT MODE
    // ========================================
    startPlacement(mode) {
        this.closeAddMenu();

        if (mode === 'object_stamp') {
            this.openObjectStampPicker();
            return;
        }

        // Obstacle mode for spike and saw blade
        if (mode === 'obstacle') {
            this.placementMode = PlacementMode.OBSTACLE;
            // Default to spike appearance
            if (!this.obstacleSettings.appearanceType) {
                this.obstacleSettings.appearanceType = 'spike';
            }
        } else {
        this.placementMode = mode;
            // Reset block to ground if coming from obstacle mode
            if (mode === 'block') {
                this.placementSettings.appearanceType = 'ground';
                this.placementSettings.actingType = 'ground';
            }
        }

        // Disable non-fly tools when entering placement mode
        this.disableNonFlyTools();
        
        // Update UI - change add button to close icon (click handler checks placementMode)
        this.ui.btnAdd.innerHTML = '<span class="material-symbols-outlined">close</span>';
        
        this.ui.placementToolbar.classList.add('active');

        // Show/hide options based on mode
        this.updatePlacementOptions();
        this.updateDefaultColor();
    }

    stopPlacement() {
        this.placementMode = PlacementMode.NONE;
        this.objectStampPlacementId = null;
        this.isPlacing = false;
        
        // Reset UI - restore add icon (click handler checks placementMode)
        this.ui.btnAdd.innerHTML = '<span class="material-symbols-outlined">add</span>';
        
        // Make sure button is visible and enabled (test mode hides editor chrome — do not reveal)
        if (this.engine.state !== GameState.TESTING) {
            this.ui.btnAdd.classList.remove('hidden');
        }
        this.ui.btnAdd.disabled = false;
        this.ui.btnAdd.style.pointerEvents = '';
        
        this.ui.placementToolbar.classList.remove('active');
        
        // Ensure add menu is closed
        this.closeAddMenu();
    }

    updateTilemapAnimationFrameControls() {
        const container = document.getElementById('placement-tilemap-frame-selectors');
        if (!container) return;
        const atlas = this.world.tilemaps.find(tilemap => tilemap.layer === this.tilemapLayer)?.atlas;
        if (this.tilemapAnimation === 'atlasCycle' && atlas) {
            const maxFrame = atlas.columns * atlas.rows - 1;
            container.innerHTML = Array.from({ length: 8 }, (_, index) => {
                this.tilemapAtlasAnimationFrames[index] = Math.max(0, Math.min(maxFrame,
                    Math.floor(Number(this.tilemapAtlasAnimationFrames[index]) || 0)));
                const hidden = index >= this.tilemapAnimationFrameCount ? ' hidden' : '';
                return `<label class="placement-option-label${hidden}" style="display:flex;align-items:center;gap:4px;">${index + 1}<input class="form-input form-input-sm" type="number" min="0" max="${maxFrame}" step="1" value="${this.tilemapAtlasAnimationFrames[index]}" data-frame-index="${index}" aria-label="Tile atlas animation frame ${index + 1}" style="width:78px;"></label>`;
            }).join('');
            return;
        }
        const textures = [
            ['solid', 'Solid'], ['brick', 'Brick'], ['stone', 'Stone'],
            ['wood', 'Wood'], ['moss', 'Moss']
        ];
        container.innerHTML = Array.from({ length: 8 }, (_, index) => {
            const hidden = index >= this.tilemapAnimationFrameCount ? ' hidden' : '';
            const options = textures.map(([value, label]) =>
                `<option value="${value}"${this.tilemapAnimationFrames[index] === value ? ' selected' : ''}>${label}</option>`
            ).join('');
            return `<label class="placement-option-label${hidden}" style="display:flex;align-items:center;gap:4px;">${index + 1}<select class="form-input form-input-sm" data-frame-index="${index}" aria-label="Tile animation frame ${index + 1} texture" style="max-width:120px;">${options}</select></label>`;
        }).join('');
    }

    loadTilemapAtlas(file) {
        const status = document.getElementById('placement-tilemap-atlas-status');
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
            if (status) status.textContent = 'Choose a PNG, JPEG, or WebP tile atlas up to 1 MiB.';
            return;
        }
        const frameWidth = Math.floor(Number(document.getElementById('placement-tilemap-frame-width')?.value));
        const frameHeight = Math.floor(Number(document.getElementById('placement-tilemap-frame-height')?.value));
        if (!Number.isInteger(frameWidth) || frameWidth < 1 || frameWidth > 512 ||
            !Number.isInteger(frameHeight) || frameHeight < 1 || frameHeight > 512) {
            if (status) status.textContent = 'Atlas frame dimensions must be between 1 and 512 pixels.';
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => { if (status) status.textContent = 'The tile atlas could not be read.'; };
        reader.onload = () => {
            if (typeof reader.result !== 'string') return;
            const image = new Image();
            image.onerror = () => { if (status) status.textContent = 'The selected file is not a valid image.'; };
            image.onload = () => {
                const columns = image.naturalWidth / frameWidth;
                const rows = image.naturalHeight / frameHeight;
                if (image.naturalWidth > 4096 || image.naturalHeight > 4096 ||
                    image.naturalWidth * image.naturalHeight > 16000000 ||
                    image.naturalWidth % frameWidth !== 0 || image.naturalHeight % frameHeight !== 0 ||
                    columns > 128 || rows > 128 || columns * rows > 4096) {
                    if (status) status.textContent = 'Image dimensions must divide evenly into the frame size and contain at most 4096 frames (128 columns or rows).';
                    return;
                }
                const atlas = {
                    data: reader.result,
                    frameWidth,
                    frameHeight,
                    columns,
                    rows
                };
                if (!this.world.setTilemapAtlas(atlas, this.tilemapLayer)) {
                    if (status) status.textContent = 'The map has reached its combined 8 MiB sprite data or 32 megapixel tile atlas limit.';
                    return;
                }
                this.tilemapAtlasFrame = 0;
                const frameInput = document.getElementById('placement-tilemap-atlas-frame');
                if (frameInput) {
                    frameInput.max = String(atlas.columns * atlas.rows - 1);
                    frameInput.value = '0';
                }
                this.updateTilemapAtlasStatus();
                this.triggerMapChange();
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    updateTilemapAtlasStatus() {
        const tilemap = this.world.tilemaps.find(item => item.layer === this.tilemapLayer);
        const atlas = tilemap?.atlas;
        const frameInput = document.getElementById('placement-tilemap-atlas-frame');
        if (frameInput) {
            const maxFrame = atlas ? atlas.columns * atlas.rows - 1 : 0;
            this.tilemapAtlasFrame = Math.min(this.tilemapAtlasFrame, maxFrame);
            frameInput.max = String(maxFrame);
            frameInput.value = String(this.tilemapAtlasFrame);
        }
        const status = document.getElementById('placement-tilemap-atlas-status');
        if (status) status.textContent = atlas
            ? `${atlas.columns * atlas.rows} frames · ${atlas.frameWidth} × ${atlas.frameHeight} px · layer ${this.tilemapLayer}`
            : 'No atlas selected. Cells use built-in textures.';
        const preview = document.getElementById('placement-tilemap-atlas-preview');
        const previewContext = preview?.getContext('2d');
        if (previewContext) {
            previewContext.clearRect(0, 0, preview.width, preview.height);
            if (atlas) {
                const images = this.world._tilemapAtlasImages || (this.world._tilemapAtlasImages = new Map());
                let image = images.get(atlas.data);
                if (!image) {
                    image = new Image();
                    image.onload = () => {
                        this.world.invalidateTileCache();
                        this.updateTilemapAtlasStatus();
                    };
                    image.src = atlas.data;
                    images.set(atlas.data, image);
                    if (images.size > 24) images.delete(images.keys().next().value);
                }
                if (image.complete && image.naturalWidth > 0) {
                    const sourceX = (this.tilemapAtlasFrame % atlas.columns) * atlas.frameWidth;
                    const sourceY = Math.floor(this.tilemapAtlasFrame / atlas.columns) * atlas.frameHeight;
                    if (sourceX + atlas.frameWidth <= image.naturalWidth && sourceY + atlas.frameHeight <= image.naturalHeight) {
                        previewContext.imageSmoothingEnabled = false;
                        previewContext.drawImage(image, sourceX, sourceY, atlas.frameWidth, atlas.frameHeight, 0, 0, preview.width, preview.height);
                    }
                }
            }
        }
        const frameWidthInput = document.getElementById('placement-tilemap-frame-width');
        const frameHeightInput = document.getElementById('placement-tilemap-frame-height');
        if (atlas && frameWidthInput && frameHeightInput) {
            frameWidthInput.value = String(atlas.frameWidth);
            frameHeightInput.value = String(atlas.frameHeight);
        }
        const animationSelect = document.getElementById('placement-tilemap-animation-select');
        if (animationSelect) {
            const atlasCycleOption = animationSelect.querySelector('option[value="atlasCycle"]');
            if (atlasCycleOption) atlasCycleOption.disabled = !atlas || atlas.columns * atlas.rows < 2;
            if (this.tilemapAnimation === 'atlasCycle' && (!atlas || atlas.columns * atlas.rows < 2)) {
                this.tilemapAnimation = 'none';
                document.getElementById('placement-tilemap-animation-settings')?.classList.add('hidden');
            }
            animationSelect.value = this.tilemapAnimation;
        }
        document.getElementById('placement-tilemap-animation-settings')?.classList.toggle('hidden', this.tilemapAnimation === 'none');
        this.updateTilemapAnimationFrameControls();
    }

    updatePlacementOptions() {
        const options = {
            texture: document.getElementById('placement-texture'),
            appearance: document.getElementById('placement-appearance'),
            acting: document.getElementById('placement-acting'),
            collision: document.getElementById('placement-collision'),
            fill: document.getElementById('placement-fill'),
            coinSnap: document.getElementById('placement-coin-snap'),
            color: document.getElementById('placement-color'),
            opacity: document.getElementById('placement-opacity'),
            tilemapLayer: document.getElementById('placement-tilemap-layer'),
            tilemapBehavior: document.getElementById('placement-tilemap-behavior'),
            tilemapCollisionShape: document.getElementById('placement-tilemap-collision-shape'),
            tilemapAtlas: document.getElementById('placement-tilemap-atlas'),
            tilemapAnimation: document.getElementById('placement-tilemap-animation'),
            content: document.getElementById('placement-content'),
            font: document.getElementById('placement-font'),
            fontSize: document.getElementById('placement-fontsize'),
            fontPreview: document.getElementById('placement-font-preview'),
            halign: document.getElementById('placement-halign'),
            valign: document.getElementById('placement-valign'),
            hspacing: document.getElementById('placement-hspacing'),
            vspacing: document.getElementById('placement-vspacing')
        };

        // Hide all first
        Object.values(options).forEach(el => el && el.classList.add('hidden'));

        const spawnEndMarkerEl = document.getElementById('placement-spawn-end-marker');
        if (spawnEndMarkerEl) spawnEndMarkerEl.classList.add('hidden');

        if (this.placementMode === PlacementMode.TILEMAP) {
            options.texture.classList.remove('hidden');
            options.color.classList.remove('hidden');
            options.opacity.classList.remove('hidden');
            options.tilemapLayer.classList.remove('hidden');
            options.tilemapBehavior.classList.remove('hidden');
            options.tilemapCollisionShape.classList.remove('hidden');
            options.tilemapAtlas.classList.remove('hidden');
            options.tilemapAnimation.classList.remove('hidden');
            const layerSelect = document.getElementById('placement-tilemap-layer-select');
            const definitions = this.world.layerDefinitions || [];
            layerSelect.innerHTML = definitions.map(layer =>
                `<option value="${layer.depth}">${escapeHtml(layer.name)}</option>`
            ).join('');
            if (!definitions.some(layer => layer.depth === this.tilemapLayer)) this.tilemapLayer = 1;
            layerSelect.value = String(this.tilemapLayer);
            document.getElementById('placement-tilemap-behavior-select').value = this.tilemapCellBehavior;
            document.getElementById('placement-tilemap-collision-shape-select').value = this.tilemapCollisionShape;
            const supportsPolygon = ['solid', 'oneWay'].includes(this.tilemapCellBehavior);
            document.getElementById('placement-tilemap-collision-shape-select').disabled = !supportsPolygon;
            document.getElementById('placement-tilemap-polygon-one-way').checked = this.tilemapPolygonOneWay;
            document.getElementById('placement-tilemap-polygon-one-way').disabled = this.tilemapCellBehavior === 'oneWay';
            document.getElementById('placement-tilemap-collision-points').value = JSON.stringify(this.tilemapCollisionPoints);
            document.getElementById('placement-tilemap-polygon-settings').style.display = supportsPolygon && this.tilemapCollisionShape === 'polygon' ? 'flex' : 'none';
            document.getElementById('placement-tilemap-collision-points-status').textContent = `${this.tilemapCollisionPoints.length} valid convex vertices`;
            document.getElementById('placement-tilemap-animation-select').value = this.tilemapAnimation;
            document.getElementById('placement-tilemap-frame-count').value = String(this.tilemapAnimationFrameCount);
            document.getElementById('placement-tilemap-animation-fps').value = String(this.tilemapAnimationFps);
            this.updateTilemapAtlasStatus();
            this.updateTexturePreview();
        } else if (this.placementMode === PlacementMode.BLOCK) {
            options.texture.classList.remove('hidden'); // Show texture dropdown
            options.acting.classList.remove('hidden');
            options.collision.classList.remove('hidden');
            options.fill.classList.remove('hidden');
            options.color.classList.remove('hidden');
            options.opacity.classList.remove('hidden');

            // Check if HK plugin is enabled for Soul Status option
            const hkEnabledForBlock = this.world.plugins.enabled.includes('hk');

            // Update texture preview
            this.updateTexturePreview();

            // Update acting type buttons for block
            const actingBtns = options.acting.querySelector('.placement-option-btns');
            let blockActingHtml = `
                <button class="placement-opt-btn ${this.placementSettings.actingType === 'ground' ? 'active' : ''}" data-acting="ground">Ground</button>
                <button class="placement-opt-btn ${this.placementSettings.actingType === 'spike' ? 'active' : ''}" data-acting="spike">Spike</button>
                <button class="placement-opt-btn ${this.placementSettings.actingType === 'checkpoint' ? 'active' : ''}" data-acting="checkpoint">Check</button>
                <button class="placement-opt-btn ${this.placementSettings.actingType === 'spawnpoint' ? 'active' : ''}" data-acting="spawnpoint">Spawn</button>
                <button class="placement-opt-btn ${this.placementSettings.actingType === 'endpoint' ? 'active' : ''}" data-acting="endpoint">End</button>
            `;
            if (hkEnabledForBlock) {
                blockActingHtml += `
                <button class="placement-opt-btn ${this.placementSettings.actingType === 'soulStatus' ? 'active' : ''}" data-acting="soulStatus">Soul</button>
                `;
            }
            actingBtns.innerHTML = blockActingHtml;
            this.reattachActingListeners();
            
            // Update collision buttons
            document.querySelectorAll('[data-collision]').forEach(btn => {
                btn.classList.toggle('active', (btn.dataset.collision === 'true') === this.placementSettings.collision);
            });
        } else if (this.placementMode === PlacementMode.OBSTACLE) {
            // Obstacle mode - appearance selection (spike or saw blade)
            options.appearance.classList.remove('hidden');
            options.acting.classList.remove('hidden');
            options.fill.classList.remove('hidden');
            options.color.classList.remove('hidden');
            options.opacity.classList.remove('hidden');
            
            // Show collision only for spike appearance
            if (this.obstacleSettings.appearanceType === 'spike') {
                options.collision.classList.remove('hidden');
            }

            // Check if HK plugin is enabled for Soul Statue option
            const hkEnabledForObstacle = this.world.plugins.enabled.includes('hk');

            // Update appearance buttons for obstacle
            const appearanceBtnsObstacle = options.appearance.querySelector('.placement-option-btns');
            appearanceBtnsObstacle.innerHTML = `
                <button class="placement-opt-btn ${this.obstacleSettings.appearanceType === 'spike' ? 'active' : ''}" data-appearance="spike">Spike</button>
                <button class="placement-opt-btn ${this.obstacleSettings.appearanceType === 'spinner' ? 'active' : ''}" data-appearance="spinner">Saw Blade</button>
            `;
            this.reattachAppearanceListeners();

            // Update acting type buttons for obstacle
            const actingBtnsObstacle = options.acting.querySelector('.placement-option-btns');
            let obstacleActingHtml = `
                <button class="placement-opt-btn ${this.obstacleSettings.actingType === 'spike' ? 'active' : ''}" data-acting="spike">Spike</button>
                <button class="placement-opt-btn ${this.obstacleSettings.actingType === 'ground' ? 'active' : ''}" data-acting="ground">Ground</button>
                <button class="placement-opt-btn ${this.obstacleSettings.actingType === 'portal' ? 'active' : ''}" data-acting="portal">Portal</button>
            `;
            if (hkEnabledForObstacle) {
                obstacleActingHtml += `<button class="placement-opt-btn ${this.obstacleSettings.actingType === 'soulStatue' ? 'active' : ''}" data-acting="soulStatue">Soul</button>`;
            }
            actingBtnsObstacle.innerHTML = obstacleActingHtml;
            this.reattachActingListeners();

            // Update collision buttons
            document.querySelectorAll('[data-collision]').forEach(btn => {
                btn.classList.toggle('active', (btn.dataset.collision === 'true') === this.obstacleSettings.collision);
            });

            // Sync color picker with obstacle settings
            const obstacleColor = this.obstacleSettings.color || '#ff4444';
            document.getElementById('placement-color-preview').style.background = obstacleColor;
            document.getElementById('placement-color-input').value = obstacleColor;

            // Sync opacity
            const obstacleOpacity = Math.round((this.obstacleSettings.opacity || 1) * 100);
            document.getElementById('placement-opacity-input').value = obstacleOpacity;
        } else if (this.placementMode === PlacementMode.SPAWN_END) {
            if (spawnEndMarkerEl) spawnEndMarkerEl.classList.remove('hidden');
            options.fill.classList.remove('hidden');
            options.color.classList.remove('hidden');
            options.opacity.classList.remove('hidden');

            const markerBtns = spawnEndMarkerEl && spawnEndMarkerEl.querySelector('.placement-option-btns');
            if (markerBtns) {
                const pt = this.spawnEndSettings.pointType;
                markerBtns.innerHTML = `
                    <button class="placement-opt-btn ${pt === 'spawnpoint' ? 'active' : ''}" data-spawn-end-marker="spawnpoint">Spawn</button>
                    <button class="placement-opt-btn ${pt === 'endpoint' ? 'active' : ''}" data-spawn-end-marker="endpoint">End</button>
                `;
            }
            this.reattachSpawnEndMarkerListeners();

            document.querySelectorAll('[data-fill]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.fill === (this.spawnEndSettings.fillMode || 'add'));
            });

            const seColor = this.spawnEndSettings.color || '#4CAF50';
            document.getElementById('placement-color-preview').style.background = seColor;
            document.getElementById('placement-color-input').value = seColor;

            const seOpacity = Math.round((this.spawnEndSettings.opacity != null ? this.spawnEndSettings.opacity : 1) * 100);
            document.getElementById('placement-opacity-input').value = seOpacity;
        } else if (this.placementMode === PlacementMode.KOREEN) {
            if (this.koreenSettings.appearanceType === 'spawnpoint' || this.koreenSettings.appearanceType === 'endpoint') {
                this.koreenSettings.appearanceType = 'checkpoint';
                this.koreenSettings.actingType = 'checkpoint';
            }
            if (this.koreenSettings.actingType === 'spawnpoint' || this.koreenSettings.actingType === 'endpoint') {
                this.koreenSettings.actingType = 'checkpoint';
            }

            options.appearance.classList.remove('hidden');
            options.acting.classList.remove('hidden');
            options.fill.classList.remove('hidden');
            options.opacity.classList.remove('hidden');

            // Check if HK plugin is enabled for Soul Statue option
            const hkEnabled = this.world.plugins.enabled.includes('hk');

            // Update appearance for koreen (spawn/end use the dedicated "Spawn & end" add tool)
            const appearanceBtns = options.appearance.querySelector('.placement-option-btns');
            let koreenAppearanceHtml = `
                <button class="placement-opt-btn ${this.koreenSettings.appearanceType === 'checkpoint' ? 'active' : ''}" data-appearance="checkpoint">Checkpoint</button>
                <button class="placement-opt-btn ${this.koreenSettings.appearanceType === 'zone' ? 'active' : ''}" data-appearance="zone">Zone</button>
                <button class="placement-opt-btn ${this.koreenSettings.appearanceType === 'bouncer' ? 'active' : ''}" data-appearance="bouncer">Bouncer</button>
                <button class="placement-opt-btn ${this.koreenSettings.appearanceType === 'coin' ? 'active' : ''}" data-appearance="coin">Coin</button>
            `;
            if (hkEnabled) {
                koreenAppearanceHtml += `
                <button class="placement-opt-btn ${this.koreenSettings.appearanceType === 'soulStatue' ? 'active' : ''}" data-appearance="soulStatue">Soul Statue</button>
                `;
            }
            appearanceBtns.innerHTML = koreenAppearanceHtml;
            this.reattachAppearanceListeners();

            // Update acting type buttons for koreen (zone-only if appearance is zone, soulStatus if appearance is soulStatue)
            const actingBtns = options.acting.querySelector('.placement-option-btns');
            if (this.koreenSettings.appearanceType === 'zone') {
            actingBtns.innerHTML = `
                    <button class="placement-opt-btn active" data-acting="zone">Zone</button>
                `;
                this.koreenSettings.actingType = 'zone';
            } else if (this.koreenSettings.appearanceType === 'soulStatue') {
                actingBtns.innerHTML = `
                    <button class="placement-opt-btn active" data-acting="soulStatus">Soul Statue</button>
                `;
                this.koreenSettings.actingType = 'soulStatus';
            } else if (this.koreenSettings.appearanceType === 'bouncer') {
                actingBtns.innerHTML = `
                    <button class="placement-opt-btn active" data-acting="bouncer">Bouncer</button>
                `;
                this.koreenSettings.actingType = 'bouncer';
                this.koreenSettings.color = this.world.defaultBouncerColor || '#461A0C';
            } else if (this.koreenSettings.appearanceType === 'coin') {
                actingBtns.innerHTML = `<button class="placement-opt-btn active" data-acting="coin">Coin</button>`;
                this.koreenSettings.actingType = 'coin';
                this.koreenSettings.collision = false;
                options.coinSnap.classList.remove('hidden');
                document.querySelectorAll('[data-coin-snap]').forEach(btn => {
                    btn.classList.toggle('active', (btn.dataset.coinSnap === 'true') === (this.koreenSettings.coinSnapToGrid !== false));
                });
            } else {
                let koreenActingHtml = `
                <button class="placement-opt-btn ${this.koreenSettings.actingType === 'checkpoint' ? 'active' : ''}" data-acting="checkpoint">Check</button>
                <button class="placement-opt-btn ${this.koreenSettings.actingType === 'text' ? 'active' : ''}" data-acting="text">Text</button>
            `;
                if (hkEnabled) {
                    koreenActingHtml += `
                <button class="placement-opt-btn ${this.koreenSettings.actingType === 'soulStatus' ? 'active' : ''}" data-acting="soulStatus">Soul</button>
                    `;
                }
                actingBtns.innerHTML = koreenActingHtml;
            }
            this.reattachActingListeners();
        } else if (this.placementMode === PlacementMode.TEXT) {
            options.fill.classList.remove('hidden');
            options.content.classList.remove('hidden');
            options.acting.classList.remove('hidden');
            options.font.classList.remove('hidden');
            options.fontSize.classList.remove('hidden');
            options.fontPreview.classList.remove('hidden');
            options.color.classList.remove('hidden');
            options.opacity.classList.remove('hidden');
            options.halign.classList.remove('hidden');
            options.valign.classList.remove('hidden');
            options.hspacing.classList.remove('hidden');
            options.vspacing.classList.remove('hidden');

            // Update acting type buttons for text
            const actingBtns = options.acting.querySelector('.placement-option-btns');
            actingBtns.innerHTML = `
                <button class="placement-opt-btn ${this.textSettings.actingType === 'ground' ? 'active' : ''}" data-acting="ground">Ground</button>
                <button class="placement-opt-btn ${this.textSettings.actingType === 'spike' ? 'active' : ''}" data-acting="spike">Spike</button>
                <button class="placement-opt-btn ${this.textSettings.actingType === 'checkpoint' ? 'active' : ''}" data-acting="checkpoint">Check</button>
                <button class="placement-opt-btn ${this.textSettings.actingType === 'spawnpoint' ? 'active' : ''}" data-acting="spawnpoint">Spawn</button>
                <button class="placement-opt-btn ${this.textSettings.actingType === 'endpoint' ? 'active' : ''}" data-acting="endpoint">End</button>
                <button class="placement-opt-btn ${this.textSettings.actingType === 'text' ? 'active' : ''}" data-acting="text">Text</button>
            `;
            this.reattachActingListeners();
            
            // Update content input (textarea) with font
            const contentInput = document.getElementById('placement-content-input');
            if (contentInput) {
                contentInput.value = this.textSettings.content || '';
                contentInput.style.fontFamily = `"${this.textSettings.font || 'Parkoreen Game'}"`;
            }
            
            // Update font dropdown value
            const fontValue = document.getElementById('font-dropdown-value');
            if (fontValue) {
                fontValue.textContent = this.textSettings.font || 'Parkoreen Game';
                fontValue.style.fontFamily = `"${this.textSettings.font || 'Parkoreen Game'}"`;
            }
            
            // Update font size input
            const fontSizeInput = document.getElementById('placement-fontsize-input');
            if (fontSizeInput) {
                fontSizeInput.value = this.textSettings.fontSize || 24;
            }
            
            // Update font preview
            this.updatePlacementFontPreview();
            
            // Update color picker
            const colorInput = document.querySelector('#placement-color input[type="color"]');
            if (colorInput) {
                colorInput.value = this.textSettings.color || '#000000';
            }
        } else if (this.placementMode === PlacementMode.TELEPORTAL) {
            // Teleportal options - acting type, color, and opacity
            options.fill.classList.remove('hidden');
            options.acting.classList.remove('hidden');
            options.color.classList.remove('hidden');
            options.opacity.classList.remove('hidden');
            
            // Update acting type buttons for teleportal
            const actingBtns = options.acting.querySelector('.placement-option-btns');
            actingBtns.innerHTML = `
                <button class="placement-opt-btn ${this.teleportalSettings.actingType === 'portal' ? 'active' : ''}" data-acting="portal">Portal</button>
                <button class="placement-opt-btn ${this.teleportalSettings.actingType === 'ground' ? 'active' : ''}" data-acting="ground">Ground</button>
                <button class="placement-opt-btn ${this.teleportalSettings.actingType === 'spike' ? 'active' : ''}" data-acting="spike">Spike</button>
                <button class="placement-opt-btn ${this.teleportalSettings.actingType === 'checkpoint' ? 'active' : ''}" data-acting="checkpoint">Check</button>
                <button class="placement-opt-btn ${this.teleportalSettings.actingType === 'spawnpoint' ? 'active' : ''}" data-acting="spawnpoint">Spawn</button>
                <button class="placement-opt-btn ${this.teleportalSettings.actingType === 'endpoint' ? 'active' : ''}" data-acting="endpoint">End</button>
                <button class="placement-opt-btn ${this.teleportalSettings.actingType === 'text' ? 'active' : ''}" data-acting="text">Text</button>
            `;
            this.reattachActingListeners();
            
            // Sync color picker with teleportal settings
            const teleportalColor = this.teleportalSettings.color || this.world.defaultPortalColor || '#9b59b6';
            this.teleportalSettings.color = teleportalColor;
            document.getElementById('placement-color-preview').style.background = teleportalColor;
            document.getElementById('placement-color-input').value = teleportalColor;
            
            // Sync opacity
            const teleportalOpacity = Math.round((this.teleportalSettings.opacity || 1) * 100);
            document.getElementById('placement-opacity-input').value = teleportalOpacity;
        } else if (this.placementMode === PlacementMode.BUTTON) {
            // Button mode - only opacity, drag-to-place like zones
            options.fill.classList.remove('hidden');
            options.opacity.classList.remove('hidden');
            
            const opacity = Math.round((this.koreenSettings.opacity || 1) * 100);
            document.getElementById('placement-opacity-input').value = opacity;
        }

        this.syncFillModeUI();
    }

    syncFillModeUI() {
        let fillMode = 'add';
        if (this.placementMode === PlacementMode.BLOCK) {
            fillMode = this.placementSettings.fillMode || 'add';
        } else if (this.placementMode === PlacementMode.OBSTACLE) {
            fillMode = this.obstacleSettings.fillMode || 'add';
        } else if (this.placementMode === PlacementMode.KOREEN) {
            fillMode = this.koreenSettings.fillMode || 'add';
        } else if (this.placementMode === PlacementMode.SPAWN_END) {
            fillMode = this.spawnEndSettings.fillMode || 'add';
        } else if (this.placementMode === PlacementMode.TEXT) {
            fillMode = this.textSettings.fillMode || 'add';
        } else if (this.placementMode === PlacementMode.TELEPORTAL) {
            fillMode = this.teleportalSettings.fillMode || 'add';
        } else if (this.placementMode === PlacementMode.BUTTON) {
            fillMode = this.buttonSettings.fillMode || 'add';
        }

        document.querySelectorAll('[data-fill]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.fill === fillMode);
        });
    }

    getOverlappingObjectsInArea(x, y, w, h) {
        return this.world.objects.filter((obj) =>
            x < obj.x + obj.width &&
            x + w > obj.x &&
            y < obj.y + obj.height &&
            y + h > obj.y
        );
    }

    applyFillModeToArea(fillMode, x, y, w, h) {
        const mode = fillMode || 'add';
        const overlaps = this.getOverlappingObjectsInArea(x, y, w, h);

        if (mode === 'add' && overlaps.length > 0) {
            return false;
        }

        if (mode === 'replace' && overlaps.length > 0) {
            for (const existing of overlaps) {
                this.world.removeObject(existing.id);
            }
        }

        return true;
    }

    updatePlacementFontPreview() {
        const previewText = document.getElementById('font-preview-text');
        if (!previewText) return;
        
        const content = this.textSettings.content || 'Text';
        const font = this.textSettings.font || 'Parkoreen Game';
        const color = this.textSettings.color || '#FFFFFF';
        const fontSize = this.textSettings.fontSize || 24;
        // Scale preview font size - cap at 32px for the preview box
        const previewFontSize = Math.min(fontSize, 32);
        
        previewText.textContent = content.split('\n')[0].substring(0, 30) || 'Text';
        previewText.style.fontFamily = `"${font}"`;
        previewText.style.color = color;
        previewText.style.fontSize = `${previewFontSize}px`;
        
        const box = document.getElementById('font-preview-box');
        if (box) box.style.background = this.contrastBackground(color);
    }

    reattachAppearanceListeners() {
        const container = document.querySelector('#placement-appearance .placement-option-btns');
        if (!container) return;
        
        // Clone and replace to remove all event listeners
        const newContainer = container.cloneNode(true);
        container.parentNode.replaceChild(newContainer, container);
        
        newContainer.querySelectorAll('[data-appearance]').forEach(btn => {
            btn.addEventListener('click', () => {
                // Zones are always available (mechanics are built-in)
                newContainer.querySelectorAll('[data-appearance]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (this.placementMode === PlacementMode.BLOCK) {
                    this.placementSettings.appearanceType = btn.dataset.appearance;
                    // Sync acting type with appearance type for blocks
                    this.placementSettings.actingType = btn.dataset.appearance;
                    this.syncActingTypeUI(btn.dataset.appearance);
                } else if (this.placementMode === PlacementMode.OBSTACLE) {
                    this.obstacleSettings.appearanceType = btn.dataset.appearance;
                    // Refresh placement options to update UI based on new appearance
                    this.updatePlacementOptions();
                } else if (this.placementMode === PlacementMode.KOREEN) {
                    this.koreenSettings.appearanceType = btn.dataset.appearance;
                    
                    // Rebuild acting type buttons based on appearance (zone vs non-zone vs soulStatue)
                    const actingBtns = document.querySelector('#placement-acting .placement-option-btns');
                    const hkEnabled = this.world.plugins.enabled.includes('hk');
                    
                    if (btn.dataset.appearance === 'zone') {
                        actingBtns.innerHTML = `
                            <button class="placement-opt-btn active" data-acting="zone">Zone</button>
                        `;
                        this.koreenSettings.actingType = 'zone';
                    } else if (btn.dataset.appearance === 'soulStatue') {
                        actingBtns.innerHTML = `
                            <button class="placement-opt-btn active" data-acting="soulStatus">Soul Statue</button>
                        `;
                        this.koreenSettings.actingType = 'soulStatus';
                    } else if (btn.dataset.appearance === 'bouncer') {
                        actingBtns.innerHTML = `
                            <button class="placement-opt-btn active" data-acting="bouncer">Bouncer</button>
                        `;
                        this.koreenSettings.actingType = 'bouncer';
                    } else {
                    // Sync acting type with appearance type for koreens
                    this.koreenSettings.actingType = btn.dataset.appearance;
                        let koreenActingHtml = `
                            <button class="placement-opt-btn ${this.koreenSettings.actingType === 'checkpoint' ? 'active' : ''}" data-acting="checkpoint">Check</button>
                            <button class="placement-opt-btn ${this.koreenSettings.actingType === 'text' ? 'active' : ''}" data-acting="text">Text</button>
                        `;
                        if (hkEnabled) {
                            koreenActingHtml += `
                            <button class="placement-opt-btn ${this.koreenSettings.actingType === 'soulStatus' ? 'active' : ''}" data-acting="soulStatus">Soul</button>
                            `;
                        }
                        actingBtns.innerHTML = koreenActingHtml;
                    }
                    this.reattachActingListeners();
                }
                this.updateDefaultColor();
            });
        });
    }

    reattachActingListeners() {
        const container = document.querySelector('#placement-acting .placement-option-btns');
        if (!container) return;
        
        // Clone and replace to remove all event listeners
        const newContainer = container.cloneNode(true);
        container.parentNode.replaceChild(newContainer, container);
        
        newContainer.querySelectorAll('[data-acting]').forEach(btn => {
            btn.addEventListener('click', () => {
                newContainer.querySelectorAll('.placement-opt-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (this.placementMode === PlacementMode.BLOCK) {
                    this.placementSettings.actingType = btn.dataset.acting;
                } else if (this.placementMode === PlacementMode.OBSTACLE) {
                    this.obstacleSettings.actingType = btn.dataset.acting;
                } else if (this.placementMode === PlacementMode.KOREEN) {
                    this.koreenSettings.actingType = btn.dataset.acting;
                } else if (this.placementMode === PlacementMode.TEXT) {
                    this.textSettings.actingType = btn.dataset.acting;
                }
            });
        });
    }

    reattachSpawnEndMarkerListeners() {
        const wrap = document.getElementById('placement-spawn-end-marker');
        if (!wrap) return;
        const container = wrap.querySelector('.placement-option-btns');
        if (!container) return;

        const newContainer = container.cloneNode(true);
        container.parentNode.replaceChild(newContainer, container);

        newContainer.querySelectorAll('[data-spawn-end-marker]').forEach(btn => {
            btn.addEventListener('click', () => {
                newContainer.querySelectorAll('.placement-opt-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const t = btn.dataset.spawnEndMarker;
                this.spawnEndSettings.pointType = t;
                if (t === 'spawnpoint') {
                    this.spawnEndSettings.color = '#4CAF50';
                } else if (t === 'endpoint') {
                    this.spawnEndSettings.color = '#FFD700';
                }
                document.getElementById('placement-color-preview').style.background = this.spawnEndSettings.color;
                document.getElementById('placement-color-input').value = this.spawnEndSettings.color;
            });
        });
    }

    updateDefaultColor() {
        let color;
        if (this.placementMode === PlacementMode.BLOCK || this.placementMode === PlacementMode.TILEMAP) {
                color = this.world.defaultBlockColor;
            this.placementSettings.color = color;
        } else if (this.placementMode === PlacementMode.OBSTACLE) {
            color = this.world.defaultSpikeColor;
            this.obstacleSettings.color = color;
        } else if (this.placementMode === PlacementMode.TEXT) {
            color = this.world.defaultTextColor;
            this.textSettings.color = color;
        } else {
            return;
        }
        
        document.getElementById('placement-color-preview').style.background = color;
        document.getElementById('placement-color-input').value = color;
        
        // Update texture preview with new color
        if (this.placementMode === PlacementMode.BLOCK || this.placementMode === PlacementMode.TILEMAP) {
            this.updateTexturePreview();
        }
    }
    
    syncActingTypeUI(actingType) {
        // Update the acting type buttons to show the correct active state
        const actingContainer = document.querySelector('#placement-acting .placement-option-btns');
        if (!actingContainer) return;
        
        actingContainer.querySelectorAll('[data-acting]').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.acting === actingType) {
                btn.classList.add('active');
            }
        });
    }

    // ========================================
    // LAYERS
    // ========================================
    
    // Check if two objects overlap
    objectsOverlap(a, b) {
        return a.x < b.x + b.width &&
               a.x + a.width > b.x &&
               a.y < b.y + b.height &&
               a.y + a.height > b.y;
    }
    
    // Group overlapping objects together
    getOverlapGroups() {
        const objects = [...this.world.objects];
        const groups = [];
        const assigned = new Set();
        
        for (let i = 0; i < objects.length; i++) {
            if (assigned.has(i)) continue;
            
            const group = [i];
            assigned.add(i);
            
            // Find all objects that overlap with any object in the current group
            let changed = true;
            while (changed) {
                changed = false;
                for (let j = 0; j < objects.length; j++) {
                    if (assigned.has(j)) continue;
                    
                    // Check if this object overlaps with any object in the group
                    for (const idx of group) {
                        if (this.objectsOverlap(objects[idx], objects[j])) {
                            group.push(j);
                            assigned.add(j);
                            changed = true;
                            break;
                        }
                    }
                }
            }
            
            groups.push(group);
        }
        
        return groups;
    }
    
    promptAddDrawLayer(side) {
        const position = side === 'behind' ? 'behind the player' : 'above the player';
        const name = window.prompt(`Name the new draw layer (${position}):`);
        if (name === null) return;
        try {
            this.world.addDrawLayer(name, side);
            this.triggerMapChange();
            this.updateLayersList();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    }

    updateLayersList() {
        const list = this.ui.layersList;
        list.innerHTML = '';

        const layerDefinitions = [...this.world.layerDefinitions].sort((a, b) => a.depth - b.depth);
        const layerDefinitionsPanel = document.createElement('div');
        layerDefinitionsPanel.className = 'draw-layer-definitions';
        layerDefinitionsPanel.innerHTML = `
            <div class="draw-layer-definitions-title">Draw layers <span>ordered around the player</span></div>
            ${layerDefinitions.map(layer => `
                <div class="draw-layer-definition">
                    <span class="draw-layer-definition-name">${escapeHtml(layer.name)}</span>
                    <span class="draw-layer-definition-position">${layer.depth < 1 ? 'Behind player' : (layer.depth === 1 ? 'Player depth' : 'Above player')}</span>
                    ${layer.builtin ? '' : `
                        <span class="draw-layer-definition-position">Parallax ${layer.parallaxX ?? 1}, ${layer.parallaxY ?? 1}</span>
                        <button class="layer-btn" data-parallax-layer="${escapeHtml(layer.id)}" title="Set parallax for ${escapeHtml(layer.name)}" aria-label="Set parallax for ${escapeHtml(layer.name)}"><span class="material-symbols-outlined">layers</span></button>
                        <button class="layer-btn" data-rename-layer="${escapeHtml(layer.id)}" title="Rename ${escapeHtml(layer.name)}" aria-label="Rename ${escapeHtml(layer.name)}"><span class="material-symbols-outlined">edit</span></button>
                        <button class="layer-btn" data-delete-layer="${escapeHtml(layer.id)}" title="Delete ${escapeHtml(layer.name)}" aria-label="Delete ${escapeHtml(layer.name)}"><span class="material-symbols-outlined">delete</span></button>
                    `}
                </div>
            `).join('')}
        `;
        list.appendChild(layerDefinitionsPanel);

        layerDefinitionsPanel.querySelectorAll('[data-parallax-layer]').forEach(button => {
            button.addEventListener('click', () => {
                const layer = this.world.layerDefinitions.find(item => item.id === button.dataset.parallaxLayer);
                if (!layer) return;
                const value = window.prompt('Enter horizontal, vertical parallax factors (0 to 2). Use 1 for normal camera movement and lower values for distant scenery.', `${layer.parallaxX ?? 1}, ${layer.parallaxY ?? 1}`);
                if (value === null) return;
                const factors = value.split(',').map(item => item.trim());
                if (factors.length !== 2 || factors.some(item => item === '')) {
                    this.showToast('Enter two numbers separated by a comma.', 'error');
                    return;
                }
                try {
                    this.world.setDrawLayerParallax(layer.id, Number(factors[0]), Number(factors[1]));
                    this.triggerMapChange();
                    this.updateLayersList();
                } catch (error) {
                    this.showToast(error.message, 'error');
                }
            });
        });

        layerDefinitionsPanel.querySelectorAll('[data-rename-layer]').forEach(button => {
            button.addEventListener('click', () => {
                const layer = this.world.layerDefinitions.find(item => item.id === button.dataset.renameLayer);
                if (!layer) return;
                const name = window.prompt('Rename draw layer:', layer.name);
                if (name === null) return;
                try {
                    this.world.renameDrawLayer(layer.id, name);
                    this.triggerMapChange();
                    this.updateLayersList();
                } catch (error) {
                    this.showToast(error.message, 'error');
                }
            });
        });
        layerDefinitionsPanel.querySelectorAll('[data-delete-layer]').forEach(button => {
            button.addEventListener('click', () => {
                const layer = this.world.layerDefinitions.find(item => item.id === button.dataset.deleteLayer);
                if (!layer || !window.confirm(`Delete "${layer.name}"? Its objects will move to the nearest built-in layer.`)) return;
                this.world.removeDrawLayer(layer.id);
                this.triggerMapChange();
                this.updateLayersList();
            });
        });

        // Get overlap groups
        const groups = this.getOverlapGroups();
        
        // Flatten groups in display order (reverse for top-to-bottom)
        let colorIndex = 0;
        
        for (let g = groups.length - 1; g >= 0; g--) {
            const group = groups[g];
            const groupColor = colorIndex % 2 === 0 ? 'layer-color-light' : 'layer-color-dark';
            colorIndex++;
            
            // Sort group by array index (reverse for display)
            const sortedGroup = [...group].sort((a, b) => b - a);
            
            for (const idx of sortedGroup) {
                const obj = this.world.objects[idx];
            const item = document.createElement('div');
                item.className = `layer-item ${groupColor}`;
            item.dataset.id = obj.id;
                item.dataset.groupIndex = g.toString();
            item.draggable = true;
            
                // Show group indicator for multi-object groups
                const groupIndicator = group.length > 1 ? 
                    `<span class="layer-group-indicator" title="Overlapping with ${group.length - 1} other object(s)">●</span>` : '';
                
                // Create preview element based on object type
                const opacityText = Math.round(obj.opacity * 100) + '%';
                let previewStyle = `background: ${obj.color}; width: 24px; height: 24px; border-radius: 4px; position: relative; flex-shrink: 0;`;
                let previewContent = '';
                
                if (obj.appearanceType === 'spike') {
                    // Triangle for spikes
                    previewStyle = `width: 24px; height: 24px; position: relative; flex-shrink: 0;`;
                    previewContent = `<div style="width: 0; height: 0; border-left: 12px solid transparent; border-right: 12px solid transparent; border-bottom: 20px solid ${obj.color};"></div>`;
                } else if (obj.appearanceType === 'checkpoint') {
                    previewStyle = `width: 24px; height: 24px; position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center;`;
                    previewContent = `<span class="material-symbols-outlined" style="font-size: 20px; color: ${obj.color};">flag</span>`;
                } else if (obj.appearanceType === 'spawnpoint') {
                    previewStyle = `width: 24px; height: 24px; position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center;`;
                    previewContent = `<span class="material-symbols-outlined" style="font-size: 20px; color: #4CAF50;">person_pin_circle</span>`;
                } else if (obj.appearanceType === 'endpoint') {
                    previewStyle = `width: 24px; height: 24px; position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center;`;
                    previewContent = `<span class="material-symbols-outlined" style="font-size: 20px; color: #FFD700;">star</span>`;
                } else if (obj.appearanceType === 'zone') {
                    previewStyle = `width: 24px; height: 24px; position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border: 2px dashed rgba(255, 255, 255, 1); background: rgba(255, 255, 255, 0.3); border-radius: 4px;`;
                    previewContent = `<span class="material-symbols-outlined" style="font-size: 14px; color: rgba(255, 255, 255, 1);">select_all</span>`;
                } else if (obj.type === 'text') {
                    previewStyle = `width: 24px; height: 24px; position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: bold; color: ${obj.color}; font-size: 14px;`;
                    previewContent = 'T';
                } else {
                    // Block/ground - square
                    previewContent = '';
                }
                
                // Opacity label overlay
                const opacityLabel = obj.opacity < 1 ? 
                    `<span class="layer-opacity-label">${opacityText}</span>` : '';
                const supportsDrawLayer = obj.appearanceType !== 'zone' && obj.appearanceType !== 'button';
            
            item.innerHTML = `
                <span class="material-symbols-outlined" style="cursor: grab; color: var(--text-muted);">drag_indicator</span>
                    ${groupIndicator}
                    <div class="layer-item-preview" style="${previewStyle}">${previewContent}${opacityLabel}</div>
                <span class="layer-item-name">${obj.name}</span>
                <div class="layer-item-actions">
                    <button class="layer-btn layer-delete" data-delete="${obj.id}" title="Delete">
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                    ${supportsDrawLayer ? `
                        <select class="layer-depth-select" data-layer-object="${escapeHtml(obj.id)}" aria-label="Draw layer for ${escapeHtml(obj.name || 'object')}">
                            ${layerDefinitions.map(layer => {
                                const parallaxOnly = obj.collision !== false && (layer.parallaxX !== 1 || layer.parallaxY !== 1);
                                return `<option value="${layer.depth}" ${obj.layer === layer.depth ? 'selected' : ''} ${parallaxOnly ? 'disabled' : ''}>${escapeHtml(layer.name)}</option>`;
                            }).join('')}
                        </select>
                    ` : '<span class="layer-overlay-label">Overlay</span>'}
                </div>
            `;

            // Delete button
            item.querySelector('.layer-delete').addEventListener('click', () => {
                this.world.removeObject(obj.id);
                this.updateLayersList();
                this.triggerMapChange();
            });

            // Draw depth selector
            item.querySelector('.layer-depth-select')?.addEventListener('change', (event) => {
                const depth = Number(event.target.value);
                const targetLayer = this.world.getLayerDefinition(depth);
                if (Number.isSafeInteger(depth) && targetLayer &&
                    !(obj.collision !== false && (targetLayer.parallaxX !== 1 || targetLayer.parallaxY !== 1))) {
                    obj.layer = depth;
                    this.triggerMapChange();
                }
                this.updateLayersList();
            });

            // Drag and drop
            item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('text/plain', idx.toString());
                    e.dataTransfer.setData('groupIndex', g.toString());
                item.classList.add('dragging');
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                    const fromGroup = parseInt(e.dataTransfer.getData('groupIndex'));
                    const toGroup = parseInt(item.dataset.groupIndex);
                    
                    // Only allow reordering within the same group or to adjacent positions
                    // For simplicity, allow any reorder but keep overlapping objects together
                    const toIndex = idx;
                    
                    if (fromIndex !== toIndex) {
                        this.world.reorderLayers(fromIndex, toIndex);
                this.updateLayersList();
                this.triggerMapChange();
                    }
                });
                
                // Hover to highlight object in editor
                item.addEventListener('mouseenter', () => {
                    this.highlightedLayerObject = obj;
                });
                
                item.addEventListener('mouseleave', () => {
                    if (this.highlightedLayerObject === obj) {
                        this.highlightedLayerObject = null;
                    }
                });
                
                // Click on name to open edit popup
                item.querySelector('.layer-item-name').addEventListener('click', () => {
                    this.openObjectEditPopup(obj);
                });
                
                // Double-click on preview to open edit popup
                item.querySelector('.layer-item-preview').addEventListener('dblclick', () => {
                    this.openObjectEditPopup(obj);
            });

            list.appendChild(item);
            }
        }
    }

    // ========================================
    // COLOR PICKER
    // ========================================
    openColorPicker(target) {
        this.colorPickerState.target = target;
        this.ui.colorPickerPopup.classList.add('active');
        
        // Get current color
        let currentColor;
        if (target === 'placement') {
            if (this.placementMode === PlacementMode.TEXT) {
                currentColor = this.textSettings.color;
            } else if (this.placementMode === PlacementMode.TELEPORTAL) {
                currentColor = this.teleportalSettings.color;
            } else if (this.placementMode === PlacementMode.OBSTACLE) {
                currentColor = this.obstacleSettings.color;
            } else if (this.placementMode === PlacementMode.KOREEN) {
                currentColor = this.koreenSettings.color || this.placementSettings.color;
            } else if (this.placementMode === PlacementMode.SPAWN_END) {
                currentColor = this.spawnEndSettings.color || '#4CAF50';
            } else {
                currentColor = this.placementSettings.color;
            }
        } else if (target === 'object-edit') {
            currentColor = this.editingObject ? this.editingObject.color : '#787878';
        } else if (target.startsWith('config-')) {
            const type = target.replace('config-', '');
            currentColor = document.getElementById(`config-${type}-color`).value;
        }
        
        // Set initial state from color
        this.setColorPickerFromHex(currentColor);
    }
    
    showColorPicker(target) {
        // Alias for openColorPicker
        this.openColorPicker(target);
    }

    closeColorPicker() {
        this.ui.colorPickerPopup.classList.remove('active');
        this.colorPickerState.target = null;
    }

    setColorPickerFromHex(hex) {
        // Convert hex to HSV (not HSL - the gradient is HSV style)
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
            const d = max - min;
        
        let h = 0;
        if (d !== 0) {
            switch (max) {
                case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                case g: h = ((b - r) / d + 2) / 6; break;
                case b: h = ((r - g) / d + 4) / 6; break;
            }
        }
        
        const s = max === 0 ? 0 : d / max; // HSV saturation
        const v = max; // HSV value/brightness

        this.colorPickerState.hue = Math.round(h * 360);
        this.colorPickerState.saturation = Math.round(s * 100);
        this.colorPickerState.value = Math.round(v * 100);

        // Update UI
        document.getElementById('color-picker-hue').value = this.colorPickerState.hue;
        document.getElementById('color-picker-hex').value = hex.replace(/^#/, '').toUpperCase();
        document.getElementById('color-picker-preview-box').style.background = hex;
        
        const gradient = document.getElementById('color-picker-gradient');
        gradient.style.background = `
            linear-gradient(to bottom, transparent, black),
            linear-gradient(to right, white, hsl(${this.colorPickerState.hue}, 100%, 50%))
        `;

        // Position cursor - X is saturation, Y is value (inverted)
        const cursor = document.getElementById('color-picker-cursor');
        cursor.style.left = `${this.colorPickerState.saturation}%`;
        cursor.style.top = `${100 - this.colorPickerState.value}%`;
    }

    updateColorPickerPreview() {
        const hex = this.hsvToHex(
            this.colorPickerState.hue,
            this.colorPickerState.saturation,
            this.colorPickerState.value
        );
        
        document.getElementById('color-picker-hex').value = hex.replace(/^#/, '').toUpperCase();
        document.getElementById('color-picker-preview-box').style.background = hex;
        
        this.applyColorPickerColor(hex);
    }

    applyColorPickerColor(hex) {
        const target = this.colorPickerState.target;
        
        if (target === 'placement') {
            if (this.placementMode === PlacementMode.TEXT) {
                this.textSettings.color = hex;
            } else if (this.placementMode === PlacementMode.TELEPORTAL) {
                this.teleportalSettings.color = hex;
            } else if (this.placementMode === PlacementMode.OBSTACLE) {
                this.obstacleSettings.color = hex;
            } else if (this.placementMode === PlacementMode.KOREEN) {
                this.koreenSettings.color = hex;
            } else if (this.placementMode === PlacementMode.SPAWN_END) {
                this.spawnEndSettings.color = hex;
            } else {
                this.placementSettings.color = hex;
                // Update texture preview with new background color
                this.updateTexturePreview();
            }
            document.getElementById('placement-color-preview').style.background = hex;
            document.getElementById('placement-color-input').value = hex;
            if (this.placementMode === PlacementMode.TEXT) {
                this.updatePlacementFontPreview();
            }
        } else if (target === 'object-edit') {
            if (this.editingObject) {
                this.editingObject.color = hex;
                document.getElementById('object-edit-color').value = hex;
                document.getElementById('object-edit-color-preview').style.background = hex;
                this.triggerMapChange();
                if (this.editingObject.type === 'text') {
                    this.updateObjectEditFontPreview();
                }
            }
        } else if (target && target.startsWith('config-')) {
            const type = target.replace('config-', '');
            
            // Handle cloud colors (config-cloud-sky, config-cloud-galaxy)
            if (type.startsWith('cloud-')) {
                document.getElementById(`config-${type}`).value = hex;
                document.getElementById(`config-${type}-preview`).style.background = hex;
                
                if (type === 'cloud-sky') this.world.cloudColorSky = hex;
                else if (type === 'cloud-galaxy') this.world.cloudColorGalaxy = hex;
            } else {
            document.getElementById(`config-${type}-color`).value = hex;
            document.getElementById(`config-${type}-color-preview`).style.background = hex;
            
            if (type === 'block') this.world.defaultBlockColor = hex;
            else if (type === 'spike') this.world.defaultSpikeColor = hex;
            else if (type === 'text') this.world.defaultTextColor = hex;
            else if (type === 'portal') this.world.defaultPortalColor = hex;
            else if (type === 'bouncer') this.world.defaultBouncerColor = hex;
            }
        }
    }

    // Returns a contrasting preview background — dark for bright text, light for dark text
    contrastBackground(hex) {
        if (!hex || hex.length < 7) return 'rgba(0,0,0,0.5)';
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        return lum > 0.45 ? 'rgba(30,30,30,0.85)' : 'rgba(220,220,220,0.85)';
    }

    hslToHex(h, s, l) {
        s /= 100;
        l /= 100;
        const a = s * Math.min(l, 1 - l);
        const f = n => {
            const k = (n + h / 30) % 12;
            const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
            return Math.round(255 * color).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    }
    
    hsvToHex(h, s, v) {
        s /= 100;
        v /= 100;
        
        const c = v * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = v - c;
        
        let r, g, b;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        
        r = Math.round((r + m) * 255).toString(16).padStart(2, '0');
        g = Math.round((g + m) * 255).toString(16).padStart(2, '0');
        b = Math.round((b + m) * 255).toString(16).padStart(2, '0');
        
        return `#${r}${g}${b}`;
    }

    // ========================================
    // INPUT HANDLING
    // ========================================
    handleKeyPress(e) {
        const isTestMode = this.engine.state === GameState.TESTING;
        const isEditorMode = this.engine.state === GameState.EDITOR;
        
        if (!isEditorMode && !isTestMode) return;
        
        // Don't handle shortcuts if user is typing (inputs, textareas, selects, contenteditable)
        const activeEl = document.activeElement;
        const isTyping = this._isTypingTarget(activeEl);
        
        // Allow Escape even while typing
        if (e.code === 'Escape') {
            this.handleEscape();
            return;
        }
        
        // Skip other shortcuts if typing
        if (isTyping) return;
        
        // Fly mode toggle works in both editor and test mode
        if (e.code === 'KeyG') {
            e.preventDefault();
                this.setTool(EditorTool.FLY);
            return;
        }
        
        // Other shortcuts only work in editor mode
        if (!isEditorMode) return;

        if ((e.ctrlKey || e.metaKey) && this._handleUndoRedoKeys(e)) {
            e.preventDefault();
            return;
        }

        // Don't intercept other browser shortcuts with Ctrl/Cmd
        if (e.ctrlKey || e.metaKey) return;
        
        switch (e.code) {
            case 'KeyQ':
                e.preventDefault();
                this.setTool(EditorTool.ERASE);
                break;
            case 'KeyM':
                e.preventDefault();
                this.setTool(EditorTool.MOVE);
                break;
            case 'KeyC':
                e.preventDefault();
                this.setTool(EditorTool.DUPLICATE);
                break;
            case 'KeyR':
                e.preventDefault();
                this.setTool(EditorTool.ROTATE);
                break;
            case 'KeyH':
                e.preventDefault();
                this.toggleGrid();
                break;
            case 'KeyV':
                e.preventDefault();
                this.setTool(EditorTool.SELECT);
                break;
        }
    }

    handleEscape() {
        // Exit selection mode
        if (this.isSelectionActive) {
            this.exitSelectionMode();
            return;
        }
        
        // Cancel zone adjustment mode
        if (this.zoneAdjustment.active) {
            this.exitZoneAdjustmentMode();
            return;
        }
        
        // Cancel spinner adjustment mode
        if (this.spinnerAdjustment.active) {
            this.exitSpinnerAdjustmentMode();
            return;
        }
        
        // Cancel zone placement
        if (this.zonePlacement.isPlacing) {
            this.zonePlacement.isPlacing = false;
            return;
        }

        // Cancel obstacle placement (spinner)
        if (this.obstaclePlacement.isPlacing) {
            this.obstaclePlacement.isPlacing = false;
            return;
        }
        
        // Cancel button placement
        if (this.buttonPlacement.isPlacing) {
            this.buttonPlacement.isPlacing = false;
            return;
        }

        if (this.placementMode !== PlacementMode.NONE) {
            this.stopPlacement();
        } else if (this.currentTool !== EditorTool.NONE) {
            this.setTool(this.currentTool); // Toggle off
        } else if (this.movingObject) {
            this.movingObject = null;
        } else {
            this.closeColorPicker();
            this.closeAddMenu();
            this.closePanel('config');
            this.closePanel('layers');
            this.closePanel('settings');
            this.closeObjectEditPopup();
            this.closeZoneNamePopup();
            this.closeButtonEditPopup();
        }
    }

    handleMouseMove(e) {
        const isTestMode = this.engine.state === GameState.TESTING;
        const isEditorMode = this.engine.state === GameState.EDITOR;
        
        // Update inspect box in test mode
        if (isTestMode) {
            const hoveredObj = this.getObjectUnderMouse();
            this.updateInspectBox(hoveredObj);
            return;
        }
        
        if (!isEditorMode) return;

        const worldPos = this.engine.getMouseWorldPos();
        const gridPos = this.engine.getGridAlignedPos(worldPos.x, worldPos.y);
        
        // Selection mode handling
        if (this.isSelectionActive && this.engine.mouse.down) {
            if (this.selectionMode === SelectionMode.QUOT && this.selectionRect) {
                this.handleQuotSelectionMove(worldPos.x, worldPos.y);
                return;
            }
            if (this.selectionMode === SelectionMode.MOUSE && this.selectionMovingObjects) {
                this.handleMouseModeMove(worldPos.x, worldPos.y);
                return;
            }
            // In selection mode, allow camera pan with fly when not interacting with objects
            if (this.isFlying) {
                this.camera.targetX -= e.movementX / this.camera.zoom;
                this.camera.targetY -= e.movementY / this.camera.zoom;
            }
            return;
        }
        
        // Zone placement - update end corner
        if (this.zonePlacement.isPlacing) {
            this.zonePlacement.endX = gridPos.x;
            this.zonePlacement.endY = gridPos.y;
            return; // Don't do anything else during zone drawing
        }

        // Obstacle (spinner) placement - update end corner
        if (this.obstaclePlacement.isPlacing) {
            this.obstaclePlacement.endX = gridPos.x;
            this.obstaclePlacement.endY = gridPos.y;
            return;
        }
        
        // Button placement - update end corner
        if (this.buttonPlacement.isPlacing) {
            this.buttonPlacement.endX = gridPos.x;
            this.buttonPlacement.endY = gridPos.y;
            return;
        }
        
        // Zone adjustment - handle dragger movement
        if (this.zoneAdjustment.active && this.zoneAdjustment.draggerHeld && this.engine.mouse.down) {
            this.handleZoneDraggerMove(gridPos.x, gridPos.y);
            return;
        }

        // Spinner adjustment - handle dragger movement
        if (this.spinnerAdjustment.active && this.spinnerAdjustment.draggerHeld && this.engine.mouse.down) {
            this.handleSpinnerDraggerMove(gridPos.x, gridPos.y);
            return;
        }

        // Fly mode camera movement
        if (this.isFlying && this.engine.mouse.down && this.placementMode === PlacementMode.NONE && !this.zonePlacement.isPlacing) {
            this.camera.targetX -= e.movementX / this.camera.zoom;
            this.camera.targetY -= e.movementY / this.camera.zoom;
        }

        // Brush-like placement - continue placing while mouse is held (except for teleportal, button, and obstacle with spinner appearance)
        const isSpinnerMode = this.placementMode === PlacementMode.OBSTACLE && this.obstacleSettings.appearanceType === 'spinner';
        if (this.isPlacing && this.engine.mouse.down && this._placementUsesBrushStroke() && this.placementMode !== PlacementMode.TELEPORTAL && this.placementMode !== PlacementMode.BUTTON && !isSpinnerMode && !this.isOverUI(e)) {
            this.placeObject(gridPos.x, gridPos.y);
        }

        // Moving object
        if (this.movingObject) {
            this.movingObject.x = gridPos.x;
            this.movingObject.y = gridPos.y;
            this.world._spatialDirty = true;
            this.world._editorMergedDirty = true;
        }
        
        // Rotating object (drag-based rotation)
        if (this.rotatingObject && this.rotationStartPos) {
            // Calculate angle from object center to mouse position
            const objCenterX = this.rotatingObject.x + this.rotatingObject.width / 2;
            const objCenterY = this.rotatingObject.y + this.rotatingObject.height / 2;
            
            const dx = worldPos.x - objCenterX;
            const dy = worldPos.y - objCenterY;
            
            // Calculate angle in degrees (0 = right, 90 = down, 180 = left, -90 = up)
            let angle = Math.atan2(dy, dx) * (180 / Math.PI);
            
            // Snap to nearest 90-degree increment
            angle = Math.round(angle / 90) * 90;
            
            // Convert to game rotation system (0 = up, 90 = right, 180 = down, 270 = left)
            // atan2 gives: 0 = right, 90 = down, 180/-180 = left, -90 = up
            // Game uses: 0 = default (up), 90 = right, 180 = down, 270 = left
            let rotation = (angle + 90 + 360) % 360;
            
            if (this.isBouncerObject(this.rotatingObject)) {
                if (this.rotatingObject.bouncerDirection !== rotation || this.rotatingObject.bouncerAppearanceDirection !== rotation || this.rotatingObject.rotation !== 0) {
                    this.setBouncerDirectionFromAbsoluteRotation(this.rotatingObject, rotation);
                }
            } else if (this.rotatingObject.rotation !== rotation) {
                this.rotatingObject.rotation = rotation;
            }
        }

        // Quick eraser (one undo step per mouse-down stroke)
        if (this.isErasing && this.engine.mouse.down && !this.isOverUI(e)) {
            if (!this._quickEraseUndoActive) {
                this.beginUndoTransaction();
                this._quickEraseUndoActive = true;
            }
            const objOrObjs = this.getObjectToErase(worldPos.x, worldPos.y);
            const gridPos = this.engine.getGridAlignedPos(worldPos.x, worldPos.y);
            const halfW = Math.floor(this.eraseSettings.width / 2) * GRID_SIZE;
            const halfH = Math.floor(this.eraseSettings.height / 2) * GRID_SIZE;
            const eX = gridPos.x - halfW;
            const eY = gridPos.y - halfH;
            const eW = this.eraseSettings.width * GRID_SIZE;
            const eH = this.eraseSettings.height * GRID_SIZE;
            if (objOrObjs || this.world.hasTilemapCellsInArea(eX, eY, eW, eH)) {
                if (this.eraseFromArea(objOrObjs, eX, eY, eW, eH, true)) {
                    this.triggerMapChange();
                }
            }
        }

        // Update hovered object
        this.hoveredObject = this.world.getObjectAt(worldPos.x, worldPos.y);
    }

    handleMouseDown(e) {
        if (this.engine.state !== GameState.EDITOR) return;
        if (this.isOverUI(e)) return;
        
        // Selection mode handling
        if (this.isSelectionActive) {
            const worldPos = this.engine.getMouseWorldPos();
            
            switch (this.selectionMode) {
                case SelectionMode.QUOT:
                    this.handleQuotSelectionDown(worldPos.x, worldPos.y);
                    return;
                case SelectionMode.MULTI:
                    this.handleMultiSelectClick(worldPos.x, worldPos.y);
                    return;
                case SelectionMode.MOUSE:
                    this.handleMouseModeDown(worldPos.x, worldPos.y);
                    return;
            }
        }
        
        // Handle zone adjustment draggers
        if (this.zoneAdjustment.active) {
            const worldPos = this.engine.getMouseWorldPos();
            const dragger = this.getZoneDraggerAtPoint(worldPos.x, worldPos.y);
            if (dragger) {
                this.zoneAdjustment.draggerHeld = dragger;
                this.beginUndoTransaction();
                this._zoneDragUndoActive = true;
                return;
            }
            // If clicking outside draggers, allow camera panning
        }

        // Handle spinner adjustment draggers
        if (this.spinnerAdjustment.active) {
            const worldPos = this.engine.getMouseWorldPos();
            const dragger = this.getSpinnerDraggerAtPoint(worldPos.x, worldPos.y);
            if (dragger) {
                this.spinnerAdjustment.draggerHeld = dragger;
                this.beginUndoTransaction();
                this._spinnerDragUndoActive = true;
                return;
            }
            // If clicking outside draggers, allow camera panning
        }

        const worldPos = this.engine.getMouseWorldPos();
        const gridPos = this.engine.getGridAlignedPos(worldPos.x, worldPos.y);

        if (this.placementMode === PlacementMode.OBJECT_STAMP) {
            this.beginUndoTransaction();
            try {
                this.placeObjectStamp(gridPos.x, gridPos.y);
            } finally {
                this.endUndoTransaction();
            }
            return;
        }

        // Zone placement mode - start drawing region
        if (this.placementMode === PlacementMode.KOREEN && this.koreenSettings.appearanceType === 'zone') {
            this.zonePlacement.isPlacing = true;
            this.zonePlacement.startX = gridPos.x;
            this.zonePlacement.startY = gridPos.y;
            this.zonePlacement.endX = gridPos.x;
            this.zonePlacement.endY = gridPos.y;
            return;
        }

        // Obstacle placement mode with spinner appearance - start drawing region (like zone)
        if (this.placementMode === PlacementMode.OBSTACLE && this.obstacleSettings.appearanceType === 'spinner') {
            this.obstaclePlacement.isPlacing = true;
            this.obstaclePlacement.startX = gridPos.x;
            this.obstaclePlacement.startY = gridPos.y;
            this.obstaclePlacement.endX = gridPos.x;
            this.obstaclePlacement.endY = gridPos.y;
            return;
        }

        // Button placement mode - start drawing region (like zone)
        if (this.placementMode === PlacementMode.BUTTON) {
            this.buttonPlacement.isPlacing = true;
            this.buttonPlacement.startX = gridPos.x;
            this.buttonPlacement.startY = gridPos.y;
            this.buttonPlacement.endX = gridPos.x;
            this.buttonPlacement.endY = gridPos.y;
            return;
        }

        // Placement mode - start brush placement
        if (this.placementMode !== PlacementMode.NONE) {
            if (this._placementUsesBrushStroke()) {
                this.beginUndoTransaction();
                this._brushUndoActive = true;
            }
            this.isPlacing = true;
            const usesFreeCoinPlacement = this.placementMode === PlacementMode.KOREEN && this.koreenSettings.appearanceType === 'coin' && this.koreenSettings.coinSnapToGrid === false;
            this.placeObject(usesFreeCoinPlacement ? worldPos.x : gridPos.x, usesFreeCoinPlacement ? worldPos.y : gridPos.y);
            return;
        }

        // Tool actions
        switch (this.currentTool) {
            case EditorTool.MOVE:
                const obj = this.world.getObjectAt(worldPos.x, worldPos.y);
                if (obj) {
                    this.beginUndoTransaction();
                    this._moveRotateUndoActive = true;
                    this.movingObject = obj;
                }
                break;
            
            case EditorTool.DUPLICATE:
                const objToDupe = this.world.getObjectAt(worldPos.x, worldPos.y);
                if (objToDupe) {
                    const clone = objToDupe.clone();
                    this.world.addObject(clone);
                    this.movingObject = clone;
                    this.triggerMapChange();
                    this.playTileSound();
                }
                break;
            
            case EditorTool.ROTATE:
                const objToRotate = this.world.getObjectAt(worldPos.x, worldPos.y);
                if (objToRotate) {
                    this.beginUndoTransaction();
                    this._moveRotateUndoActive = true;
                    this.rotatingObject = objToRotate;
                    this.rotationStartPos = { x: worldPos.x, y: worldPos.y };
                }
                break;
            
            case EditorTool.ROTATE_LEFT: {
                const obj = this.world.getObjectAt(worldPos.x, worldPos.y);
                if (obj) {
                    this._pushUndoSnapshot();
                    this.rotateObjectWithBouncerSync(obj, -90);
                    this.triggerMapChange();
                }
                break;
            }
            
            case EditorTool.ROTATE_RIGHT: {
                const obj = this.world.getObjectAt(worldPos.x, worldPos.y);
                if (obj) {
                    this._pushUndoSnapshot();
                    this.rotateObjectWithBouncerSync(obj, 90);
                    this.triggerMapChange();
                }
                break;
            }
            
            case EditorTool.ERASE: {
                const objOrObjsToErase = this.getObjectToErase(worldPos.x, worldPos.y);
                const gridPos = this.engine.getGridAlignedPos(worldPos.x, worldPos.y);
                const halfW = Math.floor(this.eraseSettings.width / 2) * GRID_SIZE;
                const halfH = Math.floor(this.eraseSettings.height / 2) * GRID_SIZE;
                const eX = gridPos.x - halfW;
                const eY = gridPos.y - halfH;
                const eW = this.eraseSettings.width * GRID_SIZE;
                const eH = this.eraseSettings.height * GRID_SIZE;
                if (objOrObjsToErase || this.world.hasTilemapCellsInArea(eX, eY, eW, eH)) {
                    if (this.eraseFromArea(objOrObjsToErase, eX, eY, eW, eH)) {
                        this.triggerMapChange();
                    }
                }
                break;
            }
            
            case EditorTool.NONE:
                // If no tool is active, open edit popup on click
                if (this.isFlying) {
                    // In fly mode, record click start to detect click vs drag
                    this.flyClickStart = { x: e.clientX, y: e.clientY, worldPos: { ...worldPos } };
                } else {
                    const objToEdit = this.world.getObjectAt(worldPos.x, worldPos.y);
                    if (objToEdit) {
                        this.openObjectEditPopup(objToEdit);
                    }
                }
                break;
        }
    }

    handleMouseUp(e) {
        // Selection mode handling
        if (this.isSelectionActive) {
            const worldPos = this.engine.getMouseWorldPos();
            if (this.selectionMode === SelectionMode.QUOT && this.selectionRect) {
                this.handleQuotSelectionUp();
                return;
            }
            if (this.selectionMode === SelectionMode.MOUSE) {
                this.handleMouseModeUp(worldPos.x, worldPos.y);
                return;
            }
        }
        
        // Handle fly mode click (vs drag) - open object popup if minimal movement
        if (this.flyClickStart && this.currentTool === EditorTool.NONE) {
            const dx = e.clientX - this.flyClickStart.x;
            const dy = e.clientY - this.flyClickStart.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // If mouse moved less than 5 pixels, treat as a click
            if (distance < 5) {
                const objToEdit = this.world.getObjectAt(this.flyClickStart.worldPos.x, this.flyClickStart.worldPos.y);
                if (objToEdit) {
                    this.openObjectEditPopup(objToEdit);
                }
            }
            this.flyClickStart = null;
        }
        // Complete zone placement
        if (this.zonePlacement.isPlacing) {
            this.zonePlacement.isPlacing = false;
            this.completeZonePlacement();
            return;
        }

        // Complete obstacle (spinner) placement
        if (this.obstaclePlacement.isPlacing) {
            this.obstaclePlacement.isPlacing = false;
            this.completeSpinnerPlacement();
            return;
        }
        
        // Complete button placement
        if (this.buttonPlacement.isPlacing) {
            this.buttonPlacement.isPlacing = false;
            this.completeButtonPlacement();
            return;
        }
        
        // Release zone adjustment dragger
        if (this.zoneAdjustment.draggerHeld) {
            this.zoneAdjustment.draggerHeld = null;
            if (this._zoneDragUndoActive) {
                this._zoneDragUndoActive = false;
                this._discardMatchingTopUndoIfUnchanged();
                this.endUndoTransaction();
            }
            this.triggerMapChange();
            return;
        }
        
        // Release spinner adjustment dragger
        if (this.spinnerAdjustment.draggerHeld) {
            this.spinnerAdjustment.draggerHeld = null;
            if (this._spinnerDragUndoActive) {
                this._spinnerDragUndoActive = false;
                this._discardMatchingTopUndoIfUnchanged();
                this.endUndoTransaction();
            }
            this.triggerMapChange();
            return;
        }
        
        // Stop brush placement
        this.isPlacing = false;
        if (this._brushUndoActive) {
            this._brushUndoActive = false;
            this._discardMatchingTopUndoIfUnchanged();
            this.endUndoTransaction();
        }

        if (this._quickEraseUndoActive) {
            this._quickEraseUndoActive = false;
            this._discardMatchingTopUndoIfUnchanged();
            this.endUndoTransaction();
        }
        
        if (this.movingObject) {
            this.movingObject.snapToGrid();
            this.movingObject = null;
            this.setTool(EditorTool.NONE);
            if (this._moveRotateUndoActive) {
                this._moveRotateUndoActive = false;
                this._discardMatchingTopUndoIfUnchanged();
                this.endUndoTransaction();
            }
            this.triggerMapChange();
            this.playTileSound();
        }
        
        // Finish rotation drag
        if (this.rotatingObject) {
            this.rotatingObject = null;
            this.rotationStartPos = null;
            if (this._moveRotateUndoActive) {
                this._moveRotateUndoActive = false;
                this._discardMatchingTopUndoIfUnchanged();
                this.endUndoTransaction();
            }
            this.triggerMapChange();
        }
    }

    isOverUI(e) {
        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        return elements.some(el => 
            el.closest('.toolbar') ||
            el.closest('.panel') ||
            el.closest('.btn') ||
            el.closest('.add-menu') ||
            el.closest('.placement-toolbar') ||
            el.closest('.color-picker-popup') ||
            el.closest('.modal-overlay') ||
            el.closest('.object-edit-popup') ||
            el.closest('.object-edit-panel') ||
            el.closest('.zone-name-panel') ||
            el.closest('.zone-edit-panel') ||
            el.closest('.zone-adjust-stop') ||
            el.closest('.spinner-adjust-stop')
        );
    }

    // ========================================
    // OBJECT ERASING
    // ========================================
    getObjectsInEraserArea(x, y) {
        // Get eraser dimensions in pixels
        const eraserWidth = this.eraseSettings.width * GRID_SIZE;
        const eraserHeight = this.eraseSettings.height * GRID_SIZE;
        
        // Center the eraser on the mouse position (grid-aligned)
        const gridPos = this.engine.getGridAlignedPos(x, y);
        const halfW = Math.floor(this.eraseSettings.width / 2) * GRID_SIZE;
        const halfH = Math.floor(this.eraseSettings.height / 2) * GRID_SIZE;
        const eraserX = gridPos.x - halfW;
        const eraserY = gridPos.y - halfH;
        
        // Get all objects that intersect with the eraser area
        const objectsInArea = this.world.objects.filter(obj => {
            return obj.x < eraserX + eraserWidth &&
                   obj.x + obj.width > eraserX &&
                   obj.y < eraserY + eraserHeight &&
                   obj.y + obj.height > eraserY;
        });
        
        return objectsInArea;
    }
    
    getObjectToErase(x, y) {
        // Get all objects in eraser area
        const objectsInArea = this.getObjectsInEraserArea(x, y);
        
        if (objectsInArea.length === 0) return null;
        if (objectsInArea.length === 1) return objectsInArea[0];
        
        // Sort by actual visual draw order, then by object order for ties.
        objectsInArea.sort((a, b) => {
            const indexA = this.world.objects.indexOf(a);
            const indexB = this.world.objects.indexOf(b);
            const depthA = a.appearanceType === 'zone' || a.appearanceType === 'button' ? Number.POSITIVE_INFINITY : (a.layer ?? 1);
            const depthB = b.appearanceType === 'zone' || b.appearanceType === 'button' ? Number.POSITIVE_INFINITY : (b.layer ?? 1);
            return depthA - depthB || indexA - indexB;
        });
        
        switch (this.eraseSettings.eraseType) {
            case 'all':
                // Return ALL objects in the area for bulk erase
                return objectsInArea;
            case 'top':
                // Return the topmost object (highest index)
                return objectsInArea[objectsInArea.length - 1];
            case 'bottom':
                // Return the bottommost object (lowest index)
                return objectsInArea[0];
            default:
                return objectsInArea[objectsInArea.length - 1];
        }
    }

    // ========================================
    // OBJECT PLACEMENT
    // ========================================
    placeObject(x, y) {
        let settings, type;

        if (this.placementMode === PlacementMode.TILEMAP) {
            const animationFrames = this.tilemapAnimationFrames.slice(0, this.tilemapAnimationFrameCount);
            if (this.tilemapAnimation === 'textureCycle' && new Set(animationFrames).size < 2) {
                this.showToast('Choose at least two different textures for an animated tile.', 'error');
                return;
            }
            const tilemapAtlas = this.world.tilemaps.find(tilemap => tilemap.layer === this.tilemapLayer)?.atlas;
            const atlasAnimationFrames = this.tilemapAtlasAnimationFrames.slice(0, this.tilemapAnimationFrameCount);
            if (this.tilemapAnimation === 'atlasCycle' &&
                (!tilemapAtlas || new Set(atlasAnimationFrames).size < 2)) {
                this.showToast('Choose at least two different frames from a tile atlas.', 'error');
                return;
            }
            const animation = this.tilemapAnimation === 'textureCycle'
                ? { textures: animationFrames, fps: this.tilemapAnimationFps }
                : this.tilemapAnimation === 'atlasCycle'
                    ? { atlasFrames: atlasAnimationFrames, fps: this.tilemapAnimationFps }
                    : null;
            const changed = this.world.setTilemapCell(x, y, {
                color: this.placementSettings.color,
                texture: this.placementSettings.texture,
                opacity: this.placementSettings.opacity,
                collisionType: this.tilemapCellBehavior,
                collisionShape: this.tilemapCollisionShape,
                collisionPoints: this.tilemapCollisionShape === 'polygon' ? this.tilemapCollisionPoints : undefined,
                polygonOneWay: this.tilemapPolygonOneWay,
                atlasFrame: this.tilemapAnimation === 'textureCycle' ? undefined
                    : this.tilemapAnimation === 'atlasCycle' ? atlasAnimationFrames[0] : this.tilemapAtlasFrame,
                animation
            }, this.tilemapLayer);
            if (changed) {
                this.triggerMapChange();
                if (this.engine?.audioManager) this.engine.audioManager.play('place');
            }
            return;
        }

        if (this.placementMode === PlacementMode.BLOCK) {
            settings = this.placementSettings;
            type = 'block';
        } else if (this.placementMode === PlacementMode.OBSTACLE && this.obstacleSettings.appearanceType === 'spike') {
            settings = this.obstacleSettings;
            type = 'block';
        } else if (this.placementMode === PlacementMode.SPAWN_END) {
            const pt = this.spawnEndSettings.pointType;
            settings = {
                appearanceType: pt,
                actingType: pt,
                fillMode: this.spawnEndSettings.fillMode || 'add',
                collision: false,
                opacity: this.spawnEndSettings.opacity != null ? this.spawnEndSettings.opacity : 1,
                color: this.spawnEndSettings.color || (pt === 'endpoint' ? '#FFD700' : '#4CAF50')
            };
            type = 'koreen';
        } else if (this.placementMode === PlacementMode.KOREEN) {
            settings = this.koreenSettings;
            type = 'koreen';
            if (settings.appearanceType === 'coin') {
                // Coin: fixed size; either center in grid cell or place freely at cursor.
                const coinSize = Math.round(GRID_SIZE * 0.75);
                const snapToGrid = settings.coinSnapToGrid !== false;
                const coinX = snapToGrid ? x + (GRID_SIZE - coinSize) / 2 : x - coinSize / 2;
                const coinY = snapToGrid ? y + (GRID_SIZE - coinSize) / 2 : y - coinSize / 2;
                const coinFill = settings.fillMode || 'add';
                if (!this.applyFillModeToArea(coinFill, coinX, coinY, coinSize, coinSize)) return;
                const coin = new WorldObject({
                    x: coinX,
                    y: coinY,
                    width: coinSize,
                    height: coinSize,
                    type: 'koreen',
                    appearanceType: 'coin',
                    actingType: 'coin',
                    collision: false,
                    color: '#FFDD00',
                    opacity: this.koreenSettings.opacity || 1,
                    name: 'Coin'
                });
                coin.layer = 2;
                this.world.addObject(coin);
                this.triggerMapChange();
                if (this.engine && this.engine.audioManager) this.engine.audioManager.play('place');
                return;
            }
        } else if (this.placementMode === PlacementMode.TEXT) {
            settings = this.textSettings;
            type = 'text';
        } else if (this.placementMode === PlacementMode.TELEPORTAL) {
            // Teleportal placement - single click only, opens naming popup
            this.placeTeleportal(x, y);
            return;
        } else {
            return;
        }

        // Determine object dimensions (Soul Statue is 3x10 blocks)
        let objWidth = GRID_SIZE;
        let objHeight = GRID_SIZE;
        let objX = x;
        let objY = y;
        if (settings.appearanceType === 'soulStatue') {
            objWidth = GRID_SIZE * 3; // 3 blocks wide (96px)
            objHeight = GRID_SIZE * 10; // 10 blocks tall (320px)
            objX = x - GRID_SIZE; // Center horizontally on click
            objY = y - GRID_SIZE * 9; // Place with click point at bottom
        }

        const fillMode = settings.fillMode || 'add';
        if (!this.applyFillModeToArea(fillMode, objX, objY, objWidth, objHeight)) return;

        // Create object
        const obj = new WorldObject({
            x: objX,
            y: objY,
            width: objWidth,
            height: objHeight,
            type: type,
            appearanceType: settings.appearanceType || 'ground',
            actingType: settings.actingType || 'ground',
            texture: settings.texture || 'solid',
            collision: settings.collision !== undefined ? settings.collision : true,
            color: settings.color || '#787878',
            opacity: settings.opacity !== undefined ? settings.opacity : 1,
            content: settings.content || '',
            font: settings.font || 'Arial',
            fontSize: settings.fontSize || 24,
            hAlign: settings.hAlign || 'center',
            vAlign: settings.vAlign || 'center',
            hSpacing: settings.hSpacing || 0,
            vSpacing: settings.vSpacing || 0,
            bouncerStrength: settings.bouncerStrength !== undefined ? settings.bouncerStrength : 20
        });

        // Set default layer based on type
        if (settings.actingType === 'spike') {
            obj.layer = 2; // Above player by default for spikes
        } else if (settings.collision) {
            obj.layer = 1; // Same layer for collidable
        } else {
            obj.layer = 1;
        }

        this.world.addObject(obj);
        this.mergeBlockWithAdjacent(obj);
        this.triggerMapChange();
        if (this.engine && this.engine.audioManager) this.engine.audioManager.play('place');
    }

    /**
     * @param {boolean} [skipOuterTransaction] when true, caller manages beginUndoTransaction/endUndoTransaction (quick-erase drag)
     */
    eraseFromArea(objects, eraserX, eraserY, eraserW, eraserH, skipOuterTransaction = false) {
        if (!skipOuterTransaction) this.beginUndoTransaction();
        let didErase = false;
        try {
            const toProcess = Array.isArray(objects) ? objects : (objects ? [objects] : []);

            for (const obj of toProcess) {
                const isMerged = obj.type === 'block' && obj.appearanceType === 'ground' &&
                    obj.rotation === 0 && !obj.flipHorizontal &&
                    (obj.width > GRID_SIZE || obj.height > GRID_SIZE);

                if (!isMerged) {
                    this.world.removeObject(obj.id);
                    didErase = true;
                    continue;
                }

                const gs = GRID_SIZE;
                const cols = Math.round(obj.width / gs);
                const rows = Math.round(obj.height / gs);
                const kept = [];

                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        const cx = obj.x + c * gs;
                        const cy = obj.y + r * gs;
                        const inside = cx < eraserX + eraserW && cx + gs > eraserX &&
                                       cy < eraserY + eraserH && cy + gs > eraserY;
                        if (!inside) {
                            kept.push({ x: cx, y: cy });
                        }
                    }
                }

                if (kept.length === cols * rows) continue;
                didErase = true;

                this.world.removeObject(obj.id);

                for (const cell of kept) {
                    this.world.addObject(new WorldObject({
                        type: obj.type,
                        x: cell.x,
                        y: cell.y,
                        width: gs,
                        height: gs,
                        color: obj.color,
                        texture: obj.texture,
                        opacity: obj.opacity,
                        layer: obj.layer,
                        collision: obj.collision,
                        appearanceType: obj.appearanceType,
                        actingType: obj.actingType
                    }));
                }
            }
            if (toProcess.length === 0 || this.eraseSettings.eraseType === 'all') {
                didErase = this.world.removeTilemapCellsInArea(eraserX, eraserY, eraserW, eraserH) > 0 || didErase;
            }
        } finally {
            if (!skipOuterTransaction) this.endUndoTransaction();
        }
        if (didErase && this.engine && this.engine.audioManager) this.engine.audioManager.play('erase');
        return didErase;
    }

    mergeBlockWithAdjacent(obj) {
        if (obj.type !== 'block') return;
        const at = obj.appearanceType;
        if (at === 'spike' || at === 'spinner' || at === 'checkpoint' ||
            at === 'soulStatue' || at === 'button' || at === 'bouncer') return;
        if (obj.rotation !== 0 || obj.flipHorizontal) return;

        const propKey = (o) =>
            `${o.color}|${o.texture || 'solid'}|${o.opacity}|${o.layer ?? 1}|${o.collision}|${o.appearanceType}|${o.actingType}`;
        const myKey = propKey(obj);

        let changed = true;
        while (changed) {
            changed = false;
            const near = this.world.queryNear(
                obj.x - 1, obj.y - 1, obj.width + 2, obj.height + 2
            );
            for (let i = 0; i < near.length; i++) {
                const other = near[i];
                if (other === obj || other.id === obj.id) continue;
                if (other.type !== 'block') continue;
                if (other.rotation !== 0 || other.flipHorizontal) continue;
                if (propKey(other) !== myKey) continue;

                // Right: other is directly to the right, same top & height
                if (obj.x + obj.width === other.x && obj.y === other.y && obj.height === other.height) {
                    obj.width += other.width;
                    this.world.removeObject(other.id);
                    changed = true; break;
                }
                // Left
                if (other.x + other.width === obj.x && obj.y === other.y && obj.height === other.height) {
                    obj.x = other.x;
                    obj.width += other.width;
                    this.world.removeObject(other.id);
                    changed = true; break;
                }
                // Below
                if (obj.y + obj.height === other.y && obj.x === other.x && obj.width === other.width) {
                    obj.height += other.height;
                    this.world.removeObject(other.id);
                    changed = true; break;
                }
                // Above
                if (other.y + other.height === obj.y && obj.x === other.x && obj.width === other.width) {
                    obj.y = other.y;
                    obj.height += other.height;
                    this.world.removeObject(other.id);
                    changed = true; break;
                }
            }
        }

        this.world._spatialDirty = true;
        this.world._tileCacheReady = false;
        this.world._mergedBlockCache = null;
        this.world._editorMergedDirty = true;
    }

    // ========================================
    // INSPECT BOX (Test Mode)
    // ========================================
    createInspectBox() {
        if (this.inspectBox) return;
        
        const container = document.createElement('div');
        container.className = 'inspect-box-container';
        container.id = 'inspect-box-container';
        container.innerHTML = `
            <div class="inspect-box">
                <div class="inspect-box-title">Object Inspector</div>
                <div class="inspect-box-content" id="inspect-box-content">
                    <div class="inspect-box-empty">(Hover over an object)</div>
                </div>
            </div>
            <button class="inspect-toggle-btn" id="inspect-toggle-btn" title="Hide Inspector">
                <span class="material-symbols-outlined" style="font-size: 18px;">keyboard_double_arrow_left</span>
            </button>
        `;
        document.body.appendChild(container);
        
        this.inspectBox = container;
        this.inspectBoxContent = document.getElementById('inspect-box-content');
        
        // Toggle button
        const toggleBtn = document.getElementById('inspect-toggle-btn');
        const toggleIcon = toggleBtn.querySelector('.material-symbols-outlined');
        toggleBtn.addEventListener('click', () => {
            const isHidden = container.classList.toggle('hidden');
            toggleBtn.title = isHidden ? 'Show Inspector' : 'Hide Inspector';
            toggleIcon.textContent = isHidden ? 'visibility' : 'keyboard_double_arrow_left';
        });
    }
    
    showInspectBox() {
        if (!this.inspectBox) this.createInspectBox();
        this.inspectBox.style.display = 'block';
    }
    
    hideInspectBox() {
        if (this.inspectBox) {
            this.inspectBox.style.display = 'none';
        }
    }
    
    updateInspectBox(obj) {
        if (!this.inspectBoxContent) return;
        
        if (!obj) {
            this.inspectBoxContent.innerHTML = '<div class="inspect-box-empty">(Hover over an object)</div>';
            return;
        }
        
        const data = {
            'Type': obj.type || 'unknown',
            'Appearance': obj.appearanceType || '-',
            'Acting As': obj.actingType || '-',
            'Name': obj.name || '-',
            'Position': `(${Math.round(obj.x)}, ${Math.round(obj.y)})`,
            'Size': `${obj.width} × ${obj.height}`,
            'Color': obj.color || '-',
            'Opacity': obj.opacity !== undefined ? Math.round(obj.opacity * 100) + '%' : '-',
            'Collision': obj.collision ? 'Yes' : 'No',
            'Rotation': obj.rotation ? obj.rotation + '°' : '0°',
            'Layer': obj.layer ?? 1
        };
        
        // Add type-specific data
        if (obj.type === 'teleportal') {
            data['Portal Name'] = obj.teleportalName || '-';
            const sendCount = (obj.sendTo || []).filter(c => c?.enabled !== false).length;
            const receiveCount = (obj.receiveFrom || []).filter(c => c?.enabled !== false).length;
            data['Send To'] = sendCount > 0 ? `${sendCount} connection(s)` : 'None';
            data['Receive From'] = receiveCount > 0 ? `${receiveCount} connection(s)` : 'None';
        }
        
        if (obj.type === 'text') {
            data['Content'] = obj.content || '-';
            data['Font'] = obj.font || 'Default';
            data['Font Size'] = obj.fontSize || 24;
        }
        
        if (obj.appearanceType === 'zone') {
            data['Zone Name'] = obj.zoneName || '-';
        }
        
        // Show spike settings only for actual spikes, not spinners
        const isSpinnerObj = obj.type === 'spinner' || obj.appearanceType === 'spinner';
        if (!isSpinnerObj && (obj.appearanceType === 'spike' || obj.actingType === 'spike')) {
            data['Touchbox'] = obj.spikeTouchbox || 'default';
            data['Drop Hurt Only'] = obj.dropHurtOnly === true ? 'Yes' : (obj.dropHurtOnly === false ? 'No' : 'World Default');
        }
        
        if (obj.flipHorizontal) {
            data['Flipped'] = 'Yes';
        }
        
        // Build HTML
        let html = '';
        for (const [key, value] of Object.entries(data)) {
            if (value && value !== '-') {
                html += `<div class="inspect-box-row"><span class="inspect-box-key">${key}:</span><span class="inspect-box-value">${value}</span></div>`;
            }
        }
        
        if (!html) {
            html = '<div class="inspect-box-empty">(Data empty)</div>';
        }
        
        this.inspectBoxContent.innerHTML = html;
    }
    
    getObjectUnderMouse() {
        const worldPos = this.engine.getMouseWorldPos();
        if (!worldPos) return null;
        
        // Check from top layer to bottom
        const sortedObjects = [...this.world.objects].sort((a, b) => (b.layer ?? 1) - (a.layer ?? 1));
        
        for (const obj of sortedObjects) {
            if (worldPos.x >= obj.x && worldPos.x <= obj.x + obj.width &&
                worldPos.y >= obj.y && worldPos.y <= obj.y + obj.height) {
                return obj;
            }
        }
        return null;
    }

    // ========================================
    // TEST MODE
    // ========================================
    async startTest() {
        if (!this.world.spawnPoint) {
            this.showToast('Please add a spawn point first!', 'error');
            return;
        }

        // Save before testing
        if (this.onBeforeTest) {
            await this.onBeforeTest();
        }

        this.engine.startTestGame();
        
        // Reset fly mode to OFF for test mode
        this.isFlying = false;
        if (this.engine.localPlayer) {
            this.engine.localPlayer.isFlying = false;
        }
        
        // Update fly button UI to show inactive state
        const flyBtn = this.ui.toolbar.querySelector('[data-tool="fly"]');
        if (flyBtn) {
            flyBtn.classList.remove('active');
        }

        this.closePanel('config');
        this.closePanel('layers');
        this.closeAddMenu();
        this.stopPlacement();
        
        // Update UI
        this.ui.btnConfig.classList.add('hidden');
        this.ui.btnAdd.classList.add('hidden');
        this.ui.btnLayers.classList.add('hidden');
        this.ui.btnStopTest.classList.remove('hidden');
        this.ui.placementToolbar.classList.remove('active');
        
        // Start music playback
        this.startMusicPlayback();
        
        // Show limited toolbar (fly, zoom in, zoom out only)
        this.ui.toolbar.classList.remove('hidden');
        this.ui.toolbar.querySelectorAll('.toolbar-btn').forEach(btn => {
            const tool = btn.dataset.tool;
            const action = btn.dataset.action;
            if (tool === 'fly' || action === 'zoom-in' || action === 'zoom-out') {
                btn.classList.remove('hidden');
            } else if (btn.classList.contains('test-mode-tool')) {
                btn.classList.remove('hidden');
            } else {
                btn.classList.add('hidden');
            }
        });
        this.ui.toolbar.querySelectorAll('.toolbar-divider').forEach(div => {
            div.classList.add('hidden');
        });
        const extraEl = document.getElementById('toolbar-extra');
        if (extraEl) extraEl.classList.add('hidden');
        
        // Restore touchbox state from previous tester session (off by default until explicitly enabled in tester)
        if (this._testerTouchboxState === undefined) this._testerTouchboxState = false;
        this.showTouchboxes = this._testerTouchboxState;
        const touchboxBtnTest = this.ui.toolbar.querySelector('[data-action="toggle-touchboxes"]');
        if (touchboxBtnTest) touchboxBtnTest.classList.toggle('active', this.showTouchboxes);
        
        // Show inspect box
        this.showInspectBox();
    }

    stopTest() {
        this.engine.stopGame();
        
        this.stopMusicPlayback();
        this.hideInspectBox();
        
        // Save touchbox state for next tester session, then disable it in editor mode
        this._testerTouchboxState = this.showTouchboxes;
        this.showTouchboxes = false;
        this.invincibilityEnabled = false;
        
        // Reset tool state
        this.currentTool = EditorTool.NONE;
        this.isErasing = false;
        this.hideEraseMode();
        
        // Sync fly mode with the editor player (createEditorPlayer sets isFlying=true)
        this.isFlying = true;
        
        // Restore UI
        this.ui.btnConfig.classList.remove('hidden');
        this.ui.btnAdd.classList.remove('hidden');
        this.ui.btnLayers.classList.remove('hidden');
        this.ui.btnStopTest.classList.add('hidden');
        
        // Restore full toolbar
        this.ui.toolbar.classList.remove('hidden');
        this.ui.toolbar.querySelectorAll('.toolbar-btn').forEach(btn => {
            if (btn.classList.contains('test-mode-tool')) {
                btn.classList.add('hidden');
            } else {
            btn.classList.remove('hidden');
            }
        });
        this.ui.toolbar.querySelectorAll('.toolbar-divider').forEach(div => {
            div.classList.remove('hidden');
        });
        const extraEl = document.getElementById('toolbar-extra');
        if (extraEl) extraEl.classList.remove('hidden');
        
        // Restore correct button active states
        this.ui.toolbar.querySelectorAll('.toolbar-btn[data-tool]').forEach(btn => {
            btn.classList.remove('active');
        });
        const flyBtn = this.ui.toolbar.querySelector('[data-tool="fly"]');
        if (flyBtn) flyBtn.classList.toggle('active', this.isFlying);
    }

    // ========================================
    // EXPORT/IMPORT
    // ========================================
    async exportMap() {
        try {
            const exportManager = new ExportManager();
            await exportManager.exportToFile(this.world, this.world.mapName, this.world.storedDataType);
        this.showToast('Map exported successfully!', 'success');
        } catch (err) {
            console.error('Export failed:', err);
            this.showToast('Export failed: ' + err.message, 'error');
        }
    }

    async importMap(e) {
        const file = e.target.files[0];
        if (!file) return;

            try {
            const importManager = new ImportManager();
            const data = await importManager.importFromFile(file);
                this.world.fromJSON(data);
                this.clearUndoHistory();
                
                // Initialize plugins from imported world data
                if (window.PluginManager) {
                    await window.PluginManager.initFromWorld(this.world);
                }
                
                this.updateBackground();
            this.syncConfigPanel();
                this.triggerMapChange();
                this.showToast('Map imported successfully!', 'success');
            } catch (err) {
            console.error('Import failed:', err);
            this.showToast('Import failed: ' + err.message, 'error');
            }
        
        // Reset input
        e.target.value = '';
    }

    // ========================================
    // HOST GAME
    // ========================================
    generatePassword() {
        const chars = '0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz!@#$%';
        let password = '';
        for (let i = 0; i < 12; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        document.getElementById('config-password').value = password;
    }

    hostGame() {
        // Validate
        if (!this.world.spawnPoint) {
            this.showToast('Please add a spawn point first!', 'error');
            return;
        }

        const usePassword = document.getElementById('config-use-password').checked;
        const password = document.getElementById('config-password').value;

        if (usePassword && !password) {
            this.showToast('Please enter a password or disable password protection.', 'error');
            return;
        }

        // Host game logic will be handled by multiplayer module
        if (window.MultiplayerManager) {
            const editorMapId =
                typeof window.parkoreenEditorMapId === 'string' && window.parkoreenEditorMapId
                    ? window.parkoreenEditorMapId
                    : null;
            window.MultiplayerManager.hostGame({
                mapData: this.world.toJSON(),
                mapId: editorMapId,
                mapName: this.world.mapName || null,
                maxPlayers: Math.min(10, Math.max(1, parseInt(document.getElementById('config-max-players').value) || 10)),
                visibility: document.getElementById('config-room-visibility')?.value || 'private',
                usePassword: usePassword,
                password: password
            });
        } else {
            this.showToast('Multiplayer not available', 'error');
        }
    }

    // ========================================
    // BACKGROUND
    // ========================================
    updateBackground() {
        const gameContainer = document.getElementById('game-container');
        if (!gameContainer) return;

        let bgElement = gameContainer.querySelector('.game-bg');
        if (!bgElement) {
            bgElement = document.createElement('div');
            bgElement.className = 'game-bg';
            gameContainer.insertBefore(bgElement, gameContainer.firstChild);
        }

        // Remove existing custom background elements
        const existingCustomBg = bgElement.querySelector('.custom-bg-element');
        if (existingCustomBg) existingCustomBg.remove();

        if (this.world.background === 'custom' && this.world.customBackground.enabled) {
            bgElement.className = 'game-bg custom';
            
            // Create custom background element
            const cb = this.world.customBackground;
            if (cb.data) {
                if (cb.type === 'video') {
                    const video = document.createElement('video');
                    video.className = 'custom-bg-element';
                    video.src = cb.data;
                    video.autoplay = true;
                    video.muted = true;
                    video.loop = cb.playMode === 'loop' && cb.loopCount === -1;
                    video.playsInline = true;
                    video.style.cssText = 'position: absolute; top: 50%; left: 50%; min-width: 100%; min-height: 100%; transform: translate(-50%, -50%); object-fit: cover;';
                    bgElement.appendChild(video);
                    
                    if (cb.reverse) {
                        video.playbackRate = -1; // Note: negative playback rate not widely supported
                    }
                } else {
                    const img = document.createElement('img');
                    img.className = 'custom-bg-element';
                    img.src = cb.data;
                    img.style.cssText = 'position: absolute; top: 50%; left: 50%; min-width: 100%; min-height: 100%; transform: translate(-50%, -50%); object-fit: cover;';
                    bgElement.appendChild(img);
                }
            }
        } else {
        bgElement.className = `game-bg ${this.world.background}`;
        }
        
        // Also sync config panel values with world
        this.syncConfigPanel();
    }
    
    updatePlayerSpriteSheetStatus(message = null) {
        const status = document.getElementById('config-player-sprite-status');
        if (!status) return;
        const spriteSheet = this.world?.playerSpriteSheet;
        status.textContent = message || (spriteSheet && this._playerSpriteSheetValidationError) || (spriteSheet
            ? `Frame ${spriteSheet.frameWidth} × ${spriteSheet.frameHeight} px · ${Object.keys(spriteSheet.animations).length} states configured`
            : 'No character sprite sheet selected.');
    }

    validatePlayerSpriteSheetForEditor() {
        const spriteSheet = this.world?.playerSpriteSheet;
        if (!spriteSheet || this._playerSpriteSheetEditorValidationTarget === spriteSheet) return;
        this._playerSpriteSheetEditorValidationTarget = spriteSheet;
        this._playerSpriteSheetValidationError = '';
        const image = new Image();
        image.onerror = () => {
            if (this.world?.playerSpriteSheet !== spriteSheet) return;
            this._playerSpriteSheetValidationError = 'The selected sprite-sheet image could not be decoded.';
            this.updatePlayerSpriteSheetStatus();
        };
        image.onload = () => {
            if (this.world?.playerSpriteSheet !== spriteSheet) return;
            const columns = Math.floor(image.naturalWidth / spriteSheet.frameWidth);
            const rows = Math.floor(image.naturalHeight / spriteSheet.frameHeight);
            if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 16000000) {
                this._playerSpriteSheetValidationError = 'Image dimensions must be at most 4096 × 4096 and 16 megapixels.';
            } else if (columns < 1 || rows < 1) {
                this._playerSpriteSheetValidationError = 'The configured frame size does not fit this image.';
            } else {
                const invalid = Object.entries(spriteSheet.animations || {}).find(([, animation]) =>
                    !animation || animation.row < 0 || animation.row >= rows ||
                    animation.frameCount < 1 || animation.frameCount > columns);
                this._playerSpriteSheetValidationError = invalid
                    ? `${invalid[0][0].toUpperCase()}${invalid[0].slice(1)} needs a row below ${rows} and no more than ${columns} frames.`
                    : '';
            }
            this.updatePlayerSpriteSheetStatus();
        };
        image.src = spriteSheet.data;
    }

    loadPlayerSpriteSheet(file) {
        if (!this.world || !file) return;
        const requestId = (this._playerSpriteSheetSettingsRequest || 0) + 1;
        this._playerSpriteSheetSettingsRequest = requestId;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
            this.updatePlayerSpriteSheetStatus('Choose a PNG, JPEG, or WebP image up to 1 MB.');
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => {
            if (this._playerSpriteSheetSettingsRequest === requestId) this.updatePlayerSpriteSheetStatus('The image could not be read.');
        };
        reader.onload = () => {
            if (this._playerSpriteSheetSettingsRequest !== requestId || typeof reader.result !== 'string') return;
            const image = new Image();
            image.onerror = () => {
                if (this._playerSpriteSheetSettingsRequest === requestId) this.updatePlayerSpriteSheetStatus('The selected file is not a valid image.');
            };
            image.onload = () => {
                if (this._playerSpriteSheetSettingsRequest !== requestId) return;
                if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 16000000) {
                    this.updatePlayerSpriteSheetStatus('Image dimensions must be at most 4096 × 4096 and 16 megapixels.');
                    return;
                }
                const data = reader.result;
                const currentSpriteBytes = this.world.getSpriteSheetDataLength() - (this.world.playerSpriteSheet?.data.length || 0);
                if (currentSpriteBytes + data.length > 8 * 1024 * 1024) {
                    this.updatePlayerSpriteSheetStatus('Sprite sheets across this map and its Object Stamps are limited to 8 MiB total.');
                    return;
                }
                document.getElementById('config-player-sprite-frame-width').value = image.naturalWidth;
                document.getElementById('config-player-sprite-frame-height').value = image.naturalHeight;
                const animations = Object.fromEntries(['idle', 'run', 'jump', 'fall'].map(state => [
                    state, { row: 0, frameCount: 1, fps: 8 }
                ]));
                this._playerSpriteSheetValidationError = '';
                this._playerSpriteSheetEditorValidationTarget = null;
                this.world.playerSpriteSheet = normalizeWorldPlayerSpriteSheet({
                    data, frameWidth: image.naturalWidth, frameHeight: image.naturalHeight, animations
                });
                for (const state of ['idle', 'run', 'jump', 'fall']) {
                    document.getElementById(`config-player-sprite-${state}-row`).value = this.world.playerSpriteSheet.animations[state].row;
                    document.getElementById(`config-player-sprite-${state}-frames`).value = 1;
                    document.getElementById(`config-player-sprite-${state}-fps`).value = 8;
                }
                for (const state of ['attack', 'hurt', 'dash']) {
                    const enabled = document.getElementById(`config-player-sprite-${state}-enabled`);
                    if (enabled) enabled.checked = false;
                    document.getElementById(`config-player-sprite-${state}-row`)?.classList.add('hidden');
                }
                this.updatePlayerSpriteSheetStatus(`${image.naturalWidth} × ${image.naturalHeight} px · configure rows and frame counts below`);
                this.triggerMapChange();
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    applyPlayerSpriteSheetSettings() {
        const current = this.world?.playerSpriteSheet;
        if (!current) return;
        const requestId = (this._playerSpriteSheetSettingsRequest || 0) + 1;
        this._playerSpriteSheetSettingsRequest = requestId;
        const frameWidth = Number(document.getElementById('config-player-sprite-frame-width').value);
        const frameHeight = Number(document.getElementById('config-player-sprite-frame-height').value);
        if (!Number.isInteger(frameWidth) || frameWidth < 1 || frameWidth > 4096 ||
            !Number.isInteger(frameHeight) || frameHeight < 1 || frameHeight > 4096) {
            this.updatePlayerSpriteSheetStatus('Frame dimensions must be between 1 and 4096 pixels.');
            return;
        }
        const animations = {};
        for (const state of ['idle', 'run', 'jump', 'fall']) {
            const row = Number(document.getElementById(`config-player-sprite-${state}-row`).value);
            const frameCount = Number(document.getElementById(`config-player-sprite-${state}-frames`).value);
            const fps = Number(document.getElementById(`config-player-sprite-${state}-fps`).value);
            if (!Number.isInteger(row) || row < 0 || row > 127 ||
                !Number.isInteger(frameCount) || frameCount < 1 || frameCount > 256 ||
                !Number.isFinite(fps) || fps < 1 || fps > 30) {
                this.updatePlayerSpriteSheetStatus('Rows must be 0–127, frames 1–256, and animation speed 1–30 FPS.');
                return;
            }
            animations[state] = { row, frameCount, fps };
        }
        for (const state of ['attack', 'hurt', 'dash']) {
            if (!document.getElementById(`config-player-sprite-${state}-enabled`)?.checked) continue;
            const row = Number(document.getElementById(`config-player-sprite-${state}-row-index`).value);
            const frameCount = Number(document.getElementById(`config-player-sprite-${state}-frames`).value);
            const fps = Number(document.getElementById(`config-player-sprite-${state}-fps`).value);
            if (!Number.isInteger(row) || row < 0 || row > 127 ||
                !Number.isInteger(frameCount) || frameCount < 1 || frameCount > 256 ||
                !Number.isFinite(fps) || fps < 1 || fps > 30) {
                this.updatePlayerSpriteSheetStatus(`${state[0].toUpperCase()}${state.slice(1)} rows must be 0–127, frames 1–256, and animation speed 1–30 FPS.`);
                return;
            }
            animations[state] = { row, frameCount, fps };
        }
        const applyIfValid = image => {
            if (!this.world || this._playerSpriteSheetSettingsRequest !== requestId || this.world.playerSpriteSheet !== current) return;
            const columns = Math.floor(image.naturalWidth / frameWidth);
            const rows = Math.floor(image.naturalHeight / frameHeight);
            if (columns < 1 || rows < 1) {
                this.updatePlayerSpriteSheetStatus('The selected frame size does not fit this image.');
                return;
            }
            for (const [state, animation] of Object.entries(animations)) {
                if (animation.row >= rows || animation.frameCount > columns) {
                    this.updatePlayerSpriteSheetStatus(`${state[0].toUpperCase()}${state.slice(1)} needs a row below ${rows} and no more than ${columns} frames.`);
                    return;
                }
            }
            this._playerSpriteSheetValidationError = '';
            this._playerSpriteSheetEditorValidationTarget = null;
            this.world.playerSpriteSheet = normalizeWorldPlayerSpriteSheet({ ...current, frameWidth, frameHeight, animations });
            this.updatePlayerSpriteSheetStatus();
            this.triggerMapChange();
        };
        const image = new Image();
        image.onload = () => applyIfValid(image);
        image.onerror = () => {
            if (this._playerSpriteSheetSettingsRequest === requestId) this.updatePlayerSpriteSheetStatus('The selected sprite-sheet image could not be decoded.');
        };
        image.src = current.data;
    }

    syncConfigPanel() {
        // Map Name
        const mapNameInput = document.getElementById('config-map-name');
        if (mapNameInput) mapNameInput.value = this.world.mapName || 'Untitled Map';

        // Background
        const bgSelect = document.getElementById('config-background');
        if (bgSelect) bgSelect.value = this.world.background;
        
        // Colors
        const blockColor = document.getElementById('config-block-color');
        const blockPreview = document.getElementById('config-block-color-preview');
        if (blockColor) blockColor.value = this.world.defaultBlockColor;
        if (blockPreview) blockPreview.style.background = this.world.defaultBlockColor;
        
        const spikeColor = document.getElementById('config-spike-color');
        const spikePreview = document.getElementById('config-spike-color-preview');
        if (spikeColor) spikeColor.value = this.world.defaultSpikeColor;
        if (spikePreview) spikePreview.style.background = this.world.defaultSpikeColor;
        
        const textColor = document.getElementById('config-text-color');
        const textPreview = document.getElementById('config-text-color-preview');
        if (textColor) textColor.value = this.world.defaultTextColor;
        if (textPreview) textPreview.style.background = this.world.defaultTextColor;

        const portalColor = document.getElementById('config-portal-color');
        const portalPreview = document.getElementById('config-portal-color-preview');
        if (portalColor) portalColor.value = this.world.defaultPortalColor || '#9b59b6';
        if (portalPreview) portalPreview.style.background = this.world.defaultPortalColor || '#9b59b6';

        const bouncerColor = document.getElementById('config-bouncer-color');
        const bouncerPreview = document.getElementById('config-bouncer-color-preview');
if (bouncerColor) bouncerColor.value = this.world.defaultBouncerColor || '#461A0C';
                if (bouncerPreview) bouncerPreview.style.background = this.world.defaultBouncerColor || '#461A0C';
        
        // Cloud colors
        const cloudSkyColor = document.getElementById('config-cloud-sky');
        const cloudSkyPreview = document.getElementById('config-cloud-sky-preview');
        if (cloudSkyColor) cloudSkyColor.value = this.world.cloudColorSky || '#ffffff';
        if (cloudSkyPreview) cloudSkyPreview.style.background = this.world.cloudColorSky || '#ffffff';
        
        const cloudGalaxyColor = document.getElementById('config-cloud-galaxy');
        const cloudGalaxyPreview = document.getElementById('config-cloud-galaxy-preview');
        if (cloudGalaxyColor) cloudGalaxyColor.value = this.world.cloudColorGalaxy || '#9382a8';
        if (cloudGalaxyPreview) cloudGalaxyPreview.style.background = this.world.cloudColorGalaxy || '#9382a8';

        // Checkpoint colors
        const cpDefaultColor = document.getElementById('config-checkpoint-default');
        const cpDefaultPreview = document.getElementById('config-checkpoint-default-preview');
        if (cpDefaultColor) cpDefaultColor.value = this.world.checkpointDefaultColor || '#808080';
        if (cpDefaultPreview) cpDefaultPreview.style.background = this.world.checkpointDefaultColor || '#808080';
        
        const cpActiveColor = document.getElementById('config-checkpoint-active');
        const cpActivePreview = document.getElementById('config-checkpoint-active-preview');
        if (cpActiveColor) cpActiveColor.value = this.world.checkpointActiveColor || '#4CAF50';
        if (cpActivePreview) cpActivePreview.style.background = this.world.checkpointActiveColor || '#4CAF50';
        
        const cpTouchedColor = document.getElementById('config-checkpoint-touched');
        const cpTouchedPreview = document.getElementById('config-checkpoint-touched-preview');
        if (cpTouchedColor) cpTouchedColor.value = this.world.checkpointTouchedColor || '#2196F3';
        if (cpTouchedPreview) cpTouchedPreview.style.background = this.world.checkpointTouchedColor || '#2196F3';
        const persistCheckpoints = document.getElementById('config-persist-checkpoints');
        if (persistCheckpoints) persistCheckpoints.checked = this.world.persistCheckpoints === true;
        
        // Jumps
        const jumpsSelect = document.getElementById('config-jumps');
        const jumpsNumber = document.getElementById('config-jumps-number');
        const jumpsNumberGroup = document.getElementById('config-jumps-number-group');
        const airjumpGroup = document.getElementById('config-airjump-group');
        const airjumpCheck = document.getElementById('config-airjump');
        const collideCheck = document.getElementById('config-collide');
        
        if (jumpsSelect) {
            jumpsSelect.value = this.world.infiniteJumps ? 'infinite' : 'set';
        }
        if (jumpsNumber) jumpsNumber.value = this.world.maxJumps;
        if (jumpsNumberGroup) jumpsNumberGroup.classList.toggle('hidden', this.world.infiniteJumps);
        if (airjumpGroup) airjumpGroup.classList.toggle('hidden', this.world.infiniteJumps);
        if (airjumpCheck) airjumpCheck.checked = this.world.additionalAirjump;
        if (collideCheck) collideCheck.checked = this.world.collideWithEachOther;

        const playerSprite = this.world.playerSpriteSheet;
        const playerSpriteFile = document.getElementById('config-player-sprite-file');
        if (playerSpriteFile) playerSpriteFile.value = '';
        const playerSpriteFrameWidth = document.getElementById('config-player-sprite-frame-width');
        if (playerSpriteFrameWidth) playerSpriteFrameWidth.value = playerSprite?.frameWidth || 32;
        const playerSpriteFrameHeight = document.getElementById('config-player-sprite-frame-height');
        if (playerSpriteFrameHeight) playerSpriteFrameHeight.value = playerSprite?.frameHeight || 32;
        for (const [index, state] of ['attack', 'hurt', 'dash'].entries()) {
            const animation = playerSprite?.animations?.[state];
            const enabled = document.getElementById(`config-player-sprite-${state}-enabled`);
            if (enabled) enabled.checked = Boolean(animation);
            document.getElementById(`config-player-sprite-${state}-row`)?.classList.toggle('hidden', !animation);
            const row = document.getElementById(`config-player-sprite-${state}-row-index`);
            const frames = document.getElementById(`config-player-sprite-${state}-frames`);
            const fps = document.getElementById(`config-player-sprite-${state}-fps`);
            if (row) row.value = animation?.row ?? 4 + index;
            if (frames) frames.value = animation?.frameCount ?? 1;
            if (fps) fps.value = animation?.fps ?? (state === 'attack' ? 12 : 8);
        }
        for (const [index, state] of ['idle', 'run', 'jump', 'fall'].entries()) {
            const animation = playerSprite?.animations?.[state];
            const row = document.getElementById(`config-player-sprite-${state}-row`);
            const frames = document.getElementById(`config-player-sprite-${state}-frames`);
            const fps = document.getElementById(`config-player-sprite-${state}-fps`);
            if (row) row.value = animation?.row ?? index;
            if (frames) frames.value = animation?.frameCount ?? 1;
            if (fps) fps.value = animation?.fps ?? 8;
        }
        this.updatePlayerSpriteSheetStatus();
        this.validatePlayerSpriteSheetForEditor();

        // Coin counter
        const showCoinCounter = document.getElementById('config-show-coin-counter');
        if (showCoinCounter) showCoinCounter.checked = this.world.showCoinCounter !== false;
        
        // Die line Y
        const dieLineY = document.getElementById('config-die-line-y');
        if (dieLineY) dieLineY.value = this.world.dieLineY || 1000;
        
        // Physics settings
        const playerSpeed = document.getElementById('config-player-speed');
        if (playerSpeed) playerSpeed.value = this.world.playerSpeed || 5;
        
        const jumpForce = document.getElementById('config-jump-force');
        if (jumpForce) jumpForce.value = this.world.jumpForce || -13.2;
        
        const gravity = document.getElementById('config-gravity');
        if (gravity) gravity.value = this.world.gravity || 0.71;

        const horizontalAcceleration = document.getElementById('config-horizontal-acceleration');
        if (horizontalAcceleration) horizontalAcceleration.value = this.world.horizontalAcceleration ?? 0;

        const airControl = document.getElementById('config-air-control');
        if (airControl) airControl.value = this.world.airControl ?? 1;

        const terminalFallSpeed = document.getElementById('config-terminal-fall-speed');
        if (terminalFallSpeed) {
            terminalFallSpeed.value = this.world.terminalFallSpeed ?? (16 * (this.world.gravity || 0.71) / 0.71).toFixed(1);
        }
        
        const cameraLerpX = document.getElementById('config-camera-lerp-x');
        const cameraLerpXValue = document.getElementById('config-camera-lerp-x-value');
        if (cameraLerpX) {
            cameraLerpX.value = this.world.cameraLerpX || 0.12;
            if (cameraLerpXValue) cameraLerpXValue.textContent = (this.world.cameraLerpX || 0.12).toFixed(2);
        }
        
        const cameraLerpY = document.getElementById('config-camera-lerp-y');
        const cameraLerpYValue = document.getElementById('config-camera-lerp-y-value');
        if (cameraLerpY) {
            cameraLerpY.value = this.world.cameraLerpY || 0.12;
            if (cameraLerpYValue) cameraLerpYValue.textContent = (this.world.cameraLerpY || 0.12).toFixed(2);
        }
        const cameraFollowMode = document.getElementById('config-camera-follow-mode');
        if (cameraFollowMode) cameraFollowMode.value = this.world.cameraFollowMode || 'both';

        const cameraBounds = this.world.cameraBounds || { enabled: false, x: 0, y: 0, width: 2000, height: 1200 };
        const cameraBoundsEnabled = document.getElementById('config-camera-bounds-enabled');
        const cameraBoundsFields = document.getElementById('config-camera-bounds-fields');
        if (cameraBoundsEnabled) cameraBoundsEnabled.checked = cameraBounds.enabled === true;
        if (cameraBoundsFields) cameraBoundsFields.style.display = cameraBounds.enabled === true ? 'grid' : 'none';
        ['x', 'y', 'width', 'height'].forEach(key => {
            const input = document.getElementById(`config-camera-bounds-${key}`);
            if (input) {
                input.value = cameraBounds[key];
                input.disabled = cameraBounds.enabled !== true;
            }
        });
        
        // Spike touchbox
        const spikeTouchbox = document.getElementById('config-spike-touchbox');
        if (spikeTouchbox) {
            spikeTouchbox.value = this.world.spikeTouchbox || 'normal';
            this.updateSpikeTouchboxDescription(this.world.spikeTouchbox || 'normal');
        }
        
        // Drop Hurt Only
        const dropHurtOnly = document.getElementById('config-drop-hurt-only');
        if (dropHurtOnly) {
            dropHurtOnly.checked = this.world.dropHurtOnly || false;
        }
        
        // Stored data type
        const storedDataType = document.getElementById('config-stored-data-type');
        if (storedDataType) {
            storedDataType.value = this.world.storedDataType || 'json';
            this.updateStoredDataTypeDescription(this.world.storedDataType || 'json');
        }
        
        // Music settings
        const musicSelect = document.getElementById('config-music');
        const customMusicOptions = document.getElementById('custom-music-options');
        const musicVolume = document.getElementById('config-music-volume');
        const musicVolumeLabel = document.getElementById('config-music-volume-label');
        const musicLoop = document.getElementById('config-music-loop');
        
        if (musicSelect && this.world.music) {
            musicSelect.value = this.world.music.type || 'none';
            
            if (this.world.music.type === 'custom') {
                customMusicOptions.classList.remove('hidden');
                
                // If there's custom music data, show the preview
                if (this.world.music.customData) {
                    const preview = document.getElementById('custom-music-preview');
                    const dropzone = document.getElementById('custom-music-dropzone');
                    const nameEl = document.getElementById('custom-music-name');
                    
                    nameEl.textContent = this.world.music.customName || 'Custom Music';
                    preview.classList.remove('hidden');
                    dropzone.classList.add('hidden');
                    
                    if (this.previewAudio) {
                        this.previewAudio.src = this.world.music.customData;
                        this.previewAudio.volume = this.world.music.volume / 100;
                    }
                }
            } else {
                customMusicOptions.classList.add('hidden');
            }
        }
        
        if (musicVolume) {
            musicVolume.value = this.world.music?.volume ?? 50;
        }
        if (musicVolumeLabel) {
            musicVolumeLabel.textContent = (this.world.music?.volume ?? 50) + '%';
        }
        if (musicLoop) {
            musicLoop.checked = this.world.music?.loop !== false;
        }
        
        // Plugin settings
        this.syncPluginSettings();
        
        // Custom background
        this.syncCustomBackgroundUI();
    }
    
    syncPluginSettings() {
        // Update plugin config sections visibility
        this.updatePluginConfigSections();
        
        // HP settings
        const hpDefault = document.getElementById('config-hp-default');
        if (hpDefault) {
            hpDefault.value = this.world.plugins?.hp?.defaultHP ?? 3;
        }
        
        // Hollow Knight settings
        const hkGravity = document.getElementById('config-hk-gravity');
        const hkMaxSoul = document.getElementById('config-hk-maxsoul');
        const hkPogoBouncePower = document.getElementById('config-hk-pogo-bounce-power');
        const hkNailSpeed = document.getElementById('config-hk-nail-speed');
        const hkMonarchWing = document.getElementById('config-hk-monarchwing');
        const hkMonarchWingAmount = document.getElementById('config-hk-monarchwing-amount');
        const hkMonarchWingAmountGroup = document.getElementById('config-hk-monarchwing-amount-group');
        const hkDash = document.getElementById('config-hk-dash');
        const hkSuperDash = document.getElementById('config-hk-superdash');
        const hkMantisClaw = document.getElementById('config-hk-mantisclaw');
        const hkEffectToggles = [
            ['config-hk-slash-effects', 'slashEffects'],
            ['config-hk-impact-effects', 'impactEffects'],
            ['config-hk-camera-shake-effects', 'cameraShakeEffects'],
            ['config-hk-dash-trail-effects', 'dashTrailEffects'],
            ['config-hk-ability-aura-effects', 'abilityAuraEffects']
        ];
        const hkShakeIntensities = [
            ['config-hk-impact-shake-intensity', 'impactShakeIntensity', 7],
            ['config-hk-landing-shake-intensity', 'landingShakeIntensity', 2]
        ];
        const hkEffectColors = [
            ['config-hk-nail-effect-color', 'nailEffectColor'],
            ['config-hk-dash-effect-color', 'dashEffectColor'],
            ['config-hk-charge-effect-color', 'chargeEffectColor'],
            ['config-hk-heal-effect-color', 'healEffectColor']
        ];
        
        const hk = this.world.plugins?.hk;
        if (hkGravity) hkGravity.value = hk?.defaultGravity ?? 1.14;
        if (hkMaxSoul) hkMaxSoul.value = hk?.maxSoul ?? 99;
        if (hkPogoBouncePower) hkPogoBouncePower.value = hk?.pogoBouncePower ?? 1.2;
        if (hkNailSpeed) hkNailSpeed.value = hk?.nailSpeed === 'quickSlash' ? 'quickSlash' : 'base';
        if (hkMonarchWing) hkMonarchWing.checked = hk?.monarchWing ?? false;
        if (hkMonarchWingAmount) hkMonarchWingAmount.value = hk?.monarchWingAmount ?? 1;
        if (hkMonarchWingAmountGroup) hkMonarchWingAmountGroup.classList.toggle('hidden', !(hk?.monarchWing));
        if (hkDash) hkDash.checked = hk?.dash ?? false;
        if (hkSuperDash) hkSuperDash.checked = hk?.superDash ?? false;
        if (hkMantisClaw) hkMantisClaw.checked = hk?.mantisClaw ?? false;
        hkEffectToggles.forEach(([elementId, configKey]) => {
            const input = document.getElementById(elementId);
            if (input) input.checked = hk?.[configKey] !== false;
        });
        hkShakeIntensities.forEach(([elementId, configKey, fallback]) => {
            const input = document.getElementById(elementId);
            if (input) input.value = hk?.[configKey] ?? fallback;
        });
        document.getElementById('config-hk-camera-shake-settings')?.classList.toggle('hidden', hk?.cameraShakeEffects === false);
        hkEffectColors.forEach(([elementId, configKey]) => {
            const input = document.getElementById(elementId);
            const color = hk?.[configKey];
            if (input) input.value = typeof color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color)
                ? color : input.defaultValue;
        });
        
        // Code plugin settings
        const codeAutoRespawn = document.getElementById('config-code-autorespawn');
        const code = this.world.plugins?.code;
        if (codeAutoRespawn) codeAutoRespawn.checked = code?.autoRespawn ?? true;
        
        // Update zone button state
        this.updateZoneButtonState();
    }
    
    syncCustomBackgroundUI() {
        const customOptions = document.getElementById('custom-bg-options');
        const dropzone = document.getElementById('custom-bg-dropzone');
        const preview = document.getElementById('custom-bg-preview');
        const previewImg = document.getElementById('custom-bg-preview-img');
        const previewVideo = document.getElementById('custom-bg-preview-video');
        const videoOptions = document.getElementById('custom-bg-video-options');
        const playMode = document.getElementById('custom-bg-playmode');
        const loopType = document.getElementById('custom-bg-loop-type');
        const loopCount = document.getElementById('custom-bg-loop-count');
        const loopOptions = document.getElementById('custom-bg-loop-options');
        const endOptions = document.getElementById('custom-bg-end-options');
        const endType = document.getElementById('custom-bg-endtype');
        const syncCheckbox = document.getElementById('custom-bg-sync');
        const reverseCheckbox = document.getElementById('custom-bg-reverse');
        
        const cb = this.world.customBackground;
        
        // Show/hide custom options based on background type
        if (this.world.background === 'custom') {
            customOptions.classList.remove('hidden');
        } else {
            customOptions.classList.add('hidden');
            return;
        }
        
        if (cb.enabled && cb.data) {
            // Show preview
            preview.classList.remove('hidden');
            dropzone.classList.add('hidden');
            
            if (cb.type === 'video') {
                previewImg.style.display = 'none';
                previewVideo.style.display = 'block';
                previewVideo.src = cb.data;
                previewVideo.play();
                videoOptions.classList.remove('hidden');
            } else if (cb.type === 'gif') {
                previewImg.style.display = 'block';
                previewVideo.style.display = 'none';
                previewImg.src = cb.data;
                videoOptions.classList.remove('hidden');
            } else {
                previewImg.style.display = 'block';
                previewVideo.style.display = 'none';
                previewImg.src = cb.data;
                videoOptions.classList.add('hidden');
            }
            
            // Sync video options
            if (playMode) playMode.value = cb.playMode || 'loop';
            if (loopType) loopType.value = cb.loopCount === -1 ? 'infinite' : 'set';
            if (loopCount) {
                loopCount.value = cb.loopCount > 0 ? cb.loopCount : 1;
                loopCount.style.display = cb.loopCount === -1 ? 'none' : 'block';
            }
            
            // Show/hide based on play mode
            if (cb.playMode === 'once') {
                loopOptions.classList.add('hidden');
                endOptions.classList.remove('hidden');
            } else {
                loopOptions.classList.remove('hidden');
                if (cb.loopCount === -1) {
                    endOptions.classList.add('hidden');
                } else {
                    endOptions.classList.remove('hidden');
                }
            }
            
            // Update loop label
            const loopLabel = loopOptions.querySelector('.form-label');
            if (loopLabel) {
                loopLabel.textContent = cb.playMode === 'bounce' ? 'Bounce Amount' : 'Loop Amount';
            }
            
            if (endType) endType.value = cb.endType || 'freeze';
            if (syncCheckbox) syncCheckbox.checked = cb.sameAcrossScreens || false;
            if (reverseCheckbox) reverseCheckbox.checked = cb.reverse || false;
        } else {
            // No custom background - show upload
            preview.classList.add('hidden');
            dropzone.classList.remove('hidden');
            videoOptions.classList.add('hidden');
        }
    }
    
    updateSpikeTouchboxDescription(mode) {
        const descEl = document.getElementById('spike-touchbox-description');
        if (!descEl) return;
        
        const descriptions = {
            'full': '<strong style="color: #ff6b6b;">Full Spike:</strong> The entire spike is dangerous. Any contact with the spike will damage the player. There is no safe zone.',
            'normal': '<strong style="color: #ffd93d;">Normal Spike:</strong> The flat base of the spike acts as solid ground. All other parts will damage the player on contact. This is the default behavior.',
            'tip': '<strong style="color: #6bcb77;">Tip Spike:</strong> Only the very peak of the spike is dangerous. The flat base acts as ground, and the middle section has no collision at all.',
            'all-spike': '<strong style="color: #ff9f43;">All Spike:</strong> No safe zone. Like Normal Spike but the flat base now also damages the player. The danger zone and the flat base are both lethal — the player cannot stand on it.',
            'ground': '<strong style="color: #4d96ff;">Ground:</strong> The spike acts completely as solid ground. It will not damage the player at all - useful for decorative spikes.',
            'flag': '<strong style="color: #9b59b6;">Flag:</strong> Only the flat base acts as solid ground. The rest of the spike has no collision - player can pass through but won\'t take damage.',
            'air': '<strong style="color: #888;">Air:</strong> The spike has no collision at all. Players pass through completely without any interaction.'
        };
        
        descEl.innerHTML = descriptions[mode] || descriptions['normal'];
    }
    
    updateStoredDataTypeDescription(type) {
        const descEl = document.getElementById('stored-data-type-description');
        if (!descEl) return;
        
        const descriptions = {
            'json': '<strong style="color: #6bcb77;">.json:</strong> Human-readable format. Easier to debug and edit manually. Recommended for smaller maps or during development.',
            'dat': '<strong style="color: #4d96ff;">.dat:</strong> Binary format with compression. Smaller file size, faster loading. Recommended for extremely large maps with many objects or media files.'
        };
        
        descEl.innerHTML = descriptions[type] || descriptions['json'];
    }
    
    handleMusicUpload(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            this.world.music.customData = e.target.result;
            this.world.music.customName = file.name;
            
            // Update UI
            const preview = document.getElementById('custom-music-preview');
            const dropzone = document.getElementById('custom-music-dropzone');
            const nameEl = document.getElementById('custom-music-name');
            
            nameEl.textContent = file.name;
            preview.classList.remove('hidden');
            dropzone.classList.add('hidden');
            
            // Set audio source for preview
            this.previewAudio.src = e.target.result;
            this.previewAudio.volume = this.world.music.volume / 100;
            
            this.triggerMapChange();
            this.updateMusicPlayback();
        };
        reader.readAsDataURL(file);
    }
    
    updateMusicPlayback() {
        // Stop any existing music
        if (this.bgMusic) {
            this.bgMusic.pause();
            this.bgMusic.src = '';
        }
        
        const music = this.world.music;
        if (music.type === 'none') {
            return;
        }
        
        if (!this.bgMusic) {
            this.bgMusic = new Audio();
        }
        
        let src = null;
        if (music.type === 'custom' && music.customData) {
            src = music.customData;
        } else if (music.type !== 'none') {
            // Built-in music files
            const musicFiles = {
                'maccary-bay': 'assets/mp3/maccary-bay.mp3',
                'reggae-party': 'assets/mp3/reggae-party.mp3'
            };
            src = musicFiles[music.type];
        }
        
        if (src) {
            this.bgMusic.src = src;
            this.bgMusic.volume = music.volume / 100;
            this.bgMusic.loop = music.loop;
            // Don't auto-play in editor
        }
    }
    
    startMusicPlayback() {
        // Set up the music if not already done
        this.updateMusicPlayback();
        
        // Start playing if there's music to play
        if (this.bgMusic && this.bgMusic.src && this.world.music.type !== 'none') {
            this.bgMusic.currentTime = 0;
            this.bgMusic.play().catch(err => {
                console.log('Music playback blocked by browser:', err);
            });
        }
    }
    
    stopMusicPlayback() {
        if (this.bgMusic) {
            this.bgMusic.pause();
            this.bgMusic.currentTime = 0;
        }
    }
    
    setupCollapsibleSections() {
        const sections = document.querySelectorAll('.config-section.collapsible');
        
        sections.forEach(section => {
            const header = section.querySelector('.config-section-header');
            if (!header) return;
            
            header.addEventListener('click', () => {
                section.classList.toggle('expanded');
            });
        });
    }
    
    setupCustomBackgroundListeners() {
        const dropzone = document.getElementById('custom-bg-dropzone');
        const fileInput = document.getElementById('custom-bg-file');
        const preview = document.getElementById('custom-bg-preview');
        const previewImg = document.getElementById('custom-bg-preview-img');
        const previewVideo = document.getElementById('custom-bg-preview-video');
        const removeBtn = document.getElementById('custom-bg-remove');
        const videoOptions = document.getElementById('custom-bg-video-options');
        const playMode = document.getElementById('custom-bg-playmode');
        const loopOptions = document.getElementById('custom-bg-loop-options');
        const loopType = document.getElementById('custom-bg-loop-type');
        const loopCount = document.getElementById('custom-bg-loop-count');
        const endOptions = document.getElementById('custom-bg-end-options');
        const endType = document.getElementById('custom-bg-endtype');
        const endUpload = document.getElementById('custom-bg-end-upload');
        const syncCheckbox = document.getElementById('custom-bg-sync');
        const reverseCheckbox = document.getElementById('custom-bg-reverse');
        
        // Dropzone click
        dropzone.addEventListener('click', () => fileInput.click());
        
        // Drag and drop
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--primary)';
            dropzone.style.background = 'rgba(45, 90, 39, 0.1)';
        });
        
        dropzone.addEventListener('dragleave', () => {
            dropzone.style.borderColor = 'var(--surface-light)';
            dropzone.style.background = 'transparent';
        });
        
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--surface-light)';
            dropzone.style.background = 'transparent';
            
            const file = e.dataTransfer.files[0];
            if (file) this.handleCustomBackgroundFile(file);
        });
        
        // File input change
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this.handleCustomBackgroundFile(file);
        });
        
        // Remove button
        removeBtn.addEventListener('click', () => {
            this.world.customBackground.enabled = false;
            this.world.customBackground.type = null;
            this.world.customBackground.data = null;
            
            preview.classList.add('hidden');
            previewImg.style.display = 'none';
            previewVideo.style.display = 'none';
            videoOptions.classList.add('hidden');
            dropzone.classList.remove('hidden');
            
            this.updateBackground();
            this.triggerMapChange();
        });
        
        // Play mode change
        playMode.addEventListener('change', (e) => {
            const mode = e.target.value;
            this.world.customBackground.playMode = mode;
            
            // Update loop options label
            const loopLabel = loopOptions.querySelector('.form-label');
            if (mode === 'bounce') {
                loopLabel.textContent = 'Bounce Amount';
            } else {
                loopLabel.textContent = 'Loop Amount';
            }
            
            // Show/hide options based on mode
            if (mode === 'once') {
                loopOptions.classList.add('hidden');
                endOptions.classList.remove('hidden');
            } else {
                loopOptions.classList.remove('hidden');
                this.updateEndOptionsVisibility();
            }
            
            this.triggerMapChange();
        });
        
        // Loop type change
        loopType.addEventListener('change', (e) => {
            if (e.target.value === 'set') {
                loopCount.style.display = 'block';
                this.world.customBackground.loopCount = parseInt(loopCount.value) || 1;
            } else {
                loopCount.style.display = 'none';
                this.world.customBackground.loopCount = -1;
            }
            this.updateEndOptionsVisibility();
            this.triggerMapChange();
        });
        
        // Loop count change
        loopCount.addEventListener('change', (e) => {
            // Don't auto-correct while typing
            if (e.target.value === '') return;
            
            const val = parseInt(e.target.value);
            if (isNaN(val) || val < 1) {
                e.target.value = 1;
                this.world.customBackground.loopCount = 1;
            } else {
                this.world.customBackground.loopCount = val;
            }
            this.triggerMapChange();
        });
        
        // Handle blur to auto-correct empty value
        loopCount.addEventListener('blur', (e) => {
            if (e.target.value === '' || parseInt(e.target.value) < 1) {
                e.target.value = 1;
                this.world.customBackground.loopCount = 1;
                this.triggerMapChange();
            }
        });
        
        // End type change
        endType.addEventListener('change', (e) => {
            this.world.customBackground.endType = e.target.value;
            endUpload.classList.toggle('hidden', e.target.value !== 'replace');
            this.triggerMapChange();
        });
        
        // Sync checkbox
        syncCheckbox.addEventListener('change', (e) => {
            this.world.customBackground.sameAcrossScreens = e.target.checked;
            this.triggerMapChange();
        });
        
        // Reverse checkbox
        reverseCheckbox.addEventListener('change', (e) => {
            this.world.customBackground.reverse = e.target.checked;
            this.triggerMapChange();
        });
    }
    
    updateEndOptionsVisibility() {
        const loopType = document.getElementById('custom-bg-loop-type');
        const endOptions = document.getElementById('custom-bg-end-options');
        const playMode = document.getElementById('custom-bg-playmode');
        
        // Show end options if play once or limited loops/bounces
        if (playMode.value === 'once' || loopType.value === 'set') {
            endOptions.classList.remove('hidden');
        } else {
            endOptions.classList.add('hidden');
        }
    }
    
    handleCustomBackgroundFile(file) {
        const preview = document.getElementById('custom-bg-preview');
        const previewImg = document.getElementById('custom-bg-preview-img');
        const previewVideo = document.getElementById('custom-bg-preview-video');
        const videoOptions = document.getElementById('custom-bg-video-options');
        const dropzone = document.getElementById('custom-bg-dropzone');
        
        const reader = new FileReader();
        
        reader.onload = (e) => {
            const data = e.target.result;
            const isVideo = file.type.startsWith('video/');
            const isGif = file.type === 'image/gif';
            
            this.world.customBackground.enabled = true;
            this.world.customBackground.data = data;
            this.world.customBackground.type = isVideo ? 'video' : (isGif ? 'gif' : 'image');
            
            // Show preview
            preview.classList.remove('hidden');
            dropzone.classList.add('hidden');
            
            if (isVideo) {
                previewImg.style.display = 'none';
                previewVideo.style.display = 'block';
                previewVideo.src = data;
                previewVideo.play();
                videoOptions.classList.remove('hidden');
            } else if (isGif) {
                previewImg.style.display = 'block';
                previewVideo.style.display = 'none';
                previewImg.src = data;
                videoOptions.classList.remove('hidden');
            } else {
                previewImg.style.display = 'block';
                previewVideo.style.display = 'none';
                previewImg.src = data;
                videoOptions.classList.add('hidden');
            }
            
            this.updateBackground();
            this.triggerMapChange();
        };
        
        reader.readAsDataURL(file);
    }

    // ========================================
    // TOUCH CONTROLS - Multi-touch enabled
    // ========================================
    clearTouchControlInput() {
        for (const direction of ['up', 'down', 'left', 'right', 'jump', 'attack', 'dash', 'heal']) {
            this.engine.setTouchInput(direction, false);
        }

        const touchControls = document.getElementById('touch-controls');
        touchControls?.querySelectorAll('.touch-plugin-control').forEach(button => {
            this.engine.setTouchInput(button.dataset.action, false);
        });
        touchControls?.querySelector('.touch-joystick-base')?.classList.remove('active');
        const joystickStick = touchControls?.querySelector('.touch-joystick-stick');
        if (joystickStick) joystickStick.style.transform = 'translate(0, 0)';
        touchControls?.querySelectorAll('.touch-btn.active').forEach(button => button.classList.remove('active'));

        if (this.touchState) {
            this.touchState.joystick = { touchId: null, x: 0, y: 0 };
            this.touchState.buttons?.clear();
        }
    }

    updateTouchControls() {
        let touchControls = document.getElementById('touch-controls');
        
        if (this.engine.touchControlsEnabled) {
            if (!touchControls) {
                touchControls = document.createElement('div');
                touchControls.id = 'touch-controls';
                touchControls.className = 'touch-controls active';
                
                // Check if HK plugin is enabled and which abilities are active
                const hkEnabled = window.PluginManager?.isEnabled('hk');
                const hkConfig = this.world?.plugins?.hk || {};
                
                // Attack is always available when HK is enabled
                const hasAttack = hkEnabled;
                // Dash requires the dash ability to be enabled
                const hasDash = hkEnabled && hkConfig.dash;
                // Heal is always available when HK is enabled (uses soul)
                const hasHeal = hkEnabled;
                const pluginControls = window.PluginManager?.getTouchControls?.() || [];
                
                touchControls.innerHTML = `
                    <div class="touch-joystick-container">
                        <div class="touch-joystick-base" id="touch-joystick">
                            <div class="touch-joystick-stick"></div>
                    </div>
                    </div>
                    <div class="touch-buttons-right">
                        <button class="touch-btn touch-jump" data-action="jump">
                            <span class="material-symbols-outlined">keyboard_double_arrow_up</span>
                        </button>
                        ${hasAttack ? `
                        <button class="touch-btn touch-attack" data-action="attack">
                            <span class="material-symbols-outlined">swords</span>
                        </button>
                        ` : ''}
                        ${hasDash ? `
                        <button class="touch-btn touch-dash" data-action="dash">
                            <span class="material-symbols-outlined">bolt</span>
                        </button>
                        ` : ''}
                        ${hasHeal ? `
                        <button class="touch-btn touch-heal" data-action="heal">
                            <span class="material-symbols-outlined">favorite</span>
                        </button>
                        ` : ''}
                        ${pluginControls.map(control => `
                            <button class="touch-btn touch-plugin-control" data-action="plugin:${escapeHtml(control.id)}" title="${escapeHtml(control.label)}" aria-label="${escapeHtml(control.label)}">
                                <span class="touch-plugin-control-label">${escapeHtml(control.label)}</span>
                            </button>
                        `).join('')}
                    </div>
                `;
                document.body.appendChild(touchControls);

                // Initialize multi-touch state
                this.touchState = {
                    joystick: { touchId: null, x: 0, y: 0 },
                    buttons: new Map() // action -> touchId
                };
                
                const joystickBase = document.getElementById('touch-joystick');
                const joystickStick = joystickBase.querySelector('.touch-joystick-stick');
                const maxDistance = 50;
                
                // Helper: Find touch by ID in a TouchList
                const findTouch = (touches, id) => {
                    for (let i = 0; i < touches.length; i++) {
                        if (touches[i].identifier === id) return touches[i];
                    }
                    return null;
                };
                
                // Joystick movement handler
                const handleJoystickMove = (touch) => {
                    const rect = joystickBase.getBoundingClientRect();
                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;
                    
                    let dx = touch.clientX - centerX;
                    let dy = touch.clientY - centerY;
                    
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance > maxDistance) {
                        dx = (dx / distance) * maxDistance;
                        dy = (dy / distance) * maxDistance;
                    }
                    
                    joystickStick.style.transform = `translate(${dx}px, ${dy}px)`;
                    
                    // Normalize to -1 to 1
                    this.touchState.joystick.x = dx / maxDistance;
                    this.touchState.joystick.y = dy / maxDistance;
                    
                    // Update engine input
                    const threshold = 0.3;
                    const isPlayMode = this.engine.state === GameState.PLAYING;
                    const isFlying = !isPlayMode && (this.isFlying || (this.engine.localPlayer?.isFlying));
                    
                    this.engine.setTouchInput('left', this.touchState.joystick.x < -threshold);
                    this.engine.setTouchInput('right', this.touchState.joystick.x > threshold);
                    
                    if (isFlying) {
                        this.engine.setTouchInput('up', this.touchState.joystick.y < -threshold);
                        this.engine.setTouchInput('down', this.touchState.joystick.y > threshold);
                    }
                };
                
                const resetJoystick = () => {
                    joystickStick.style.transform = 'translate(0, 0)';
                    this.touchState.joystick.touchId = null;
                    this.touchState.joystick.x = 0;
                    this.touchState.joystick.y = 0;
                    
                    this.engine.setTouchInput('left', false);
                    this.engine.setTouchInput('right', false);
                    this.engine.setTouchInput('up', false);
                    this.engine.setTouchInput('down', false);
                };
                
                // JOYSTICK EVENTS - Track specific touch
                joystickBase.addEventListener('touchstart', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // Only claim if not already tracking a touch
                    if (this.touchState.joystick.touchId === null) {
                        const touch = e.changedTouches[0];
                        this.touchState.joystick.touchId = touch.identifier;
                        joystickBase.classList.add('active');
                        handleJoystickMove(touch);
                        
                        // Haptic feedback
                        if (navigator.vibrate) navigator.vibrate(10);
                    }
                }, { passive: false });
                
                joystickBase.addEventListener('touchmove', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    if (this.touchState.joystick.touchId !== null) {
                        const touch = findTouch(e.touches, this.touchState.joystick.touchId);
                        if (touch) {
                            handleJoystickMove(touch);
                        }
                    }
                }, { passive: false });
                
                joystickBase.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // Check if our tracked touch ended
                    for (let i = 0; i < e.changedTouches.length; i++) {
                        if (e.changedTouches[i].identifier === this.touchState.joystick.touchId) {
                            joystickBase.classList.remove('active');
                            resetJoystick();
                            break;
                        }
                    }
                }, { passive: false });
                
                joystickBase.addEventListener('touchcancel', (e) => {
                    e.preventDefault();
                    joystickBase.classList.remove('active');
                    resetJoystick();
                }, { passive: false });
                
                // ACTION BUTTONS - Each tracks its own touch
                const actionButtons = touchControls.querySelectorAll('.touch-btn');
                actionButtons.forEach(btn => {
                    const action = btn.dataset.action;
                    
                    btn.addEventListener('touchstart', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        // Only claim if not already tracking
                        if (!this.touchState.buttons.has(action)) {
                            const touch = e.changedTouches[0];
                            this.touchState.buttons.set(action, touch.identifier);
                            btn.classList.add('active');
                            
                            this.engine.setTouchInput(action, true);
                            
                            // Haptic feedback
                            if (navigator.vibrate) navigator.vibrate(15);
                        }
                    }, { passive: false });
                    
                    btn.addEventListener('touchend', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        // Check if our tracked touch ended
                        const trackedId = this.touchState.buttons.get(action);
                        for (let i = 0; i < e.changedTouches.length; i++) {
                            if (e.changedTouches[i].identifier === trackedId) {
                                this.touchState.buttons.delete(action);
                                btn.classList.remove('active');
                                
                                this.engine.setTouchInput(action, false);
                                break;
                            }
                        }
                    }, { passive: false });
                    
                    btn.addEventListener('touchcancel', (e) => {
                        e.preventDefault();
                        this.touchState.buttons.delete(action);
                        btn.classList.remove('active');
                        
                        this.engine.setTouchInput(action, false);
                    }, { passive: false });
                });
            }
            
            // Update button visibility based on HK plugin state
            this.updateTouchButtonVisibility();
            touchControls.classList.add('active');
            document.body.classList.add('touch-active');
        } else {
            this.clearTouchControlInput();
            if (touchControls) touchControls.classList.remove('active');
            document.body.classList.remove('touch-active');
        }
    }
    
    // Update which touch buttons are visible based on enabled plugins and abilities
    updateTouchButtonVisibility() {
        const touchControls = document.getElementById('touch-controls');
        if (!touchControls) return;
        
        const hkEnabled = window.PluginManager?.isEnabled('hk');
        const hkConfig = this.world?.plugins?.hk || {};
        const buttonsContainer = touchControls.querySelector('.touch-buttons-right');
        
        if (buttonsContainer) {
            const attackBtn = buttonsContainer.querySelector('.touch-attack');
            const dashBtn = buttonsContainer.querySelector('.touch-dash');
            const healBtn = buttonsContainer.querySelector('.touch-heal');
            const expectedPluginControls = (window.PluginManager?.getTouchControls?.() || []).map(control => control.id).sort();
            const renderedPluginControls = Array.from(buttonsContainer.querySelectorAll('.touch-plugin-control'))
                .map(button => button.dataset.action.slice('plugin:'.length)).sort();
            
            // Check what should be visible
            const shouldShowAttack = hkEnabled;
            const shouldShowDash = hkEnabled && hkConfig.dash;
            const shouldShowHeal = hkEnabled;
            
            // Check if we need to recreate (button exists but shouldn't, or should exist but doesn't)
            const needsRecreate = 
                (shouldShowAttack && !attackBtn) || 
                (!shouldShowAttack && attackBtn) ||
                (shouldShowDash && !dashBtn) || 
                (!shouldShowDash && dashBtn) ||
                (shouldShowHeal && !healBtn) || 
                (!shouldShowHeal && healBtn) ||
                expectedPluginControls.length !== renderedPluginControls.length ||
                expectedPluginControls.some((controlId, index) => controlId !== renderedPluginControls[index]);
            
            if (needsRecreate) {
                this.clearTouchControlInput();
                touchControls.remove();
                this.updateTouchControls();
                return;
            }
            
            // Update visibility of existing buttons
            if (attackBtn) attackBtn.style.display = shouldShowAttack ? '' : 'none';
            if (dashBtn) dashBtn.style.display = shouldShowDash ? '' : 'none';
            if (healBtn) healBtn.style.display = shouldShowHeal ? '' : 'none';
        }
    }
    
    // Called when plugin settings change to refresh touch controls
    refreshTouchControls() {
        const touchControls = document.getElementById('touch-controls');
        if (touchControls && this.engine.touchControlsEnabled) {
            this.clearTouchControlInput();
            touchControls.remove();
            this.updateTouchControls();
        }
    }

    // ========================================
    // RENDERING
    // ========================================
    renderOverlay(ctx, camera) {
        // Grid (only in editor mode, not testing)
        if (this.engine.state === GameState.EDITOR) {
            this.renderGrid(ctx, camera);
            this.renderDieLine(ctx, camera);
        }

        // Selection highlights
        if (this.isSelectionActive && this.selectedObjects.size > 0 && this.engine.state === GameState.EDITOR) {
            ctx.save();
            for (const obj of this.selectedObjects) {
                const sx = obj.x - camera.x;
                const sy = obj.y - camera.y;
                const w = obj.width;
                const h = obj.height;
                
                // Fill with semi-transparent blue
                ctx.fillStyle = 'rgba(66, 133, 244, 0.2)';
                ctx.fillRect(sx, sy, w, h);
                
                // Border
                ctx.strokeStyle = '#4285f4';
                ctx.lineWidth = 2 / camera.zoom;
                ctx.setLineDash([6 / camera.zoom, 3 / camera.zoom]);
                ctx.strokeRect(sx, sy, w, h);
            }
            ctx.setLineDash([]);
            ctx.restore();
        }
        
        // Quot selection rectangle preview
        if (this.isSelectionActive && this.selectionRect && this.engine.state === GameState.EDITOR) {
            const { startX, startY, endX, endY } = this.selectionRect;
            const rx = Math.min(startX, endX) - camera.x;
            const ry = Math.min(startY, endY) - camera.y;
            const rw = Math.abs(endX - startX) + GRID_SIZE;
            const rh = Math.abs(endY - startY) + GRID_SIZE;
            
            const isDeselect = this.selectionAction === SelectionAction.DESELECT;
            
            ctx.fillStyle = isDeselect ? 'rgba(244, 67, 54, 0.15)' : 'rgba(66, 133, 244, 0.15)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = isDeselect ? '#f44336' : '#4285f4';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.setLineDash([8 / camera.zoom, 4 / camera.zoom]);
            ctx.strokeRect(rx, ry, rw, rh);
            ctx.setLineDash([]);
        }

        // Hover highlight (from canvas hover)
        // Note: ctx already has camera.zoom applied via ctx.scale()
        if (this.hoveredObject && this.engine.state === GameState.EDITOR) {
            const screenX = this.hoveredObject.x - camera.x;
            const screenY = this.hoveredObject.y - camera.y;
            const width = this.hoveredObject.width;
            const height = this.hoveredObject.height;

            ctx.strokeStyle = '#f4a261';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(screenX, screenY, width, height);
            ctx.setLineDash([]);
        }
        
        // Layer panel hover highlight - inverse color box
        if (this.highlightedLayerObject && this.engine.state === GameState.EDITOR) {
            const obj = this.highlightedLayerObject;
            const screenX = obj.x - camera.x;
            const screenY = obj.y - camera.y;
            const width = obj.width;
            const height = obj.height;
            
            // Draw inverse color highlight box
            ctx.save();
            ctx.globalCompositeOperation = 'difference';
            ctx.fillStyle = '#FFFFFF';
            const pad = 4 / camera.zoom;
            ctx.fillRect(screenX - pad, screenY - pad, width + pad * 2, height + pad * 2);
            ctx.restore();
            
            // Also draw a bright border for visibility
            ctx.strokeStyle = '#00FFFF';
            ctx.lineWidth = 3 / camera.zoom;
            const pad2 = 2 / camera.zoom;
            ctx.strokeRect(screenX - pad2, screenY - pad2, width + pad2 * 2, height + pad2 * 2);
        }
        
        // Eraser size indicator
        if (this.isErasing && this.engine.state === GameState.EDITOR) {
            const worldPos = this.engine.getMouseWorldPos();
            const gridPos = this.engine.getGridAlignedPos(worldPos.x, worldPos.y);
            
            // Calculate eraser rectangle (centered on grid position)
            const eraserWidth = this.eraseSettings.width * GRID_SIZE;
            const eraserHeight = this.eraseSettings.height * GRID_SIZE;
            const halfW = Math.floor(this.eraseSettings.width / 2) * GRID_SIZE;
            const halfH = Math.floor(this.eraseSettings.height / 2) * GRID_SIZE;
            const eraserX = gridPos.x - halfW;
            const eraserY = gridPos.y - halfH;
            
            const screenX = eraserX - camera.x;
            const screenY = eraserY - camera.y;
            
            // Draw eraser area
            ctx.fillStyle = 'rgba(231, 76, 60, 0.3)';
            ctx.fillRect(screenX, screenY, eraserWidth, eraserHeight);
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.setLineDash([6 / camera.zoom, 3 / camera.zoom]);
            ctx.strokeRect(screenX, screenY, eraserWidth, eraserHeight);
            ctx.setLineDash([]);
        }

        // Placement preview
        if (this.placementMode !== PlacementMode.NONE) {
            // Zone placement preview (rectangle)
            if (this.zonePlacement.isPlacing) {
                const { startX, startY, endX, endY } = this.zonePlacement;
                const x = Math.min(startX, endX);
                const y = Math.min(startY, endY);
                const width = Math.abs(endX - startX) + GRID_SIZE;
                const height = Math.abs(endY - startY) + GRID_SIZE;
                
                const screenX = x - camera.x;
                const screenY = y - camera.y;
                const screenW = width;
                const screenH = height;
                
                ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.fillRect(screenX, screenY, screenW, screenH);
                ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
                ctx.lineWidth = 2 / camera.zoom;
                ctx.setLineDash([8 / camera.zoom, 4 / camera.zoom]);
                ctx.strokeRect(screenX, screenY, screenW, screenH);
                ctx.setLineDash([]);
            } else if (this.obstaclePlacement.isPlacing) {
                // Spinner placement preview (oval/rectangle)
                const { startX, startY, endX, endY } = this.obstaclePlacement;
                const x = Math.min(startX, endX);
                const y = Math.min(startY, endY);
                const width = Math.max(Math.abs(endX - startX) + GRID_SIZE, GRID_SIZE * 2);
                const height = Math.max(Math.abs(endY - startY) + GRID_SIZE, GRID_SIZE * 2);
                
                const screenX = x - camera.x;
                const screenY = y - camera.y;
                const centerX = screenX + width / 2;
                const centerY = screenY + height / 2;
                
                // Draw ellipse preview
                ctx.beginPath();
                ctx.ellipse(centerX, centerY, width / 2, height / 2, 0, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255, 100, 100, 0.3)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(255, 100, 100, 1)';
                ctx.lineWidth = 2 / camera.zoom;
                ctx.setLineDash([8 / camera.zoom, 4 / camera.zoom]);
                ctx.stroke();
                ctx.setLineDash([]);
            } else if (this.buttonPlacement.isPlacing) {
                // Button placement preview
                const { startX, startY, endX, endY } = this.buttonPlacement;
                const x = Math.min(startX, endX);
                const y = Math.min(startY, endY);
                const width = Math.abs(endX - startX) + GRID_SIZE;
                const height = Math.abs(endY - startY) + GRID_SIZE;
                
                const screenX = x - camera.x;
                const screenY = y - camera.y;
                
                ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
                ctx.fillRect(screenX, screenY, width, height);
                ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
                ctx.lineWidth = 2 / camera.zoom;
                ctx.setLineDash([8 / camera.zoom, 4 / camera.zoom]);
                ctx.strokeRect(screenX, screenY, width, height);
                ctx.setLineDash([]);
            } else {
                // Normal placement preview
                const worldPos = this.engine.getMouseWorldPos();
                const gridPos = this.engine.getGridAlignedPos(worldPos.x, worldPos.y);

                if (this.placementMode === PlacementMode.KOREEN && this.koreenSettings.appearanceType === 'coin' && this.koreenSettings.coinSnapToGrid === false) {
                    const coinSize = Math.round(GRID_SIZE * 0.75);
                    const screenX = worldPos.x - coinSize / 2 - camera.x;
                    const screenY = worldPos.y - coinSize / 2 - camera.y;

                    ctx.save();
                    ctx.globalAlpha = 0.5;
                    if (typeof WorldObject !== 'undefined') {
                        if (!this._coinPreviewObject) {
                            this._coinPreviewObject = new WorldObject({
                                type: 'koreen',
                                appearanceType: 'coin',
                                actingType: 'coin',
                                collision: false,
                                color: '#FFDD00',
                                opacity: 1,
                                width: coinSize,
                                height: coinSize,
                                name: 'Coin'
                            });
                        }
                        this._coinPreviewObject.width = coinSize;
                        this._coinPreviewObject.height = coinSize;
                        this._coinPreviewObject.renderCoin(ctx, screenX, screenY, coinSize, coinSize);
                    } else {
                        ctx.beginPath();
                        ctx.arc(screenX + coinSize / 2, screenY + coinSize / 2, coinSize * 0.42, 0, Math.PI * 2);
                        ctx.fillStyle = '#FFDD00';
                        ctx.fill();
                    }
                    ctx.restore();
                } else {
                    const screenX = gridPos.x - camera.x;
                    const screenY = gridPos.y - camera.y;
                    const size = GRID_SIZE;

                    ctx.fillStyle = 'rgba(45, 90, 39, 0.5)';
                    ctx.fillRect(screenX, screenY, size, size);
                    ctx.strokeStyle = '#4a8c3f';
                ctx.lineWidth = 2 / camera.zoom;
                    ctx.strokeRect(screenX, screenY, size, size);
                }
            }
        }
        
        // Zone adjustment handles
        if (this.zoneAdjustment.active && this.zoneAdjustment.zone) {
            this.renderZoneAdjustmentHandles(ctx, camera);
        }
        
        // Spinner adjustment handles
        if (this.spinnerAdjustment.active && this.spinnerAdjustment.spinner) {
            this.renderSpinnerAdjustmentHandles(ctx, camera);
        }
        
        // Touchbox debug overlay (works in both editor and test modes)
        if (this.showTouchboxes) {
            this.renderTouchboxes(ctx, camera);
        }
    }
    
    renderZoneAdjustmentHandles(ctx, camera) {
        const zone = this.zoneAdjustment.zone;
        const handleSize = 12 / camera.zoom;
        
        const screenX = zone.x - camera.x;
        const screenY = zone.y - camera.y;
        const screenW = zone.width;
        const screenH = zone.height;
        
        // Draw zone highlight (white to match zone style)
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3 / camera.zoom;
        ctx.setLineDash([]);
        ctx.strokeRect(screenX, screenY, screenW, screenH);
        
        // Dragger positions
        const draggers = [
            { x: screenX, y: screenY, cursor: 'nw-resize', name: 'top-left' },
            { x: screenX + screenW / 2, y: screenY, cursor: 'n-resize', name: 'top' },
            { x: screenX + screenW, y: screenY, cursor: 'ne-resize', name: 'top-right' },
            { x: screenX, y: screenY + screenH / 2, cursor: 'w-resize', name: 'left' },
            { x: screenX + screenW, y: screenY + screenH / 2, cursor: 'e-resize', name: 'right' },
            { x: screenX, y: screenY + screenH, cursor: 'sw-resize', name: 'bottom-left' },
            { x: screenX + screenW / 2, y: screenY + screenH, cursor: 'n-resize', name: 'bottom' },
            { x: screenX + screenW, y: screenY + screenH, cursor: 'se-resize', name: 'bottom-right' }
        ];
        
        for (const d of draggers) {
            // Handle background (dark for contrast against white border)
            ctx.fillStyle = '#333';
            ctx.fillRect(d.x - handleSize / 2, d.y - handleSize / 2, handleSize, handleSize);
            
            // Handle border (white to match zone)
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2 / camera.zoom;
            ctx.strokeRect(d.x - handleSize / 2, d.y - handleSize / 2, handleSize, handleSize);
        }
    }
    
    renderDieLine(ctx, camera) {
        const dieLineY = this.world.dieLineY ?? 2000;
        const screenY = (dieLineY - camera.y) * camera.zoom;
        
        if (screenY < -100 || screenY > camera.height + 100) return;
        
        // Draw in screen pixel coordinates to guarantee viewport-relative positioning
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        ctx.strokeStyle = '#ff3333';
        ctx.lineWidth = 3;
        ctx.setLineDash([15, 10]);
        
        ctx.beginPath();
        ctx.moveTo(0, screenY);
        ctx.lineTo(camera.width, screenY);
        ctx.stroke();
        
        ctx.font = 'bold 14px monospace';
        ctx.fillStyle = '#ff3333';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.setLineDash([]);
        
        const text = '☠ DEATH LINE - Players die below this point';
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(10, screenY - 24, textWidth + 10, 22);
        
        ctx.fillStyle = '#ff3333';
        ctx.fillText(text, 15, screenY - 6);

        ctx.restore();
    }

    renderTouchboxes(ctx, camera) {
        const lw = 2 / camera.zoom;
        const vpW = camera.width / camera.zoom;
        const vpH = camera.height / camera.zoom;

        ctx.save();
        ctx.lineWidth = lw;
        ctx.setLineDash([]);

        const drawBox = (bx, by, bw, bh, color) => {
            const sx = bx - camera.x;
            const sy = by - camera.y;
            if (sx + bw < 0 || sx > vpW || sy + bh < 0 || sy > vpH) return;
            ctx.strokeStyle = color;
            ctx.strokeRect(sx, sy, bw, bh);
        };

        const objects = this.world?.objects;
        if (objects) {
            const gs = GRID_SIZE;
            const collisionBlocks = [];
            const nonMergeableCollision = [];

            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                const at = obj.appearanceType;
                const act = obj.actingType;

                if (act === 'spike' || obj.type === 'spinner' || at === 'spinner') {
                    // Collision disabled → no touchbox at all (matches game.js line 465)
                    if (obj.collision === false) continue;

                    if (obj.type === 'spinner' || at === 'spinner') {
                        const cx = obj.x + obj.width / 2 - camera.x;
                        const cy = obj.y + obj.height / 2 - camera.y;
                        const r = Math.min(obj.width, obj.height) / 2 * 0.82;
                        ctx.strokeStyle = '#ff0000';
                        ctx.beginPath();
                        ctx.arc(cx, cy, r, 0, Math.PI * 2);
                        ctx.stroke();
                    } else {
                        const spikeMode = obj.spikeTouchbox || this.world?.spikeTouchbox || 'normal';
                        const player = this.engine.localPlayer;

                        // 'air' and 'flag' modes: no damage AND no ground collision
                        if (spikeMode === 'air' || spikeMode === 'flag') continue;

                        if (spikeMode === 'full') {
                            // Full mode: entire sprite is a damage zone, no ground collision
                            drawBox(obj.x, obj.y, obj.width, obj.height, '#ff0000');
                        } else if (spikeMode === 'ground') {
                            // Ground mode: entire sprite acts as ground, no damage
                            drawBox(obj.x, obj.y, obj.width, obj.height, '#2196f3');
                        } else if (player && (spikeMode === 'normal' || spikeMode === 'tip')) {
                            // Damage zone
                            if (spikeMode === 'normal') {
                                const d = player.getSpikeDanger(obj);
                                drawBox(d.x, d.y, d.width, d.height, '#ff0000');
                            } else {
                                const t = player.getSpikeTip(obj);
                                drawBox(t.x, t.y, t.width, t.height, '#ff0000');
                            }
                            // Flat ground zone only if no adjacent block on the flat side
                            if (!player._spikeHasAdjacentBlock(obj, this.world)) {
                                const f = player.getSpikeFlat(obj);
                                drawBox(f.x, f.y, f.width, f.height, '#2196f3');
                            }
                        }
                    }
                } else if (at === 'zone' || at === 'button') {
                    drawBox(obj.x, obj.y, obj.width, obj.height, '#a855f7');
                } else if (obj.type === 'teleportal' || at === 'teleportal') {
                    drawBox(obj.x, obj.y, obj.width, obj.height, '#00e5ff');
                } else if (at === 'spawnpoint' || at === 'endpoint' || at === 'checkpoint') {
                    drawBox(obj.x, obj.y, obj.width, obj.height, '#4caf50');
                } else if (obj.collision) {
                    if (obj.type === 'block' && obj.collisionShape === 'box' && obj.rotation === 0 && !obj.flipHorizontal &&
                        obj.width === gs && obj.height === gs &&
                        Math.round(obj.x) % gs === 0 && Math.round(obj.y) % gs === 0) {
                        collisionBlocks.push(obj);
                    } else {
                        nonMergeableCollision.push(obj);
                    }
                }
            }

            // Tilemap cells are not stored in world.objects, so include visible
            // custom-shape cells explicitly in the tester collision overlay.
            const visibleTileColliders = this.world.queryNear?.(camera.x, camera.y, vpW, vpH) || [];
            for (const tile of visibleTileColliders) {
                if (tile?._tilemapCell === true && tile.collision !== false &&
                    ['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(tile.collisionShape)) {
                    nonMergeableCollision.push(tile);
                }
            }

            // Greedy-merge collision blocks into larger rectangles
            if (collisionBlocks.length > 0) {
                const grid = new Set();
                for (let i = 0; i < collisionBlocks.length; i++) {
                    const gx = Math.round(collisionBlocks[i].x / gs);
                    const gy = Math.round(collisionBlocks[i].y / gs);
                    grid.add(`${gx},${gy}`);
                }
                collisionBlocks.sort((a, b) => {
                    const ay = Math.round(a.y / gs), by = Math.round(b.y / gs);
                    if (ay !== by) return ay - by;
                    return Math.round(a.x / gs) - Math.round(b.x / gs);
                });
                const visited = new Set();
                for (let i = 0; i < collisionBlocks.length; i++) {
                    const startGx = Math.round(collisionBlocks[i].x / gs);
                    const startGy = Math.round(collisionBlocks[i].y / gs);
                    const sk = `${startGx},${startGy}`;
                    if (visited.has(sk)) continue;

                    let endGx = startGx;
                    while (grid.has(`${endGx + 1},${startGy}`) && !visited.has(`${endGx + 1},${startGy}`)) endGx++;

                    let endGy = startGy;
                    let canExtend = true;
                    while (canExtend) {
                        const ny = endGy + 1;
                        for (let gx = startGx; gx <= endGx; gx++) {
                            if (!grid.has(`${gx},${ny}`) || visited.has(`${gx},${ny}`)) { canExtend = false; break; }
                        }
                        if (canExtend) endGy = ny;
                    }

                    for (let gy = startGy; gy <= endGy; gy++) {
                        for (let gx = startGx; gx <= endGx; gx++) {
                            visited.add(`${gx},${gy}`);
                        }
                    }

                    drawBox(startGx * gs, startGy * gs, (endGx - startGx + 1) * gs, (endGy - startGy + 1) * gs, '#2196f3');
                }
            }

            for (let i = 0; i < nonMergeableCollision.length; i++) {
                const obj = nonMergeableCollision[i];
                if (obj.collisionShape === 'capsule') {
                    ctx.strokeStyle = '#2196f3';
                    const left = obj.x - camera.x;
                    const top = obj.y - camera.y;
                    const radius = Math.min(obj.width, obj.height) / 2;
                    ctx.beginPath();
                    ctx.moveTo(left + radius, top);
                    ctx.lineTo(left + obj.width - radius, top);
                    ctx.quadraticCurveTo(left + obj.width, top, left + obj.width, top + radius);
                    ctx.lineTo(left + obj.width, top + obj.height - radius);
                    ctx.quadraticCurveTo(left + obj.width, top + obj.height, left + obj.width - radius, top + obj.height);
                    ctx.lineTo(left + radius, top + obj.height);
                    ctx.quadraticCurveTo(left, top + obj.height, left, top + obj.height - radius);
                    ctx.lineTo(left, top + radius);
                    ctx.quadraticCurveTo(left, top, left + radius, top);
                    ctx.stroke();
                } else if (obj.collisionShape === 'circle') {
                    const cx = obj.x + obj.width / 2 - camera.x;
                    const cy = obj.y + obj.height / 2 - camera.y;
                    ctx.strokeStyle = '#2196f3';
                    ctx.beginPath();
                    ctx.arc(cx, cy, Math.min(obj.width, obj.height) / 2, 0, Math.PI * 2);
                    ctx.stroke();
                } else if (['slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.collisionShape)) {
                    const left = obj.x - camera.x;
                    const top = obj.y - camera.y;
                    const normalized = obj.collisionShape === 'polygon'
                        ? (WorldObject.normalizeCollisionPolygon(obj.collisionPoints) || WorldObject.DEFAULT_COLLISION_POLYGON)
                        : obj.collisionShape === 'slopeUpRight'
                            ? [[0, 1], [1, 0], [1, 1]]
                            : [[0, 0], [0, 1], [1, 1]];
                    const points = normalized.map(([x, y]) => [left + x * obj.width, top + y * obj.height]);
                    ctx.strokeStyle = '#2196f3';
                    ctx.beginPath();
                    ctx.moveTo(points[0][0], points[0][1]);
                    for (let p = 1; p < points.length; p++) ctx.lineTo(points[p][0], points[p][1]);
                    ctx.closePath();
                    ctx.stroke();
                } else {
                    drawBox(obj.x, obj.y, obj.width, obj.height, '#2196f3');
                }
            }
        }

        // Player touchboxes
        const player = this.engine.localPlayer;
        if (player && !player.isDead) {
            const gt = player.getGroundTouchbox();
            drawBox(gt.x, gt.y, gt.width, gt.height, '#ffeb3b');

            const ht = player.getHurtTouchbox();
            drawBox(ht.x, ht.y, ht.width, ht.height, '#ff9800');
        }
        
        ctx.restore();
    }

    renderGrid(ctx, camera) {
        if (!this.showGrid) return;
        
        const bg = this.world?.background || 'sky';
        const useDark = (bg === 'sky');
        const r = useDark ? 0 : 255;
        const g = useDark ? 0 : 255;
        const b = useDark ? 0 : 255;
        
        const startX = Math.floor(camera.x / GRID_SIZE) * GRID_SIZE;
        const startY = Math.floor(camera.y / GRID_SIZE) * GRID_SIZE;
        const endX = camera.x + camera.width / camera.zoom + GRID_SIZE;
        const endY = camera.y + camera.height / camera.zoom + GRID_SIZE;

        const viewStartX = startX - camera.x;
        const viewStartY = startY - camera.y;
        const viewEndX = viewStartX + (endX - startX);
        const viewEndY = viewStartY + (endY - startY);

        // Minor grid lines
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.3)`;
        ctx.lineWidth = 0.5 / camera.zoom;

            ctx.beginPath();
        for (let x = startX; x < endX; x += GRID_SIZE) {
            if (x % (GRID_SIZE * 5) === 0) continue;
            const screenX = x - camera.x;
            ctx.moveTo(screenX, viewStartY);
            ctx.lineTo(screenX, viewEndY);
        }
        for (let y = startY; y < endY; y += GRID_SIZE) {
            if (y % (GRID_SIZE * 5) === 0) continue;
            const screenY = y - camera.y;
            ctx.moveTo(viewStartX, screenY);
            ctx.lineTo(viewEndX, screenY);
        }
        ctx.stroke();
        
        // Major grid lines (every 5 cells)
        const majorStart = Math.floor(camera.x / (GRID_SIZE * 5)) * GRID_SIZE * 5;
        const majorStartY = Math.floor(camera.y / (GRID_SIZE * 5)) * GRID_SIZE * 5;
        
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.55)`;
        ctx.lineWidth = 1 / camera.zoom;
        
            ctx.beginPath();
        for (let x = majorStart; x < endX; x += GRID_SIZE * 5) {
            const screenX = x - camera.x;
            ctx.moveTo(screenX, viewStartY);
            ctx.lineTo(screenX, viewEndY);
        }
        for (let y = majorStartY; y < endY; y += GRID_SIZE * 5) {
            const screenY = y - camera.y;
            ctx.moveTo(viewStartX, screenY);
            ctx.lineTo(viewEndX, screenY);
        }
            ctx.stroke();
        
        // Origin lines (x=0 and y=0)
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.75)`;
        ctx.lineWidth = 2 / camera.zoom;
        
        ctx.beginPath();
        if (0 >= camera.x - GRID_SIZE && 0 <= camera.x + camera.width / camera.zoom + GRID_SIZE) {
            const originScreenX = 0 - camera.x;
            ctx.moveTo(originScreenX, viewStartY);
            ctx.lineTo(originScreenX, viewEndY);
        }
        if (0 >= camera.y - GRID_SIZE && 0 <= camera.y + camera.height / camera.zoom + GRID_SIZE) {
            const originScreenY = 0 - camera.y;
            ctx.moveTo(viewStartX, originScreenY);
            ctx.lineTo(viewEndX, originScreenY);
        }
        ctx.stroke();
    }

    // ========================================
    // TOAST NOTIFICATIONS
    // ========================================
    showToast(message, type = 'info') {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span class="material-symbols-outlined">${type === 'success' ? 'check_circle' : type === 'error' ? 'error' : 'info'}</span>
            <span>${message}</span>
        `;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideIn 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

// Export
window.Editor = Editor;
window.EditorTool = EditorTool;
window.PlacementMode = PlacementMode;
