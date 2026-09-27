/**
 * Code Plugin - Global Constants and Data Structures
 */

// Reserved trigger names (cannot be used, case-insensitive)
const CODE_RESERVED_NAMES = ['player', 'custom', 'trigger'];

// Trigger Types (sorted alphabetically by label for UI)
const CODE_TRIGGER_TYPES = {
    GAME_STARTS: 'gameStarts',
    GAME_ENDS: 'gameEnds',
    PLAYER_ACTION_INPUT: 'playerActionInput',
    PLAYER_ATTACKS_OBJECT: 'playerAttacksObject',
    PLAYER_DIES: 'playerDies',
    PLAYER_JUMPS: 'playerJumps',
    PLAYER_LANDS: 'playerLands',
    PLAYER_RESPAWNS: 'playerRespawns',
    PLAYER_ENTER_ZONE: 'playerEnterZone',
    PLAYER_JOINS_ROOM: 'playerJoinsRoom',
    PLAYER_KEY_INPUT: 'playerKeyInput',
    PLAYER_LEAVE_ZONE: 'playerLeaveZone',
    PLAYER_LEAVE_OBJECT: 'playerLeaveObject',
    PLAYER_LEAVES_ROOM: 'playerLeavesRoom',
    PLAYER_PRESS_BUTTON: 'playerPressButton',
    PLAYER_TOUCH_OBJECT: 'playerTouchObject',
    PLAYER_TOUCH_TILEMAP: 'playerTouchTilemap',
    PLAYER_STATS: 'playerStats',
    PLAYER_HEALTH_CHANGED: 'playerHealthChanged',
    VARIABLE_CONDITION: 'variableCondition',
    REPEAT: 'repeat'
};

// Trigger type labels and descriptions (for UI, sorted alphabetically)
const CODE_TRIGGER_TYPE_INFO = [
    { id: CODE_TRIGGER_TYPES.GAME_STARTS, label: 'Game Starts', description: 'Fires once when the game begins' },
    { id: CODE_TRIGGER_TYPES.GAME_ENDS, label: 'Game Ends', description: 'Fires once when the player completes the map' },
    { id: CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT, label: 'Player Action Input', description: 'When player performs a specific action' },
    { id: CODE_TRIGGER_TYPES.PLAYER_ATTACKS_OBJECT, label: 'Player Attacks Object', description: 'When an HK nail attack hits a selected map object' },
    { id: CODE_TRIGGER_TYPES.PLAYER_DIES, label: 'Player Dies', description: 'When the player dies from a hazard or gameplay action' },
    { id: CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE, label: 'Player Enter Zone', description: 'When player enters a zone' },
    { id: CODE_TRIGGER_TYPES.PLAYER_JOINS_ROOM, label: 'Player Joins Room', description: 'When a guest joins while the host is running this room' },
    { id: CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT, label: 'Player Key Input', description: 'When specific keys are pressed' },
    { id: CODE_TRIGGER_TYPES.PLAYER_JUMPS, label: 'Player Jumps', description: 'After the player successfully jumps, from the ground or air' },
    { id: CODE_TRIGGER_TYPES.PLAYER_LANDS, label: 'Player Lands', description: 'When the player lands on a solid surface after being airborne' },
    { id: CODE_TRIGGER_TYPES.PLAYER_LEAVE_ZONE, label: 'Player Leave Zone', description: 'When player leaves a zone' },
    { id: CODE_TRIGGER_TYPES.PLAYER_LEAVE_OBJECT, label: 'Player Leaves Object', description: 'When player stops touching a selected map object' },
    { id: CODE_TRIGGER_TYPES.PLAYER_LEAVES_ROOM, label: 'Player Leaves Room', description: 'When a guest leaves while the host keeps this room running' },
    { id: CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON, label: 'Player Press Button', description: 'When player presses a button UI' },
    { id: CODE_TRIGGER_TYPES.PLAYER_RESPAWNS, label: 'Player Respawns', description: 'When the player respawns after death or returns to a checkpoint' },
    { id: CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT, label: 'Player Touches Object', description: 'When player starts touching a map object using its configured box, circle, or capsule shape' },
    { id: CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP, label: 'Player Touches Tilemap', description: 'When player starts touching a collidable cell in a selected tilemap' },
    { id: CODE_TRIGGER_TYPES.PLAYER_STATS, label: 'Player Stats', description: 'When player stats match a condition' },
    { id: CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED, label: 'Player Health Changed', description: 'When the player’s numeric health increases, decreases, or changes' },
    { id: CODE_TRIGGER_TYPES.VARIABLE_CONDITION, label: 'Variable Condition', description: 'When a map, campaign, or player variable changes into a matching condition' },
    { id: CODE_TRIGGER_TYPES.REPEAT, label: 'Repeat', description: 'Fires repeatedly at an interval' }
].sort((a, b) => a.label.localeCompare(b.label));

// Player Action Input Options (sorted alphabetically by label)
const CODE_PLAYER_ACTIONS = [
    { id: 'airJump', label: 'Air Jump' },
    { id: 'die', label: 'Die' },
    { id: 'doJumpForTime', label: 'Do a [number]s Jump', hasValue: true, valueType: 'number', valuePlaceholder: 'seconds', defaultValue: 1 },
    { id: 'fall', label: 'Fall' },
    { id: 'fallForDistance', label: 'Fall for [distance]', hasValue: true, valueType: 'number', valuePlaceholder: 'pixels', defaultValue: 100 },
    { id: 'fallForTime', label: 'Fall for [time]', hasValue: true, valueType: 'number', valuePlaceholder: 'seconds', defaultValue: 1 },
    { id: 'groundJump', label: 'Ground Jump' },
    { id: 'jump', label: 'Jump' },
    { id: 'move', label: 'Move' },
    { id: 'moveHorizontally', label: 'Move Horizontally' },
    { id: 'moveLeft', label: 'Move Left' },
    { id: 'moveRight', label: 'Move Right' },
    { id: 'teleport', label: 'Teleport' },
    { id: 'touchOtherPlayer', label: 'Touch Other Player' }
].sort((a, b) => a.label.localeCompare(b.label));

// Player Stats Options (sorted alphabetically by label)
const CODE_PLAYER_STATS = [
    { id: 'color', label: 'Color' },
    { id: 'displayName', label: 'Display Name' },
    { id: 'hostOrGuest', label: 'Host or Guest' },
    { id: 'tag', label: 'Tag' },
    { id: 'username', label: 'Username' }
].sort((a, b) => a.label.localeCompare(b.label));

const CODE_HEALTH_CHANGE_DIRECTIONS = [
    { id: 'any', label: 'Any change' },
    { id: 'increased', label: 'Health increased' },
    { id: 'decreased', label: 'Health decreased' }
];

// Keyboard Keys (organized by category)
const CODE_KEYBOARD_KEYS = [
    // Special groups
    { id: 'any', label: 'Any Key', category: 'special' },
    { id: 'all', label: 'All Keys', category: 'special' },
    { id: 'allAlphabet', label: 'All Alphabet Keys', category: 'special' },
    { id: 'allNumbers', label: 'All Numbers', category: 'special' },
    { id: 'allAlphanumeric', label: 'All Numbers & Alphabet', category: 'special' },
    // Common
    { id: 'Space', label: 'Space', category: 'common' },
    { id: 'Enter', label: 'Enter', category: 'common' },
    { id: 'Tab', label: 'Tab', category: 'common' },
    { id: 'Escape', label: 'Escape', category: 'common' },
    { id: 'Backspace', label: 'Backspace', category: 'common' },
    // Mouse
    { id: 'Mouse0', label: 'Mouse1', category: 'mouse' },
    { id: 'Mouse1', label: 'Mouse2', category: 'mouse' },
    { id: 'Mouse2', label: 'Mouse3', category: 'mouse' },
    { id: 'Mouse3', label: 'Mouse4', category: 'mouse' },
    { id: 'Mouse4', label: 'Mouse5', category: 'mouse' },
    { id: 'Mouse5', label: 'Mouse6', category: 'mouse' },
    { id: 'Mouse6', label: 'Mouse7', category: 'mouse' },
    { id: 'Mouse7', label: 'Mouse8', category: 'mouse' },
    { id: 'Mouse8', label: 'Mouse9', category: 'mouse' },
    // Alphabet
    { id: 'KeyA', label: 'A', category: 'alphabet' },
    { id: 'KeyB', label: 'B', category: 'alphabet' },
    { id: 'KeyC', label: 'C', category: 'alphabet' },
    { id: 'KeyD', label: 'D', category: 'alphabet' },
    { id: 'KeyE', label: 'E', category: 'alphabet' },
    { id: 'KeyF', label: 'F', category: 'alphabet' },
    { id: 'KeyG', label: 'G', category: 'alphabet' },
    { id: 'KeyH', label: 'H', category: 'alphabet' },
    { id: 'KeyI', label: 'I', category: 'alphabet' },
    { id: 'KeyJ', label: 'J', category: 'alphabet' },
    { id: 'KeyK', label: 'K', category: 'alphabet' },
    { id: 'KeyL', label: 'L', category: 'alphabet' },
    { id: 'KeyM', label: 'M', category: 'alphabet' },
    { id: 'KeyN', label: 'N', category: 'alphabet' },
    { id: 'KeyO', label: 'O', category: 'alphabet' },
    { id: 'KeyP', label: 'P', category: 'alphabet' },
    { id: 'KeyQ', label: 'Q', category: 'alphabet' },
    { id: 'KeyR', label: 'R', category: 'alphabet' },
    { id: 'KeyS', label: 'S', category: 'alphabet' },
    { id: 'KeyT', label: 'T', category: 'alphabet' },
    { id: 'KeyU', label: 'U', category: 'alphabet' },
    { id: 'KeyV', label: 'V', category: 'alphabet' },
    { id: 'KeyW', label: 'W', category: 'alphabet' },
    { id: 'KeyX', label: 'X', category: 'alphabet' },
    { id: 'KeyY', label: 'Y', category: 'alphabet' },
    { id: 'KeyZ', label: 'Z', category: 'alphabet' },
    // Numbers
    { id: 'Digit0', label: '0', category: 'number' },
    { id: 'Digit1', label: '1', category: 'number' },
    { id: 'Digit2', label: '2', category: 'number' },
    { id: 'Digit3', label: '3', category: 'number' },
    { id: 'Digit4', label: '4', category: 'number' },
    { id: 'Digit5', label: '5', category: 'number' },
    { id: 'Digit6', label: '6', category: 'number' },
    { id: 'Digit7', label: '7', category: 'number' },
    { id: 'Digit8', label: '8', category: 'number' },
    { id: 'Digit9', label: '9', category: 'number' },
    // Modifiers
    { id: 'ShiftLeft', label: 'Left Shift', category: 'modifier' },
    { id: 'ShiftRight', label: 'Right Shift', category: 'modifier' },
    { id: 'ControlLeft', label: 'Control (Mac) / Ctrl (Windows)', category: 'modifier' },
    { id: 'ControlRight', label: 'Right Ctrl', category: 'modifier' },
    { id: 'MetaLeft', label: 'Command (Mac) / Win (Windows)', category: 'modifier' },
    { id: 'MetaRight', label: 'Right Command/Win', category: 'modifier' },
    { id: 'AltLeft', label: 'Option (Mac) / Alt (Windows)', category: 'modifier' },
    { id: 'AltRight', label: 'Right Option/Alt', category: 'modifier' },
    { id: 'CapsLock', label: 'Caps Lock', category: 'modifier' },
    // Arrows
    { id: 'ArrowUp', label: '↑ (Up)', category: 'arrow' },
    { id: 'ArrowDown', label: '↓ (Down)', category: 'arrow' },
    { id: 'ArrowLeft', label: '← (Left)', category: 'arrow' },
    { id: 'ArrowRight', label: '→ (Right)', category: 'arrow' },
    // Punctuation
    { id: 'Comma', label: ', (Comma)', category: 'punctuation' },
    { id: 'Period', label: '. (Period)', category: 'punctuation' },
    { id: 'Slash', label: '/ (Slash)', category: 'punctuation' },
    { id: 'Semicolon', label: '; (Semicolon)', category: 'punctuation' },
    { id: 'Quote', label: "' (Quote)", category: 'punctuation' },
    { id: 'BracketLeft', label: '[ (Left Bracket)', category: 'punctuation' },
    { id: 'BracketRight', label: '] (Right Bracket)', category: 'punctuation' },
    { id: 'Backslash', label: '\\ (Backslash)', category: 'punctuation' },
    { id: 'Backquote', label: '` (Backtick)', category: 'punctuation' },
    { id: 'Minus', label: '- (Minus)', category: 'punctuation' },
    { id: 'Equal', label: '= (Equal)', category: 'punctuation' },
    // Function keys
    { id: 'F1', label: 'F1', category: 'function' },
    { id: 'F2', label: 'F2', category: 'function' },
    { id: 'F3', label: 'F3', category: 'function' },
    { id: 'F4', label: 'F4', category: 'function' },
    { id: 'F5', label: 'F5', category: 'function' },
    { id: 'F6', label: 'F6', category: 'function' },
    { id: 'F7', label: 'F7', category: 'function' },
    { id: 'F8', label: 'F8', category: 'function' },
    { id: 'F9', label: 'F9', category: 'function' },
    { id: 'F10', label: 'F10', category: 'function' },
    { id: 'F11', label: 'F11', category: 'function' },
    { id: 'F12', label: 'F12', category: 'function' },
    // Navigation
    { id: 'Delete', label: 'Delete', category: 'navigation' },
    { id: 'Insert', label: 'Insert', category: 'navigation' },
    { id: 'Home', label: 'Home', category: 'navigation' },
    { id: 'End', label: 'End', category: 'navigation' },
    { id: 'PageUp', label: 'Page Up', category: 'navigation' },
    { id: 'PageDown', label: 'Page Down', category: 'navigation' },
    // Other (custom input - captures next keypress)
    { id: 'other', label: 'Other (Press to capture)', category: 'other' }
];

// Repeat Time Units
const CODE_TIME_UNITS = [
    { id: 'ticks', label: 'ticks', labelSingular: 'tick' },
    { id: 'seconds', label: 'seconds', labelSingular: 'second' },
    { id: 'minutes', label: 'minutes', labelSingular: 'minute' }
];

// Shared by trigger preflight and runtime contact checks so tile behavior
// filters cannot drift between what the editor accepts and what can fire.
const CODE_TILEMAP_CELL_MATCHES_TRIGGER_FILTER = (cell, filter = 'any') => {
    if (!cell || cell.collision === false) return false;
    if (filter === 'any') return true;
    const collisionType = cell.collisionType ?? cell._tilemapCollisionType;
    if (collisionType === filter) return true;
    return filter === 'oneWay' && (
        ['rampUpRight', 'rampUpLeft'].includes(collisionType) ||
        (cell.collisionShape === 'polygon' && cell.polygonOneWay !== false)
    );
};

// Code Block Types
const CODE_BLOCK_TYPES = {
    TRIGGER: 'trigger',
    EVENT: 'event',
    VARIABLE: 'variable'
};

// Variable Types
const CODE_VARIABLE_TYPES = {
    VARIABLE: 'variable',
    LIST: 'list'
};

// Variable Value Types
const CODE_VALUE_TYPES = [
    { id: 'string', label: 'String', default: '' },
    { id: 'integer', label: 'Integer', default: 0 },
    { id: 'float', label: 'Float', default: 0.0 },
    { id: 'boolean', label: 'Boolean', default: false },
    { id: 'variable', label: 'Variable Reference', default: null }
];

// Default trigger template
const CODE_DEFAULT_TRIGGER = {
    id: '',
    name: 'New Trigger',
    type: CODE_BLOCK_TYPES.TRIGGER,
    enabled: true,
    triggerType: CODE_TRIGGER_TYPES.GAME_STARTS,
    config: {}
};

// Default event template
const CODE_DEFAULT_EVENT = {
    id: '',
    name: 'New Event',
    type: CODE_BLOCK_TYPES.EVENT,
    enabled: true,
    actions: [],
    code: '' // Legacy field, retained for map compatibility.
};

// Declarative actions are the supported, serializable event runtime surface.
const CODE_EVENT_ACTION_TYPES = [
    { id: 'setVariable', label: 'Set Variable' },
    { id: 'addVariable', label: 'Add to Number Variable' },
    { id: 'calculateVariable', label: 'Calculate Number Variable' },
    { id: 'toggleVariable', label: 'Toggle Boolean Variable' },
    { id: 'branchVariable', label: 'Branch on Variable' },
    { id: 'branchPlayerCount', label: 'Branch on Player Count' },
    { id: 'appendListItem', label: 'Add Item to List' },
    { id: 'removeListItem', label: 'Remove Item from List' },
    { id: 'clearList', label: 'Clear List' },
    { id: 'setInventoryItemEquipped', label: 'Set Inventory Item Equipped' },
    { id: 'branchInventoryItemEquipped', label: 'Branch on Equipped Item' },
    { id: 'consumeInventoryItem', label: 'Use Inventory Item' },
    { id: 'branchListContains', label: 'Branch on List Item' },
    { id: 'showList', label: 'Show List Panel' },
    { id: 'showVariablePanel', label: 'Show Variable Panel' },
    { id: 'setCheckpoint', label: 'Set Player Checkpoint' },
    { id: 'setTriggerEnabled', label: 'Set Trigger Enabled' },
    { id: 'setObjectEnabled', label: 'Set Object Enabled' },
    { id: 'setObjectHealth', label: 'Set Object Health' },
    { id: 'damageObject', label: 'Damage Object' },
    { id: 'branchObjectHealth', label: 'Branch on Object Health' },
    { id: 'spawnObject', label: 'Spawn Object' },
    { id: 'removeSpawnedObjects', label: 'Remove Spawned Objects' },
    { id: 'setObjectPosition', label: 'Set Object Position' },
    { id: 'setObjectDrawLayer', label: 'Set Object Draw Layer' },
    { id: 'moveObject', label: 'Move Object (Animated)' },
    { id: 'setObjectSpriteFrame', label: 'Set Object Sprite Frame' },
    { id: 'setObjectOpacity', label: 'Set Object Opacity' },
    { id: 'playObjectSpriteAnimation', label: 'Play Object Sprite Animation' },
    { id: 'setCameraFollowMode', label: 'Set Camera Follow Axes' },
    { id: 'setCameraBounds', label: 'Set Camera Bounds' },
    { id: 'setLayerVisibility', label: 'Set Draw Layer Visibility' },
    { id: 'setGravity', label: 'Set Gravity' },
    { id: 'setJumpForce', label: 'Set Jump Force' },
    { id: 'setPlayerSpeed', label: 'Set Player Speed' },
    { id: 'setMovementControl', label: 'Set Movement Control' },
    { id: 'setTilemapCellBehavior', label: 'Set Tilemap Cell Behavior' },
    { id: 'startTimer', label: 'Start Timer' },
    { id: 'stopTimer', label: 'Stop Timer' },
    { id: 'teleportPlayer', label: 'Teleport Player' },
    { id: 'teleportPlayerToObject', label: 'Teleport Player Above Object' },
    { id: 'setVelocity', label: 'Set Player Velocity' },
    { id: 'damagePlayer', label: 'Damage Player' },
    { id: 'healPlayer', label: 'Heal Player' },
    { id: 'playSound', label: 'Play Sound' },
    { id: 'playPluginSound', label: 'Play Plugin Sound' },
    { id: 'stopPluginSound', label: 'Stop Plugin Sound' },
    { id: 'transitionToMap', label: 'Transition to Map' },
    { id: 'restartScene', label: 'Restart Scene' },
    { id: 'runEvent', label: 'Run Event' },
   { id: 'showMessage', label: 'Show Message' },
    { id: 'showDialogue', label: 'Show Dialogue' },
    { id: 'showChoice', label: 'Show Choices' },
    { id: 'showMenu', label: 'Show Menu' }
];

// Sound names exposed by the core AudioManager. Keep mechanics sound actions
// symbolic so maps never store arbitrary URLs or plugin asset paths.
const CODE_CORE_SOUND_NAMES = [
    'jump', 'coin', 'bounce', 'button', 'checkpoint', 'endpoint'
];
const CODE_MAX_EVENT_ACTIONS = 128;
const CODE_MAX_EVENT_CHAIN_ACTIONS = 256;
const CODE_MAX_EVENT_DEPTH = 16;
const CODE_MAX_DIALOGUE_PAGES = 12;
const CODE_MAX_DIALOGUE_PAGE_LENGTH = 512;
const CODE_MAX_DIALOGUE_SPEAKER_LENGTH = 64;
const CODE_MAX_DIALOGUE_CHOICES = 8;
const CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH = 64;
const CODE_MAX_QUEUED_DIALOGUES = 16;
const CODE_MAX_ACTIVE_TIMERS = 128;
const CODE_MAX_TIMER_DELAY_SECONDS = 86400;
const CODE_MAX_TIMER_FIRES = 10000;
const CODE_MAX_TIMER_REPEAT_COUNT = 1000;
const CODE_MAX_VARIABLE_STRING_LENGTH = 512;
const CODE_MAX_LIST_ITEMS = 100;
const CODE_MAX_PLAYER_STAT_VALUE_LENGTH = 128;
const CODE_MAX_PLAYER_TELEPORT_COORDINATE = 10000000;
const CODE_MAX_PLAYER_VELOCITY = 10000;
const CODE_MAX_TRIGGER_KEYS = 16;
const CODE_MAX_OBJECT_MOVE_DURATION_SECONDS = 60;
const CODE_MAX_MECHANICS_SPAWNED_OBJECTS = 64;
const CODE_MAX_MECHANICS_SPAWN_LIFETIME_SECONDS = 3600;
const CODE_OBJECT_MOTION_EASINGS = [
    { id: 'linear', label: 'Linear' },
    { id: 'easeIn', label: 'Ease In' },
    { id: 'easeOut', label: 'Ease Out' },
    { id: 'easeInOut', label: 'Ease In and Out' }
];

// Default variable template
const CODE_DEFAULT_VARIABLE = {
    id: '',
    name: 'New Variable',
    type: CODE_BLOCK_TYPES.VARIABLE,
    enabled: true,
    variableType: CODE_VARIABLE_TYPES.VARIABLE, // 'variable' or 'list'
    scope: 'map', // Map, cross-scene campaign, or separate per-player state.
    campaignKey: '', // Stable key reused by campaign variables across maps.
    persist: false, // Opt into a browser-local save slot for this variable.
    valueType: 'string', // string, integer, float, boolean
    defaultValue: '',
    // For lists:
    listLength: 0,
    listItems: [] // Array of { valueType, value }
};

// Plugin state (runtime, not persisted)
const CODE_STATE = {
    isEditorOpen: false,
    hasUnsavedChanges: false
};

// Export for use in other files
if (typeof window !== 'undefined') {
    window.CODE_RESERVED_NAMES = CODE_RESERVED_NAMES;
    window.CODE_TRIGGER_TYPES = CODE_TRIGGER_TYPES;
    window.CODE_TRIGGER_TYPE_INFO = CODE_TRIGGER_TYPE_INFO;
    window.CODE_PLAYER_ACTIONS = CODE_PLAYER_ACTIONS;
    window.CODE_PLAYER_STATS = CODE_PLAYER_STATS;
    window.CODE_HEALTH_CHANGE_DIRECTIONS = CODE_HEALTH_CHANGE_DIRECTIONS;
    window.CODE_KEYBOARD_KEYS = CODE_KEYBOARD_KEYS;
    window.CODE_TIME_UNITS = CODE_TIME_UNITS;
    window.CODE_TILEMAP_CELL_MATCHES_TRIGGER_FILTER = CODE_TILEMAP_CELL_MATCHES_TRIGGER_FILTER;
    window.CODE_BLOCK_TYPES = CODE_BLOCK_TYPES;
    window.CODE_VARIABLE_TYPES = CODE_VARIABLE_TYPES;
    window.CODE_VALUE_TYPES = CODE_VALUE_TYPES;
    window.CODE_DEFAULT_TRIGGER = CODE_DEFAULT_TRIGGER;
    window.CODE_DEFAULT_EVENT = CODE_DEFAULT_EVENT;
    window.CODE_EVENT_ACTION_TYPES = CODE_EVENT_ACTION_TYPES;
    window.CODE_CORE_SOUND_NAMES = CODE_CORE_SOUND_NAMES;
    window.CODE_MAX_EVENT_ACTIONS = CODE_MAX_EVENT_ACTIONS;
    window.CODE_MAX_EVENT_CHAIN_ACTIONS = CODE_MAX_EVENT_CHAIN_ACTIONS;
    window.CODE_MAX_EVENT_DEPTH = CODE_MAX_EVENT_DEPTH;
    window.CODE_MAX_DIALOGUE_PAGES = CODE_MAX_DIALOGUE_PAGES;
    window.CODE_MAX_DIALOGUE_PAGE_LENGTH = CODE_MAX_DIALOGUE_PAGE_LENGTH;
    window.CODE_MAX_DIALOGUE_SPEAKER_LENGTH = CODE_MAX_DIALOGUE_SPEAKER_LENGTH;
    window.CODE_MAX_DIALOGUE_CHOICES = CODE_MAX_DIALOGUE_CHOICES;
    window.CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH = CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH;
    window.CODE_MAX_QUEUED_DIALOGUES = CODE_MAX_QUEUED_DIALOGUES;
    window.CODE_MAX_ACTIVE_TIMERS = CODE_MAX_ACTIVE_TIMERS;
    window.CODE_MAX_TIMER_DELAY_SECONDS = CODE_MAX_TIMER_DELAY_SECONDS;
    window.CODE_MAX_TIMER_FIRES = CODE_MAX_TIMER_FIRES;
    window.CODE_MAX_TIMER_REPEAT_COUNT = CODE_MAX_TIMER_REPEAT_COUNT;
    window.CODE_MAX_VARIABLE_STRING_LENGTH = CODE_MAX_VARIABLE_STRING_LENGTH;
    window.CODE_MAX_LIST_ITEMS = CODE_MAX_LIST_ITEMS;
    window.CODE_MAX_PLAYER_STAT_VALUE_LENGTH = CODE_MAX_PLAYER_STAT_VALUE_LENGTH;
    window.CODE_MAX_PLAYER_TELEPORT_COORDINATE = CODE_MAX_PLAYER_TELEPORT_COORDINATE;
    window.CODE_MAX_PLAYER_VELOCITY = CODE_MAX_PLAYER_VELOCITY;
    window.CODE_MAX_TRIGGER_KEYS = CODE_MAX_TRIGGER_KEYS;
    window.CODE_MAX_OBJECT_MOVE_DURATION_SECONDS = CODE_MAX_OBJECT_MOVE_DURATION_SECONDS;
    window.CODE_MAX_MECHANICS_SPAWNED_OBJECTS = CODE_MAX_MECHANICS_SPAWNED_OBJECTS;
    window.CODE_MAX_MECHANICS_SPAWN_LIFETIME_SECONDS = CODE_MAX_MECHANICS_SPAWN_LIFETIME_SECONDS;
    window.CODE_OBJECT_MOTION_EASINGS = CODE_OBJECT_MOTION_EASINGS;
    window.CODE_DEFAULT_VARIABLE = CODE_DEFAULT_VARIABLE;
    window.CODE_STATE = CODE_STATE;
}
