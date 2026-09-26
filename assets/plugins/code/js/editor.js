/**
 * Code Plugin - Editor UI
 * Full-page code editor dashboard for managing triggers and events
 */

(function() {
    'use strict';

    const pluginId = 'code';

    // Editor state
    let codeEditorOverlay = null;
    let currentView = 'dashboard'; // 'dashboard', 'editTrigger', 'editEvent', 'editVariable'
    let dashboardMode = 'cards'; // 'cards' or 'flow'
    let editingBlock = null;
    let hasUnsavedChanges = false;
    let keyCapturingElement = null; // For "Other" key capture
    let savedSceneMapsPromise = null;
    
    // Get world reference safely
    const getWorld = () => typeof world !== 'undefined' ? world : null;
    
    // Get world's code data
    const getCodeData = () => {
        const w = getWorld();
        if (w) {
            const normalize = globalThis.normalizeParkoreenCodeData;
            if (typeof normalize === 'function') {
                w.codeData = normalize(w.codeData);
                return w.codeData;
            }
            if (!w.codeData || typeof w.codeData !== 'object' || Array.isArray(w.codeData)) {
                w.codeData = { triggers: [], events: [], variables: [] };
            }
            // Migrate old 'actions' array to 'events' (backward compatibility)
            if (!w.codeData.events && w.codeData.actions) {
                w.codeData.events = w.codeData.actions;
                delete w.codeData.actions;
            }
            if (!Array.isArray(w.codeData.triggers)) {
                w.codeData.triggers = [];
            }
            if (!Array.isArray(w.codeData.events)) {
                w.codeData.events = [];
            }
            if (Array.isArray(w.codeData.actions)) {
                const seenIds = new Set(w.codeData.events.map(event => event?.id).filter(id => typeof id === 'string'));
                for (const action of w.codeData.actions) {
                    if (!action || typeof action !== 'object' || Array.isArray(action) ||
                        (typeof action.id === 'string' && seenIds.has(action.id))) continue;
                    if (typeof action.id === 'string') seenIds.add(action.id);
                    w.codeData.events.push(action.type === 'action' ? { ...action, type: 'event' } : action);
                }
                delete w.codeData.actions;
            }
            // Migrate old block type 'action' → 'event'
            for (const block of w.codeData.events) {
                if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'action') {
                    block.type = 'event';
                }
            }
            // Ensure variables array exists (backward compatibility)
            if (!Array.isArray(w.codeData.variables)) {
                w.codeData.variables = [];
            }
            return w.codeData;
        }
        return { triggers: [], events: [], variables: [] };
    };
    
    // Save code data to world and notify editor
    const saveCodeData = (data) => {
        const w = getWorld();
        if (w) {
            w.codeData = data;
            // Notify main editor of changes
            if (typeof editor !== 'undefined' && editor.triggerMapChange) {
                editor.triggerMapChange();
            }
        }
        hasUnsavedChanges = false;
        if (typeof CODE_STATE !== 'undefined') {
            CODE_STATE.hasUnsavedChanges = false;
        }
    };
    
    // Mark as having unsaved changes
    const markUnsaved = () => {
        hasUnsavedChanges = true;
        if (typeof CODE_STATE !== 'undefined') {
            CODE_STATE.hasUnsavedChanges = true;
        }
    };
    
    // Generate unique ID
    const generateId = () => {
        return 'code_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
    };
    
    // Validate block name
    const isValidName = (name) => {
        if (!name || name.trim() === '') return false;
        const lowerName = name.toLowerCase().trim();
        return !CODE_RESERVED_NAMES.includes(lowerName);
    };
    
    // Get all zones from world
    const getZones = () => {
        const w = getWorld();
        if (w && w.objects) {
            // Runtime treats equal zone names as one logical region group, and
            // ignores mechanics-disabled zones. Keep the picker aligned with
            // that contract and show each selectable group once.
            const zonesByName = new Map();
            w.objects
                .filter(obj => obj._mechanicsEnabled !== false && obj.appearanceType === 'zone' &&
                    typeof obj.zoneName === 'string' && obj.zoneName.trim())
                .forEach(obj => {
                    if (!zonesByName.has(obj.zoneName)) {
                        zonesByName.set(obj.zoneName, { id: obj.id, name: obj.zoneName });
                    }
                });
            return Array.from(zonesByName.values()).sort((a, b) => a.name.localeCompare(b.name));
        }
        return [];
    };
    
    // Get all buttons from world
    const getButtons = () => {
        const w = getWorld();
        if (w && w.objects) {
            return w.objects
                // Match the runtime activation contract: button art alone does
                // not make an object pressable by PLAYER_PRESS_BUTTON.
                .filter(obj => obj.appearanceType === 'button' && obj.actingType === 'button' &&
                    typeof obj.name === 'string' && obj.name.trim().length > 0)
                .map(obj => ({ id: obj.id, name: obj.name, displayName: obj.displayName }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
        return [];
    };

    const getUniquelyNamedButtons = () => {
        const buttons = getButtons();
        const counts = new Map();
        for (const button of buttons) {
            if (button.name) counts.set(button.name, (counts.get(button.name) || 0) + 1);
        }
        return buttons.filter(button => button.name && counts.get(button.name) === 1);
    };

    const getInventoryPickupObjects = () => {
        const world = getWorld();
        return (world?.objects || [])
            .filter(object => object?.id && !object._mechanicsSpawned && object._mechanicsEnabled !== false && object._collected !== true &&
                object.type !== 'teleportal' && object.appearanceType !== 'teleportal' &&
                !['zone', 'button', 'checkpoint', 'spawnpoint', 'endpoint'].includes(object.appearanceType) &&
                !['checkpoint', 'spawnpoint', 'endpoint'].includes(object.actingType))
            .map(object => ({
                id: object.id,
                label: String(object.displayName || object.name || object.appearanceType || 'Item').slice(0, CODE_MAX_VARIABLE_STRING_LENGTH)
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
    };

    const getTriggers = () => getCodeData().triggers || [];
    const getEvents = () => getCodeData().events || [];

    const hasEscapeMenuFlow = () => {
        const eventsById = new Map(getEvents().map(event => [event.id, event]));
        return (getCodeData().triggers || []).some(trigger => {
            if (trigger?.enabled === false || trigger?.triggerType !== CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT ||
                !Array.isArray(trigger.config?.keys) || !trigger.config.keys.includes('Escape')) return false;
            const event = eventsById.get(trigger.config.eventId);
            return event?.enabled !== false && (event?.actions || []).some(action => action?.type === 'showMenu');
        });
    };

    const hasGameStartsMenuFlow = () => {
        const eventsById = new Map(getEvents().map(event => [event.id, event]));
        return (getCodeData().triggers || []).some(trigger => {
            if (trigger?.enabled === false || trigger?.triggerType !== CODE_TRIGGER_TYPES.GAME_STARTS) return false;
            const event = eventsById.get(trigger.config?.eventId);
            return event?.enabled !== false && (event?.actions || []).some(action => action?.type === 'showMenu');
        });
    };

    const getVariables = (valueType = null) => {
        return (getCodeData().variables || []).filter(variable =>
            variable.enabled !== false &&
            variable.variableType !== CODE_VARIABLE_TYPES.LIST &&
            (!valueType || (Array.isArray(valueType) ? valueType.includes(variable.valueType) : variable.valueType === valueType))
        );
    };

    const getListVariables = () => (getCodeData().variables || []).filter(variable =>
        variable.enabled !== false && variable.variableType === CODE_VARIABLE_TYPES.LIST
    );

    const renderEventOptions = (selectedId) => {
        const events = getEvents();
        return `<option value="">No event</option>${events.map(event =>
            `<option value="${escapeHtml(event.id)}" ${event.id === selectedId ? 'selected' : ''}>${escapeHtml(event.name)}</option>`
        ).join('')}`;
    };

    const renderObjectOptions = (selectedId) => {
        const objects = getWorld()?.objects || [];
        return `<option value="">Select an object…</option>${objects.map(object => {
            const label = `${object.name || object.appearanceType || object.type || 'Object'} · ${object.appearanceType || object.type || 'object'} · (${Math.round(object.x)}, ${Math.round(object.y)})`;
            return `<option value="${escapeHtml(object.id)}" ${object.id === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('')}`;
    };

    const renderSpawnTemplateOptions = (selectedId) => {
        const objects = (getWorld()?.objects || []).filter(object =>
            !object._mechanicsSpawned && object.type !== 'teleportal' && object.appearanceType !== 'teleportal' &&
            !['zone', 'button', 'checkpoint', 'spawnpoint', 'endpoint'].includes(object.appearanceType) &&
            !['checkpoint', 'spawnpoint', 'endpoint'].includes(object.actingType)
        );
        return `<option value="">${objects.length ? 'Select an object template…' : 'No spawnable object templates'}</option>${objects.map(object => {
            const label = `${object.name || object.appearanceType || object.type || 'Object'} · ${object.appearanceType || object.type || 'object'} · (${Math.round(object.x)}, ${Math.round(object.y)})`;
            return `<option value="${escapeHtml(object.id)}" ${object.id === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('')}`;
    };

    const renderCheckpointOptions = (selectedId) => {
        const checkpoints = (getWorld()?.objects || []).filter(object => object.actingType === 'checkpoint');
        return `<option value="">${checkpoints.length ? 'Select a checkpoint…' : 'No checkpoints on this map'}</option>${checkpoints.map(checkpoint => {
            const label = `${checkpoint.name || 'Checkpoint'} · (${Math.round(checkpoint.x)}, ${Math.round(checkpoint.y)})`;
            return `<option value="${escapeHtml(checkpoint.id)}" ${checkpoint.id === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('')}`;
    };

    const renderVariableOptions = (selectedId, valueType = null) => {
        const variables = getVariables(valueType);
        return `<option value="">${variables.length ? 'Select a variable…' : 'No compatible variables'}</option>${variables.map(variable =>
            `<option value="${escapeHtml(variable.id)}" ${variable.id === selectedId ? 'selected' : ''}>${variable.scope === 'player' ? 'Player' : 'Map'} · ${escapeHtml(variable.name)}</option>`
        ).join('')}`;
    };

    const renderPlayerVariableOptions = (selectedId) => {
        const variables = getVariables().filter(variable => variable.scope === 'player');
        return `<option value="">${variables.length ? 'Select a player variable…' : 'No enabled player variables'}</option>${variables.map(variable =>
            `<option value="${escapeHtml(variable.id)}" ${variable.id === selectedId ? 'selected' : ''}>${escapeHtml(variable.name)} · ${escapeHtml(variable.valueType)}</option>`
        ).join('')}`;
    };

    const renderListVariableOptions = (selectedId) => {
        const variables = getListVariables();
        return `<option value="">${variables.length ? 'Select a list…' : 'No enabled list variables'}</option>${variables.map(variable =>
            `<option value="${escapeHtml(variable.id)}" ${variable.id === selectedId ? 'selected' : ''}>${variable.scope === 'player' ? 'Player' : 'Map'} · ${escapeHtml(variable.name)}</option>`
        ).join('')}`;
    };

    const renderPlayerStringListOptions = (selectedId) => {
        const variables = getListVariables().filter(variable => variable.scope === 'player' && variable.valueType === 'string');
        return `<option value="">${variables.length ? 'Select a Player string List…' : 'No enabled Player string Lists'}</option>${variables.map(variable =>
            `<option value="${escapeHtml(variable.id)}" ${variable.id === selectedId ? 'selected' : ''}>${escapeHtml(variable.name)}</option>`
        ).join('')}`;
    };

    const loadSavedSceneMaps = (pickerId, inputId, selectedId) => {
        if (!savedSceneMapsPromise) {
            savedSceneMapsPromise = Promise.resolve().then(() =>
                typeof window.MapManager?.listMaps === 'function' ? window.MapManager.listMaps() : []
            ).then(maps => Array.isArray(maps) ? maps.filter(map =>
                typeof map?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(map.id)
            ) : []).catch(() => []);
        }
        savedSceneMapsPromise.then(maps => {
            const picker = document.getElementById(pickerId);
            if (!picker) return;
            const options = maps.map(map =>
                `<option value="${escapeHtml(map.id)}">${escapeHtml(map.name || map.id)} · ${escapeHtml(map.id)}</option>`
            );
            if (selectedId && !maps.some(map => map.id === selectedId)) {
                options.unshift(`<option value="${escapeHtml(selectedId)}">Saved target · ${escapeHtml(selectedId)}</option>`);
            }
            picker.innerHTML = `<option value="">${maps.length ? 'Choose one of your maps…' : 'No saved maps found'}</option>${options.join('')}`;
            picker.value = selectedId || '';
            picker.disabled = maps.length === 0;
            picker.addEventListener('change', () => {
                if (!picker.value) return;
                const input = document.getElementById(inputId);
                if (!input) return;
                input.value = picker.value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });
    };

    const renderListItemActionFields = (action, includeBranches = false) => {
        const listVariable = getListVariables().find(variable => variable.id === action.variableId);
        const valueType = ['string', 'integer', 'float', 'boolean'].includes(action.valueType) ? action.valueType : 'string';
        const typeOptions = CODE_VALUE_TYPES.filter(type => ['string', 'integer', 'float', 'boolean'].includes(type.id))
            .map(type => `<option value="${type.id}" ${type.id === valueType ? 'selected' : ''}>${type.label}</option>`).join('');
        let valueField;
        if (valueType === 'boolean') {
            valueField = `<label class="trigger-form-label">Value</label><select class="trigger-form-select event-action-field" data-field="value"><option value="false" ${String(action.value) !== 'true' ? 'selected' : ''}>false</option><option value="true" ${String(action.value) === 'true' ? 'selected' : ''}>true</option></select>`;
        } else {
            const inputType = ['integer', 'float'].includes(valueType) ? 'number' : 'text';
            const step = valueType === 'integer' ? '1' : 'any';
            const maxLengthAttribute = valueType === 'string' ? ` maxlength="${CODE_MAX_VARIABLE_STRING_LENGTH}"` : '';
            valueField = `<label class="trigger-form-label">Value</label><input class="trigger-form-input event-action-field" data-field="value" type="${inputType}" value="${escapeHtml(action.value ?? '')}"${maxLengthAttribute} placeholder="List item">`;
            if (inputType === 'number') valueField = valueField.replace('type="number"', `type="number" step="${step}"`);
        }
        const branches = includeBranches
            ? `<label class="trigger-form-label">When found</label><select class="trigger-form-select event-action-field" data-field="trueEventId">${renderEventOptions(action.trueEventId)}</select><label class="trigger-form-label">When missing</label><select class="trigger-form-select event-action-field" data-field="falseEventId">${renderEventOptions(action.falseEventId)}</select>`
            : '';
        const playerTarget = listVariable?.scope === 'player'
            ? `<label class="trigger-form-label">Target player</label><select class="trigger-form-select event-action-field" data-field="playerTarget"><option value="triggering" ${!action.playerTarget || action.playerTarget === 'triggering' ? 'selected' : ''}>Triggering player</option><option value="touched" ${action.playerTarget === 'touched' ? 'selected' : ''}>Touched player</option>${includeBranches ? '' : `<option value="all" ${action.playerTarget === 'all' ? 'selected' : ''}>All live players</option>`}</select>`
            : '';
        return `<label class="trigger-form-label">List</label><select class="trigger-form-select event-action-field" data-field="variableId">${renderListVariableOptions(action.variableId)}</select>${playerTarget}<label class="trigger-form-label">Item type</label><select class="trigger-form-select event-action-field" data-field="valueType">${typeOptions}</select>${valueField}${branches}`;
    };

    const getVariableConditionOperators = (variable) => {
        const operators = [
            ['equals', 'Equals'], ['notEquals', 'Does not equal'],
            ['truthy', 'Is true / non-empty'], ['falsy', 'Is false / empty']
        ];
        if (['integer', 'float'].includes(variable?.valueType)) {
            operators.splice(2, 0, ['greaterThan', 'Greater than'], ['lessThan', 'Less than']);
        }
        return operators;
    };
    
    // Show toast notification
    const showToast = (message, type = 'info') => {
        const existing = document.querySelector('.code-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `code-toast code-toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add('visible'), 10);
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    };
    
    // Show confirmation dialog
    const showConfirm = (title, message) => {
        return new Promise((resolve) => {
            const dialog = document.createElement('div');
            dialog.className = 'code-dialog-overlay';
            dialog.innerHTML = `
                <div class="code-dialog">
                    <h2>${escapeHtml(title)}</h2>
                    <p style="color: var(--text-muted); margin-bottom: 20px;">${escapeHtml(message)}</p>
                    <div class="code-dialog-actions">
                        <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
                        <button class="btn btn-danger" id="confirm-ok">Confirm</button>
                    </div>
                </div>
            `;
            document.body.appendChild(dialog);
            
            dialog.querySelector('#confirm-cancel').addEventListener('click', () => {
                dialog.remove();
                resolve(false);
            });
            
            dialog.querySelector('#confirm-ok').addEventListener('click', () => {
                dialog.remove();
                resolve(true);
            });
            
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) {
                    dialog.remove();
                    resolve(false);
                }
            });
        });
    };
    
    // Create the Mechanics Editor overlay
    const createCodeEditorOverlay = () => {
        if (codeEditorOverlay) return codeEditorOverlay;

        codeEditorOverlay = document.createElement('div');
        codeEditorOverlay.id = 'code-editor-overlay';
        codeEditorOverlay.className = 'code-editor-overlay';
        codeEditorOverlay.innerHTML = `
            <div class="code-editor-container">
                <div class="code-editor-header">
                    <button class="btn btn-icon btn-ghost code-back-btn" id="code-editor-back" title="Back (Escape)">
                        <span class="material-symbols-outlined">arrow_back</span>
                    </button>
                    <h1 class="code-editor-title">
                        <span class="material-symbols-outlined">code</span>
                        Mechanics Editor
                        <span class="code-beta-badge">BETA</span>
                    </h1>
                    <button class="btn btn-secondary" id="code-templates-btn" title="Add a ready-to-edit mechanics setup">
                        <span class="material-symbols-outlined">dashboard_customize</span>
                        Templates
                    </button>
                    <button class="btn btn-primary code-new-btn" id="code-new-block" title="Create a mechanic block" aria-label="Create a mechanic block">
                        <span class="material-symbols-outlined">add</span>
                        New Mechanic
                    </button>
                </div>
                <div class="code-editor-content" id="code-editor-content">
                    <!-- Content rendered dynamically -->
                </div>
            </div>
        `;
        
        // Add styles
        addCodeEditorStyles();
        
        document.body.appendChild(codeEditorOverlay);
        
        // Event listeners
        document.getElementById('code-editor-back').addEventListener('click', handleBackButton);
        document.getElementById('code-new-block').addEventListener('click', showNewBlockDialog);
        document.getElementById('code-templates-btn').addEventListener('click', showMechanicsTemplatesDialog);
        
        // Keyboard shortcuts
        codeEditorOverlay.addEventListener('keydown', handleKeyDown);
        
        return codeEditorOverlay;
    };
    
    // Handle back button
    const handleBackButton = async () => {
        if (currentView === 'dashboard') {
            if (hasUnsavedChanges) {
                const confirmed = await showConfirm('Unsaved Changes', 'You have unsaved changes. Are you sure you want to close?');
                if (!confirmed) return;
            }
            closeCodeEditor();
        } else {
            showDashboard();
        }
    };

    // Handle keyboard shortcuts
    const handleKeyDown = (e) => {
        // Escape to go back/close
        if (e.key === 'Escape') {
            e.preventDefault();
            handleBackButton();
        }
        
        // Ctrl/Cmd + S to save (when editing)
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (currentView === 'editTrigger') {
                saveTrigger();
            } else if (currentView === 'editEvent') {
                saveEvent();
            } else if (currentView === 'editVariable') {
                saveVariable();
            }
        }
    };
    
    // Add CSS styles for the code editor
    const addCodeEditorStyles = () => {
        if (document.getElementById('code-editor-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'code-editor-styles';
        style.textContent = `
            .code-editor-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: var(--bg-dark, #0a0a0f);
                z-index: 10000;
                display: none;
                overflow: hidden;
            }
            
            .code-editor-overlay.active {
                display: flex;
            }
            
            .code-editor-container {
                width: 100%;
                height: 100%;
                display: flex;
                flex-direction: column;
                padding: 20px;
                box-sizing: border-box;
            }
            
            .code-editor-header {
                display: flex;
                align-items: center;
                gap: 16px;
                padding-bottom: 20px;
                border-bottom: 1px solid var(--surface-light, #2a2a3a);
                margin-bottom: 20px;
            }
            
            .code-editor-title {
                display: flex;
                align-items: center;
                gap: 10px;
                font-size: 24px;
                font-weight: 600;
                color: #fff;
                margin: 0;
                flex: 1;
            }
            
            .code-editor-title .material-symbols-outlined {
                font-size: 28px;
                color: #3b82f6;
            }
            
            .code-beta-badge {
                font-size: 10px;
                font-weight: 700;
                background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
                color: white;
                padding: 3px 8px;
                border-radius: 4px;
                letter-spacing: 0.5px;
            }
            
            .code-editor-content {
                flex: 1;
                overflow-y: auto;
                padding-right: 10px;
            }
            
            /* Scrollbar styling */
            .code-editor-content::-webkit-scrollbar {
                width: 8px;
            }
            .code-editor-content::-webkit-scrollbar-track {
                background: transparent;
            }
            .code-editor-content::-webkit-scrollbar-thumb {
                background: var(--surface-light, #2a2a3a);
                border-radius: 4px;
            }

            .code-dashboard-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 16px;
            }

            .code-dashboard-view-switch {
                display: inline-flex;
                gap: 4px;
                padding: 4px;
                background: var(--bg-dark, #0a0a0f);
                border: 1px solid var(--surface-light, #2a2a3a);
                border-radius: 10px;
            }

            .code-dashboard-view-switch button {
                border: 0;
                border-radius: 7px;
                padding: 8px 12px;
                background: transparent;
                color: var(--text-muted, #aaa);
                font: inherit;
                cursor: pointer;
            }

            .code-dashboard-view-switch button[aria-pressed="true"] {
                background: #263755;
                color: #fff;
            }

            .code-dashboard-hint {
                color: var(--text-muted, #888);
                font-size: 12px;
            }

            .code-runtime-errors {
                margin: 0 0 16px;
                padding: 12px;
                border: 1px solid rgba(248, 113, 113, 0.35);
                border-radius: 10px;
                background: rgba(127, 29, 29, 0.12);
            }

            .code-runtime-errors-header, .code-runtime-error-row button {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }

            .code-runtime-errors-header { margin-bottom: 8px; font-size: 13px; font-weight: 600; }
            .code-runtime-error-row + .code-runtime-error-row { margin-top: 5px; }
            .code-runtime-error-row button {
                width: 100%;
                border: 1px solid rgba(248, 113, 113, 0.16);
                border-radius: 7px;
                padding: 8px 10px;
                background: rgba(0, 0, 0, 0.14);
                color: var(--text-body, #eee);
                text-align: left;
                cursor: pointer;
            }
            .code-runtime-error-row button span { flex: 1; color: var(--text-muted, #bbb); font-size: 12px; }
            .code-runtime-error-row button small { color: var(--text-muted, #999); white-space: nowrap; }

            .mechanics-flow-shell {
                overflow: auto;
                border: 1px solid var(--surface-light, #2a2a3a);
                border-radius: 12px;
                background: rgba(10, 10, 15, 0.55);
                overscroll-behavior: contain;
            }

            .mechanics-flow-svg {
                display: block;
                min-width: 1064px;
                max-width: none;
            }

            .mechanics-flow-edge {
                fill: none;
                stroke: #64748b;
                stroke-width: 2;
                opacity: 0.78;
            }

            .mechanics-flow-edge-label {
                fill: #aebbd0;
                font-size: 10px;
                text-anchor: middle;
            }

            .mechanics-flow-lane-title {
                fill: #aab6c8;
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 0.06em;
                text-transform: uppercase;
            }

            .mechanics-flow-node {
                cursor: pointer;
                outline: none;
            }

            .mechanics-flow-node rect {
                fill: #171c29;
                stroke: #39445a;
                stroke-width: 1.5;
                transition: stroke 0.12s, filter 0.12s;
            }

            .mechanics-flow-node:hover rect,
            .mechanics-flow-node:focus rect {
                stroke: #93c5fd;
                stroke-width: 2.5;
                filter: brightness(1.2);
            }

            .mechanics-flow-node.disabled { opacity: 0.5; }
            .mechanics-flow-node.trigger rect { stroke: #f59e0b; }
            .mechanics-flow-node.event rect { stroke: #8b5cf6; }
            .mechanics-flow-node.timer-loop rect { stroke: #fbbf24; }
            .mechanics-flow-node.variable rect { stroke: #10b981; }
            .mechanics-flow-node.has-error rect { stroke: #ef4444; }
            .mechanics-flow-node.has-warning rect { stroke: #f59e0b; }
            .mechanics-flow-node-title { fill: #fff; font-size: 14px; font-weight: 600; }
            .mechanics-flow-node-subtitle { fill: #aab6c8; font-size: 11px; }

            .mechanics-flow-empty {
                padding: 22px;
                color: var(--text-muted, #888);
                text-align: center;
            }
            
            /* Block Cards */
            .code-blocks-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
                gap: 16px;
            }
            
            .code-block-card {
                background: var(--bg-light, #1a1a2e);
                border-radius: 12px;
                padding: 16px;
                position: relative;
                transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
                border: 1px solid transparent;
            }
            
            .code-block-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 24px rgba(0,0,0,0.3);
                border-color: var(--surface-light, #2a2a3a);
            }
            
            .code-block-card.disabled {
                opacity: 0.5;
            }
            
            .code-block-card.has-error {
                border-color: #ef4444;
            }

            .code-block-card.has-warning {
                border-color: #f59e0b;
            }
            
            .code-block-header {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 12px;
            }
            
            .code-block-icon {
                width: 44px;
                height: 44px;
                border-radius: 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }
            
            .code-block-icon.trigger {
                background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
            }

            .code-block-icon.event {
                background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
            }

            .code-block-icon.variable {
                background: linear-gradient(135deg, #10b981 0%, #06b6d4 100%);
            }

            .code-block-icon .material-symbols-outlined {
                font-size: 24px;
                color: white;
            }
            
            .code-block-name {
                flex: 1;
                min-width: 0;
            }
            
            .code-block-name input {
                background: transparent;
                border: none;
                border-bottom: 1px solid transparent;
                color: #fff;
                font-size: 16px;
                font-weight: 600;
                width: 100%;
                outline: none;
                padding: 4px 0;
                transition: border-color 0.2s;
            }
            
            .code-block-name input:hover {
                border-bottom-color: var(--surface-light, #2a2a3a);
            }
            
            .code-block-name input:focus {
                border-bottom-color: #3b82f6;
            }
            
            .code-block-type {
                font-size: 13px;
                color: var(--text-muted, #888);
                margin-bottom: 12px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .code-block-type.error {
                color: #ef4444;
            }

            .code-block-type.warning {
                color: #f59e0b;
            }

            .code-block-connections {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 6px;
                margin: -2px 0 12px;
                font-size: 11px;
            }

            .code-block-connections-label {
                color: var(--text-muted, #888);
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            .code-flow-link {
                border: 1px solid var(--surface-light, #343447);
                border-radius: 999px;
                padding: 4px 8px;
                background: transparent;
                color: #93c5fd;
                font: inherit;
                cursor: pointer;
                max-width: 100%;
                overflow-wrap: anywhere;
            }

            .code-flow-link:hover, .code-flow-link:focus-visible {
                border-color: #60a5fa;
                background: rgba(59, 130, 246, 0.12);
                outline: none;
            }

            .code-flow-missing {
                color: #ef4444;
                overflow-wrap: anywhere;
            }
            
            .code-block-actions {
                display: flex;
                gap: 8px;
                padding-top: 12px;
                border-top: 1px solid var(--surface-light, #2a2a3a);
            }
            
            .code-block-actions .btn {
                flex: 1;
                font-size: 12px;
                padding: 8px 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
            }
            
            .code-block-actions .btn .material-symbols-outlined {
                font-size: 16px;
            }
            
            .code-block-actions .btn-icon-only {
                flex: 0 0 auto;
                padding: 8px;
            }
            
            /* Empty State */
            .code-empty-state {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 60vh;
                color: var(--text-muted, #888);
                text-align: center;
            }
            
            .code-empty-state .material-symbols-outlined {
                font-size: 72px;
                margin-bottom: 16px;
                opacity: 0.4;
            }
            
            .code-empty-state p {
                font-size: 16px;
                margin: 0 0 8px 0;
            }
            
            .code-empty-state small {
                font-size: 13px;
                opacity: 0.7;
            }
            
            /* Dialog */
            .code-dialog-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10001;
                animation: fadeIn 0.15s ease;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            
            .code-dialog {
                background: var(--bg-light, #1a1a2e);
                border-radius: 16px;
                padding: 24px;
                width: 420px;
                max-width: 90vw;
                animation: slideUp 0.2s ease;
            }
            
            @keyframes slideUp {
                from { transform: translateY(20px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            
            .code-dialog h2 {
                margin: 0 0 20px 0;
                font-size: 20px;
                color: #fff;
            }
            
            .code-dialog-types {
                display: flex;
                gap: 12px;
                margin-bottom: 20px;
            }

            .code-template-list {
                display: grid;
                gap: 10px;
                margin: 16px 0 20px;
            }

            .code-template-card {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 7px;
                width: 100%;
                padding: 15px;
                border: 1px solid var(--surface-light, #343449);
                border-radius: 12px;
                background: var(--bg-dark, #12121f);
                color: var(--text-primary, #fff);
                text-align: left;
                cursor: pointer;
            }

            .code-template-card:hover, .code-template-card:focus-visible {
                border-color: var(--primary, #6366f1);
                outline: none;
            }

            .code-template-card strong { font-size: 15px; }
            .code-template-card span { color: var(--text-muted, #aaa); font-size: 13px; line-height: 1.45; }
            .code-template-card small { color: var(--text-muted, #888); font-size: 11px; }
            
            .code-type-btn {
                flex: 1;
                padding: 20px 16px;
                border-radius: 12px;
                border: 2px solid var(--surface-light, #2a2a3a);
                background: transparent;
                cursor: pointer;
                transition: all 0.2s;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 8px;
            }
            
            .code-type-btn:hover {
                border-color: #3b82f6;
                background: rgba(59, 130, 246, 0.05);
            }
            
            .code-type-btn.selected {
                border-color: #3b82f6;
                background: rgba(59, 130, 246, 0.1);
            }
            
            .code-type-btn .material-symbols-outlined {
                font-size: 32px;
                color: #fff;
            }
            
            .code-type-btn span:last-child {
                font-size: 14px;
                color: #fff;
                font-weight: 500;
            }
            
            .code-dialog .form-group {
                margin-bottom: 16px;
            }
            
            .code-dialog .form-label {
                display: block;
                font-size: 13px;
                color: var(--text-muted, #888);
                margin-bottom: 6px;
            }
            
            .code-dialog .form-input {
                width: 100%;
                padding: 12px 14px;
                border-radius: 8px;
                border: 1px solid var(--surface-light, #2a2a3a);
                background: var(--bg-dark, #0a0a0f);
                color: #fff;
                font-size: 14px;
                outline: none;
                box-sizing: border-box;
                transition: border-color 0.2s;
            }
            
            .code-dialog .form-input:focus {
                border-color: #3b82f6;
            }
            
            .code-dialog .form-input.error {
                border-color: #ef4444;
            }
            
            .code-dialog-actions {
                display: flex;
                gap: 10px;
                justify-content: flex-end;
                margin-top: 24px;
            }
            
            /* Trigger Editor */
            .trigger-editor {
                max-width: 640px;
                margin: 0 auto;
            }
            
            .trigger-form-group {
                margin-bottom: 24px;
            }
            
            .trigger-form-label {
                display: block;
                font-size: 14px;
                font-weight: 500;
                color: #fff;
                margin-bottom: 8px;
            }
            
            .trigger-form-sublabel {
                font-size: 12px;
                color: var(--text-muted, #888);
                font-weight: normal;
                margin-left: 8px;
            }
            
            .trigger-form-select,
            .trigger-form-input {
                width: 100%;
                padding: 12px 14px;
                border-radius: 8px;
                border: 1px solid var(--surface-light, #2a2a3a);
                background: var(--bg-light, #1a1a2e);
                color: #fff;
                font-size: 14px;
                outline: none;
                box-sizing: border-box;
                transition: border-color 0.2s;
            }
            
            .trigger-form-select:focus,
            .trigger-form-input:focus {
                border-color: #3b82f6;
            }
            
            .trigger-form-select option {
                background: var(--bg-light, #1a1a2e);
            }
            
            .trigger-keys-container {
                margin-top: 12px;
            }
            
            .trigger-keys-add {
                display: flex;
                gap: 8px;
                margin-bottom: 12px;
            }
            
            .trigger-keys-add select {
                flex: 1;
            }
            
            .trigger-keys-list {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                min-height: 40px;
                padding: 12px;
                background: var(--bg-dark, #0a0a0f);
                border-radius: 8px;
                border: 1px dashed var(--surface-light, #2a2a3a);
            }
            
            .trigger-keys-list:empty::before {
                content: 'No keys selected';
                color: var(--text-muted, #666);
                font-size: 13px;
            }
            
            .trigger-key-tag {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 10px;
                background: rgba(59, 130, 246, 0.15);
                border: 1px solid rgba(59, 130, 246, 0.3);
                border-radius: 6px;
                font-size: 13px;
                color: #60a5fa;
            }
            
            .trigger-key-tag button {
                background: none;
                border: none;
                color: #60a5fa;
                cursor: pointer;
                padding: 0;
                display: flex;
                opacity: 0.7;
                transition: opacity 0.2s;
            }
            
            .trigger-key-tag button:hover {
                opacity: 1;
            }
            
            .trigger-save-btn {
                margin-top: 32px;
            }
            
            .trigger-description {
                font-size: 12px;
                color: var(--text-muted, #888);
                margin-top: 6px;
                line-height: 1.5;
            }
            
            .trigger-description.error {
                color: #ef4444;
            }
            
            /* Section dividers */
            .code-section {
                margin-bottom: 32px;
            }
            
            .code-section-title {
                font-size: 12px;
                font-weight: 600;
                color: var(--text-muted, #666);
                margin-bottom: 16px;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .code-section-title::after {
                content: '';
                flex: 1;
                height: 1px;
                background: var(--surface-light, #2a2a3a);
            }
            
            /* Toast notification */
            .code-toast {
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%) translateY(-20px);
                padding: 12px 24px;
                border-radius: 8px;
                color: #fff;
                font-size: 14px;
                font-weight: 500;
                z-index: 10002;
                opacity: 0;
                transition: all 0.3s ease;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            }
            
            .code-toast.visible {
                opacity: 1;
                transform: translateX(-50%) translateY(0);
            }
            
            .code-toast-info {
                background: #3b82f6;
            }
            
            .code-toast-success {
                background: #22c55e;
            }
            
            .code-toast-error {
                background: #ef4444;
            }
            
            .code-toast-warning {
                background: #f59e0b;
            }
            
            /* Key capture overlay */
            .key-capture-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10003;
            }
            
            .key-capture-dialog {
                background: var(--bg-light, #1a1a2e);
                padding: 32px;
                border-radius: 16px;
                text-align: center;
            }
            
            .key-capture-dialog h3 {
                margin: 0 0 8px 0;
                color: #fff;
                font-size: 18px;
            }
            
            .key-capture-dialog p {
                margin: 0;
                color: var(--text-muted, #888);
                font-size: 14px;
            }

            @media (max-width: 640px) {
                .code-editor-container { padding: 10px; }
                .code-editor-header { gap: 8px; padding-bottom: 12px; margin-bottom: 12px; }
                .code-editor-title { font-size: 17px; gap: 6px; }
                .code-editor-title .material-symbols-outlined { font-size: 22px; }
                .code-editor-title .code-beta-badge { font-size: 9px; padding: 2px 5px; }
                .code-editor-header .btn { padding: 8px; }
                .code-editor-header #code-templates-btn, .code-editor-header #code-new-block { min-width: 38px; justify-content: center; gap: 0; font-size: 0; }
                .code-editor-header #code-templates-btn .material-symbols-outlined, .code-editor-header #code-new-block .material-symbols-outlined { font-size: 22px; }
                .code-editor-content { padding-right: 0; }
                .code-dashboard-toolbar { align-items: flex-start; flex-direction: column; }
                .code-dashboard-view-switch button { padding: 8px 10px; }
                .mechanics-flow-shell { max-height: calc(100vh - 280px); }
                .code-blocks-grid { grid-template-columns: 1fr; gap: 12px; }
                .code-dialog { width: calc(100vw - 24px); max-width: none; padding: 18px; }
                .code-dialog-types { gap: 8px; }
                .code-type-btn { padding: 14px 8px; }
                .trigger-editor { max-width: none; }
                .trigger-form-group { margin-bottom: 18px; }
                .trigger-form-input, .trigger-form-select { font-size: 16px; }
                .key-capture-dialog { width: calc(100vw - 32px); padding: 20px; box-sizing: border-box; }
            }
        `;
        document.head.appendChild(style);
    };
    
    // Show dashboard view
    const showDashboard = () => {
        currentView = 'dashboard';
        editingBlock = null;
        
        const content = document.getElementById('code-editor-content');
        if (!content) return;
        
        const codeData = getCodeData();
        const triggers = codeData.triggers || [];
        const events = codeData.events || [];
        const variables = codeData.variables || [];
        const allBlocks = [...triggers, ...events, ...variables];
        const unreachableEventIds = getUnreachableEventIds(triggers, events);
        const timerCycleEventIds = getTimerCycleEventIds(events);
        const executionLimitWarnings = getEventExecutionLimitWarnings(events);
        const runtimeErrors = window.CodePluginGetRuntimeErrors?.(getWorld()) || [];
        
        // Update header
        const backBtn = document.getElementById('code-editor-back');
        if (backBtn) {
            backBtn.querySelector('.material-symbols-outlined').textContent = 'close';
            backBtn.title = 'Close (Escape)';
        }
        
        const title = document.querySelector('.code-editor-title');
        if (title) {
            title.innerHTML = `
                <span class="material-symbols-outlined">code</span>
                Mechanics Editor
                <span class="code-beta-badge">BETA</span>
            `;
        }
        
        const newBtn = document.getElementById('code-new-block');
        if (newBtn) newBtn.style.display = '';
        const templatesBtn = document.getElementById('code-templates-btn');
        if (templatesBtn) templatesBtn.style.display = '';
        
        let cardsHtml = '';
        
        if (triggers.length > 0) {
            cardsHtml += `
                <div class="code-section">
                    <div class="code-section-title">Triggers (${triggers.length})</div>
                    <div class="code-blocks-grid">
                        ${triggers.map(t => renderBlockCard(t, unreachableEventIds, timerCycleEventIds, 'trigger', executionLimitWarnings)).join('')}
                    </div>
                </div>
            `;
        }

        if (variables.length > 0) {
            cardsHtml += `
                <div class="code-section">
                    <div class="code-section-title">Variables (${variables.length})</div>
                    <div class="code-blocks-grid">
                        ${variables.map(v => renderBlockCard(v, unreachableEventIds, timerCycleEventIds, 'variable', executionLimitWarnings)).join('')}
                    </div>
                </div>
            `;
        }

        if (events.length > 0) {
            cardsHtml += `
                <div class="code-section">
                    <div class="code-section-title">Events (${events.length})</div>
                    <div class="code-blocks-grid">
                        ${events.map(a => renderBlockCard(a, unreachableEventIds, timerCycleEventIds, 'event', executionLimitWarnings)).join('')}
                    </div>
                </div>
            `;
        }
        
        const toolbar = `
            <div class="code-dashboard-toolbar">
                <div class="code-dashboard-view-switch" role="group" aria-label="Mechanics dashboard view">
                    <button type="button" data-dashboard-mode="cards" aria-pressed="${dashboardMode === 'cards'}">Blocks</button>
                    <button type="button" data-dashboard-mode="flow" aria-pressed="${dashboardMode === 'flow'}">Flow map</button>
                </div>
                <div class="code-dashboard-hint">${dashboardMode === 'flow' ? 'Select a node to open and edit it. Scroll sideways to see the full flow.' : 'Follow the links on each block, or switch to Flow map to see the whole mechanic.'}</div>
            </div>
        `;
        const body = allBlocks.length === 0
            ? `<div class="code-empty-state"><span class="material-symbols-outlined">code_off</span><p>No mechanic blocks yet</p><small>Choose Templates for a starter flow, or click "New Mechanic" to build from scratch</small></div>`
            : dashboardMode === 'flow'
                ? renderMechanicsFlow(triggers, events, variables, timerCycleEventIds, executionLimitWarnings)
                : cardsHtml;
        const runtimeErrorsHtml = runtimeErrors.length ? `
            <section class="code-runtime-errors" aria-label="Recent mechanics test errors">
                <div class="code-runtime-errors-header">
                    <span>Recent Test Errors (${runtimeErrors.length})</span>
                    <button type="button" class="btn btn-secondary" data-clear-runtime-errors>Clear</button>
                </div>
                ${runtimeErrors.slice().reverse().map(error => `
                    <div class="code-runtime-error-row">
                        <button type="button" data-runtime-block-id="${escapeHtml(error.sourceBlockId || error.eventId || '')}"
                            data-runtime-block-type="${escapeHtml(error.sourceBlockType || 'event')}"
                            ${error.sourceBlockId || error.eventId ? '' : 'disabled'}>
                            <strong>${escapeHtml(error.eventName || 'Event')}</strong>
                            <span>${escapeHtml(error.source || 'event')} · ${escapeHtml(error.message || 'Unknown error')}</span>
                            <small>${Number.isFinite(error.timestamp) ? new Date(error.timestamp).toLocaleTimeString() : ''}</small>
                        </button>
                    </div>
                `).join('')}
            </section>
        ` : '';
        content.innerHTML = `${toolbar}<div class="code-dashboard-body">${runtimeErrorsHtml}${body}</div>`;
        content.querySelector('[data-clear-runtime-errors]')?.addEventListener('click', () => {
            window.CodePluginClearRuntimeErrors?.(getWorld());
            showDashboard();
        });
        content.querySelectorAll('[data-runtime-block-id]').forEach(button => {
            button.addEventListener('click', () => {
                const blockId = button.dataset.runtimeBlockId;
                const blockType = button.dataset.runtimeBlockType === CODE_BLOCK_TYPES.TRIGGER
                    ? CODE_BLOCK_TYPES.TRIGGER : CODE_BLOCK_TYPES.EVENT;
                if (blockId) editBlock(blockId, blockType);
            });
        });
        content.querySelectorAll('[data-dashboard-mode]').forEach(button => {
            button.addEventListener('click', () => {
                dashboardMode = button.dataset.dashboardMode === 'flow' ? 'flow' : 'cards';
                showDashboard();
            });
        });
        if (allBlocks.length > 0 && dashboardMode === 'flow') attachMechanicsFlowListeners(content);
        else if (allBlocks.length > 0) attachBlockCardListeners();
    };

    // Keep event links in one place so the full Flow map, block-card shortcuts,
    // and future authoring tools use the same meaning for every action route.
    const getActionEventLinks = (action) => {
        if (!action || typeof action !== 'object') return [];
        const links = [];
        const add = (eventId, label, kind) => {
            if (typeof eventId === 'string' && eventId) links.push({ eventId, label, kind });
        };
        if (action.type === 'runEvent') add(action.eventId, 'Runs', 'call');
        else if (action.type === 'damageObject') add(action.defeatedEventId, 'On defeat', 'defeat');
        else if (action.type === 'startTimer') add(action.eventId, 'Timer', 'timer');
        else if (action.type === 'playObjectSpriteAnimation' && getObjectSpriteAnimationPlayback(action)?.loop === false) {
            add(action.completionEventId, 'Animation done', 'animation');
        } else if (['branchVariable', 'branchListContains', 'branchInventoryItemEquipped', 'consumeInventoryItem', 'branchPlayerCount', 'branchObjectHealth'].includes(action.type)) {
            const trueLabel = action.type === 'consumeInventoryItem' ? 'When used' : 'If true';
            const falseLabel = action.type === 'consumeInventoryItem' ? 'Item missing' : 'If false';
            add(action.trueEventId, trueLabel, 'branch');
            add(action.falseEventId, falseLabel, 'branch');
        } else if (action.type === 'showChoice' || action.type === 'showMenu') {
            for (const choice of Array.isArray(action.choices) ? action.choices : []) {
                add(choice?.eventId, choice?.label || (action.type === 'showMenu' ? 'Menu option' : 'Choice'), 'choice');
            }
            if (action.type === 'showMenu') add(action.cancelEventId, 'Cancel', 'choice');
        }
        return links;
    };
    const EVENT_EXECUTION_PATH_LINK_KINDS = new Set(['call', 'defeat', 'branch', 'choice']);
    const NESTED_EVENT_LINK_KINDS = new Set(['call', 'defeat', 'branch']);
    const ACTION_VARIABLE_LINK_LABELS = new Map([
        ['setVariable', 'Sets'], ['addVariable', 'Adds to'], ['calculateVariable', 'Calculates'],
        ['toggleVariable', 'Toggles'], ['branchVariable', 'Checks'], ['appendListItem', 'Adds to'],
        ['removeListItem', 'Removes from'], ['branchListContains', 'Checks'],
        ['setInventoryItemEquipped', 'Equips in'], ['branchInventoryItemEquipped', 'Checks'],
        ['consumeInventoryItem', 'Uses'], ['showList', 'Displays'], ['showVariablePanel', 'Displays']
    ]);
    const getActionVariableLinks = (action) => {
        if (!action || typeof action !== 'object') return [];
        if (action.type === 'branchPlayerCount') {
            return typeof action.playerVariableId === 'string' && action.playerVariableId
                ? [{ variableId: action.playerVariableId, label: 'Counts' }] : [];
        }
        const label = ACTION_VARIABLE_LINK_LABELS.get(action.type);
        return label && typeof action.variableId === 'string' && action.variableId
            ? [{ variableId: action.variableId, label }]
            : [];
    };
    const getActionTriggerLinks = (action) => {
        if (action?.type !== 'setTriggerEnabled' || typeof action.triggerId !== 'string' || !action.triggerId) return [];
        return [{
            triggerId: action.triggerId,
            label: action.enabled === true ? 'Enables' : action.enabled === false ? 'Disables' : 'Sets state of'
        }];
    };

    const renderMechanicsFlow = (triggers, events, variables, timerCycleEventIds = new Set(), executionLimitWarnings = new Map()) => {
        const nodeWidth = 260;
        const nodeHeight = 88;
        const columns = {
            trigger: { x: 32, title: 'Triggers', items: triggers },
            event: { x: 402, title: 'Events', items: events },
            variable: { x: 772, title: 'Variables', items: variables }
        };
        const rowStep = 122;
        const top = 48;
        const maxRows = Math.max(1, triggers.length, events.length, variables.length);
        const width = 1064;
        const height = Math.max(260, top + (maxRows - 1) * rowStep + nodeHeight + 34);
        const nodesByType = { trigger: new Map(), event: new Map(), variable: new Map() };
        const allNodes = [];

        for (const [type, column] of Object.entries(columns)) {
            column.items.forEach((block, index) => {
                const node = {
                    block,
                    type,
                    x: column.x,
                    y: top + index * rowStep,
                    title: String(block.name || `${type} ${index + 1}`),
                    error: type === 'trigger' ? getTriggerError(block)
                        : type === 'event' ? getEventError(block)
                            : getVariableError(block),
                    warning: type === 'event' ? executionLimitWarnings.get(block.id) || null : null,
                    subtitle: type === 'trigger'
                        ? (CODE_TRIGGER_TYPE_INFO.find(item => item.id === block.triggerType)?.label || 'Trigger')
                        : type === 'event'
                            ? `${Array.isArray(block.actions) ? block.actions.length : 0} actions`
                            : block.variableType === CODE_VARIABLE_TYPES.LIST
                                ? `${block.scope === 'player' ? 'Player' : 'Map'} · List (${Math.min(CODE_MAX_LIST_ITEMS, Array.isArray(block.listItems) ? block.listItems.length : 0)} initial items)`
                                : `${block.scope === 'player' ? 'Player' : 'Map'} · ${CODE_VALUE_TYPES.find(item => item.id === block.valueType)?.label || block.valueType || 'value'}`
                };
                allNodes.push(node);
                if (block.id) nodesByType[type].set(block.id, node);
            });
        }

        const edges = [];
        for (const [type, blocks] of [['trigger', triggers], ['event', events]]) {
            for (const block of blocks) {
                const source = nodesByType[type].get(block.id);
                for (const { targetId, targetType, label } of getFlowTargets(
                    block,
                    type === 'trigger' ? CODE_BLOCK_TYPES.TRIGGER : CODE_BLOCK_TYPES.EVENT
                )) {
                    const target = nodesByType[targetType]?.get(targetId);
                    if (source && target) edges.push({ source, target, label });
                }
            }
        }

        const renderEdge = ({ source, target, label }) => {
            const startX = source.x + nodeWidth;
            const startY = source.y + nodeHeight / 2;
            const endX = target.x;
            const endY = target.y + nodeHeight / 2;
            const bend = Math.max(42, Math.abs(endX - startX) / 2);
            const controlX = startX + bend;
            const path = `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`;
            const labelX = (startX + endX) / 2;
            const labelY = (startY + endY) / 2 - 6;
            return `<path class="mechanics-flow-edge" d="${path}" marker-end="url(#mechanics-flow-arrow)"/><text class="mechanics-flow-edge-label" x="${labelX}" y="${labelY}">${escapeHtml(label)}</text>`;
        };

        const renderNode = (node) => {
            const title = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title;
            const subtitle = node.subtitle.length > 34 ? `${node.subtitle.slice(0, 33)}…` : node.subtitle;
            const enabledClass = node.block.enabled === false ? ' disabled' : '';
            const hasTimerCycle = node.type === 'event' && timerCycleEventIds.has(node.block.id);
            const cycleClass = hasTimerCycle ? ' timer-loop' : '';
            const errorClass = node.error ? ' has-error' : '';
            const warningClass = node.warning ? ' has-warning' : '';
            const blockId = escapeHtml(node.block.id || '');
            const ariaLabel = escapeHtml(`${node.type}: ${node.title}. ${node.subtitle}.${node.error ? ` Error: ${node.error}.` : ''}${node.warning ? ` Warning: ${node.warning}.` : ''}${hasTimerCycle ? ' Warning: part of a timer-linked event cycle that can keep rescheduling.' : ''} Press Enter to edit.`);
            const status = node.error ? 'Invalid · open to repair'
                : node.block.enabled === false ? 'Disabled'
                    : node.warning ? 'Execution limit warning'
                        : hasTimerCycle ? 'Timer loop warning' : 'Click to edit';
            return `<g class="mechanics-flow-node ${node.type}${enabledClass}${cycleClass}${errorClass}${warningClass}" data-flow-node-id="${blockId}" data-flow-node-type="${node.type}" role="button" tabindex="0" aria-label="${ariaLabel}" transform="translate(${node.x}, ${node.y})"><title>${ariaLabel}</title><rect width="${nodeWidth}" height="${nodeHeight}" rx="12"/><text class="mechanics-flow-node-title" x="16" y="34">${escapeHtml(title)}</text><text class="mechanics-flow-node-subtitle" x="16" y="59">${escapeHtml(subtitle)}</text><text class="mechanics-flow-node-subtitle" x="16" y="77">${escapeHtml(status)}</text></g>`;
        };

        const columnTitles = Object.values(columns).map(column =>
            `<text class="mechanics-flow-lane-title" x="${column.x}" y="25">${column.title} · ${column.items.length}</text>`
        ).join('');

        if (!allNodes.length) return '<div class="mechanics-flow-empty">Add triggers, events, or variables to build a flow map.</div>';
        return `<div class="mechanics-flow-shell"><svg class="mechanics-flow-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Mechanics flow map"><defs><marker id="mechanics-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker></defs>${columnTitles}${edges.map(renderEdge).join('')}${allNodes.map(renderNode).join('')}</svg></div>`;
    };

    const attachMechanicsFlowListeners = (root) => {
        root.querySelectorAll('[data-flow-node-id]').forEach(node => {
            const open = () => editBlock(node.dataset.flowNodeId, node.dataset.flowNodeType);
            node.addEventListener('click', open);
            node.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                open();
            });
        });
    };
    
    // Check if trigger has configuration errors
    const getPlayerActionOptions = () => {
        const pluginControls = window.PluginManager?.getMechanicsActionControls?.() || [];
        const customActions = pluginControls
            .filter(control => typeof control?.id === 'string' && /^[a-z][A-Za-z0-9_-]{0,63}$/.test(control.id))
            .map(control => ({ id: `pluginControl:${control.id}`, label: `Plugin: ${control.label || control.id}` }));
        return [...CODE_PLAYER_ACTIONS, ...customActions];
    };

    const getTriggerError = (trigger) => {
        if (!trigger || typeof trigger !== 'object') return null;
        
        const config = trigger.config || {};
        const zones = getZones();
        const tilemaps = getWorld()?.tilemaps || [];
        if (!CODE_TRIGGER_TYPE_INFO.some(item => item.id === trigger.triggerType)) {
            return 'Choose a supported trigger type';
        }

        switch (trigger.triggerType) {
            case CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE:
            case CODE_TRIGGER_TYPES.PLAYER_LEAVE_ZONE:
                if (!config.zoneName) return 'No zone selected';
                if (!zones.find(z => z.name === config.zoneName)) {
                    return `Zone "${config.zoneName}" not found`;
                }
                break;
            case CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT: {
                if (!config.objectId) return 'No map object selected';
                if (config.shape !== undefined && !['box', 'circle', 'capsule'].includes(config.shape)) {
                    return 'Choose a box, circle, or capsule contact shape';
                }
                const object = (getWorld()?.objects || []).find(item =>
                    item?.id === config.objectId && item._mechanicsEnabled !== false && item._collected !== true
                );
                if (!object) return 'Selected map object not found';
                break;
            }
            case CODE_TRIGGER_TYPES.PLAYER_ATTACKS_OBJECT: {
                if (!config.objectId) return 'No map object selected';
                const object = (getWorld()?.objects || []).find(item =>
                    item?.id === config.objectId && item._mechanicsEnabled !== false && item._collected !== true
                );
                if (!object) return 'Selected map object not found';
                break;
            }
            case CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP: {
                const tilemap = tilemaps.find(item => item.id === config.tilemapId);
                if (!tilemap) return 'Choose a tilemap on this map';
                const collisionType = config.collisionType || 'any';
                if (!['any', 'solid', 'oneWay', 'hazard'].includes(collisionType)) return 'Choose a supported tile behavior';
                const hasMatchingCell = tilemap.cells.some(cell =>
                    window.CODE_TILEMAP_CELL_MATCHES_TRIGGER_FILTER(cell, collisionType));
                if (!hasMatchingCell) return 'The selected tilemap has no cells with that collision behavior';
                break;
            }
            case CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT:
                if (!Array.isArray(config.keys) || config.keys.length === 0) {
                    return 'No keys configured';
                }
                if (config.keys.length > CODE_MAX_TRIGGER_KEYS) return `A key trigger can contain at most ${CODE_MAX_TRIGGER_KEYS} keys`;
                if (config.keys.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || key === 'other')) {
                    return 'Remove an invalid captured key';
                }
                if (new Set(config.keys).size !== config.keys.length) return 'Remove duplicate keys';
                break;
            case CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON:
                if (!config.buttonName) return 'No button selected';
                if (!getButtons().find(b => b.name === config.buttonName)) {
                    return `Button "${config.buttonName}" not found`;
                }
                break;
            case CODE_TRIGGER_TYPES.VARIABLE_CONDITION:
                {
                    const variable = getVariables().find(item => item.id === config.variableId && item.enabled !== false);
                    if (!variable) return 'No compatible variable selected';
                    const operators = getVariableConditionOperators(variable).map(([id]) => id);
                    const operator = config.operator || 'equals';
                    if (!operators.includes(operator)) return 'Choose a condition supported by this variable type';
                    if (!['truthy', 'falsy'].includes(operator) && ['integer', 'float'].includes(variable.valueType)) {
                        if (!isFiniteActionNumber(config.value)) return 'Enter a valid number for the variable condition';
                        if (variable.valueType === 'integer' && !Number.isInteger(Number(config.value))) return 'Enter a whole number for the variable condition';
                    }
                    if (!['truthy', 'falsy'].includes(operator) && variable.valueType === 'boolean' && ![true, false, 'true', 'false'].includes(config.value)) {
                        return 'Choose true or false for the boolean condition';
                    }
                    if (!['truthy', 'falsy'].includes(operator) && variable.valueType === 'string' &&
                        (typeof config.value !== 'string' || config.value.length > CODE_MAX_VARIABLE_STRING_LENGTH)) {
                        return `Text conditions can contain at most ${CODE_MAX_VARIABLE_STRING_LENGTH} characters`;
                    }
                }
                break;
            case CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT: {
                const action = getPlayerActionOptions().find(item => item.id === config.action);
                if (!action) return 'Choose a supported player action';
                if (action.hasValue) {
                    const actionValue = config.actionValue === undefined ? action.defaultValue : config.actionValue;
                    if (!isFiniteActionNumber(actionValue)) return `Enter a valid ${action.valuePlaceholder} value`;
                    if (Number(actionValue) <= 0) return `${action.valuePlaceholder} must be greater than zero`;
                }
                break;
            }
            case CODE_TRIGGER_TYPES.PLAYER_STATS: {
                const stat = CODE_PLAYER_STATS.find(item => item.id === config.stat);
                if (!stat) return 'Choose a supported player stat';
                if (typeof config.statValue !== 'string' || !config.statValue.trim()) return 'Enter a value to match';
                if (config.statValue.length > CODE_MAX_PLAYER_STAT_VALUE_LENGTH) {
                    return `Player stat values can contain at most ${CODE_MAX_PLAYER_STAT_VALUE_LENGTH} characters`;
                }
                if (stat.id === 'hostOrGuest' && !['host', 'guest'].includes(config.statValue.toLowerCase())) {
                    return 'Host or Guest must be "host" or "guest"';
                }
                break;
            }
            case CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED:
                if (config.direction !== undefined && !CODE_HEALTH_CHANGE_DIRECTIONS.some(item => item.id === config.direction)) {
                    return 'Choose any change, increased health, or decreased health';
                }
                break;
            case CODE_TRIGGER_TYPES.PLAYER_LANDS:
                // Landing triggers need only the linked Event configured below.
                break;
            case CODE_TRIGGER_TYPES.PLAYER_JUMPS:
                // Jump triggers need only the linked Event configured below.
                break;
            case CODE_TRIGGER_TYPES.REPEAT: {
                const interval = config.interval === undefined ? 1 : config.interval;
                const unit = config.unit || 'seconds';
                if (!isFiniteActionNumber(interval) || Number(interval) < 1) {
                    return 'Repeat interval must be a finite number of at least 1';
                }
                if (!CODE_TIME_UNITS.some(item => item.id === unit)) return 'Choose a supported repeat time unit';
                const intervalMs = Number(interval) * (unit === 'ticks' ? 1000 / 60 : unit === 'minutes' ? 60000 : 1000);
                if (!Number.isFinite(intervalMs) || intervalMs > CODE_MAX_TIMER_DELAY_SECONDS * 1000) {
                    return 'Repeat interval cannot exceed 24 hours';
                }
                break;
            }
        }
        const eventId = config.eventId || config.actionId;
        if (!eventId) return 'No event linked';
        const linkedEvent = getEvents().find(event => event.id === eventId);
        if (!linkedEvent) return 'Linked event not found';
        if (linkedEvent.enabled === false) return 'Linked event is disabled';
        return null;
    };

    const isFiniteActionNumber = (value) => {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string' && value.trim() === '') return false;
        if (typeof value !== 'number' && typeof value !== 'string') return false;
        return Number.isFinite(Number(value));
    };

    const isBooleanActionValue = (value) => [true, false, 'true', 'false'].includes(value);

    const isValidListActionItem = (valueType, value) => {
        if (valueType === 'string') return typeof value === 'string' && value.length <= CODE_MAX_VARIABLE_STRING_LENGTH;
        if (valueType === 'integer') return isFiniteActionNumber(value) && Number.isInteger(Number(value));
        if (valueType === 'float') return isFiniteActionNumber(value);
        if (valueType === 'boolean') return isBooleanActionValue(value);
        return false;
    };

    const getVariableError = (variable) => {
        if (!variable || typeof variable !== 'object') return 'Invalid variable record';
        if (variable.variableType === CODE_VARIABLE_TYPES.LIST) {
            const items = Array.isArray(variable.listItems) ? variable.listItems : [];
            const listLength = variable.listLength === undefined ? items.length : variable.listLength;
            if (!Number.isInteger(listLength) || listLength < 0 || listLength > CODE_MAX_LIST_ITEMS || items.length < listLength) {
                return `Lists must contain between 0 and ${CODE_MAX_LIST_ITEMS} configured items`;
            }
            for (let index = 0; index < listLength; index++) {
                const item = items[index];
                if (item?.valueType === 'variable') {
                    const reference = getCodeData().variables.find(candidate => candidate.id === item.value && candidate.enabled !== false &&
                        candidate.id !== variable.id && candidate.scope !== 'player' && candidate.variableType !== CODE_VARIABLE_TYPES.LIST &&
                        ['string', 'integer', 'float', 'boolean'].includes(candidate.valueType));
                    if (!reference) return `List item ${index + 1} refers to a missing or unsupported variable`;
                } else if (!isValidListActionItem(item?.valueType, item?.value)) {
                    return `List item ${index + 1} has an invalid typed value`;
                }
            }
            return null;
        }

        if (!['string', 'integer', 'float', 'boolean'].includes(variable.valueType)) return 'Choose a supported variable value type';
        if (!isValidListActionItem(variable.valueType, variable.defaultValue)) return 'The variable default does not match its value type';
        return null;
    };

    const getObjectSpriteAnimationPlayback = (action) => {
        if (action?.type !== 'playObjectSpriteAnimation') return null;
        const object = getWorld()?.getObjectById?.(action.objectId);
        const spriteSheet = object?.spriteSheet;
        if (!spriteSheet) return null;
        if (action.mode === 'clip') {
            const clip = (Array.isArray(spriteSheet.animations) ? spriteSheet.animations : [])
                .find(candidate => candidate?.name === action.animationName);
            return clip ? clip : null;
        }
        if (action.mode === 'play') return action;
        return null;
    };

    const getEventError = (event) => {
        const actions = Array.isArray(event.actions) ? event.actions : [];
        if (actions.length > CODE_MAX_EVENT_ACTIONS) return `Events can contain at most ${CODE_MAX_EVENT_ACTIONS} actions`;
        for (let index = 0; index < actions.length - 1; index++) {
            if (actionMayYieldForDialogue(actions[index])) {
                return 'Dialogue or choices pause this event chain. Move the UI action or its linked event to the final action.';
            }
            if (actionMayTransitionMap(actions[index])) {
                return 'A scene transition or restart ends its event chain. Move it and its linked event to the final action.';
            }
        }
        if (actions.some(action => actionMayTransitionMap(action)) && typeof event.code === 'string' && event.code.trim()) {
            return 'A scene transition or restart ends the event before legacy Python runs. Move that Python to the destination scene’s Game Starts event.';
        }
        for (const action of actions) {
            if (!action || typeof action !== 'object') return 'Invalid action record';
            // Keep unknown action records editable and saveable across runtime
            // versions. The runtime reports them as unsupported until this
            // client learns the action or an author replaces the record.
            if (!CODE_EVENT_ACTION_TYPES.some(type => type.id === action.type)) continue;
            const variable = getVariables().find(item => item.id === action.variableId);
            const playerCountVariable = getVariables().find(item => item.id === action.playerVariableId && item.scope === 'player');
            const listVariable = getListVariables().find(item => item.id === action.variableId);
            if (['setVariable', 'addVariable', 'calculateVariable', 'toggleVariable'].includes(action.type) && !variable) {
                return `Select a variable for ${CODE_EVENT_ACTION_TYPES.find(type => type.id === action.type)?.label || 'this action'}`;
            }
            if (variable?.scope === 'player' && ['setVariable', 'addVariable', 'calculateVariable', 'toggleVariable'].includes(action.type) &&
                ![undefined, 'triggering', 'touched', 'all'].includes(action.playerTarget)) {
                return 'Choose a supported target for this player variable';
            }
            if (action.type === 'addVariable' && !['integer', 'float'].includes(variable?.valueType)) return 'Add requires an integer or float variable';
            if (action.type === 'addVariable' && !isFiniteActionNumber(action.amount)) return 'Enter a finite amount to add';
            if (action.type === 'addVariable' && variable?.valueType === 'integer' && isFiniteActionNumber(action.amount) && !Number.isInteger(Number(action.amount))) return 'Enter a whole number to add';
            if (action.type === 'calculateVariable' && !['integer', 'float'].includes(variable?.valueType)) return 'Calculation requires an integer or float variable';
            if (action.type === 'calculateVariable' && !['add', 'subtract', 'multiply', 'divide'].includes(action.operation)) return 'Choose an arithmetic operation';
            if (action.type === 'calculateVariable' && !isFiniteActionNumber(action.operand)) return 'Enter a finite number for the calculation';
            if (action.type === 'calculateVariable' && variable?.valueType === 'integer' && isFiniteActionNumber(action.operand) && !Number.isInteger(Number(action.operand))) return 'Integer variables require a whole-number operand';
            if (action.type === 'calculateVariable' && action.operation === 'divide' && Number(action.operand) === 0) return 'A number variable cannot be divided by zero';
            if (action.type === 'toggleVariable' && variable?.valueType !== 'boolean') return 'Toggle requires a boolean variable';
            if (action.type === 'setVariable' && !['string', 'integer', 'float', 'boolean'].includes(variable?.valueType)) return 'Set requires a supported single-value variable';
            if (action.type === 'setVariable' && ['integer', 'float'].includes(variable?.valueType) && !isFiniteActionNumber(action.value)) return 'Enter a finite number for this variable';
            if (action.type === 'setVariable' && variable?.valueType === 'integer' && isFiniteActionNumber(action.value) && !Number.isInteger(Number(action.value))) return 'Enter a whole number for this variable';
            if (action.type === 'setVariable' && variable?.valueType === 'boolean' && !isBooleanActionValue(action.value)) return 'Choose true or false for this variable';
            if (action.type === 'setVariable' && variable?.valueType === 'string' && (typeof action.value !== 'string' || action.value.length > CODE_MAX_VARIABLE_STRING_LENGTH)) return `Text values can contain at most ${CODE_MAX_VARIABLE_STRING_LENGTH} characters`;
            if (action.type === 'branchVariable') {
                if (!variable) return 'Choose a single-value variable to test';
                if (variable.scope === 'player' && ![undefined, 'triggering', 'touched'].includes(action.playerTarget)) {
                    return 'Choose the triggering or touched player for this condition';
                }
                const operators = getVariableConditionOperators(variable).map(([id]) => id);
                if (!operators.includes(action.operator || 'equals')) return 'Choose a condition supported by this variable type';
                    if (!['truthy', 'falsy'].includes(action.operator) && ['integer', 'float'].includes(variable.valueType)) {
                        if (!isFiniteActionNumber(action.value)) return 'Enter a valid number for the variable condition';
                        if (variable.valueType === 'integer' && !Number.isInteger(Number(action.value))) return 'Enter a whole number for the variable condition';
                    }
                    if (!['truthy', 'falsy'].includes(action.operator) && variable.valueType === 'boolean' && !isBooleanActionValue(action.value)) return 'Choose true or false for the boolean condition';
                    if (!['truthy', 'falsy'].includes(action.operator) && variable.valueType === 'string' &&
                        (typeof action.value !== 'string' || action.value.length > CODE_MAX_VARIABLE_STRING_LENGTH)) return `Text conditions can contain at most ${CODE_MAX_VARIABLE_STRING_LENGTH} characters`;
                const branches = [action.trueEventId, action.falseEventId].filter(Boolean);
                if (!branches.length) return 'Choose an event for at least one branch';
                for (const eventId of branches) {
                    const target = getEvents().find(candidate => candidate.id === eventId);
                    if (!target) return 'Choose a valid event for each branch';
                    if (target.enabled === false) return 'Choose an enabled event for each branch';
                    if (eventCanReach(target.id, event.id)) return 'This branch creates a recursive event chain';
                }
            }
            if (action.type === 'setCameraFollowMode' && !['both', 'horizontal', 'vertical'].includes(action.mode)) {
                return 'Choose both camera axes, horizontal only, or vertical only';
            }
            if (action.type === 'setCameraBounds') {
                if (!['map', 'unbounded', 'bounds'].includes(action.mode)) return 'Choose map bounds, no bounds, or custom bounds';
                if (action.mode === 'bounds') {
                    const values = [action.x, action.y, action.width, action.height];
                    if (values.some(value => !isFiniteActionNumber(value))) return 'Enter finite camera bounds';
                    const [x, y, width, height] = values.map(Number);
                    if (width <= 0 || height <= 0 || Math.abs(x) > 10000000 || Math.abs(y) > 10000000 ||
                        width > 20000000 || height > 20000000 || x + width > 10000000 || y + height > 10000000) {
                        return 'Camera bounds must be a positive rectangle inside ±10,000,000 map pixels';
                    }
                }
            }
            if (action.type === 'setGravity' && !['map', 'custom'].includes(action.mode)) {
                return 'Choose Map Config gravity or a custom gravity value';
            }
            if (action.type === 'setGravity' && action.mode === 'custom' &&
                (!isFiniteActionNumber(action.gravity) || Number(action.gravity) < 0 || Number(action.gravity) > 5)) {
                return 'Gravity must be between 0 and 5, or use the map setting';
            }
            if (action.type === 'setJumpForce' && !['map', 'custom'].includes(action.mode)) {
                return 'Choose Map Config jump force or a custom jump force';
            }
            if (action.type === 'setJumpForce' && action.mode === 'custom' &&
                (!isFiniteActionNumber(action.jumpForce) || Number(action.jumpForce) < -100 || Number(action.jumpForce) > -0.1)) {
                return 'Jump force must be between -100 and -0.1, or use the map setting';
            }
            if (action.type === 'setPlayerSpeed' && !['map', 'custom'].includes(action.mode)) {
                return 'Choose Map Config player speed or a custom speed';
            }
            if (action.type === 'setPlayerSpeed' && action.mode === 'custom' &&
                (!isFiniteActionNumber(action.speed) || Number(action.speed) < 0.1 || Number(action.speed) > 100)) {
                return 'Player speed must be between 0.1 and 100, or use the map setting';
            }
            if (action.type === 'setMovementControl') {
                const controlRanges = {
                    horizontalAcceleration: [0, 20],
                    airControl: [0, 1],
                    terminalFallSpeed: [1, 100]
                };
                const range = controlRanges[action.property];
                if (!range) return 'Choose acceleration, air control, or terminal fall speed';
                if (!['map', 'custom'].includes(action.mode)) return 'Choose Map Config or custom movement control';
                if (action.mode === 'custom' && (!isFiniteActionNumber(action.value) || Number(action.value) < range[0] || Number(action.value) > range[1])) {
                    return `Custom ${action.property} must be between ${range[0]} and ${range[1]}, or use the map setting`;
                }
            }
            if (action.type === 'setObjectSpriteFrame') {
                const object = getWorld()?.getObjectById?.(action.objectId);
                if (!object?.spriteSheet) return 'Choose an object with a sprite sheet';
                if (!['custom', 'automatic'].includes(action.mode)) return 'Choose a fixed frame or automatic animation';
                if (action.mode === 'custom' && (!isFiniteActionNumber(action.frame) || !Number.isSafeInteger(Number(action.frame)) ||
                    Number(action.frame) < 0 || Number(action.frame) >= object.spriteSheet.frameCount)) {
                    return `Frame must be between 0 and ${object.spriteSheet.frameCount - 1}`;
                }
            }
            if (action.type === 'setObjectOpacity') {
                if (!getWorld()?.getObjectById?.(action.objectId)) return 'Choose a map object';
                if (!['map', 'custom'].includes(action.mode)) return 'Choose Map Config or custom opacity';
                if (action.mode === 'custom' && (!isFiniteActionNumber(action.opacity) ||
                    Number(action.opacity) < 0 || Number(action.opacity) > 1)) {
                    return 'Opacity must be between 0 and 1, or use the map setting';
                }
            }
            if (action.type === 'playObjectSpriteAnimation') {
                const object = getWorld()?.getObjectById?.(action.objectId);
                if (!object?.spriteSheet) return 'Choose an object with a sprite sheet';
                if (!['play', 'clip', 'automatic'].includes(action.mode)) return 'Choose a frame range, named clip, or automatic animation';
                if (action.mode === 'clip') {
                    const clip = getObjectSpriteAnimationPlayback(action);
                    if (!clip) return 'Choose a named animation clip on this object';
                    if (action.completionEventId !== undefined && action.completionEventId !== null && action.completionEventId !== '') {
                        if (clip.loop) return 'Choose a one-shot clip before adding a completion Event';
                        if (typeof action.completionEventId !== 'string') return 'Choose a valid completion Event';
                        const completionEvent = getEvents().find(candidate => candidate.id === action.completionEventId);
                        if (!completionEvent) return 'Choose an existing completion Event';
                        if (completionEvent.enabled === false) return 'Choose an enabled completion Event';
                    }
                }
                if (action.mode === 'automatic' && action.completionEventId) return 'Automatic animation does not have a completion Event';
                if (action.mode === 'play') {
                    const startFrame = Number(action.startFrame);
                    const frameCount = Number(action.frameCount);
                    if (!isFiniteActionNumber(action.startFrame) || !Number.isSafeInteger(startFrame) || startFrame < 0 ||
                        !isFiniteActionNumber(action.frameCount) || !Number.isSafeInteger(frameCount) || frameCount < 1 ||
                        startFrame + frameCount > object.spriteSheet.frameCount) {
                        return `Choose a frame range within the object's ${object.spriteSheet.frameCount}-frame sheet`;
                    }
                    if (!isFiniteActionNumber(action.fps) || Number(action.fps) < 1 || Number(action.fps) > 30) {
                        return 'Animation rate must be between 1 and 30 FPS';
                    }
                    if (typeof action.loop !== 'boolean') return 'Choose whether the animation loops';
                    if (action.completionEventId !== undefined && action.completionEventId !== null && action.completionEventId !== '') {
                        if (action.loop) return 'Choose one-shot playback before adding a completion Event';
                        if (typeof action.completionEventId !== 'string') return 'Choose a valid completion Event';
                        const completionEvent = getEvents().find(candidate => candidate.id === action.completionEventId);
                        if (!completionEvent) return 'Choose an existing completion Event';
                        if (completionEvent.enabled === false) return 'Choose an enabled completion Event';
                    }
                }
            }
            if (action.type === 'branchPlayerCount') {
                if (!playerCountVariable) return 'Choose an enabled per-player variable to count';
                const filterOperators = getVariableConditionOperators(playerCountVariable).map(([id]) => id);
                if (!filterOperators.includes(action.filterOperator || 'equals')) return 'Choose a condition supported by the player variable';
                if (!['truthy', 'falsy'].includes(action.filterOperator || 'equals')) {
                    if (['integer', 'float'].includes(playerCountVariable.valueType) && !isFiniteActionNumber(action.filterValue)) return 'Enter a valid player-variable number';
                    if (playerCountVariable.valueType === 'integer' && !Number.isInteger(Number(action.filterValue))) return 'Enter a whole number for the player-variable condition';
                    if (playerCountVariable.valueType === 'boolean' && !isBooleanActionValue(action.filterValue)) return 'Choose true or false for the player-variable condition';
                    if (playerCountVariable.valueType === 'string' && (typeof action.filterValue !== 'string' || action.filterValue.length > CODE_MAX_VARIABLE_STRING_LENGTH)) return `Text conditions can contain at most ${CODE_MAX_VARIABLE_STRING_LENGTH} characters`;
                }
                if (!['equals', 'greaterThan', 'lessThan'].includes(action.operator || 'equals')) return 'Choose a supported player-count condition';
                if (!isFiniteActionNumber(action.count) || !Number.isInteger(Number(action.count)) || Number(action.count) < 0 || Number(action.count) > 100) return 'Player count must be a whole number from 0 to 100';
                const branches = [action.trueEventId, action.falseEventId].filter(Boolean);
                if (!branches.length) return 'Choose an event for at least one player-count branch';
                for (const eventId of branches) {
                    const target = getEvents().find(candidate => candidate.id === eventId);
                    if (!target) return 'Choose a valid event for each branch';
                    if (target.enabled === false) return 'Choose an enabled event for each branch';
                    if (eventCanReach(target.id, event.id)) return 'This player-count branch creates a recursive event chain';
                }
            }
            if (action.type === 'branchObjectHealth') {
                if (!['fixed', 'touched'].includes(action.targetMode)) return 'Choose a selected object or the object touched by this Event';
                if (action.targetMode === 'fixed' && !(getWorld()?.objects || []).some(object => object.id === action.objectId)) {
                    return 'Select an object on this map';
                }
                if (!['equals', 'notEquals', 'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual'].includes(action.operator)) {
                    return 'Choose a supported health comparison';
                }
                const value = Number(action.value);
                if (!isFiniteActionNumber(action.value) || !Number.isSafeInteger(value) || value < 0 || value > 99999) {
                    return 'Health must be a whole number from 0 to 99,999';
                }
                const branches = [action.trueEventId, action.falseEventId].filter(Boolean);
                if (!branches.length) return 'Choose an Event for at least one health branch';
                for (const eventId of branches) {
                    const target = getEvents().find(candidate => candidate.id === eventId);
                    if (!target) return 'Choose a valid Event for each health branch';
                    if (target.enabled === false) return 'Choose an enabled Event for each health branch';
                    if (eventCanReach(target.id, event.id)) return 'This object-health branch creates a recursive Event chain';
                }
            }
            if (['appendListItem', 'removeListItem', 'branchListContains'].includes(action.type)) {
                if (!listVariable) return 'Choose an enabled List variable';
                if (!isValidListActionItem(action.valueType, action.value)) {
                    return 'Enter a valid typed list item';
                }
                if (listVariable.scope === 'player') {
                    const allowedTargets = action.type === 'branchListContains'
                        ? [undefined, 'triggering', 'touched']
                        : [undefined, 'triggering', 'touched', 'all'];
                    if (!allowedTargets.includes(action.playerTarget)) return 'Choose a supported target player for this List';
                }
            }
            if (action.type === 'setInventoryItemEquipped') {
                if (!listVariable || listVariable.scope !== 'player' || listVariable.valueType !== 'string') {
                    return 'Choose a Player-scoped string List for equipment';
                }
                if (typeof action.itemName !== 'string' || !action.itemName.trim() || action.itemName.trim().length > 80) {
                    return 'Enter an inventory item name up to 80 characters';
                }
                if (typeof action.slot !== 'string' || action.slot.trim().length > 32) return 'Enter an equipment slot up to 32 characters';
                if (typeof action.equipped !== 'boolean') return 'Choose whether the item should be equipped';
                if (![undefined, 'triggering', 'touched', 'all'].includes(action.playerTarget)) return 'Choose a supported target player for this equipment action';
            }
            if (action.type === 'branchInventoryItemEquipped') {
                if (!listVariable || listVariable.scope !== 'player' || listVariable.valueType !== 'string') return 'Choose a Player-scoped string List for equipment';
                if (typeof action.itemName !== 'string' || !action.itemName.trim() || action.itemName.trim().length > 80) return 'Enter an inventory item name up to 80 characters';
                if (typeof action.slot !== 'string' || action.slot.trim().length > 32) return 'Enter an equipment slot up to 32 characters';
                if (![undefined, 'triggering', 'touched'].includes(action.playerTarget)) return 'Choose the triggering or touched player for this condition';
                const branches = [action.trueEventId, action.falseEventId].filter(Boolean);
                if (!branches.length) return 'Choose an event for at least one equipment branch';
                for (const eventId of branches) {
                    const target = getEvents().find(candidate => candidate.id === eventId);
                    if (!target) return 'Choose a valid event for each equipment branch';
                    if (target.enabled === false) return 'Choose an enabled event for each equipment branch';
                    if (eventCanReach(target.id, event.id)) return 'This equipment branch creates a recursive event chain';
                }
            }
            if (action.type === 'consumeInventoryItem') {
                if (!listVariable || listVariable.scope !== 'player' || listVariable.valueType !== 'string') return 'Choose a Player-scoped string List for item use';
                if (typeof action.itemName !== 'string' || !action.itemName.trim() || action.itemName.trim().length > 80) return 'Enter an inventory item name up to 80 characters';
                if (typeof action.slot !== 'string' || action.slot.trim().length > 32) return 'Enter an equipment slot up to 32 characters';
                if (![undefined, 'triggering', 'touched'].includes(action.playerTarget)) return 'Choose the triggering or touched player for item use';
                if (!action.trueEventId) return 'Choose the Event to run when the item is used';
                for (const eventId of [action.trueEventId, action.falseEventId].filter(Boolean)) {
                    const target = getEvents().find(candidate => candidate.id === eventId);
                    if (!target) return 'Choose a valid Event for item use';
                    if (target.enabled === false) return 'Choose an enabled Event for item use';
                    if (eventCanReach(target.id, event.id)) return 'This item-use action creates a recursive event chain';
                }
            }
            if (action.type === 'showList') {
                if (!listVariable) return 'Choose an enabled List variable to display';
                if (typeof action.title !== 'string' || !action.title.trim() || action.title.length > 64) {
                    return 'Enter a panel title up to 64 characters';
                }
            }
            if (action.type === 'showVariablePanel') {
                if (!variable) return 'Choose an enabled single-value variable to display';
                if (typeof action.title !== 'string' || !action.title.trim() || action.title.length > 64) {
                    return 'Enter a panel title up to 64 characters';
                }
            }
            if (action.type === 'branchListContains') {
                const branches = [action.trueEventId, action.falseEventId].filter(Boolean);
                if (!branches.length) return 'Choose an event for at least one list branch';
                for (const eventId of branches) {
                    const target = getEvents().find(candidate => candidate.id === eventId);
                    if (!target) return 'Choose a valid event for each list branch';
                    if (target.enabled === false) return 'Choose an enabled event for each list branch';
                    if (eventCanReach(target.id, event.id)) return 'This list branch creates a recursive event chain';
                }
            }
            if (action.type === 'setObjectEnabled') {
                if (!(getWorld()?.objects || []).some(object => object.id === action.objectId)) return 'Select an object on this map';
                if (typeof action.enabled !== 'boolean') return 'Choose whether the object should be enabled or disabled';
            }
            if (['setObjectHealth', 'damageObject'].includes(action.type)) {
                if (!['fixed', 'touched'].includes(action.targetMode)) return 'Choose a fixed object or the object touched by this Event';
                if (action.targetMode === 'fixed' && !(getWorld()?.objects || []).some(object => object.id === action.objectId)) {
                    return 'Select an object on this map';
                }
                const maximum = Number(action.maxHealth);
                if (!isFiniteActionNumber(action.maxHealth) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 99999) return 'Maximum object health must be a whole number from 1 to 99,999';
                if (action.type === 'setObjectHealth') {
                    const health = Number(action.health);
                    if (!isFiniteActionNumber(action.health) || !Number.isSafeInteger(health) || health < 0 || health > maximum) return 'Object health must be a whole number from 0 to its maximum health';
                } else {
                    const amount = Number(action.amount);
                    if (!isFiniteActionNumber(action.amount) || !Number.isSafeInteger(amount) || amount < 1 || amount > 99999) return 'Damage must be a whole number from 1 to 99,999';
                    if (action.defeatedEventId) {
                        const target = getEvents().find(candidate => candidate.id === action.defeatedEventId);
                        if (!target) return 'Choose an existing Event to run when the object is defeated';
                        if (target.enabled === false) return 'Choose an enabled Event to run when the object is defeated';
                        if (eventCanReach(target.id, event.id)) return 'The defeat Event creates a recursive Event chain';
                    }
                }
            }
            if (action.type === 'setTriggerEnabled') {
                if (!getCodeData().triggers.some(trigger => trigger.id === action.triggerId)) return 'Select a trigger on this map';
                if (typeof action.enabled !== 'boolean') return 'Choose whether the trigger should be enabled or disabled';
            }
            if (action.type === 'spawnObject') {
                const template = (getWorld()?.objects || []).find(object => object.id === action.objectId);
                if (!template || template._mechanicsSpawned) return 'Select an authored object as the spawn template';
                if (template.type === 'teleportal' || template.appearanceType === 'teleportal' ||
                    ['zone', 'button', 'checkpoint', 'spawnpoint', 'endpoint'].includes(template.appearanceType) ||
                    ['checkpoint', 'spawnpoint', 'endpoint'].includes(template.actingType)) {
                    return 'Portals, zones, buttons, checkpoints, spawn points, and endpoints cannot be spawned as runtime objects';
                }
                if (!isFiniteActionNumber(action.xOffset) || !isFiniteActionNumber(action.yOffset) ||
                    Math.abs(Number(action.xOffset)) > 10000000 || Math.abs(Number(action.yOffset)) > 10000000) {
                    return 'Enter finite spawn offsets between -10,000,000 and 10,000,000';
                }
                if (typeof action.tag !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(action.tag)) return 'Use a 1–64 character spawn tag with letters, numbers, underscores, or hyphens';
                if (!Number.isInteger(Number(action.maxInstances)) || Number(action.maxInstances) < 1 || Number(action.maxInstances) > CODE_MAX_MECHANICS_SPAWNED_OBJECTS) {
                    return `Maximum instances must be between 1 and ${CODE_MAX_MECHANICS_SPAWNED_OBJECTS}`;
                }
                const lifetime = action.lifetime === undefined ? 0 : action.lifetime;
                if (!isFiniteActionNumber(lifetime) || Number(lifetime) < 0 || Number(lifetime) > CODE_MAX_MECHANICS_SPAWN_LIFETIME_SECONDS) {
                    return `Lifetime must be 0 (until removed) or between 0 and ${CODE_MAX_MECHANICS_SPAWN_LIFETIME_SECONDS} seconds`;
                }
            }
            if (action.type === 'removeSpawnedObjects' &&
                (typeof action.tag !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(action.tag))) {
                return 'Enter the spawn tag to remove (1–64 letters, numbers, underscores, or hyphens)';
            }
            if (action.type === 'setObjectPosition') {
                if (!(getWorld()?.objects || []).some(object => object.id === action.objectId)) return 'Select an object on this map';
                if (!isFiniteActionNumber(action.x) || !isFiniteActionNumber(action.y) ||
                    Math.abs(Number(action.x)) > 10000000 || Math.abs(Number(action.y)) > 10000000) {
                    return 'Enter finite X and Y coordinates between -10,000,000 and 10,000,000';
                }
            }
            if (action.type === 'setTilemapCellBehavior') {
                const tilemap = (getWorld()?.tilemaps || []).find(item => item.id === action.tilemapId);
                if (!tilemap) return 'Select a tilemap on this map';
                if (!['fixed', 'touched'].includes(action.targetMode)) return 'Choose a fixed cell or the touched cell';
                if (!['solid', 'oneWay', 'rampUpRight', 'rampUpLeft', 'hazard', 'decorative'].includes(action.collisionType)) return 'Choose a supported tile behavior';
                if (action.targetMode === 'fixed') {
                    const x = Number(action.x);
                    const y = Number(action.y);
                    const gridSize = window.GRID_SIZE || 32;
                    if (!isFiniteActionNumber(action.x) || !isFiniteActionNumber(action.y) ||
                        !Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
                        x % gridSize !== 0 || y % gridSize !== 0 ||
                        Math.abs(x) > 10000000 || Math.abs(y) > 10000000) {
                        return `Enter cell coordinates on the ${gridSize} px grid`;
                    }
                    if (!(tilemap.cells || []).some(cell => cell.x === x && cell.y === y)) return 'Select an existing cell on this tilemap';
                }
            }
            if (action.type === 'moveObject') {
                if (!(getWorld()?.objects || []).some(object => object.id === action.objectId)) return 'Select an object on this map';
                if (!isFiniteActionNumber(action.x) || !isFiniteActionNumber(action.y) ||
                    Math.abs(Number(action.x)) > 10000000 || Math.abs(Number(action.y)) > 10000000) {
                    return 'Enter finite X and Y coordinates between -10,000,000 and 10,000,000';
                }
                const duration = Number(action.duration);
                if (!isFiniteActionNumber(action.duration) || duration < 0.01 || duration > CODE_MAX_OBJECT_MOVE_DURATION_SECONDS) {
                    return `Movement time must be between 0.01 and ${CODE_MAX_OBJECT_MOVE_DURATION_SECONDS} seconds`;
                }
                if (!CODE_OBJECT_MOTION_EASINGS.some(easing => easing.id === action.easing)) return 'Choose a movement easing';
            }
            if (action.type === 'setCheckpoint' && !(getWorld()?.objects || []).some(object =>
                object.id === action.objectId && object.actingType === 'checkpoint' && object._mechanicsEnabled !== false)) {
                return 'Select an enabled checkpoint object on this map';
            }
            if (action.type === 'startTimer') {
                const timerName = String(action.timerName || '').trim();
                if (!timerName || timerName.length > 64) return 'Enter a timer name up to 64 characters';
                const seconds = Number(action.seconds);
                if (!isFiniteActionNumber(action.seconds) || seconds < 0.01 || seconds > CODE_MAX_TIMER_DELAY_SECONDS) {
                    return `Timer delay must be between 0.01 and ${CODE_MAX_TIMER_DELAY_SECONDS} seconds`;
                }
                if (!getEvents().some(candidate => candidate.id === action.eventId && candidate.enabled !== false)) return 'Choose an enabled event for the timer';
                const repeats = action.repeat === true || action.repeat === 'true';
                if (repeats && (!isFiniteActionNumber(action.repeatCount) || !Number.isInteger(Number(action.repeatCount)) || Number(action.repeatCount) < 1 || Number(action.repeatCount) > CODE_MAX_TIMER_REPEAT_COUNT)) {
                    return `Repeat count must be between 1 and ${CODE_MAX_TIMER_REPEAT_COUNT}`;
                }
            }
            if (action.type === 'stopTimer') {
                const timerName = String(action.timerName || '').trim();
                if (!timerName) return 'Enter the name of the timer to stop';
                if (timerName.length > 64) return 'Timer names can contain at most 64 characters';
            }
            if (['damagePlayer', 'healPlayer'].includes(action.type) && (!isFiniteActionNumber(action.amount) || Number(action.amount) < 0)) return 'Health amount must be a non-negative number';
            if (action.type === 'healPlayer' && !getWorld()?.plugins?.enabled?.includes('hp')) return 'Heal Player requires the HP plugin';
            if (action.type === 'playSound' && !CODE_CORE_SOUND_NAMES.includes(action.soundName)) return 'Choose a built-in sound';
            if (['playPluginSound', 'stopPluginSound'].includes(action.type)) {
                const manager = window.PluginManager;
                const plugin = manager?.plugins?.get(action.pluginId);
                if (!plugin || !manager.isEnabled?.(action.pluginId)) return 'Choose an enabled plugin';
                if (!plugin.sounds || typeof action.soundName !== 'string' || !Object.hasOwn(plugin.sounds, action.soundName)) {
                    return 'Choose a sound declared by the selected plugin';
                }
            }
            if (action.type === 'playPluginSound') {
                const volume = action.volume === undefined ? 1 : Number(action.volume);
                if (!isFiniteActionNumber(volume) || volume < 0 || volume > 1) {
                    return 'Plugin sound volume must be between 0 and 1';
                }
            }
            if (action.type === 'teleportPlayer' && (!isFiniteActionNumber(action.x) || !isFiniteActionNumber(action.y) ||
                Math.abs(Number(action.x)) > CODE_MAX_PLAYER_TELEPORT_COORDINATE || Math.abs(Number(action.y)) > CODE_MAX_PLAYER_TELEPORT_COORDINATE)) {
                return `Teleport coordinates must be between -${CODE_MAX_PLAYER_TELEPORT_COORDINATE.toLocaleString()} and ${CODE_MAX_PLAYER_TELEPORT_COORDINATE.toLocaleString()}`;
            }
            if (action.type === 'transitionToMap' &&
                (typeof action.mapId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(action.mapId))) {
                return 'Choose a saved destination map or enter its 1–128 character map ID';
            }
            if (action.type === 'teleportPlayerToObject' && !(getWorld()?.objects || []).some(object =>
                object.id === action.objectId && object._mechanicsEnabled !== false && Number.isFinite(object.x) && Number.isFinite(object.y) &&
                Number.isFinite(object.width) && object.width > 0 && Number.isFinite(object.height) && object.height > 0)) {
                return 'Select an enabled map object with a valid position and size';
            }
            if (action.type === 'setVelocity' && (!isFiniteActionNumber(action.vx) || !isFiniteActionNumber(action.vy) ||
                Math.abs(Number(action.vx)) > CODE_MAX_PLAYER_VELOCITY || Math.abs(Number(action.vy)) > CODE_MAX_PLAYER_VELOCITY)) {
                return `Player speeds must be between -${CODE_MAX_PLAYER_VELOCITY.toLocaleString()} and ${CODE_MAX_PLAYER_VELOCITY.toLocaleString()}`;
            }
            if (action.type === 'showMessage' && action.duration !== undefined && action.duration !== null && (!isFiniteActionNumber(action.duration) || Number(action.duration) < 0)) return 'Message duration must be a non-negative number';
            if (action.type === 'runEvent') {
                const target = getEvents().find(candidate => candidate.id === action.eventId);
                if (!target) return 'Choose an event to run';
                if (target.enabled === false) return 'Choose an enabled event to run';
                if (eventCanReach(target.id, event.id)) return 'This event link creates a recursive event chain';
            }
            if (action.type === 'showMessage' && !String(action.text || '').trim()) return 'Message text is empty';
           if (action.type === 'showDialogue') {
               const pages = typeof action.pages === 'string'
                   ? action.pages.split(/\r?\n/).map(page => page.trim()).filter(Boolean)
                   : [];
               const speaker = action.speaker === undefined ? '' : action.speaker;
               if (typeof speaker !== 'string' || speaker.length > CODE_MAX_DIALOGUE_SPEAKER_LENGTH) {
                   return `Speaker names can contain at most ${CODE_MAX_DIALOGUE_SPEAKER_LENGTH} characters`;
               }
               if (pages.length < 1 || pages.length > CODE_MAX_DIALOGUE_PAGES) {
                   return `Dialogue needs 1–${CODE_MAX_DIALOGUE_PAGES} non-empty pages`;
               }
               if (pages.some(page => page.length > CODE_MAX_DIALOGUE_PAGE_LENGTH)) {
                   return `Each dialogue page can contain at most ${CODE_MAX_DIALOGUE_PAGE_LENGTH} characters`;
               }
           }
            if (action.type === 'showChoice') {
                const speaker = action.speaker === undefined ? '' : action.speaker;
                if (typeof speaker !== 'string' || speaker.length > CODE_MAX_DIALOGUE_SPEAKER_LENGTH) {
                    return `Speaker names can contain at most ${CODE_MAX_DIALOGUE_SPEAKER_LENGTH} characters`;
                }
                if (typeof action.prompt !== 'string' || !action.prompt.trim() || action.prompt.includes('\n') ||
                    action.prompt.length > CODE_MAX_DIALOGUE_PAGE_LENGTH) {
                    return `Enter one prompt of at most ${CODE_MAX_DIALOGUE_PAGE_LENGTH} characters`;
                }
                const choices = Array.isArray(action.choices) ? action.choices : [];
                if (choices.length < 2 || choices.length > CODE_MAX_DIALOGUE_CHOICES) {
                    return `Add 2–${CODE_MAX_DIALOGUE_CHOICES} choices`;
                }
                const labels = new Set();
                for (const choice of choices) {
                    const label = typeof choice?.label === 'string' ? choice.label.trim() : '';
                    if (!label || label.length > CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH || labels.has(label.toLocaleLowerCase())) {
                        return `Choice labels must be unique and 1–${CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH} characters`;
                    }
                    labels.add(label.toLocaleLowerCase());
                    const target = getEvents().find(candidate => candidate.id === choice.eventId);
                    if (!target) return 'Choose an event for every choice';
                    if (target.enabled === false) return 'Choose an enabled event for every choice';
                    if (eventCanReach(target.id, event.id)) return 'This choice creates a recursive event chain';
                }
            }
            if (action.type === 'showMenu') {
                if (typeof action.title !== 'string' || !action.title.trim() || action.title.length > 64) {
                    return 'Enter a menu title up to 64 characters';
                }
                if (action.pauseWorld !== undefined && typeof action.pauseWorld !== 'boolean') {
                    return 'Choose whether this menu pauses the whole solo scene';
                }
                const choices = Array.isArray(action.choices) ? action.choices : [];
                if (choices.length < 1 || choices.length > CODE_MAX_DIALOGUE_CHOICES) {
                    return `Add 1–${CODE_MAX_DIALOGUE_CHOICES} menu options`;
                }
                const labels = new Set();
                for (const choice of choices) {
                    const label = typeof choice?.label === 'string' ? choice.label.trim() : '';
                    if (!label || label.length > CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH || labels.has(label.toLocaleLowerCase())) {
                        return `Menu option labels must be unique and 1–${CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH} characters`;
                    }
                    labels.add(label.toLocaleLowerCase());
                    const target = getEvents().find(candidate => candidate.id === choice.eventId);
                    if (!target) return 'Choose an Event for every menu option';
                    if (target.enabled === false) return 'Choose an enabled Event for every menu option';
                    if (eventCanReach(target.id, event.id)) return 'This menu creates a recursive event chain';
                }
                if (action.cancelEventId !== undefined && action.cancelEventId !== null && action.cancelEventId !== '') {
                    if (typeof action.cancelEventId !== 'string') return 'Choose a valid Event for the menu cancel route';
                    const cancelTarget = getEvents().find(candidate => candidate.id === action.cancelEventId);
                    if (!cancelTarget) return 'Choose a valid Event for the menu cancel route';
                    if (cancelTarget.enabled === false) return 'Choose an enabled Event for the menu cancel route';
                    if (eventCanReach(cancelTarget.id, event.id)) return 'The menu cancel route creates a recursive event chain';
                }
            }
        }
        return null;
    };

    const eventCanReach = (fromEventId, targetEventId, visited = new Set()) => {
        if (!fromEventId) return false;
        if (fromEventId === targetEventId) return true;
        if (visited.has(fromEventId)) return false;
        visited.add(fromEventId);
        const event = getEvents().find(candidate => candidate.id === fromEventId);
        return (event?.actions || []).some(action => getActionEventLinks(action)
            .filter(link => EVENT_EXECUTION_PATH_LINK_KINDS.has(link.kind))
            .some(link => eventCanReach(link.eventId, targetEventId, visited)));
    };

    const actionMayYieldForDialogue = (action, visited = new Set()) => {
        if (action?.type === 'showDialogue') return true;
        if (action?.type === 'showChoice' || action?.type === 'showMenu') return true;
        const eventIds = getActionEventLinks(action)
            .filter(link => NESTED_EVENT_LINK_KINDS.has(link.kind))
            .map(link => link.eventId);
        for (const eventId of eventIds) {
            if (!eventId || visited.has(eventId)) continue;
            visited.add(eventId);
            const event = getEvents().find(candidate => candidate.id === eventId);
            if ((event?.actions || []).some(nextAction => actionMayYieldForDialogue(nextAction, visited))) return true;
        }
        return false;
    };

    const actionMayTransitionMap = (action, visited = new Set()) => {
        if (action?.type === 'transitionToMap' || action?.type === 'restartScene') return true;
        const eventIds = getActionEventLinks(action)
            .filter(link => EVENT_EXECUTION_PATH_LINK_KINDS.has(link.kind))
            .map(link => link.eventId);
        for (const eventId of eventIds) {
            if (!eventId || visited.has(eventId)) continue;
            visited.add(eventId);
            const event = getEvents().find(candidate => candidate.id === eventId);
            if ((event?.actions || []).some(nextAction => actionMayTransitionMap(nextAction, visited))) return true;
        }
        return false;
    };

    const getEventExecutionLimitWarnings = (events = getEvents()) => {
        const enabledEvents = events.filter(event => event?.id && event.enabled !== false);
        const eventsById = new Map(enabledEvents.map(event => [event.id, event]));
        const maxDepth = CODE_MAX_EVENT_DEPTH || 16;
        const maxChainActions = CODE_MAX_EVENT_CHAIN_ACTIONS || 256;
        const memo = new Map();
        const visiting = new Set();

        const analyze = eventId => {
            if (memo.has(eventId)) return memo.get(eventId);
            if (visiting.has(eventId)) return { depth: 0, actions: 0 };
            const event = eventsById.get(eventId);
            if (!event) return { depth: 0, actions: 0 };

            visiting.add(eventId);
            const actions = Array.isArray(event.actions) ? event.actions : [];
            const ownActionCount = Math.min(actions.length, (CODE_MAX_EVENT_ACTIONS || 128) + 1);
            let depth = 1;
            let chainActions = ownActionCount;

            for (const action of actions) {
                const links = getActionEventLinks(action).filter(link => EVENT_EXECUTION_PATH_LINK_KINDS.has(link.kind));
                const targets = links.map(link => link.eventId);
                const startsNewStack = links.some(link => link.kind === 'choice');

                const childPaths = targets.filter(targetId => eventsById.has(targetId)).map(analyze);
                if (!childPaths.length) continue;
                const longestChildActions = childPaths.reduce((best, child) => Math.max(best, child.actions), 0);
                const longestChildDepth = childPaths.reduce((best, child) => Math.max(best, child.depth), 0);
                chainActions = Math.min(maxChainActions + 1, chainActions + longestChildActions);
                if (startsNewStack) depth = Math.max(depth, longestChildDepth);
                else depth = Math.max(depth, Math.min(maxDepth + 1, 1 + longestChildDepth));
            }

            visiting.delete(eventId);
            const result = { depth, actions: chainActions };
            memo.set(eventId, result);
            return result;
        };

        const warnings = new Map();
        for (const event of enabledEvents) {
            const path = analyze(event.id);
            const messages = [];
            if (path.depth > maxDepth) messages.push(`A linked synchronous path can nest ${path.depth} Events; the runtime limit is ${maxDepth}`);
            if (path.actions > maxChainActions) messages.push(`A linked execution path can run more than ${maxChainActions} actions; excess actions stop at the runtime limit`);
            if (messages.length) warnings.set(event.id, messages.join('. '));
        }
        return warnings;
    };

    const getUnreachableEventIds = (triggers = getTriggers(), events = getEvents()) => {
        const eventsById = new Map(events.map(event => [event.id, event]));
        const reachable = new Set();
        const pending = [];

        for (const trigger of triggers) {
            if (trigger.enabled === false || getTriggerError(trigger)) continue;
            const eventId = trigger.config?.eventId || trigger.config?.actionId;
            if (eventId) pending.push(eventId);
        }

        while (pending.length > 0) {
            const eventId = pending.pop();
            if (!eventId || reachable.has(eventId)) continue;
            const event = eventsById.get(eventId);
            if (!event || event.enabled === false) continue;
            reachable.add(eventId);

            for (const action of Array.isArray(event.actions) ? event.actions : []) {
                for (const link of getActionEventLinks(action)) pending.push(link.eventId);
            }
        }

        return new Set(events
            .filter(event => event.enabled !== false && !reachable.has(event.id))
            .map(event => event.id));
    };

    // Timer-linked cycles are allowed, but an event that continually starts a
    // timer for an event path back to itself can schedule up to the runtime's
    // per-map safety limit. Surface the cycle in the dashboard without
    // blocking intentional timed loops.
    const getTimerCycleEventIds = (events = getEvents()) => {
        const enabledEvents = events.filter(event => event?.id && event.enabled !== false);
        const eventsById = new Map(enabledEvents.map(event => [event.id, event]));
        const edgesById = new Map();
        const reverseEdgesById = new Map(enabledEvents.map(event => [event.id, []]));

        for (const event of enabledEvents) {
            const edges = [];
            for (const action of Array.isArray(event.actions) ? event.actions : []) {
                for (const { eventId: targetId, kind } of getActionEventLinks(action).filter(link => link.kind !== 'animation')) {
                    if (eventsById.has(targetId)) {
                        edges.push({ targetId, timer: kind === 'timer' });
                        reverseEdgesById.get(targetId).push(event.id);
                    }
                }
            }
            edgesById.set(event.id, edges);
        }

        // Iterative Kosaraju traversal keeps long user-authored flows from
        // consuming the JavaScript call stack while finding strongly
        // connected event groups.
        const visited = new Set();
        const finishOrder = [];
        for (const event of enabledEvents) {
            if (visited.has(event.id)) continue;
            visited.add(event.id);
            const stack = [{ eventId: event.id, nextEdge: 0 }];
            while (stack.length) {
                const frame = stack[stack.length - 1];
                const edges = edgesById.get(frame.eventId) || [];
                if (frame.nextEdge < edges.length) {
                    const targetId = edges[frame.nextEdge++].targetId;
                    if (!visited.has(targetId)) {
                        visited.add(targetId);
                        stack.push({ eventId: targetId, nextEdge: 0 });
                    }
                } else {
                    finishOrder.push(frame.eventId);
                    stack.pop();
                }
            }
        }

        const assigned = new Set();
        const timerCycleEventIds = new Set();
        for (let index = finishOrder.length - 1; index >= 0; index--) {
            const rootId = finishOrder[index];
            if (assigned.has(rootId)) continue;
            const component = new Set();
            const stack = [rootId];
            assigned.add(rootId);
            while (stack.length) {
                const memberId = stack.pop();
                component.add(memberId);
                for (const sourceId of reverseEdgesById.get(memberId) || []) {
                    if (assigned.has(sourceId)) continue;
                    assigned.add(sourceId);
                    stack.push(sourceId);
                }
            }

            const hasCycle = component.size > 1 || (edgesById.get(rootId) || []).some(edge => edge.targetId === rootId);
            if (!hasCycle) continue;
            const hasTimerEdge = [...component].some(id =>
                (edgesById.get(id) || []).some(edge => edge.timer && component.has(edge.targetId))
            );
            if (hasTimerEdge) component.forEach(id => timerCycleEventIds.add(id));
        }
        return timerCycleEventIds;
    };

    const getFlowTargets = (block, blockType = block?.type) => {
        const targets = [];
        if (blockType === CODE_BLOCK_TYPES.TRIGGER) {
            const eventId = block.config?.eventId || block.config?.actionId;
            if (eventId) targets.push({ targetId: eventId, targetType: 'event', label: 'Starts' });
            if (block.triggerType === CODE_TRIGGER_TYPES.VARIABLE_CONDITION && block.config?.variableId) {
                targets.push({ targetId: block.config.variableId, targetType: 'variable', label: 'Checks' });
            }
            for (const event of getEvents()) {
                if ((Array.isArray(event.actions) ? event.actions : []).some(action =>
                    getActionTriggerLinks(action).some(link => link.triggerId === block.id)
                )) {
                    targets.push({ targetId: event.id, targetType: 'event', label: 'Changed by' });
                }
            }
            return targets;
        }

        if (blockType === CODE_BLOCK_TYPES.VARIABLE) {
            for (const trigger of getTriggers()) {
                if (trigger.triggerType === CODE_TRIGGER_TYPES.VARIABLE_CONDITION &&
                    trigger.config?.variableId === block.id) {
                    targets.push({ targetId: trigger.id, targetType: 'trigger', label: 'Checked by' });
                }
            }
            for (const event of getEvents()) {
                if ((Array.isArray(event.actions) ? event.actions : []).some(action =>
                    getActionVariableLinks(action).some(link => link.variableId === block.id)
                )) {
                    targets.push({ targetId: event.id, targetType: 'event', label: 'Used by' });
                }
            }
            return targets;
        }

        if (blockType !== CODE_BLOCK_TYPES.EVENT) return targets;
        for (const action of Array.isArray(block.actions) ? block.actions : []) {
            targets.push(...getActionEventLinks(action).map(link => ({
                targetId: link.eventId,
                targetType: 'event',
                label: link.label
            })));
            targets.push(...getActionVariableLinks(action).map(link => ({
                targetId: link.variableId,
                targetType: 'variable',
                label: link.label
            })));
            targets.push(...getActionTriggerLinks(action).map(link => ({
                targetId: link.triggerId,
                targetType: 'trigger',
                label: link.label
            })));
        }
        return targets;
    };

    const renderFlowConnections = (block, blockType = block?.type) => {
        const targets = getFlowTargets(block, blockType);
        if (targets.length === 0) return '';
        const triggersById = new Map(getTriggers().map(trigger => [trigger.id, trigger]));
        const eventsById = new Map(getEvents().map(event => [event.id, event]));
        const variablesById = new Map((getCodeData().variables || []).map(variable => [variable.id, variable]));
        return `
            <div class="code-block-connections" aria-label="Connected mechanic flow">
                <span class="code-block-connections-label">Flow</span>
                ${targets.map(({ targetId, targetType, label }) => {
                    const target = targetType === 'variable' ? variablesById.get(targetId)
                        : targetType === 'trigger' ? triggersById.get(targetId)
                            : eventsById.get(targetId);
                    if (!target) {
                        return `<span class="code-flow-missing">${escapeHtml(label)} → Missing ${targetType}</span>`;
                    }
                    return `<button type="button" class="code-flow-link" data-flow-target="${escapeHtml(target.id)}" data-flow-target-type="${targetType}" title="Open ${escapeHtml(target.name)}">${escapeHtml(label)} → ${escapeHtml(target.name)}${target.enabled === false ? ' (disabled)' : ''}</button>`;
                }).join('')}
            </div>
        `;
    };

    // Render a single block card
    const renderBlockCard = (block, unreachableEventIds = new Set(), timerCycleEventIds = new Set(), blockType = block?.type, executionLimitWarnings = new Map()) => {
        const isTrigger = blockType === CODE_BLOCK_TYPES.TRIGGER;
        const isVariable = blockType === CODE_BLOCK_TYPES.VARIABLE;
        let icon, iconClass;

        if (isTrigger) {
            icon = 'frame_inspect';
            iconClass = 'trigger';
        } else if (isVariable) {
            icon = 'data_object';
            iconClass = 'variable';
        } else {
            icon = 'code_blocks';
            iconClass = 'event';
        }

        const error = isTrigger ? getTriggerError(block)
            : isVariable ? getVariableError(block)
                : getEventError(block);
        const warnings = [];
        if (!error && !isTrigger && !isVariable && block.enabled !== false && unreachableEventIds.has(block.id)) {
            warnings.push('No enabled trigger or reachable event path reaches this event');
        }
        if (!error && !isTrigger && !isVariable && block.enabled !== false && timerCycleEventIds.has(block.id)) {
            warnings.push('This event is part of a timer-linked cycle; the map stops timer events after 10,000 fires');
        }
        if (!error && !isTrigger && !isVariable && block.enabled !== false && executionLimitWarnings.has(block.id)) {
            warnings.push(executionLimitWarnings.get(block.id));
        }
        const warning = warnings.length ? warnings.join('. ') : null;

        let typeDescription = '';
        if (isTrigger) {
            const triggerInfo = CODE_TRIGGER_TYPE_INFO.find(t => t.id === block.triggerType);

            switch (block.triggerType) {
                case CODE_TRIGGER_TYPES.GAME_STARTS:
                    typeDescription = 'When game starts';
                    break;
                case CODE_TRIGGER_TYPES.GAME_ENDS:
                    typeDescription = 'When the player completes the map';
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_DIES:
                    typeDescription = 'When player dies';
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_JOINS_ROOM:
                    typeDescription = 'When a player joins the room';
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_LEAVES_ROOM:
                    typeDescription = 'When a player leaves the room';
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_RESPAWNS:
                    typeDescription = 'When player respawns';
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_LANDS:
                    typeDescription = 'When player lands on a solid surface';
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_JUMPS:
                    typeDescription = 'After player successfully jumps';
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE:
                    typeDescription = error ? `⚠ ${error}` : `When player enters "${block.config?.zoneName}"`;
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_LEAVE_ZONE:
                    typeDescription = error ? `⚠ ${error}` : `When player leaves "${block.config?.zoneName}"`;
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT: {
                    const object = (getWorld()?.objects || []).find(item => item?.id === block.config?.objectId);
                    typeDescription = error
                        ? `⚠ ${error}`
                        : `When player touches "${object?.name || object?.appearanceType || 'Object'}"`;
                    break;
                }
                case CODE_TRIGGER_TYPES.PLAYER_ATTACKS_OBJECT: {
                    const object = (getWorld()?.objects || []).find(item => item?.id === block.config?.objectId);
                    typeDescription = error
                        ? `⚠ ${error}`
                        : `When an HK nail hits "${object?.name || object?.appearanceType || 'Object'}"`;
                    break;
                }
                case CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP: {
                    const tilemap = (getWorld()?.tilemaps || []).find(item => item.id === block.config?.tilemapId);
                    const behavior = {
                        any: 'any collidable cell', solid: 'solid cells', oneWay: 'one-way cells', hazard: 'damage cells'
                    }[block.config?.collisionType || 'any'] || 'tile cells';
                    typeDescription = error
                        ? `⚠ ${error}`
                        : `When player touches ${behavior} in "${tilemap?.name || 'tilemap'}"`;
                    break;
                }
                case CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT:
                    if (error) {
                        typeDescription = `⚠ ${error}`;
                    } else {
                        const keyLabels = (block.config?.keys || []).map(k => {
                            const keyObj = CODE_KEYBOARD_KEYS.find(kk => kk.id === k);
                            return keyObj?.label || k;
                        });
                        typeDescription = `Keys: ${keyLabels.join(' + ')}`;
                    }
                    break;
                case CODE_TRIGGER_TYPES.REPEAT: {
                    const unit = block.config?.unit || 'seconds';
                    const interval = block.config?.interval || 1;
                    const unitInfo = CODE_TIME_UNITS.find(u => u.id === unit);
                    const unitLabel = interval === 1 ? unitInfo?.labelSingular : unitInfo?.label;
                    typeDescription = `Every ${interval} ${unitLabel || unit}`;
                    break;
                }
                case CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT: {
                    const actionObj = getPlayerActionOptions().find(a => a.id === block.config?.action);
                    typeDescription = actionObj ? `Player: ${actionObj.label}` : 'Player action';
                    break;
                }
                case CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON:
                    typeDescription = error ? `⚠ ${error}` : `When player presses "${block.config?.buttonName}"`;
                    break;
                case CODE_TRIGGER_TYPES.PLAYER_STATS: {
                    const statObj = CODE_PLAYER_STATS.find(s => s.id === block.config?.stat);
                    typeDescription = statObj ? `${statObj.label} = "${block.config?.statValue || ''}"` : 'Player stat';
                    break;
                }
                case CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED: {
                    const direction = CODE_HEALTH_CHANGE_DIRECTIONS.find(item => item.id === block.config?.direction);
                    typeDescription = direction?.id === 'increased' ? 'When player health increases'
                        : direction?.id === 'decreased' ? 'When player health decreases'
                            : 'When player health changes';
                    break;
                }
                case CODE_TRIGGER_TYPES.VARIABLE_CONDITION: {
                    const variable = getVariables().find(v => v.id === block.config?.variableId);
                    const operator = block.config?.operator || 'equals';
                    typeDescription = variable ? `When ${variable.name} ${operator} ${block.config?.value ?? ''}` : (error || 'Variable condition');
                    break;
                }
                default:
                    typeDescription = triggerInfo?.label || 'Trigger';
            }
        } else if (isVariable) {
            const varType = block.variableType === CODE_VARIABLE_TYPES.LIST ? 'List' : 'Variable';
            const valueType = CODE_VALUE_TYPES.find(v => v.id === block.valueType)?.label || block.valueType;
            if (block.variableType === CODE_VARIABLE_TYPES.LIST) {
                const itemCount = Math.min(CODE_MAX_LIST_ITEMS, Number.isInteger(block.listLength) ? block.listLength : 0);
                typeDescription = error ? `⚠ ${error}` : `${block.scope === 'player' ? 'Player' : 'Map'} List (${itemCount} initial items)${block.persist === true ? ' · saves locally' : ''}`;
            } else {
                const scopeLabel = block.scope === 'player' ? 'Player' : 'Map';
                typeDescription = error ? `⚠ ${error}` : `${scopeLabel} · ${valueType}: ${block.defaultValue !== undefined ? block.defaultValue : 'undefined'}${block.persist === true ? ' · saves locally' : ''}`;
            }
        } else {
            const actionCount = Array.isArray(block.actions) ? block.actions.length : 0;
            typeDescription = error
                ? `⚠ ${error}`
                : warning
                    ? `⚠ ${warning}`
                    : `Event (${actionCount} ${actionCount === 1 ? 'action' : 'actions'})`;
        }
        const blockIdAttribute = escapeHtml(block.id || '');
        
        return `
            <div class="code-block-card ${block.enabled ? '' : 'disabled'} ${error ? 'has-error' : warning ? 'has-warning' : ''}" data-block-id="${blockIdAttribute}" data-block-type="${escapeHtml(blockType || 'event')}">
                <div class="code-block-header">
                    <div class="code-block-icon ${iconClass}">
                        <span class="material-symbols-outlined">${icon}</span>
                    </div>
                    <div class="code-block-name">
                        <input type="text" value="${escapeHtml(block.name)}" data-block-id="${blockIdAttribute}" class="block-name-input" spellcheck="false">
                    </div>
                </div>
                <div class="code-block-type ${error ? 'error' : warning ? 'warning' : ''}" title="${escapeHtml(typeDescription)}">${escapeHtml(typeDescription)}</div>
                ${renderFlowConnections(block, blockType)}
                <div class="code-block-actions">
                    <button class="btn btn-secondary btn-edit" data-block-id="${blockIdAttribute}">
                        <span class="material-symbols-outlined">edit</span>
                        Edit
                    </button>
                    <button class="btn btn-secondary btn-toggle" data-block-id="${blockIdAttribute}" title="${block.enabled ? 'Disable' : 'Enable'}">
                        <span class="material-symbols-outlined">${block.enabled ? 'visibility_off' : 'visibility'}</span>
                    </button>
                    <button class="btn btn-secondary btn-icon-only btn-duplicate" data-block-id="${blockIdAttribute}" title="Duplicate">
                        <span class="material-symbols-outlined">content_copy</span>
                    </button>
                    <button class="btn btn-danger btn-icon-only btn-delete" data-block-id="${blockIdAttribute}" title="Delete">
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                </div>
            </div>
        `;
    };
    
    // Attach event listeners to block cards
    const attachBlockCardListeners = () => {
        document.querySelectorAll('.code-flow-link').forEach(button => {
            button.addEventListener('click', (event) => {
                editBlock(event.currentTarget.dataset.flowTarget, event.currentTarget.dataset.flowTargetType);
            });
        });

        // Name input change
        document.querySelectorAll('.block-name-input').forEach(input => {
            input.addEventListener('blur', handleNameChange);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.target.blur();
                }
            });
        });
        
        // Edit button
        document.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const card = e.currentTarget.closest('.code-block-card');
                editBlock(e.currentTarget.dataset.blockId, card?.dataset.blockType);
            });
        });
        
        // Toggle button
        document.querySelectorAll('.btn-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const card = e.currentTarget.closest('.code-block-card');
                toggleBlock(e.currentTarget.dataset.blockId, card?.dataset.blockType);
            });
        });
        
        // Duplicate button
        document.querySelectorAll('.btn-duplicate').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const card = e.currentTarget.closest('.code-block-card');
                duplicateBlock(e.currentTarget.dataset.blockId, card?.dataset.blockType);
            });
        });
        
        // Delete button
        document.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const blockId = e.currentTarget.dataset.blockId;
                const blockType = e.currentTarget.closest('.code-block-card')?.dataset.blockType;
                const codeData = getCodeData();
                const block = findBlock(codeData, blockId, blockType);
                const resolvedType = resolveBlockType(codeData, block, blockType);
                const references = getBlockReferenceSummary(codeData, block, resolvedType);
                const pythonVariableNote = resolvedType === CODE_BLOCK_TYPES.VARIABLE
                    ? ' Check Python Event scripts manually for references by variable name.'
                    : '';
                const referenceWarning = references.length
                    ? ` It has ${references.length} explicit link${references.length === 1 ? '' : 's'} from ${references.slice(0, 3).join(', ')}${references.length > 3 ? `, and ${references.length - 3} more` : ''}. Those links will remain and the affected flow may need repair.${pythonVariableNote}`
                    : '';
                const confirmed = await showConfirm('Delete Block', `Are you sure you want to delete "${block?.name || 'this block'}"?${referenceWarning}`);
                if (confirmed) {
                    deleteBlock(blockId, blockType);
                }
            });
        });
    };
    
    // Handle name change
    const handleNameChange = (e) => {
        const blockId = e.target.dataset.blockId;
        const blockType = e.target.closest('.code-block-card')?.dataset.blockType;
        const newName = e.target.value.trim();
        
        if (!isValidName(newName)) {
            showToast('Cannot use reserved names: ' + CODE_RESERVED_NAMES.join(', '), 'error');
            showDashboard();
            return;
        }
        
        if (!newName) {
            showDashboard();
            return;
        }
        
        const codeData = getCodeData();
        const block = findBlock(codeData, blockId, blockType);
        if (block && block.name !== newName) {
            block.name = newName;
            saveCodeData(codeData);
            showToast('Renamed successfully', 'success');
        }
    };
    
    const getBlockList = (codeData, blockType) =>
        blockType === CODE_BLOCK_TYPES.TRIGGER ? codeData.triggers
            : blockType === CODE_BLOCK_TYPES.VARIABLE ? codeData.variables
                : blockType === CODE_BLOCK_TYPES.EVENT ? codeData.events : null;

    const getBlockReferenceSummary = (codeData, block, blockType) => {
        if (!block?.id) return [];
        const references = [];
        const addReference = label => references.push(label);
        if (blockType === CODE_BLOCK_TYPES.EVENT) {
            for (const trigger of codeData.triggers || []) {
                if ([trigger.config?.eventId, trigger.config?.actionId].includes(block.id)) {
                    addReference(`Trigger “${trigger.name || 'Untitled'}”`);
                }
            }
            for (const event of codeData.events || []) {
                for (const action of Array.isArray(event.actions) ? event.actions : []) {
                    const linkedIds = [action?.eventId, action?.defeatedEventId, action?.trueEventId, action?.falseEventId, action?.cancelEventId];
                    if (Array.isArray(action?.choices)) linkedIds.push(...action.choices.map(choice => choice?.eventId));
                    const matchingLinks = linkedIds.filter(id => id === block.id).length;
                    for (let index = 0; index < matchingLinks; index++) addReference(`Event “${event.name || 'Untitled'}”`);
                }
            }
        } else if (blockType === CODE_BLOCK_TYPES.TRIGGER) {
            for (const event of codeData.events || []) {
                for (const action of Array.isArray(event.actions) ? event.actions : []) {
                    if (action?.type === 'setTriggerEnabled' && action.triggerId === block.id) {
                        addReference(`Event “${event.name || 'Untitled'}”`);
                    }
                }
            }
        } else if (blockType === CODE_BLOCK_TYPES.VARIABLE) {
            for (const trigger of codeData.triggers || []) {
                if (trigger.config?.variableId === block.id) addReference(`Trigger “${trigger.name || 'Untitled'}”`);
            }
            for (const event of codeData.events || []) {
                for (const action of Array.isArray(event.actions) ? event.actions : []) {
                    for (const key of ['variableId', 'playerVariableId']) {
                        if (action?.[key] === block.id) addReference(`Event “${event.name || 'Untitled'}”`);
                    }
                }
            }
            for (const variable of codeData.variables || []) {
                const linkedItems = (Array.isArray(variable.listItems) ? variable.listItems : [])
                    .filter(item => item?.valueType === 'variable' && item.value === block.id).length;
                for (let index = 0; index < linkedItems; index++) addReference(`List “${variable.name || 'Untitled'}”`);
            }
        }
        return references;
    };

    const findBlock = (codeData, blockId, blockType) => {
        const list = getBlockList(codeData, blockType);
        return (list || [...codeData.triggers, ...codeData.events, ...codeData.variables])
            .find(block => String(block?.id ?? '') === String(blockId ?? ''));
    };

    const resolveBlockType = (codeData, block, requestedType) => {
        if (getBlockList(codeData, requestedType)) return requestedType;
        if (block?.type === CODE_BLOCK_TYPES.TRIGGER || block?.type === CODE_BLOCK_TYPES.VARIABLE || block?.type === CODE_BLOCK_TYPES.EVENT) {
            return block.type;
        }
        if (codeData.triggers.includes(block)) return CODE_BLOCK_TYPES.TRIGGER;
        if (codeData.variables.includes(block)) return CODE_BLOCK_TYPES.VARIABLE;
        return CODE_BLOCK_TYPES.EVENT;
    };

    // Edit a block by category as well as id; malformed imports can reuse ids across categories.
    const editBlock = (blockId, blockType) => {
        const codeData = getCodeData();
        const block = findBlock(codeData, blockId, blockType);
        if (!block) return;
        const type = resolveBlockType(codeData, block, blockType);
        editingBlock = block;

        if (type === CODE_BLOCK_TYPES.TRIGGER) showTriggerEditor(block);
        else if (type === CODE_BLOCK_TYPES.VARIABLE) showVariableEditor(block);
        else showEventEditor(block);
    };

    // Toggle block enabled/disabled
    const toggleBlock = (blockId, blockType) => {
        const codeData = getCodeData();
        const block = findBlock(codeData, blockId, blockType);
        if (block) {
            block.enabled = !block.enabled;
            saveCodeData(codeData);
            showToast(block.enabled ? 'Enabled' : 'Disabled', 'info');
            showDashboard();
        }
    };

    // Duplicate a block
    const duplicateBlock = (blockId, blockType) => {
        const codeData = getCodeData();
        const block = findBlock(codeData, blockId, blockType);
        if (!block) return;

        const type = resolveBlockType(codeData, block, blockType);
        const newBlock = JSON.parse(JSON.stringify(block));
        newBlock.id = generateId();
        newBlock.name = `${block.name || type} (Copy)`;
        getBlockList(codeData, type).push(newBlock);

        saveCodeData(codeData);
        showToast('Duplicated', 'success');
        showDashboard();
    };

    // Delete only the selected category's record so an ID collision cannot erase unrelated blocks.
    const deleteBlock = (blockId, blockType) => {
        const codeData = getCodeData();
        const type = resolveBlockType(codeData, findBlock(codeData, blockId, blockType), blockType);
        const list = getBlockList(codeData, type);
        if (!list) return;
        const next = list.filter(block => String(block?.id ?? '') !== String(blockId ?? ''));
        if (next.length === list.length) return;
        if (type === CODE_BLOCK_TYPES.TRIGGER) codeData.triggers = next;
        else if (type === CODE_BLOCK_TYPES.VARIABLE) codeData.variables = next;
        else codeData.events = next;

        saveCodeData(codeData);
        showToast('Deleted', 'info');
        showDashboard();
    };

    // Build complete, linked starter mechanics. Each installation gets fresh ids so
    // repeated use stays additive and never overwrites a creator's existing blocks.
    const createMechanicsTemplate = (templateId, options = {}) => {
        if (templateId === 'player-inventory') {
            const buttons = getUniquelyNamedButtons();
            if (options.buttonName && !buttons.some(button => button.name === options.buttonName)) return null;
            const pickupObject = options.pickupObjectId
                ? getInventoryPickupObjects().find(object => object.id === options.pickupObjectId)
                : null;
            if (options.pickupObjectId && !pickupObject) return null;
            const listId = generateId();
            const openEventId = generateId();
            const list = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                id: listId,
                name: 'Inventory',
                variableType: CODE_VARIABLE_TYPES.LIST,
                scope: 'player',
                persist: options.persist === true,
                valueType: 'string',
                defaultValue: '',
                listLength: 0,
                listItems: []
            };
            const openEvent = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                id: openEventId,
                name: 'Open Inventory',
                actions: [{ type: 'showList', variableId: listId, title: 'Inventory' }]
            };
            const triggers = [{
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                id: generateId(),
                name: 'Open Inventory With I',
                triggerType: CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT,
                config: { keys: ['KeyI'], eventId: openEventId }
            }];
            const events = [openEvent];
            if (options.buttonName) {
                triggers.push({
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Open Inventory Button',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON,
                    config: { buttonName: options.buttonName, eventId: openEventId }
                });
            }
            if (pickupObject) {
                const pickupEventId = generateId();
                triggers.push({
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: `Collect ${pickupObject.label}`,
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT,
                    config: { objectId: pickupObject.id, shape: 'box', eventId: pickupEventId }
                });
                events.push({
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: pickupEventId,
                    name: `Add ${pickupObject.label} To Inventory`,
                    actions: [
                        { type: 'appendListItem', variableId: listId, valueType: 'string', value: pickupObject.label, playerTarget: 'triggering' },
                        { type: 'setObjectEnabled', objectId: pickupObject.id, enabled: false, persist: options.persist === true }
                    ]
                });
            }
            return { triggers, events, variables: [list] };
        }

        if (templateId === 'hk-enemy') {
            const object = (getWorld()?.objects || []).find(item => item?.id === options.objectId &&
                item._mechanicsEnabled !== false && item._collected !== true);
            const maxHealth = Number(options.maxHealth);
            const damage = Number(options.damage);
            const patrolDistance = Number(options.patrolDistance ?? 0);
            const patrolDuration = Number(options.patrolDuration ?? 2);
            const contactDamage = Number(options.contactDamage ?? 0);
            const objectX = Number(object?.x);
            const objectY = Number(object?.y);
            if (!object || !Number.isSafeInteger(maxHealth) || maxHealth < 1 || maxHealth > 99999 ||
                !Number.isSafeInteger(damage) || damage < 1 || damage > 99999 ||
                !Number.isSafeInteger(patrolDistance) || patrolDistance < 0 || patrolDistance > 10000 ||
                !Number.isFinite(patrolDuration) || patrolDuration < 0.1 || patrolDuration > 60 ||
                !Number.isSafeInteger(contactDamage) || contactDamage < 0 || contactDamage > 99999 ||
                (patrolDistance > 0 && (!Number.isFinite(objectX) || !Number.isFinite(objectY) ||
                    Math.abs(objectX - patrolDistance) > 10000000 || Math.abs(objectX + patrolDistance) > 10000000 ||
                    Math.abs(objectY) > 10000000))) return null;
            const label = String(object.name || object.displayName || object.appearanceType || 'Enemy').trim().slice(0, 64) || 'Enemy';
            const initializeEventId = generateId();
            const damageEventId = generateId();
            const defeatedEventId = generateId();
            const patrolEventIds = patrolDistance > 0 ? [generateId(), generateId()] : [];
            const patrolTimerName = `enemy-patrol-${generateId().slice(-8)}`;
            const contactDamageEventId = contactDamage > 0 ? generateId() : null;
            const triggers = [{
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                id: generateId(),
                name: `${label} Starts`.slice(0, 80),
                triggerType: CODE_TRIGGER_TYPES.GAME_STARTS,
                config: { eventId: initializeEventId }
            }, {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                id: generateId(),
                name: `Hit ${label}`.slice(0, 80),
                triggerType: CODE_TRIGGER_TYPES.PLAYER_ATTACKS_OBJECT,
                config: { objectId: object.id, eventId: damageEventId }
            }];
            const events = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: initializeEventId,
                    name: `Initialize ${label}`.slice(0, 80),
                    actions: [
                        { type: 'setObjectHealth', objectId: object.id, targetMode: 'fixed', health: maxHealth, maxHealth },
                        ...(patrolDistance > 0 ? [{ type: 'runEvent', eventId: patrolEventIds[0] }] : [])
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: damageEventId,
                    name: `Damage ${label}`.slice(0, 80),
                    actions: [{
                        type: 'damageObject', targetMode: 'touched', amount: damage,
                        maxHealth, defeatedEventId
                    }]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: defeatedEventId,
                    name: `${label} Defeated`.slice(0, 80),
                    actions: [
                        ...(patrolDistance > 0 ? [{ type: 'stopTimer', timerName: patrolTimerName }] : []),
                        { type: 'showMessage', text: `${label} defeated!`, duration: 2.5 }
                    ]
                }
            ];
            if (patrolDistance > 0) {
                const patrolTargets = [objectX + patrolDistance, objectX - patrolDistance];
                events.push(...patrolEventIds.map((eventId, index) => ({
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: eventId,
                    name: `${label} Patrol ${index === 0 ? 'Right' : 'Left'}`.slice(0, 80),
                    actions: [
                        { type: 'moveObject', objectId: object.id, x: patrolTargets[index], y: objectY, duration: patrolDuration, easing: 'linear' },
                        {
                            type: 'startTimer', timerName: patrolTimerName, seconds: patrolDuration,
                            eventId: patrolEventIds[1 - index], repeat: false, repeatCount: 1
                        }
                    ]
                })));
            }
            if (contactDamageEventId) {
                triggers.push({
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: `${label} Contact`.slice(0, 80),
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT,
                    config: { objectId: object.id, shape: 'box', eventId: contactDamageEventId }
                });
                events.push({
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: contactDamageEventId,
                    name: `${label} Contact Damage`.slice(0, 80),
                    actions: [{ type: 'damagePlayer', amount: contactDamage }]
                });
            }
            return {
                triggers,
                events
            };
        }

        if (templateId === 'timed-round') {
            const variableId = generateId();
            const startEventId = generateId();
            const endEventId = generateId();
            const timerName = `round-end-${generateId().slice(-6)}`;
            const variable = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                id: variableId,
                name: 'Round Active',
                valueType: 'boolean',
                defaultValue: false,
                scope: 'map'
            };
            const startEvent = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                id: startEventId,
                name: 'Start Timed Round',
                actions: [
                    { type: 'setVariable', variableId, value: true },
                    { type: 'showMessage', text: 'Round started! You have 60 seconds.', duration: 3 },
                    { type: 'startTimer', timerName, seconds: 60, eventId: endEventId, repeat: false, repeatCount: 1 }
                ]
            };
            const endEvent = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                id: endEventId,
                name: 'End Timed Round',
                actions: [
                    { type: 'setVariable', variableId, value: false },
                    { type: 'showMessage', text: 'Time is up!', duration: 4 }
                ]
            };
            const trigger = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                id: generateId(),
                name: 'Begin Round When Game Starts',
                config: { eventId: startEventId }
            };
            return { triggers: [trigger], events: [startEvent, endEvent], variables: [variable] };
        }

        if (templateId === 'checkpoint-zone') {
            const zoneExists = getZones().some(zone => zone.name === options.zoneName);
            const checkpointExists = (getWorld()?.objects || []).some(object =>
                object.id === options.checkpointId && object.actingType === 'checkpoint');
            if (!zoneExists || !checkpointExists) return null;
            const eventId = generateId();
            const trigger = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                id: generateId(),
                name: 'Enter Checkpoint Zone',
                triggerType: CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE,
                config: { zoneName: options.zoneName, eventId }
            };
            const event = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                id: eventId,
                name: 'Activate Checkpoint',
                actions: [
                    { type: 'setCheckpoint', objectId: options.checkpointId },
                    { type: 'showMessage', text: 'Checkpoint set!', duration: 2 }
                ]
            };
            return { triggers: [trigger], events: [event], variables: [] };
        }

        if (templateId === 'save-point') {
            const buttonExists = getUniquelyNamedButtons().some(button => button.name === options.buttonName);
            const checkpointExists = (getWorld()?.objects || []).some(object =>
                object.id === options.checkpointId && object.actingType === 'checkpoint' && object._mechanicsEnabled !== false);
            if (!buttonExists || !checkpointExists) return null;
            const eventId = generateId();
            const trigger = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                id: generateId(),
                name: 'Press Save Point Button',
                triggerType: CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON,
                config: { buttonName: options.buttonName, eventId }
            };
            const event = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                id: eventId,
                name: 'Activate Save Point',
                actions: [
                    { type: 'setCheckpoint', objectId: options.checkpointId },
                    { type: 'showMessage', text: 'Checkpoint activated.', duration: 2 }
                ]
            };
            return { triggers: [trigger], events: [event], variables: [] };
        }

        if (templateId === 'pause-menu') {
            if (hasEscapeMenuFlow()) return null;
            const buttonExists = !options.buttonName || getUniquelyNamedButtons()
                .some(button => button.name === options.buttonName);
            if (!buttonExists) return null;
            const menuEventId = generateId();
            const resumeEventId = generateId();
            const restartEventId = generateId();
            const triggers = [{
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                id: generateId(),
                name: 'Open Pause Menu With Escape',
                triggerType: CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT,
                config: { keys: ['Escape'], eventId: menuEventId }
            }];
            if (options.buttonName) {
                triggers.push({
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Open Pause Menu Button',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON,
                    config: { buttonName: options.buttonName, eventId: menuEventId }
                });
            }
            return {
                triggers,
                events: [
                    {
                        ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                        id: menuEventId,
                        name: 'Pause Menu',
                        actions: [{
                            type: 'showMenu',
                            title: 'Paused',
                            pauseWorld: true,
                            choices: [
                                { label: 'Resume', eventId: resumeEventId },
                                { label: 'Restart', eventId: restartEventId }
                            ]
                        }]
                    },
                    { ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)), id: resumeEventId, name: 'Resume Game', actions: [] },
                    { ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)), id: restartEventId, name: 'Restart Scene', actions: [{ type: 'restartScene' }] }
                ],
                variables: []
            };
        }

        if (templateId === 'title-menu') {
            if (hasGameStartsMenuFlow()) return null;
            const menuEventId = generateId();
            const startEventId = generateId();
            const trigger = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                id: generateId(),
                name: 'Show Title Menu At Game Start',
                triggerType: CODE_TRIGGER_TYPES.GAME_STARTS,
                config: { eventId: menuEventId }
            };
            return {
                triggers: [trigger],
                events: [
                    {
                        ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                        id: menuEventId,
                        name: 'Title Menu',
                        actions: [{
                            type: 'showMenu',
                            title: 'Welcome',
                            pauseWorld: true,
                            choices: [{ label: 'Start', eventId: startEventId }]
                        }]
                    },
                    { ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)), id: startEventId, name: 'Start Game', actions: [] }
                ],
                variables: []
            };
        }

        if (templateId === 'timed-course') {
            const zoneNames = new Set(getZones().map(zone => zone.name));
            if (!options.startZone || !options.finishZone || options.startZone === options.finishZone ||
                !zoneNames.has(options.startZone) || !zoneNames.has(options.finishZone)) return null;

            const activeVariableId = generateId();
            const checkStartEventId = generateId();
            const beginEventId = generateId();
            const checkFinishEventId = generateId();
            const completeEventId = generateId();
            const checkTimeoutEventId = generateId();
            const timeoutEventId = generateId();
            const timerName = `course-end-${generateId().slice(-6)}`;
            const activeVariable = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                id: activeVariableId,
                name: 'Course Active',
                valueType: 'boolean',
                defaultValue: false,
                scope: 'map'
            };
            const events = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: checkStartEventId,
                    name: 'Check Course Start',
                    actions: [
                        { type: 'branchVariable', variableId: activeVariableId, operator: 'equals', value: false, trueEventId: beginEventId }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: beginEventId,
                    name: 'Start Timed Course',
                    actions: [
                        { type: 'setVariable', variableId: activeVariableId, value: true },
                        { type: 'showMessage', text: 'Course started! Reach the finish before time runs out.', duration: 4 },
                        { type: 'startTimer', timerName, seconds: 120, eventId: checkTimeoutEventId, repeat: false, repeatCount: 1 }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: checkFinishEventId,
                    name: 'Check Course Finish',
                    actions: [
                        { type: 'branchVariable', variableId: activeVariableId, operator: 'equals', value: true, trueEventId: completeEventId }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: completeEventId,
                    name: 'Complete Timed Course',
                    actions: [
                        { type: 'setVariable', variableId: activeVariableId, value: false },
                        { type: 'stopTimer', timerName },
                        { type: 'showMessage', text: 'Course complete!', duration: 4 }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: checkTimeoutEventId,
                    name: 'Check Course Timeout',
                    actions: [
                        { type: 'branchVariable', variableId: activeVariableId, operator: 'equals', value: true, trueEventId: timeoutEventId }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: timeoutEventId,
                    name: 'End Timed Course',
                    actions: [
                        { type: 'setVariable', variableId: activeVariableId, value: false },
                        { type: 'showMessage', text: 'Course time is up!', duration: 4 }
                    ]
                }
            ];
            const triggers = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Enter Course Start Zone',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE,
                    config: { zoneName: options.startZone, eventId: checkStartEventId }
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Enter Course Finish Zone',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE,
                    config: { zoneName: options.finishZone, eventId: checkFinishEventId }
                }
            ];
            return { triggers, events, variables: [activeVariable] };
        }

        if (templateId === 'switch-door') {
            const matchingButtons = getButtons().filter(button => button.name === options.buttonName);
            const targetObject = getWorld()?.objects?.find(object => object.id === options.objectId && object.appearanceType !== 'button');
            if (matchingButtons.length !== 1 || !targetObject) return null;

            const openVariableId = generateId();
            const resetEventId = generateId();
            const checkSwitchEventId = generateId();
            const openEventId = generateId();
            const closeEventId = generateId();
            const openVariable = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                id: openVariableId,
                name: 'Door Open',
                valueType: 'boolean',
                defaultValue: false,
                scope: 'map'
            };
            const triggers = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Reset Switch And Door',
                    config: { eventId: resetEventId }
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Press Switch',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON,
                    config: { buttonName: options.buttonName, eventId: checkSwitchEventId }
                }
            ];
            const events = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: resetEventId,
                    name: 'Reset Door To Closed',
                    actions: [
                        { type: 'setVariable', variableId: openVariableId, value: false },
                        { type: 'setObjectEnabled', objectId: options.objectId, enabled: true }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: checkSwitchEventId,
                    name: 'Toggle Door',
                    actions: [
                        { type: 'branchVariable', variableId: openVariableId, operator: 'equals', value: true, trueEventId: closeEventId, falseEventId: openEventId }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: openEventId,
                    name: 'Open Door',
                    actions: [
                        { type: 'setVariable', variableId: openVariableId, value: true },
                        { type: 'setObjectEnabled', objectId: options.objectId, enabled: false },
                        { type: 'playSound', soundName: 'button' },
                        { type: 'showMessage', text: 'Door opened.', duration: 2 }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: closeEventId,
                    name: 'Close Door',
                    actions: [
                        { type: 'setVariable', variableId: openVariableId, value: false },
                        { type: 'setObjectEnabled', objectId: options.objectId, enabled: true },
                        { type: 'playSound', soundName: 'button' },
                        { type: 'showMessage', text: 'Door closed.', duration: 2 }
                    ]
                }
            ];
            return { triggers, events, variables: [openVariable] };
        }

        if (templateId === 'tag-game') {
            const itVariableId = generateId();
            const startEventId = generateId();
            const assignHostEventId = generateId();
            const checkTagEventId = generateId();
            const transferTagEventId = generateId();
            const itVariable = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                id: itVariableId,
                name: 'Is It',
                valueType: 'boolean',
                defaultValue: false,
                scope: 'player'
            };
            const events = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: startEventId,
                    name: 'Reset Tag Round',
                    actions: [
                        { type: 'setVariable', variableId: itVariableId, value: false, playerTarget: 'all' },
                        { type: 'showMessage', text: 'Tag round started. The host is IT.', duration: 4 }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: assignHostEventId,
                    name: 'Make Host It',
                    actions: [
                        { type: 'setVariable', variableId: itVariableId, value: true, playerTarget: 'triggering' },
                        { type: 'showMessage', text: 'You are IT! Touch another player to pass it.', duration: 4 }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: checkTagEventId,
                    name: 'Check Tagger',
                    actions: [
                        { type: 'branchVariable', variableId: itVariableId, operator: 'equals', value: true, trueEventId: transferTagEventId }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: transferTagEventId,
                    name: 'Pass Tag',
                    actions: [
                        { type: 'setVariable', variableId: itVariableId, value: false, playerTarget: 'triggering' },
                        { type: 'setVariable', variableId: itVariableId, value: true, playerTarget: 'touched' },
                        { type: 'showMessage', text: 'Tag! The touched player is now IT.', duration: 3 }
                    ]
                }
            ];
            const triggers = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Reset Tag Round On Start',
                    config: { eventId: startEventId }
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Host Starts As It',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_STATS,
                    config: { stat: 'hostOrGuest', statValue: 'host', eventId: assignHostEventId }
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Touch Another Player',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT,
                    config: { action: 'touchOtherPlayer', eventId: checkTagEventId }
                }
            ];
            return { triggers, events, variables: [itVariable] };
        }

        if (templateId === 'hide-and-seek') {
            const roleVariableId = generateId();
            const foundVariableId = generateId();
            const roundCompleteVariableId = generateId();
            const resetEventId = generateId();
            const assignSeekerEventId = generateId();
            const checkSeekerEventId = generateId();
            const checkHiderEventId = generateId();
            const markFoundEventId = generateId();
            const completeRoundEventId = generateId();
            const announceVictoryEventId = generateId();
            const roleVariable = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                id: roleVariableId,
                name: 'Hide And Seek Role',
                valueType: 'string',
                defaultValue: 'hider',
                scope: 'player'
            };
            const foundVariable = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                id: foundVariableId,
                name: 'Hiders Found',
                valueType: 'integer',
                defaultValue: 0,
                scope: 'map'
            };
            const roundCompleteVariable = {
                ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                id: roundCompleteVariableId,
                name: 'Hide And Seek Round Complete',
                valueType: 'boolean',
                defaultValue: false,
                scope: 'map'
            };
            const events = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: resetEventId,
                    name: 'Reset Hide And Seek Round',
                    actions: [
                        { type: 'setVariable', variableId: roleVariableId, value: 'hider', playerTarget: 'all' },
                        { type: 'setVariable', variableId: foundVariableId, value: 0 },
                        { type: 'setVariable', variableId: roundCompleteVariableId, value: false },
                        { type: 'showMessage', text: 'Hide and seek started. The host is the seeker.', duration: 4 }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: assignSeekerEventId,
                    name: 'Make Host The Seeker',
                    actions: [
                        { type: 'setVariable', variableId: roleVariableId, value: 'seeker', playerTarget: 'triggering' },
                        { type: 'showMessage', text: 'You are the seeker. Find the hiders!', duration: 4 }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: checkSeekerEventId,
                    name: 'Check Seeker Role',
                    actions: [
                        { type: 'branchVariable', variableId: roleVariableId, operator: 'equals', value: 'seeker', playerTarget: 'triggering', trueEventId: checkHiderEventId }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: checkHiderEventId,
                    name: 'Check Touched Player Role',
                    actions: [
                        { type: 'branchVariable', variableId: roleVariableId, operator: 'equals', value: 'hider', playerTarget: 'touched', trueEventId: markFoundEventId }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: markFoundEventId,
                    name: 'Mark Hider Found',
                    actions: [
                        { type: 'setVariable', variableId: roleVariableId, value: 'found', playerTarget: 'touched' },
                        { type: 'addVariable', variableId: foundVariableId, amount: 1 },
                        { type: 'branchPlayerCount', playerVariableId: roleVariableId, filterOperator: 'equals', filterValue: 'hider', operator: 'equals', count: 0, trueEventId: completeRoundEventId },
                        { type: 'showMessage', text: 'Hider found!', duration: 3 }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: completeRoundEventId,
                    name: 'Complete Hide And Seek Round',
                    actions: [
                        { type: 'setVariable', variableId: roundCompleteVariableId, value: true }
                    ]
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: announceVictoryEventId,
                    name: 'Announce Seeker Victory',
                    actions: [
                        { type: 'showMessage', text: 'The seeker found every hider!', duration: 4 }
                    ]
                }
            ];
            const triggers = [
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Reset Hide And Seek On Start',
                    config: { eventId: resetEventId }
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Host Starts As Seeker',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_STATS,
                    config: { stat: 'hostOrGuest', statValue: 'host', eventId: assignSeekerEventId }
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Touch A Player',
                    triggerType: CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT,
                    config: { action: 'touchOtherPlayer', eventId: checkSeekerEventId }
                },
                {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: 'Announce Hide And Seek Winner',
                    triggerType: CODE_TRIGGER_TYPES.VARIABLE_CONDITION,
                    config: { variableId: roundCompleteVariableId, operator: 'equals', value: true, eventId: announceVictoryEventId }
                }
            ];
            return { triggers, events, variables: [roleVariable, foundVariable, roundCompleteVariable] };
        }

        return null;
    };

    const installMechanicsTemplate = (template) => {
        if (!template) return false;
        const codeData = getCodeData();
        const existingNames = new Set([...codeData.triggers, ...codeData.events, ...codeData.variables]
            .map(block => String(block?.name || '').toLowerCase()));
        for (const block of [...template.triggers, ...template.events, ...template.variables]) {
            const baseName = block.name;
            let name = baseName;
            let suffix = 2;
            while (existingNames.has(name.toLowerCase())) name = `${baseName} (${suffix++})`;
            block.name = name;
            existingNames.add(name.toLowerCase());
        }
        codeData.triggers.push(...template.triggers);
        codeData.events.push(...template.events);
        codeData.variables.push(...template.variables);
        saveCodeData(codeData);
        showToast('Template added. Edit its values and timings to fit your map.', 'success');
        showDashboard();
        return true;
    };

    const showTimedCourseTemplateSetup = () => {
        const zoneNames = [...new Set(getZones().map(zone => zone.name).filter(Boolean))];
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        const zoneOptions = `<option value="">Select a zone...</option>${zoneNames.map(name =>
            `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
        dialog.innerHTML = `
            <div class="code-dialog" role="dialog" aria-modal="true" aria-labelledby="timed-course-title">
                <h2 id="timed-course-title">Set Up Timed Course</h2>
                <p class="trigger-description">Choose two different named zones. The first starts a shared 120-second course timer; the second finishes it.</p>
                ${zoneNames.length < 2 ? '<p class="trigger-description error">Add at least two named Zone objects to this map before adding this template.</p>' : `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label" for="course-start-zone">Start zone</label>
                        <select class="trigger-form-select" id="course-start-zone">${zoneOptions}</select>
                    </div>
                    <div class="trigger-form-group">
                        <label class="trigger-form-label" for="course-finish-zone">Finish zone</label>
                        <select class="trigger-form-select" id="course-finish-zone">${zoneOptions}</select>
                    </div>
                    <p class="trigger-description error" id="course-zone-error" role="alert" style="display:none">Choose two different zones.</p>
                `}
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="timed-course-cancel">Cancel</button>
                    <button class="btn btn-primary" id="timed-course-add" ${zoneNames.length < 2 ? 'disabled' : ''}>Add Course</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        const close = () => dialog.remove();
        dialog.querySelector('#timed-course-cancel').addEventListener('click', close);
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        dialog.querySelector('#timed-course-add').addEventListener('click', () => {
            const startZone = dialog.querySelector('#course-start-zone')?.value;
            const finishZone = dialog.querySelector('#course-finish-zone')?.value;
            const error = dialog.querySelector('#course-zone-error');
            if (!startZone || !finishZone || startZone === finishZone) {
                if (error) error.style.display = '';
                return;
            }
            const template = createMechanicsTemplate('timed-course', { startZone, finishZone });
            if (!template) {
                showToast('Those zones are no longer available. Reopen the template setup.', 'error');
                close();
                return;
            }
            close();
            installMechanicsTemplate(template);
        });
        dialog.querySelector('#course-start-zone')?.focus();
    };

    const showSwitchDoorTemplateSetup = () => {
        const buttonCounts = new Map();
        for (const button of getButtons()) {
            if (button.name) buttonCounts.set(button.name, (buttonCounts.get(button.name) || 0) + 1);
        }
        const buttons = getButtons().filter(button => button.name && buttonCounts.get(button.name) === 1);
        const objects = (getWorld()?.objects || []).filter(object => object?.id && object.appearanceType !== 'button');
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        const buttonOptions = `<option value="">Select a button...</option>${buttons.map(button =>
            `<option value="${escapeHtml(button.name)}">${escapeHtml(button.displayName || button.name)}</option>`).join('')}`;
        const objectOptions = `<option value="">Select an object...</option>${objects.map(object => {
            const label = `${object.name || object.displayName || object.appearanceType || 'Object'} · ${String(object.id).slice(-8)}`;
            return `<option value="${escapeHtml(object.id)}">${escapeHtml(label)}</option>`;
        }).join('')}`;
        dialog.innerHTML = `
            <div class="code-dialog" role="dialog" aria-modal="true" aria-labelledby="switch-door-title">
                <h2 id="switch-door-title">Set Up Switch And Door</h2>
                <p class="trigger-description">Bind a unique Button and a map object. The object starts enabled, then the button toggles it open and closed.</p>
                ${!buttons.length || !objects.length ? `<p class="trigger-description error">${!buttons.length ? 'Add a uniquely named Button' : ''}${!buttons.length && !objects.length ? ' and ' : ''}${!objects.length ? 'add a target object' : ''} to this map first, then reopen this template.</p>` : `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label" for="switch-door-button">Button</label>
                        <select class="trigger-form-select" id="switch-door-button">${buttonOptions}</select>
                    </div>
                    <div class="trigger-form-group">
                        <label class="trigger-form-label" for="switch-door-object">Object to toggle</label>
                        <select class="trigger-form-select" id="switch-door-object">${objectOptions}</select>
                    </div>
                    <p class="trigger-description error" id="switch-door-error" role="alert" style="display:none">Choose both the button and target object.</p>
                `}
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="switch-door-cancel">Cancel</button>
                    <button class="btn btn-primary" id="switch-door-add" ${!buttons.length || !objects.length ? 'disabled' : ''}>Add Switch</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        const close = () => dialog.remove();
        dialog.querySelector('#switch-door-cancel').addEventListener('click', close);
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        dialog.querySelector('#switch-door-add').addEventListener('click', () => {
            const buttonName = dialog.querySelector('#switch-door-button')?.value;
            const objectId = dialog.querySelector('#switch-door-object')?.value;
            if (!buttonName || !objectId) {
                const error = dialog.querySelector('#switch-door-error');
                if (error) error.style.display = '';
                return;
            }
            const template = createMechanicsTemplate('switch-door', { buttonName, objectId });
            if (!template) {
                showToast('The selected button or object is no longer available.', 'error');
                close();
                return;
            }
            close();
            installMechanicsTemplate(template);
        });
        dialog.querySelector('#switch-door-button')?.focus();
    };

    const showCheckpointTemplateSetup = () => {
        const zoneNames = [...new Set(getZones().map(zone => zone.name).filter(Boolean))];
        const checkpoints = (getWorld()?.objects || []).filter(object =>
            object?.id && object.actingType === 'checkpoint' && object._mechanicsEnabled !== false);
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        const zoneOptions = `<option value="">Select a zone...</option>${zoneNames.map(name =>
            `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
        const checkpointOptions = `<option value="">Select a checkpoint...</option>${checkpoints.map(checkpoint => {
            const label = `${checkpoint.name || 'Checkpoint'} · (${Math.round(checkpoint.x)}, ${Math.round(checkpoint.y)})`;
            return `<option value="${escapeHtml(checkpoint.id)}">${escapeHtml(label)}</option>`;
        }).join('')}`;
        const unavailable = !zoneNames.length || !checkpoints.length;
        dialog.innerHTML = `
            <div class="code-dialog" role="dialog" aria-modal="true" aria-labelledby="checkpoint-template-title">
                <h2 id="checkpoint-template-title">Set Up Checkpoint Zone</h2>
                <p class="trigger-description">Choose a zone and a Checkpoint object. Entering the zone sets that checkpoint as the triggering player's respawn point.</p>
                ${unavailable ? `<p class="trigger-description error">${!zoneNames.length ? 'Add a named Zone' : ''}${!zoneNames.length && !checkpoints.length ? ' and ' : ''}${!checkpoints.length ? 'add a Checkpoint object' : ''} to this map first, then reopen this template.</p>` : `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label" for="checkpoint-zone-name">Zone</label>
                        <select class="trigger-form-select" id="checkpoint-zone-name">${zoneOptions}</select>
                    </div>
                    <div class="trigger-form-group">
                        <label class="trigger-form-label" for="checkpoint-object-id">Checkpoint object</label>
                        <select class="trigger-form-select" id="checkpoint-object-id">${checkpointOptions}</select>
                    </div>
                    <p class="trigger-description error" id="checkpoint-template-error" role="alert" style="display:none">Choose both a zone and a checkpoint.</p>
                `}
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="checkpoint-template-cancel">Cancel</button>
                    <button class="btn btn-primary" id="checkpoint-template-add" ${unavailable ? 'disabled' : ''}>Add Checkpoint Flow</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        const close = () => dialog.remove();
        dialog.querySelector('#checkpoint-template-cancel').addEventListener('click', close);
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        dialog.querySelector('#checkpoint-template-add').addEventListener('click', () => {
            const zoneName = dialog.querySelector('#checkpoint-zone-name')?.value;
            const checkpointId = dialog.querySelector('#checkpoint-object-id')?.value;
            if (!zoneName || !checkpointId) {
                const error = dialog.querySelector('#checkpoint-template-error');
                if (error) error.style.display = '';
                return;
            }
            const template = createMechanicsTemplate('checkpoint-zone', { zoneName, checkpointId });
            if (!template) {
                showToast('The selected zone or checkpoint is no longer available.', 'error');
                close();
                return;
            }
            close();
            installMechanicsTemplate(template);
        });
        dialog.querySelector('#checkpoint-zone-name')?.focus();
    };

    const showPauseMenuTemplateSetup = () => {
        const buttons = getUniquelyNamedButtons();
        const buttonOptions = `<option value="">Escape key only</option>${buttons.map(button => {
            const label = button.displayName || button.name;
            return `<option value="${escapeHtml(button.name)}">${escapeHtml(label)}</option>`;
        }).join('')}`;
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        dialog.innerHTML = `
            <div class="code-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-menu-template-title">
                <h2 id="pause-menu-template-title">Set Up Pause Menu</h2>
                <p class="trigger-description">Creates an Escape-key pause menu with Resume and Restart options. Select an existing Button object to add a touch-friendly menu trigger for phones and tablets.</p>
                <div class="trigger-form-group">
                    <label class="trigger-form-label" for="pause-menu-button">Optional Button object</label>
                    <select class="trigger-form-select" id="pause-menu-button">${buttonOptions}</select>
                </div>
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="pause-menu-template-cancel">Cancel</button>
                    <button class="btn btn-primary" id="pause-menu-template-add">Add Pause Menu</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        const close = () => dialog.remove();
        dialog.querySelector('#pause-menu-template-cancel').addEventListener('click', close);
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        dialog.querySelector('#pause-menu-template-add').addEventListener('click', () => {
            if (hasEscapeMenuFlow()) {
                showToast('An Escape-triggered menu already exists. Edit its Event to add or change options.', 'info');
                close();
                return;
            }
            const buttonName = dialog.querySelector('#pause-menu-button')?.value || '';
            const template = createMechanicsTemplate('pause-menu', { buttonName });
            if (!template) {
                showToast('The selected Button is no longer available.', 'error');
                close();
                return;
            }
            close();
            installMechanicsTemplate(template);
        });
        dialog.querySelector('#pause-menu-button')?.focus();
    };

    const showSavePointTemplateSetup = () => {
        const buttons = getUniquelyNamedButtons();
        const checkpoints = (getWorld()?.objects || []).filter(object =>
            object?.id && object.actingType === 'checkpoint' && object._mechanicsEnabled !== false);
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        const buttonOptions = `<option value="">Select a Button...</option>${buttons.map(button => {
            const label = button.displayName || button.name;
            return `<option value="${escapeHtml(button.name)}">${escapeHtml(label)} · ${escapeHtml(button.name)}</option>`;
        }).join('')}`;
        const checkpointOptions = `<option value="">Select a Checkpoint...</option>${checkpoints.map(checkpoint => {
            const label = `${checkpoint.name || 'Checkpoint'} · (${Math.round(checkpoint.x)}, ${Math.round(checkpoint.y)})`;
            return `<option value="${escapeHtml(checkpoint.id)}">${escapeHtml(label)}</option>`;
        }).join('')}`;
        const unavailable = !buttons.length || !checkpoints.length;
        dialog.innerHTML = `
            <div class="code-dialog" role="dialog" aria-modal="true" aria-labelledby="save-point-template-title">
                <h2 id="save-point-template-title">Set Up Button Save Point</h2>
                <p class="trigger-description">Choose a uniquely named Button and a Checkpoint object. Pressing the button sets the triggering player's respawn point. Turn on <strong>Remember Latest Checkpoint</strong> in Map Config to restore it in a later solo visit on this browser.</p>
                ${unavailable ? `<p class="trigger-description error">${!buttons.length ? 'Add a uniquely named Button' : ''}${!buttons.length && !checkpoints.length ? ' and ' : ''}${!checkpoints.length ? 'add a Checkpoint object' : ''} to this map first, then reopen this template.</p>` : `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label" for="save-point-button-name">Button</label>
                        <select class="trigger-form-select" id="save-point-button-name">${buttonOptions}</select>
                    </div>
                    <div class="trigger-form-group">
                        <label class="trigger-form-label" for="save-point-checkpoint-id">Checkpoint object</label>
                        <select class="trigger-form-select" id="save-point-checkpoint-id">${checkpointOptions}</select>
                    </div>
                    <p class="trigger-description error" id="save-point-template-error" role="alert" style="display:none">Choose both a button and a checkpoint.</p>
                `}
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="save-point-template-cancel">Cancel</button>
                    <button class="btn btn-primary" id="save-point-template-add" ${unavailable ? 'disabled' : ''}>Add Save Point</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        const close = () => dialog.remove();
        dialog.querySelector('#save-point-template-cancel').addEventListener('click', close);
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        dialog.querySelector('#save-point-template-add').addEventListener('click', () => {
            const buttonName = dialog.querySelector('#save-point-button-name')?.value;
            const checkpointId = dialog.querySelector('#save-point-checkpoint-id')?.value;
            if (!buttonName || !checkpointId) {
                const error = dialog.querySelector('#save-point-template-error');
                if (error) error.style.display = '';
                return;
            }
            const template = createMechanicsTemplate('save-point', { buttonName, checkpointId });
            if (!template) {
                showToast('The selected Button or Checkpoint is no longer available.', 'error');
                close();
                return;
            }
            close();
            installMechanicsTemplate(template);
        });
        dialog.querySelector('#save-point-button-name')?.focus();
    };

    const showPlayerInventoryTemplateSetup = () => {
        const buttons = getUniquelyNamedButtons();
        const pickupObjects = getInventoryPickupObjects();
        const buttonOptions = `<option value="">Keyboard only (I)</option>${buttons.map(button => {
            const label = button.displayName || button.name;
            return `<option value="${escapeHtml(button.name)}">${escapeHtml(label)}</option>`;
        }).join('')}`;
        const pickupOptions = `<option value="">No pickup object</option>${pickupObjects.map(object =>
            `<option value="${escapeHtml(object.id)}">${escapeHtml(object.label)}</option>`).join('')}`;
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        dialog.innerHTML = `
            <div class="code-dialog" role="dialog" aria-modal="true" aria-labelledby="player-inventory-title">
                <h2 id="player-inventory-title">Set Up Player Inventory</h2>
                <p class="trigger-description">Creates an empty Player List and an event that opens its live inventory panel. Players can press I on a keyboard. Choose an existing Button object to add a tap-friendly open trigger for phones and tablets. Optionally bind a pickup object so touching it adds its name to the player's inventory and disables that map object.</p>
                <div class="trigger-form-group">
                    <label class="trigger-form-label" for="player-inventory-button">Optional Button object</label>
                    <select class="trigger-form-select" id="player-inventory-button">${buttonOptions}</select>
                </div>
                <div class="trigger-form-group">
                    <label class="trigger-form-label" for="player-inventory-pickup">Optional pickup object</label>
                    <select class="trigger-form-select" id="player-inventory-pickup">${pickupOptions}</select>
                </div>
                <label class="trigger-form-label" style="display:flex; gap:8px; align-items:flex-start;">
                    <input type="checkbox" id="player-inventory-persist">
                    <span>Save this inventory between visits on this device</span>
                </label>
                <p class="trigger-description">Local saves work for solo play in this browser. Test runs and hosted rooms stay temporary; saves do not sync between devices.</p>
                ${!buttons.length ? '<p class="trigger-description">This map has no uniquely named Button objects yet. You can add one now and reopen this setup to include touch activation.</p>' : ''}
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="player-inventory-cancel">Cancel</button>
                    <button class="btn btn-primary" id="player-inventory-add">Add Inventory</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        const close = () => dialog.remove();
        dialog.querySelector('#player-inventory-cancel').addEventListener('click', close);
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        dialog.querySelector('#player-inventory-add').addEventListener('click', () => {
            const buttonName = dialog.querySelector('#player-inventory-button')?.value || '';
            const pickupObjectId = dialog.querySelector('#player-inventory-pickup')?.value || '';
            const persist = dialog.querySelector('#player-inventory-persist')?.checked === true;
            const template = createMechanicsTemplate('player-inventory', { buttonName, pickupObjectId, persist });
            if (!template) {
                showToast('That Button is no longer available. Reopen the inventory setup.', 'error');
                close();
                return;
            }
            close();
            installMechanicsTemplate(template);
        });
        dialog.querySelector('#player-inventory-button')?.focus();
    };

    const showHKEnemyTemplateSetup = () => {
        const objects = (getWorld()?.objects || []).filter(object => object?.id &&
            object._mechanicsEnabled !== false && object._collected !== true &&
            object.type !== 'teleportal' && object.appearanceType !== 'teleportal' &&
            !['zone', 'button', 'checkpoint', 'spawnpoint', 'endpoint'].includes(object.appearanceType) &&
            !['checkpoint', 'spawnpoint', 'endpoint'].includes(object.actingType));
        const objectOptions = `<option value="">${objects.length ? 'Select an object…' : 'No suitable objects on this map'}</option>${objects.map(object => {
            const label = `${object.name || object.displayName || object.appearanceType || object.type || 'Object'} · (${Math.round(object.x)}, ${Math.round(object.y)})`;
            return `<option value="${escapeHtml(object.id)}">${escapeHtml(label)}</option>`;
        }).join('')}`;
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        dialog.innerHTML = `
            <div class="code-dialog" role="dialog" aria-modal="true" aria-labelledby="hk-enemy-title">
                <h2 id="hk-enemy-title">Set Up a Basic HK Enemy</h2>
                <p class="trigger-description">Choose an existing object and give it health. With the Hollow Knight plugin enabled, nail hits reduce that health; the object is disabled at zero and a defeat Event shows a message.</p>
                <div class="trigger-form-group">
                    <label class="trigger-form-label" for="hk-enemy-object">Target object</label>
                    <select class="trigger-form-select" id="hk-enemy-object" ${objects.length ? '' : 'disabled'}>${objectOptions}</select>
                </div>
                <div class="trigger-form-group">
                    <label class="trigger-form-label" for="hk-enemy-health">Health</label>
                    <input class="trigger-form-input" id="hk-enemy-health" type="number" min="1" max="99999" step="1" value="3">
                    <label class="trigger-form-label" for="hk-enemy-damage">Damage per nail hit</label>
                    <input class="trigger-form-input" id="hk-enemy-damage" type="number" min="1" max="99999" step="1" value="1">
                </div>
                <div class="trigger-form-group">
                    <label class="trigger-form-label" for="hk-enemy-patrol-distance">Patrol distance</label>
                    <input class="trigger-form-input" id="hk-enemy-patrol-distance" type="number" min="0" max="10000" step="1" value="0" aria-describedby="hk-enemy-patrol-help">
                    <small class="trigger-description" id="hk-enemy-patrol-help">Pixels from the starting position to each endpoint. Set to 0 to keep this enemy stationary.</small>
                    <label class="trigger-form-label" for="hk-enemy-patrol-duration">Seconds per patrol leg</label>
                    <input class="trigger-form-input" id="hk-enemy-patrol-duration" type="number" min="0.1" max="60" step="0.1" value="2">
                    <label class="trigger-form-label" for="hk-enemy-contact-damage">Contact damage</label>
                    <input class="trigger-form-input" id="hk-enemy-contact-damage" type="number" min="0" max="99999" step="1" value="0" aria-describedby="hk-enemy-contact-help">
                    <small class="trigger-description" id="hk-enemy-contact-help">Damage dealt when the player touches the enemy. Set to 0 to disable it.</small>
                </div>
                <p class="trigger-description">The health and defeat state are temporary and reset when the game restarts. Patrol motion is shared from the host, but nail-hit damage runs locally in hosted rooms because the Worker does not verify attack geometry. Contact damage is local to each player's client.</p>
                <p class="trigger-description error" id="hk-enemy-template-error" role="alert" style="display:none">Choose valid health and damage amounts, a patrol distance from 0 to 10,000, a patrol duration from 0.1 to 60 seconds, and contact damage from 0 to 99,999.</p>
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="hk-enemy-cancel">Cancel</button>
                    <button class="btn btn-primary" id="hk-enemy-add" ${objects.length ? '' : 'disabled'}>Add Enemy Mechanics</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        const close = () => dialog.remove();
        dialog.querySelector('#hk-enemy-cancel').addEventListener('click', close);
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        dialog.querySelector('#hk-enemy-add').addEventListener('click', () => {
            const objectId = dialog.querySelector('#hk-enemy-object')?.value || '';
            const maxHealth = Number(dialog.querySelector('#hk-enemy-health')?.value);
            const damage = Number(dialog.querySelector('#hk-enemy-damage')?.value);
            const patrolDistance = Number(dialog.querySelector('#hk-enemy-patrol-distance')?.value);
            const patrolDuration = Number(dialog.querySelector('#hk-enemy-patrol-duration')?.value);
            const contactDamage = Number(dialog.querySelector('#hk-enemy-contact-damage')?.value);
            if (!objectId || !Number.isSafeInteger(maxHealth) || maxHealth < 1 || maxHealth > 99999 ||
                !Number.isSafeInteger(damage) || damage < 1 || damage > 99999 ||
                !Number.isSafeInteger(patrolDistance) || patrolDistance < 0 || patrolDistance > 10000 ||
                !Number.isFinite(patrolDuration) || patrolDuration < 0.1 || patrolDuration > 60 ||
                !Number.isSafeInteger(contactDamage) || contactDamage < 0 || contactDamage > 99999) {
                const error = dialog.querySelector('#hk-enemy-template-error');
                if (error) error.style.display = '';
                return;
            }
            const template = createMechanicsTemplate('hk-enemy', { objectId, maxHealth, damage, patrolDistance, patrolDuration, contactDamage });
            if (!template) {
                showToast('The selected object is no longer available. Reopen this setup.', 'error');
                close();
                return;
            }
            close();
            installMechanicsTemplate(template);
        });
        dialog.querySelector('#hk-enemy-object')?.focus();
    };

    const showMechanicsTemplatesDialog = () => {
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        dialog.innerHTML = `
            <div class="code-dialog" role="dialog" aria-modal="true" aria-labelledby="mechanics-templates-title">
                <h2 id="mechanics-templates-title">Mechanics Templates</h2>
                <p class="trigger-description">Add a linked, editable starter setup to this map. Templates are added alongside your existing mechanics.</p>
                <div class="code-template-list">
                    <button class="code-template-card" data-template="timed-round">
                        <strong>Timed Round</strong>
                        <span>Starts a 60-second round when play begins, tracks round state, and ends with a message.</span>
                        <small>1 trigger · 2 events · 1 map variable</small>
                    </button>
                    <button class="code-template-card" data-template="hk-enemy">
                        <strong>Basic HK Enemy</strong>
                        <span>Give a selected object health, then optionally add a patrol route and player contact damage.</span>
                        <small>2–3 triggers · 3–6 events · requires a target object and Hollow Knight plugin</small>
                    </button>
                    <button class="code-template-card" data-template="player-inventory">
                        <strong>Player Inventory</strong>
                        <span>Creates a Player List and a live inventory panel, with optional touch controls, a pickup object, and solo local saves.</span>
                        <small>1–3 triggers · 1–2 events · 1 per-player List</small>
                    </button>
                    <button class="code-template-card" data-template="tag-game">
                        <strong>Tag Game</strong>
                        <span>Starts with the host as “it” and transfers the role when that player touches someone.</span>
                        <small>3 triggers · 4 events · 1 per-player variable</small>
                    </button>
                    <button class="code-template-card" data-template="timed-course">
                        <strong>Timed Course</strong>
                        <span>Bind two existing zones to create a shared start-to-finish course with a 120-second deadline.</span>
                        <small>2 triggers · 6 events · 1 map variable · requires two zones</small>
                    </button>
                    <button class="code-template-card" data-template="switch-door">
                        <strong>Button Switch And Door</strong>
                        <span>Bind a button to a map object, then toggle the object on or off each time the button is pressed.</span>
                        <small>2 triggers · 4 events · 1 map variable · requires a button and target</small>
                    </button>
                    <button class="code-template-card" data-template="hide-and-seek">
                        <strong>Hide And Seek</strong>
                        <span>The host becomes seeker; finding the last connected hider completes the shared round.</span>
                        <small>4 triggers · 7 events · 1 per-player role · 2 map variables</small>
                    </button>
                    <button class="code-template-card" data-template="checkpoint-zone">
                        <strong>Checkpoint Zone</strong>
                        <span>Entering a named zone activates a selected Checkpoint object as the player's respawn point.</span>
                        <small>1 trigger · 1 event · requires a zone and checkpoint</small>
                    </button>
                    <button class="code-template-card" data-template="save-point">
                        <strong>Button Save Point</strong>
                        <span>Press a Button object to set the player's respawn point, with optional solo persistence from Map Config.</span>
                        <small>1 trigger · 1 event · requires a unique button name and checkpoint</small>
                    </button>
                    <button class="code-template-card" data-template="pause-menu">
                        <strong>Pause Menu</strong>
                        <span>Press Escape to open a Resume/Restart menu. Add an existing Button object for touch-first devices.</span>
                        <small>1–2 triggers · 3 events · optional Button object</small>
                    </button>
                    <button class="code-template-card" data-template="title-menu">
                        <strong>Title Menu</strong>
                        <span>Show a Welcome screen when the game starts. The solo scene waits until players select Start.</span>
                        <small>1 trigger · 2 events · touch-friendly</small>
                    </button>
                </div>
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="mechanics-templates-close">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);

        const close = () => dialog.remove();
        dialog.querySelector('#mechanics-templates-close').addEventListener('click', close);
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        dialog.querySelectorAll('[data-template]').forEach(button => {
            button.addEventListener('click', () => {
                if (button.dataset.template === 'hk-enemy') {
                    close();
                    showHKEnemyTemplateSetup();
                    return;
                }
                if (button.dataset.template === 'timed-course') {
                    close();
                    showTimedCourseTemplateSetup();
                    return;
                }
                if (button.dataset.template === 'switch-door') {
                    close();
                    showSwitchDoorTemplateSetup();
                    return;
                }
                if (button.dataset.template === 'checkpoint-zone') {
                    close();
                    showCheckpointTemplateSetup();
                    return;
                }
                if (button.dataset.template === 'save-point') {
                    close();
                    showSavePointTemplateSetup();
                    return;
                }
                if (button.dataset.template === 'pause-menu') {
                    close();
                    showPauseMenuTemplateSetup();
                    return;
                }
                if (button.dataset.template === 'title-menu' && hasGameStartsMenuFlow()) {
                    showToast('A Game Starts Event already opens a menu. Edit it to change the title screen.', 'info');
                    return;
                }
                if (button.dataset.template === 'player-inventory') {
                    close();
                    showPlayerInventoryTemplateSetup();
                    return;
                }
                const template = createMechanicsTemplate(button.dataset.template);
                if (!template) return;
                close();
                installMechanicsTemplate(template);
            });
        });
        dialog.querySelector('.code-template-card')?.focus();
    };

    // Show new block dialog
    const showNewBlockDialog = () => {
        const dialog = document.createElement('div');
        dialog.className = 'code-dialog-overlay';
        dialog.innerHTML = `
            <div class="code-dialog">
                <h2>Create New Mechanic Block</h2>
                <div class="code-dialog-types">
                    <button class="code-type-btn selected" data-type="trigger">
                        <span class="material-symbols-outlined">frame_inspect</span>
                        <span>Trigger</span>
                    </button>
                    <button class="code-type-btn" data-type="variable">
                        <span class="material-symbols-outlined">data_object</span>
                        <span>Variable</span>
                    </button>
                    <button class="code-type-btn" data-type="event">
                        <span class="material-symbols-outlined">code_blocks</span>
                        <span>Event</span>
                    </button>
                </div>
                <div class="form-group">
                    <label class="form-label">Name</label>
                    <input type="text" class="form-input" id="new-block-name" placeholder="Enter a name..." autocomplete="off" spellcheck="false">
                    <small style="color: var(--text-muted); font-size: 11px; margin-top: 4px; display: block;">
                        Cannot use: ${CODE_RESERVED_NAMES.join(', ')}
                    </small>
                </div>
                <div class="code-dialog-actions">
                    <button class="btn btn-secondary" id="new-block-cancel">Cancel</button>
                    <button class="btn btn-primary" id="new-block-create">Create</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        let selectedType = 'trigger';
        const nameInput = dialog.querySelector('#new-block-name');
        
        // Type selection
        dialog.querySelectorAll('.code-type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                dialog.querySelectorAll('.code-type-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedType = btn.dataset.type;
            });
        });
        
        // Cancel
        dialog.querySelector('#new-block-cancel').addEventListener('click', () => {
            dialog.remove();
        });
        
        // Click outside to close
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
        
        // Escape to close
        dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                dialog.remove();
            }
        });
        
        // Create
        const createBlock = () => {
            const name = nameInput.value.trim();
            
            if (name && !isValidName(name)) {
                nameInput.classList.add('error');
                showToast('Cannot use reserved names', 'error');
                return;
            }
            
            const codeData = getCodeData();
            
            if (selectedType === 'trigger') {
                const newTrigger = {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_TRIGGER)),
                    id: generateId(),
                    name: name || 'New Trigger'
                };
                codeData.triggers.push(newTrigger);
                saveCodeData(codeData);
                dialog.remove();
                showTriggerEditor(newTrigger);
            } else if (selectedType === 'variable') {
                const newVariable = {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_VARIABLE)),
                    id: generateId(),
                    name: name || 'New Variable'
                };
                codeData.variables.push(newVariable);
                saveCodeData(codeData);
                dialog.remove();
                showVariableEditor(newVariable);
            } else {
                const newEvent = {
                    ...JSON.parse(JSON.stringify(CODE_DEFAULT_EVENT)),
                    id: generateId(),
                    name: name || 'New Event'
                };
                codeData.events.push(newEvent);
                saveCodeData(codeData);
                dialog.remove();
                showEventEditor(newEvent);
            }
        };
        
        dialog.querySelector('#new-block-create').addEventListener('click', createBlock);
        
        // Enter to create
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                createBlock();
            }
        });
        
        // Focus name input
        setTimeout(() => nameInput.focus(), 100);
    };
    
    // Show trigger editor
    const showTriggerEditor = (trigger) => {
        currentView = 'editTrigger';
        editingBlock = trigger;
        
        // Update header
        const backBtn = document.getElementById('code-editor-back');
        if (backBtn) {
            backBtn.querySelector('.material-symbols-outlined').textContent = 'arrow_back';
            backBtn.title = 'Back (Escape)';
        }
        
        const title = document.querySelector('.code-editor-title');
        if (title) {
            title.innerHTML = `
                <span class="material-symbols-outlined" style="color: #f59e0b;">frame_inspect</span>
                Edit Trigger
            `;
        }
        
        const newBtn = document.getElementById('code-new-block');
        if (newBtn) newBtn.style.display = 'none';
        const templatesBtn = document.getElementById('code-templates-btn');
        if (templatesBtn) templatesBtn.style.display = 'none';
        
        const content = document.getElementById('code-editor-content');
        if (!content) return;
        
        // Sort trigger types alphabetically
        const sortedTriggerTypes = [...CODE_TRIGGER_TYPE_INFO].sort((a, b) => a.label.localeCompare(b.label));
        
        content.innerHTML = `
            <div class="trigger-editor">
                <div class="trigger-form-group">
                    <label class="trigger-form-label">Trigger Name</label>
                    <input type="text" class="trigger-form-input" id="trigger-name" value="${escapeHtml(trigger.name)}" spellcheck="false">
                </div>
                
                <div class="trigger-form-group">
                    <label class="trigger-form-label">
                        Trigger Type
                        <span class="trigger-form-sublabel">When should this trigger fire?</span>
                    </label>
                    <select class="trigger-form-select" id="trigger-type">
                        ${CODE_TRIGGER_TYPE_INFO.some(type => type.id === trigger.triggerType) ? '' : `<option value="${escapeHtml(String(trigger.triggerType ?? ''))}" selected>Unsupported trigger: ${escapeHtml(String(trigger.triggerType ?? '(missing type)'))}</option>`}
                        ${sortedTriggerTypes.map(t => `
                            <option value="${t.id}" ${trigger.triggerType === t.id ? 'selected' : ''}>${escapeHtml(t.label)}</option>
                        `).join('')}
                    </select>
                    <p class="trigger-description" id="trigger-type-description"></p>
                </div>
                
                <div id="trigger-config-area">
                    <!-- Dynamic config options will be rendered here -->
                </div>
                
                <button class="btn btn-primary trigger-save-btn" id="trigger-save" style="width: 100%;">
                    <span class="material-symbols-outlined">save</span>
                    Save Trigger
                    <span style="opacity: 0.7; margin-left: 8px; font-size: 12px;">Ctrl+S</span>
                </button>
            </div>
        `;
        
        // Update description
        updateTriggerTypeDescription(trigger.triggerType);
        
        // Render initial config
        renderTriggerConfig(trigger.triggerType, trigger.config);
        
        // Trigger type change
        document.getElementById('trigger-type').addEventListener('change', (e) => {
            updateTriggerTypeDescription(e.target.value);
            renderTriggerConfig(e.target.value, { eventId: editingBlock?.config?.eventId || editingBlock?.config?.actionId || '' });
            markUnsaved();
        });
        
        // Track changes
        document.getElementById('trigger-name').addEventListener('input', markUnsaved);
        
        // Save button
        document.getElementById('trigger-save').addEventListener('click', saveTrigger);
    };
    
    // Update trigger type description
    const updateTriggerTypeDescription = (triggerType) => {
        const descEl = document.getElementById('trigger-type-description');
        if (!descEl) return;
        
        const info = CODE_TRIGGER_TYPE_INFO.find(t => t.id === triggerType);
        descEl.textContent = info?.description || '';
    };
    
    // Render trigger-specific config options
    const renderTriggerConfig = (triggerType, config = {}) => {
        const area = document.getElementById('trigger-config-area');
        if (!area) return;
        
        const supportedTrigger = CODE_TRIGGER_TYPE_INFO.some(type => type.id === triggerType);
        const zones = getZones();
        const tilemaps = getWorld()?.tilemaps || [];
        const objects = (getWorld()?.objects || []).filter(object =>
            object && object._mechanicsEnabled !== false && object._collected !== true
        );
        
        let html = '';
        
        switch (triggerType) {
            case CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE:
            case CODE_TRIGGER_TYPES.PLAYER_LEAVE_ZONE: {
                const hasZones = zones.length > 0;
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Zone</label>
                        <select class="trigger-form-select" id="trigger-config-zone" ${!hasZones ? 'disabled' : ''}>
                            ${!hasZones ? '<option value="">No zones available</option>' : ''}
                            ${zones.map(z => `<option value="${escapeHtml(z.name)}" ${config.zoneName === z.name ? 'selected' : ''}>${escapeHtml(z.name)}</option>`).join('')}
                        </select>
                        ${!hasZones ? '<p class="trigger-description error">Create zones in the editor first (use Game Item → Zone)</p>' : ''}
                    </div>
                `;
                break;
            }

            case CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT: {
                const hasObjects = objects.length > 0;
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Map object</label>
                        <select class="trigger-form-select" id="trigger-config-object" ${!hasObjects ? 'disabled' : ''}>
                            <option value="">${hasObjects ? 'Select an object…' : 'No available objects'}</option>
                            ${objects.map(object => {
                                const label = `${object.name || object.displayName || object.appearanceType || object.type || 'Object'} · (${Math.round(object.x)}, ${Math.round(object.y)})`;
                                return `<option value="${escapeHtml(object.id)}" ${config.objectId === object.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                            }).join('')}
                        </select>
                        <label class="trigger-form-label" style="margin-top: 10px;">Contact shape</label>
                        <select class="trigger-form-select" id="trigger-config-shape">
                            <option value="box" ${(config.shape || 'box') === 'box' ? 'selected' : ''}>Box</option>
                            <option value="circle" ${config.shape === 'circle' ? 'selected' : ''}>Circle</option>
                            <option value="capsule" ${config.shape === 'capsule' ? 'selected' : ''}>Capsule</option>
                        </select>
                        ${!hasObjects ? '<p class="trigger-description error">Add a map object in the editor first</p>' : ''}
                        <p class="trigger-description">Fires once when the player begins touching the object. Circle and capsule use a radius equal to half the object’s shorter side; capsule rounds the ends along the longer axis. It can fire again after the player leaves. This setting affects trigger contact only, not solid platform collision.</p>
                    </div>
                `;
                break;
            }

            case CODE_TRIGGER_TYPES.PLAYER_ATTACKS_OBJECT: {
                const hasObjects = objects.length > 0;
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Target map object</label>
                        <select class="trigger-form-select" id="trigger-config-object" ${!hasObjects ? 'disabled' : ''}>
                            <option value="">${hasObjects ? 'Select an object…' : 'No available objects'}</option>
                            ${objects.map(object => {
                                const label = `${object.name || object.displayName || object.appearanceType || object.type || 'Object'} · (${Math.round(object.x)}, ${Math.round(object.y)})`;
                                return `<option value="${escapeHtml(object.id)}" ${config.objectId === object.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                            }).join('')}
                        </select>
                        ${!hasObjects ? '<p class="trigger-description error">Add a map object in the editor first</p>' : ''}
                        <p class="trigger-description">Requires the Hollow Knight plugin. Fires once per target object during each nail swing; the hit does not consume the attack unless the target already has Hollow Knight behavior.</p>
                    </div>
                `;
                break;
            }

            case CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP: {
                const hasTilemaps = tilemaps.length > 0;
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Tilemap</label>
                        <select class="trigger-form-select" id="trigger-config-tilemap" ${!hasTilemaps ? 'disabled' : ''}>
                            <option value="">${hasTilemaps ? 'Select a tilemap…' : 'No tilemaps available'}</option>
                            ${tilemaps.map(tilemap => `<option value="${escapeHtml(tilemap.id)}" ${config.tilemapId === tilemap.id ? 'selected' : ''}>${escapeHtml(tilemap.name || `Layer ${tilemap.layer}`)}</option>`).join('')}
                        </select>
                        <label class="trigger-form-label" style="margin-top: 10px;">Cell behavior</label>
                        <select class="trigger-form-select" id="trigger-config-tilemap-behavior">
                            <option value="any" ${(config.collisionType || 'any') === 'any' ? 'selected' : ''}>Any collidable cell</option>
                            <option value="solid" ${config.collisionType === 'solid' ? 'selected' : ''}>Solid</option>
                            <option value="oneWay" ${config.collisionType === 'oneWay' ? 'selected' : ''}>One-way platform</option>
                            <option value="hazard" ${config.collisionType === 'hazard' ? 'selected' : ''}>Damage on touch</option>
                        </select>
                        ${!hasTilemaps ? '<p class="trigger-description error">Paint a Tilemap Brush layer with collidable cells first</p>' : ''}
                        <p class="trigger-description">Fires once when the player begins touching a matching collidable cell. Decorative cells do not trigger it. It can fire again after the player leaves the selected tilemap.</p>
                    </div>
                `;
                break;
            }
                
            case CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT: {
                const keys = Array.isArray(config.keys) ? config.keys.slice(0, CODE_MAX_TRIGGER_KEYS) : [];
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Keys <span class="trigger-form-sublabel">Must all be pressed simultaneously</span></label>
                        <div class="trigger-keys-container">
                            <div class="trigger-keys-add">
                                <select class="trigger-form-select" id="trigger-add-key">
                                    <option value="">Select a key to add...</option>
                                    ${CODE_KEYBOARD_KEYS.map(k => `<option value="${k.id}">${escapeHtml(k.label)}</option>`).join('')}
                                </select>
                                <button class="btn btn-secondary" id="trigger-add-key-btn">
                                    <span class="material-symbols-outlined">add</span>
                                </button>
                            </div>
                            <div class="trigger-keys-list" id="trigger-keys-list">
                                ${keys.map(k => {
                                    const keyObj = CODE_KEYBOARD_KEYS.find(kk => kk.id === k);
                                    return `
                                        <div class="trigger-key-tag" data-key="${escapeHtml(k)}">
                                            <span>${keyObj ? escapeHtml(keyObj.label) : escapeHtml(k)}</span>
                                            <button class="remove-key-btn" title="Remove"><span class="material-symbols-outlined" style="font-size: 14px;">close</span></button>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    </div>
                `;
                break;
            }
                
            case CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT: {
                const sortedActions = getPlayerActionOptions().sort((a, b) => a.label.localeCompare(b.label));
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Action</label>
                        <select class="trigger-form-select" id="trigger-config-action">
                            ${sortedActions.map(a => `<option value="${a.id}" ${config.action === a.id ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}
                        </select>
                    </div>
                    <div id="trigger-action-value-area"></div>
                `;
                break;
            }
                
            case CODE_TRIGGER_TYPES.PLAYER_STATS: {
                const sortedStats = [...CODE_PLAYER_STATS].sort((a, b) => a.label.localeCompare(b.label));
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Stat</label>
                        <select class="trigger-form-select" id="trigger-config-stat">
                            ${sortedStats.map(s => `<option value="${s.id}" ${config.stat === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Value to Match</label>
                        <input type="text" class="trigger-form-input" id="trigger-config-stat-value" value="${escapeHtml(config.statValue || '')}" placeholder="Enter value..." maxlength="${CODE_MAX_PLAYER_STAT_VALUE_LENGTH}" spellcheck="false">
                    </div>
                `;
                break;
            }

            case CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED: {
                const directions = CODE_HEALTH_CHANGE_DIRECTIONS;
                const selectedDirection = directions.some(item => item.id === config.direction) ? config.direction : 'any';
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Change</label>
                        <select class="trigger-form-select" id="trigger-config-health-direction">
                            ${directions.map(item => `<option value="${item.id}" ${item.id === selectedDirection ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
                        </select>
                        <p class="trigger-description">Tracks changes to numeric <code>player.hp</code>. The first reading seeds the baseline and does not fire. In hosted rooms this presentation trigger is local; guest health is not host-validated.</p>
                    </div>
                `;
                break;
            }

            case CODE_TRIGGER_TYPES.VARIABLE_CONDITION: {
                const variables = getVariables();
                const selectedVariable = variables.find(variable => variable.id === config.variableId);
                const operators = getVariableConditionOperators(selectedVariable);
                const selectedOperator = operators.some(([id]) => id === config.operator) ? config.operator : 'equals';
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Variable</label>
                        <select class="trigger-form-select" id="trigger-config-variable" ${variables.length ? '' : 'disabled'}>${renderVariableOptions(config.variableId)}</select>
                        ${variables.length ? '' : '<p class="trigger-description error">Create a single-value variable first.</p>'}
                    </div>
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Condition</label>
                        <select class="trigger-form-select" id="trigger-config-operator">${operators.map(([id, label]) => `<option value="${id}" ${id === (selectedOperator || 'equals') ? 'selected' : ''}>${label}</option>`).join('')}</select>
                    </div>
                    <div id="trigger-variable-value-area"></div>
                `;
                break;
            }
                
            case CODE_TRIGGER_TYPES.REPEAT:
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Repeat Every</label>
                        <div style="display: flex; gap: 12px;">
                            <input type="number" class="trigger-form-input" id="trigger-config-interval" value="${config.interval || 1}" min="1" style="flex: 1;">
                            <select class="trigger-form-select" id="trigger-config-unit" style="flex: 1;">
                                ${CODE_TIME_UNITS.map(u => `<option value="${u.id}" ${config.unit === u.id ? 'selected' : ''}>${u.label}</option>`).join('')}
                            </select>
                        </div>
                        <p class="trigger-description">The trigger will fire repeatedly at this interval after the game starts. The interval must be between 1 and 24 hours.</p>
                    </div>
                `;
                break;
                
            case CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON: {
                const buttons = getButtons();
                const hasButtons = buttons.length > 0;
                html = `
                    <div class="trigger-form-group">
                        <label class="trigger-form-label">Button</label>
                        <select class="trigger-form-select" id="trigger-config-button" ${!hasButtons ? 'disabled' : ''}>
                            ${!hasButtons ? '<option value="">No buttons available</option>' : ''}
                            ${buttons.map(b => `<option value="${escapeHtml(b.name)}" ${config.buttonName === b.name ? 'selected' : ''}>${escapeHtml(b.name)}${b.displayName ? ' (' + escapeHtml(b.displayName) + ')' : ''}</option>`).join('')}
                        </select>
                        ${!hasButtons ? '<p class="trigger-description error">Create buttons in the editor first (use Add → Button)</p>' : ''}
                    </div>
                `;
                break;
            }

            case CODE_TRIGGER_TYPES.GAME_STARTS:
            case CODE_TRIGGER_TYPES.GAME_ENDS:
            case CODE_TRIGGER_TYPES.PLAYER_DIES:
            case CODE_TRIGGER_TYPES.PLAYER_JOINS_ROOM:
            case CODE_TRIGGER_TYPES.PLAYER_LEAVES_ROOM:
            case CODE_TRIGGER_TYPES.PLAYER_LANDS:
            case CODE_TRIGGER_TYPES.PLAYER_JUMPS:
            case CODE_TRIGGER_TYPES.PLAYER_RESPAWNS:
                html = `<p class="trigger-description">${triggerType === CODE_TRIGGER_TYPES.GAME_STARTS
                    ? 'This trigger fires once when the game starts.'
                    : triggerType === CODE_TRIGGER_TYPES.GAME_ENDS
                        ? 'Fires locally once after the player reaches an endpoint and the map completion requirements are met. Python event context includes elapsed time and whether the run was a test.'
                    : triggerType === CODE_TRIGGER_TYPES.PLAYER_DIES
                        ? 'Fires locally once at the death transition, before automatic respawn. Python event context identifies the hazard or Mechanics action that caused it.'
                    : triggerType === CODE_TRIGGER_TYPES.PLAYER_LANDS
                        ? 'Fires once when the player transitions from airborne to solid ground. In hosted rooms, this trigger runs locally on each client; guest landings are not host-validated.'
                    : triggerType === CODE_TRIGGER_TYPES.PLAYER_JUMPS
                        ? 'Fires after a core or plugin jump succeeds, not when a jump button press fails. In hosted rooms, this trigger runs locally on each client; guest jumps are not host-validated.'
                    : triggerType === CODE_TRIGGER_TYPES.PLAYER_RESPAWNS
                        ? 'Fires locally after the player has been moved to their checkpoint or spawn and other respawn hooks have run. Useful for restoring round state or showing a respawn message.'
                        : 'This room event fires in multiplayer rooms. The host runs the linked event once and shares its map changes.'} No additional configuration needed.</p>`;
                break;
            default:
                html = supportedTrigger
                    ? `<p class="trigger-description">No additional configuration needed.</p>`
                    : '<p class="trigger-description error">This trigger type is not supported by this version. Its configuration will be preserved when you save the trigger.</p>';
                break;
        }

        const events = getEvents();
        html += `
            <div class="trigger-form-group" style="margin-top: 24px;">
                <label class="trigger-form-label">Run Event</label>
                <select class="trigger-form-select" id="trigger-config-event">${renderEventOptions(config.eventId || config.actionId)}</select>
                <p class="trigger-description">Choose what happens when this trigger fires. Create an Event block first if the list is empty.</p>
                ${events.length === 0 ? '<p class="trigger-description error">No events yet. Create an Event from New Mechanic, then return here to link it.</p>' : ''}
            </div>
        `;
        
        area.innerHTML = html;
        
        // Attach event listeners for dynamic elements
        attachTriggerConfigListeners(triggerType, config);
    };
    
    // Attach event listeners for trigger config
    const attachTriggerConfigListeners = (triggerType, config) => {
        const area = document.getElementById('trigger-config-area');
        // Key input handling
        if (triggerType === CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT) {
            const addKeyBtn = document.getElementById('trigger-add-key-btn');
            const keySelect = document.getElementById('trigger-add-key');
            const keysList = document.getElementById('trigger-keys-list');
            
            const addKey = (keyId) => {
                if (!keyId || keysList.querySelector(`[data-key="${keyId}"]`)) return;
                if (keysList.querySelectorAll('.trigger-key-tag').length >= CODE_MAX_TRIGGER_KEYS) {
                    showToast(`A key trigger can contain at most ${CODE_MAX_TRIGGER_KEYS} keys`, 'error');
                    return;
                }
                if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(keyId) || keyId === 'other') return;
                
                const keyObj = CODE_KEYBOARD_KEYS.find(k => k.id === keyId);
                const tag = document.createElement('div');
                tag.className = 'trigger-key-tag';
                tag.dataset.key = keyId;
                tag.innerHTML = `
                    <span>${keyObj ? escapeHtml(keyObj.label) : escapeHtml(keyId)}</span>
                    <button class="remove-key-btn" title="Remove"><span class="material-symbols-outlined" style="font-size: 14px;">close</span></button>
                `;
                keysList.appendChild(tag);
                
                tag.querySelector('.remove-key-btn').addEventListener('click', () => {
                    tag.remove();
                    markUnsaved();
                });
                
                markUnsaved();
            };
            
            addKeyBtn?.addEventListener('click', () => {
                const keyId = keySelect.value;
                
                // Special handling for "Other" key
                if (keyId === 'other') {
                    showKeyCapture((capturedKey) => {
                        if (capturedKey) {
                            addKey(capturedKey);
                        }
                    });
                    keySelect.value = '';
                    return;
                }
                
                addKey(keyId);
                keySelect.value = '';
            });
            
            // Remove key buttons
            keysList?.querySelectorAll('.remove-key-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    btn.closest('.trigger-key-tag').remove();
                    markUnsaved();
                });
            });
        }
        
        // Player action value input
        if (triggerType === CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT) {
            const actionSelect = document.getElementById('trigger-config-action');
            const valueArea = document.getElementById('trigger-action-value-area');
            
            const updateActionValue = () => {
                const actionId = actionSelect?.value;
                const action = getPlayerActionOptions().find(a => a.id === actionId);
                
                if (action?.hasValue && valueArea) {
                    valueArea.innerHTML = `
                        <div class="trigger-form-group">
                            <label class="trigger-form-label">${escapeHtml(action.valuePlaceholder)}</label>
                            <input type="${action.valueType === 'number' ? 'number' : 'text'}" ${action.valueType === 'number' ? 'min="0.01" step="any"' : ''} class="trigger-form-input" id="trigger-config-action-value" value="${escapeHtml(config.actionValue ?? action.defaultValue ?? '')}" placeholder="${escapeHtml(action.valuePlaceholder)}" spellcheck="false">
                        </div>
                    `;
                    document.getElementById('trigger-config-action-value')?.addEventListener('input', markUnsaved);
                } else if (valueArea) {
                    valueArea.innerHTML = '';
                }
            };
            
            actionSelect?.addEventListener('change', () => {
                updateActionValue();
                markUnsaved();
            });
            updateActionValue();
        }

        if (triggerType === CODE_TRIGGER_TYPES.VARIABLE_CONDITION) {
            const variableSelect = document.getElementById('trigger-config-variable');
            const operatorSelect = document.getElementById('trigger-config-operator');
            const valueArea = document.getElementById('trigger-variable-value-area');
            const updateValueInput = () => {
                const variable = getVariables().find(item => item.id === variableSelect?.value);
                const operator = operatorSelect?.value || 'equals';
                const currentValue = document.getElementById('trigger-config-variable-value')?.value ?? config.value ?? '';
                if (!valueArea) return;
                if (operator === 'truthy' || operator === 'falsy') {
                    valueArea.innerHTML = '';
                } else if (variable?.valueType === 'boolean') {
                    valueArea.innerHTML = `<div class="trigger-form-group"><label class="trigger-form-label">Value</label><select class="trigger-form-select" id="trigger-config-variable-value"><option value="false" ${String(currentValue) === 'false' ? 'selected' : ''}>false</option><option value="true" ${String(currentValue) === 'true' ? 'selected' : ''}>true</option></select></div>`;
                } else {
                    const inputType = ['integer', 'float'].includes(variable?.valueType) ? 'number' : 'text';
                    const step = variable?.valueType === 'integer' ? '1' : 'any';
                        valueArea.innerHTML = `<div class="trigger-form-group"><label class="trigger-form-label">Value</label><input class="trigger-form-input" id="trigger-config-variable-value" type="${inputType}" ${inputType === 'number' ? `step="${step}"` : `maxlength="${CODE_MAX_VARIABLE_STRING_LENGTH}"`} value="${escapeHtml(currentValue)}"></div>`;
                }
                document.getElementById('trigger-config-variable-value')?.addEventListener('input', markUnsaved);
            };
            variableSelect?.addEventListener('change', () => {
                const requestedOperator = operatorSelect?.value || config.operator || 'equals';
                const variable = getVariables().find(item => item.id === variableSelect.value);
                const operators = getVariableConditionOperators(variable);
                if (operatorSelect) {
                    operatorSelect.innerHTML = operators.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
                    operatorSelect.value = operators.some(([id]) => id === requestedOperator) ? requestedOperator : 'equals';
                }
                updateValueInput();
                markUnsaved();
            });
            operatorSelect?.addEventListener('change', () => {
                updateValueInput();
                markUnsaved();
            });
            updateValueInput();
        }
        
        // Track changes for all inputs
        area.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('change', markUnsaved);
            el.addEventListener('input', markUnsaved);
        });
    };
    
    // Show key capture dialog for "Other" key
    const showKeyCapture = (callback) => {
        const overlay = document.createElement('div');
        overlay.className = 'key-capture-overlay';
        overlay.innerHTML = `
            <div class="key-capture-dialog">
                <h3>Press any key...</h3>
                <p>Press the key you want to capture, or Escape to cancel.</p>
            </div>
        `;
        document.body.appendChild(overlay);
        
        const handleKeyDown = (e) => {
            e.preventDefault();
            overlay.remove();
            document.removeEventListener('keydown', handleKeyDown);
            
            if (e.key === 'Escape') {
                callback(null);
            } else {
                callback(e.code);
            }
        };
        
        document.addEventListener('keydown', handleKeyDown);
        
        overlay.addEventListener('click', () => {
            overlay.remove();
            document.removeEventListener('keydown', handleKeyDown);
            callback(null);
        });
    };
    
    // Save trigger
    const saveTrigger = () => {
        if (!editingBlock) return;
        
        const nameInput = document.getElementById('trigger-name');
        const name = nameInput?.value.trim();
        
        if (!isValidName(name)) {
            showToast('Invalid name. Cannot use reserved names.', 'error');
            nameInput?.focus();
            return;
        }
        
        if (!name) {
            showToast('Please enter a name', 'error');
            nameInput?.focus();
            return;
        }
        
        const triggerType = document.getElementById('trigger-type')?.value;
        // Start with the original config so newer trigger fields survive an
        // edit from a runtime that only understands part of the schema.
        const config = triggerType === editingBlock.triggerType && editingBlock.config &&
            typeof editingBlock.config === 'object' && !Array.isArray(editingBlock.config)
            ? { ...editingBlock.config }
            : {};
        
        // Gather config based on type
        switch (triggerType) {
            case CODE_TRIGGER_TYPES.PLAYER_ENTER_ZONE:
            case CODE_TRIGGER_TYPES.PLAYER_LEAVE_ZONE:
                config.zoneName = document.getElementById('trigger-config-zone')?.value || '';
                break;

            case CODE_TRIGGER_TYPES.PLAYER_TOUCH_OBJECT:
                config.objectId = document.getElementById('trigger-config-object')?.value || '';
                config.shape = ['circle', 'capsule'].includes(document.getElementById('trigger-config-shape')?.value)
                    ? document.getElementById('trigger-config-shape').value : 'box';
                break;

            case CODE_TRIGGER_TYPES.PLAYER_ATTACKS_OBJECT:
                config.objectId = document.getElementById('trigger-config-object')?.value || '';
                break;

            case CODE_TRIGGER_TYPES.PLAYER_TOUCH_TILEMAP:
                config.tilemapId = document.getElementById('trigger-config-tilemap')?.value || '';
                config.collisionType = document.getElementById('trigger-config-tilemap-behavior')?.value || 'any';
                break;
                
            case CODE_TRIGGER_TYPES.PLAYER_KEY_INPUT: {
                const keysList = document.getElementById('trigger-keys-list');
                config.keys = Array.from(keysList?.querySelectorAll('.trigger-key-tag') || [])
                    .map(tag => tag.dataset.key);
                break;
            }
                
            case CODE_TRIGGER_TYPES.PLAYER_ACTION_INPUT: {
                config.action = document.getElementById('trigger-config-action')?.value || '';
                const actionValueEl = document.getElementById('trigger-config-action-value');
                if (actionValueEl) {
                    config.actionValue = actionValueEl.value;
                }
                break;
            }
                
            case CODE_TRIGGER_TYPES.PLAYER_STATS:
                config.stat = document.getElementById('trigger-config-stat')?.value || '';
                config.statValue = document.getElementById('trigger-config-stat-value')?.value || '';
                break;

            case CODE_TRIGGER_TYPES.PLAYER_HEALTH_CHANGED:
                config.direction = document.getElementById('trigger-config-health-direction')?.value || 'any';
                break;

            case CODE_TRIGGER_TYPES.VARIABLE_CONDITION:
                config.variableId = document.getElementById('trigger-config-variable')?.value || '';
                config.operator = document.getElementById('trigger-config-operator')?.value || 'equals';
                config.value = document.getElementById('trigger-config-variable-value')?.value ?? '';
                break;
                
            case CODE_TRIGGER_TYPES.REPEAT:
                {
                    const interval = parseFloat(document.getElementById('trigger-config-interval')?.value);
                    config.interval = Number.isFinite(interval) ? Math.max(1, interval) : 1;
                }
                config.unit = document.getElementById('trigger-config-unit')?.value || 'seconds';
                break;

            case CODE_TRIGGER_TYPES.PLAYER_PRESS_BUTTON:
                config.buttonName = document.getElementById('trigger-config-button')?.value || '';
                break;
        }
        config.eventId = document.getElementById('trigger-config-event')?.value || '';

        // Update trigger
        editingBlock.name = name;
        editingBlock.triggerType = triggerType;
        editingBlock.config = config;
        
        const codeData = getCodeData();
        saveCodeData(codeData);
        
        showToast('Trigger saved', 'success');
        showDashboard();
    };
    
    const createEventAction = (type) => {
        switch (type) {
            case 'setVariable': return { type, variableId: '', value: '', playerTarget: 'triggering' };
            case 'addVariable': return { type, variableId: '', amount: 1, playerTarget: 'triggering' };
            case 'calculateVariable': return { type, variableId: '', operation: 'add', operand: 1, playerTarget: 'triggering' };
            case 'toggleVariable': return { type, variableId: '', playerTarget: 'triggering' };
            case 'branchVariable': return { type, variableId: '', operator: 'equals', value: '', trueEventId: '', falseEventId: '' };
            case 'branchPlayerCount': return { type, playerVariableId: '', filterOperator: 'equals', filterValue: '', operator: 'equals', count: 0, trueEventId: '', falseEventId: '' };
            case 'branchObjectHealth': return { type, targetMode: 'fixed', objectId: '', operator: 'lessThanOrEqual', value: 1, trueEventId: '', falseEventId: '' };
            case 'appendListItem':
            case 'removeListItem': return { type, variableId: '', valueType: 'string', value: '', playerTarget: 'triggering' };
            case 'setInventoryItemEquipped': return { type, variableId: '', itemName: '', slot: 'default', equipped: true, playerTarget: 'triggering' };
            case 'branchListContains': return { type, variableId: '', valueType: 'string', value: '', playerTarget: 'triggering', trueEventId: '', falseEventId: '' };
            case 'branchInventoryItemEquipped': return { type, variableId: '', itemName: '', slot: 'default', playerTarget: 'triggering', trueEventId: '', falseEventId: '' };
            case 'consumeInventoryItem': return { type, variableId: '', itemName: '', slot: 'default', playerTarget: 'triggering', trueEventId: '', falseEventId: '' };
            case 'showList': return { type, variableId: '', title: 'Inventory' };
            case 'showVariablePanel': return { type, variableId: '', title: 'Score' };
            case 'setCheckpoint': return { type, objectId: '' };
            case 'setTriggerEnabled': return { type, triggerId: '', enabled: true };
            case 'setObjectEnabled': return { type, objectId: '', enabled: true, persist: false };
            case 'setObjectHealth': return { type, targetMode: 'fixed', objectId: '', health: 3, maxHealth: 3 };
            case 'damageObject': return { type, targetMode: 'touched', objectId: '', amount: 1, maxHealth: 3, defeatedEventId: '' };
            case 'spawnObject': return { type, objectId: '', xOffset: 32, yOffset: 0, tag: 'spawned', maxInstances: 16, lifetime: 10 };
            case 'removeSpawnedObjects': return { type, tag: 'spawned' };
            case 'setObjectPosition': return { type, objectId: '', x: 0, y: 0 };
            case 'moveObject': return { type, objectId: '', x: 0, y: 0, duration: 1, easing: 'easeInOut' };
            case 'setObjectSpriteFrame': return { type, objectId: '', mode: 'custom', frame: 0 };
            case 'setObjectOpacity': return { type, objectId: '', mode: 'map', opacity: 1 };
            case 'playObjectSpriteAnimation': return { type, objectId: '', mode: 'play', animationName: '', startFrame: 0, frameCount: 1, fps: 8, loop: false, completionEventId: '' };
            case 'setCameraFollowMode': return { type, mode: 'both' };
            case 'setCameraBounds': return { type, mode: 'map', x: 0, y: 0, width: 2000, height: 1200 };
            case 'setGravity': return { type, mode: 'map', gravity: 0.8 };
            case 'setJumpForce': return { type, mode: 'map', jumpForce: -13.2 };
            case 'setPlayerSpeed': return { type, mode: 'map', speed: 5 };
            case 'setMovementControl': return { type, property: 'horizontalAcceleration', mode: 'map', value: 0 };
            case 'setTilemapCellBehavior': return { type, tilemapId: '', targetMode: 'fixed', x: 0, y: 0, collisionType: 'decorative' };
            case 'startTimer': return { type, timerName: 'timer', seconds: 1, eventId: '', repeat: false, repeatCount: 1 };
            case 'stopTimer': return { type, timerName: '' };
            case 'teleportPlayer': return { type, x: 0, y: 0 };
            case 'teleportPlayerToObject': return { type, objectId: '' };
            case 'transitionToMap': return { type, mapId: '' };
            case 'restartScene': return { type };
            case 'setVelocity': return { type, vx: 0, vy: 0 };
            case 'damagePlayer':
            case 'healPlayer': return { type, amount: 1 };
            case 'playSound': return { type, soundName: 'button' };
            case 'playPluginSound': return { type, pluginId: '', soundName: '', volume: 1 };
            case 'stopPluginSound': return { type, pluginId: '', soundName: '' };
           case 'runEvent': return { type, eventId: '' };
            case 'showDialogue': return { type, speaker: '', pages: 'Hello there.' };
            case 'showChoice': return { type, speaker: '', prompt: 'What will you do?', choices: [{ label: 'Option one', eventId: '' }, { label: 'Option two', eventId: '' }] };
            case 'showMenu': return { type, title: 'Menu', pauseWorld: false, choices: [{ label: 'Continue', eventId: '' }] };
            case 'showMessage':
            default: return { type: 'showMessage', text: 'Hello!', duration: 3 };
        }
    };

    const renderEventActionConfig = (action, index) => {
        const field = (name, value, type = 'text', placeholder = '', maxLength = null) =>
            `<input class="trigger-form-input event-action-field" data-field="${name}" type="${type}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}"${maxLength ? ` maxlength="${maxLength}"` : ''}>`;
        const select = (name, options) =>
            `<select class="trigger-form-select event-action-field" data-field="variableId">${renderVariableOptions(action.variableId, options)}</select>`;
        const playerTarget = (variable) => variable?.scope === 'player'
            ? `<label class="trigger-form-label">Target player</label><select class="trigger-form-select event-action-field" data-field="playerTarget"><option value="triggering" ${!action.playerTarget || action.playerTarget === 'triggering' ? 'selected' : ''}>Triggering player</option><option value="touched" ${action.playerTarget === 'touched' ? 'selected' : ''}>Touched player</option><option value="all" ${action.playerTarget === 'all' ? 'selected' : ''}>All live players</option></select>`
            : '';

        switch (action.type) {
            case 'setVariable': {
                const variable = getVariables().find(item => item.id === action.variableId);
                if (variable?.valueType === 'boolean') {
                    return `${select('variableId')}${playerTarget(variable)}<label class="trigger-form-label">Value</label><select class="trigger-form-select event-action-field" data-field="value"><option value="false" ${String(action.value) === 'false' ? 'selected' : ''}>false</option><option value="true" ${String(action.value) === 'true' ? 'selected' : ''}>true</option></select>`;
                }
                const valueType = variable?.valueType === 'integer' || variable?.valueType === 'float' ? 'number' : 'text';
                const step = variable?.valueType === 'integer' ? '1' : 'any';
                return `${select('variableId')}${playerTarget(variable)}<label class="trigger-form-label">Value</label>${field('value', action.value, valueType, 'Value', variable?.valueType === 'string' ? CODE_MAX_VARIABLE_STRING_LENGTH : null)}`
                    .replace('type="number"', `type="number" step="${step}"`);
            }
            case 'addVariable': {
                const variable = getVariables().find(item => item.id === action.variableId);
                const step = variable?.valueType === 'integer' ? '1' : 'any';
                return `${select('variableId', ['integer', 'float'])}${playerTarget(variable)}<label class="trigger-form-label">Amount</label>${field('amount', action.amount ?? 1, 'number', '1').replace('type="number"', `type="number" step="${step}"`)}`;
            }
            case 'calculateVariable': {
                const variable = getVariables().find(item => item.id === action.variableId);
                const step = variable?.valueType === 'integer' ? '1' : 'any';
                const operations = [['add', 'Add'], ['subtract', 'Subtract'], ['multiply', 'Multiply'], ['divide', 'Divide']];
                return `${select('variableId', ['integer', 'float'])}${playerTarget(variable)}<label class="trigger-form-label">Operation</label><select class="trigger-form-select event-action-field" data-field="operation">${operations.map(([id, label]) => `<option value="${id}" ${id === (action.operation || 'add') ? 'selected' : ''}>${label}</option>`).join('')}</select><label class="trigger-form-label">Number</label>${field('operand', action.operand ?? 1, 'number', '1').replace('type="number"', `type="number" step="${step}"`)}<p class="trigger-description">Applies this operation to the selected number variable. Integer variables only accept whole-number results; dividing by zero or producing a fractional integer result reports a Mechanics error.</p>`;
            }
            case 'toggleVariable': {
                const variable = getVariables('boolean').find(item => item.id === action.variableId);
                return `${select('variableId', ['boolean'])}${playerTarget(variable)}`;
            }
            case 'branchVariable': {
                const variable = getVariables().find(item => item.id === action.variableId);
                const operators = getVariableConditionOperators(variable);
                const operator = operators.some(([id]) => id === action.operator) ? action.operator : 'equals';
                const conditionTarget = variable?.scope === 'player'
                    ? `<label class="trigger-form-label">Check player</label><select class="trigger-form-select event-action-field" data-field="playerTarget"><option value="triggering" ${action.playerTarget !== 'touched' ? 'selected' : ''}>Triggering player</option><option value="touched" ${action.playerTarget === 'touched' ? 'selected' : ''}>Touched player</option></select>${action.playerTarget === 'touched' ? '<p class="trigger-description">Touched player is available in a Touch Other Player event.</p>' : ''}`
                    : '';
                let valueField = '';
                if (!['truthy', 'falsy'].includes(operator)) {
                    if (variable?.valueType === 'boolean') {
                        valueField = `<label class="trigger-form-label">Value</label><select class="trigger-form-select event-action-field" data-field="value"><option value="false" ${String(action.value) === 'false' ? 'selected' : ''}>false</option><option value="true" ${String(action.value) === 'true' ? 'selected' : ''}>true</option></select>`;
                    } else {
                        const inputType = ['integer', 'float'].includes(variable?.valueType) ? 'number' : 'text';
                        const step = variable?.valueType === 'integer' ? '1' : 'any';
                        valueField = `<label class="trigger-form-label">Value</label>${field('value', action.value, inputType, 'Value')}`
                            .replace('type="number"', `type="number" step="${step}"`);
                    }
                }
                const eventSelect = (fieldName, label, selectedId) =>
                    `<label class="trigger-form-label">${label}</label><select class="trigger-form-select event-action-field" data-field="${fieldName}">${renderEventOptions(selectedId)}</select>`;
                return `${select('variableId')}${conditionTarget}<label class="trigger-form-label">Condition</label><select class="trigger-form-select event-action-field" data-field="operator">${operators.map(([id, label]) => `<option value="${id}" ${id === operator ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>${valueField}${eventSelect('trueEventId', 'When true', action.trueEventId)}${eventSelect('falseEventId', 'When false', action.falseEventId)}`;
            }
            case 'branchPlayerCount': {
                const variable = getVariables().find(item => item.id === action.playerVariableId && item.scope === 'player');
                const filterOperators = getVariableConditionOperators(variable);
                const filterOperator = filterOperators.some(([id]) => id === action.filterOperator) ? action.filterOperator : 'equals';
                const countOperators = [['equals', 'Equals'], ['greaterThan', 'Greater than'], ['lessThan', 'Less than']];
                let filterValueField = '';
                if (!['truthy', 'falsy'].includes(filterOperator)) {
                    if (variable?.valueType === 'boolean') {
                        filterValueField = `<label class="trigger-form-label">Player value</label><select class="trigger-form-select event-action-field" data-field="filterValue"><option value="false" ${String(action.filterValue) === 'false' ? 'selected' : ''}>false</option><option value="true" ${String(action.filterValue) === 'true' ? 'selected' : ''}>true</option></select>`;
                    } else {
                        const inputType = ['integer', 'float'].includes(variable?.valueType) ? 'number' : 'text';
                        const step = variable?.valueType === 'integer' ? '1' : 'any';
                        filterValueField = `<label class="trigger-form-label">Player value</label>${field('filterValue', action.filterValue, inputType, 'Value', variable?.valueType === 'string' ? CODE_MAX_VARIABLE_STRING_LENGTH : null)}`
                            .replace('type="number"', `type="number" step="${step}"`);
                    }
                }
                const eventSelect = (fieldName, label, selectedId) =>
                    `<label class="trigger-form-label">${label}</label><select class="trigger-form-select event-action-field" data-field="${fieldName}">${renderEventOptions(selectedId)}</select>`;
                return `<label class="trigger-form-label">Count players by</label><select class="trigger-form-select event-action-field" data-field="playerVariableId">${renderPlayerVariableOptions(action.playerVariableId)}</select><label class="trigger-form-label">Player condition</label><select class="trigger-form-select event-action-field" data-field="filterOperator">${filterOperators.map(([id, label]) => `<option value="${id}" ${id === filterOperator ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>${filterValueField}<label class="trigger-form-label">Count condition</label><select class="trigger-form-select event-action-field" data-field="operator">${countOperators.map(([id, label]) => `<option value="${id}" ${id === (action.operator || 'equals') ? 'selected' : ''}>${label}</option>`).join('')}</select><label class="trigger-form-label">Player count</label>${field('count', action.count ?? 0, 'number').replace('type="number"', 'type="number" min="0" max="100" step="1"')}${eventSelect('trueEventId', 'When true', action.trueEventId)}${eventSelect('falseEventId', 'When false', action.falseEventId)}<p class="trigger-description">Counts connected players whose per-player value matches the condition. A room host evaluates this branch for everyone.</p>`;
            }
            case 'appendListItem':
            case 'removeListItem': {
                const list = getListVariables().find(variable => variable.id === action.variableId);
                const scopeHint = list?.scope === 'player' ? 'This changes the selected player’s separate List; the host synchronizes room values to every client.' : 'This changes a map-shared List.';
                return `${renderListItemActionFields(action)}<p class="trigger-description">${scopeHint} Lists contain at most ${CODE_MAX_LIST_ITEMS} typed items.</p>`;
            }
            case 'branchListContains': {
                const list = getListVariables().find(variable => variable.id === action.variableId);
                const scopeHint = list?.scope === 'player' ? 'This checks the selected player’s separate List.' : 'This checks a map-shared List.';
                return `${renderListItemActionFields(action, true)}<p class="trigger-description">${scopeHint} Runs the matching branch when this typed item is present.</p>`;
            }
            case 'branchInventoryItemEquipped': {
                const list = getListVariables().find(variable => variable.id === action.variableId);
                return `<label class="trigger-form-label">Player List</label><select class="trigger-form-select event-action-field" data-field="variableId">${renderPlayerStringListOptions(action.variableId)}</select>${playerTarget(list)}<label class="trigger-form-label">Item name</label>${field('itemName', action.itemName || '', 'text', 'Iron Key', 80)}<label class="trigger-form-label">Equipment slot</label>${field('slot', action.slot || 'default', 'text', 'default', 32)}<label class="trigger-form-label">If equipped</label><select class="trigger-form-select event-action-field" data-field="trueEventId">${renderEventOptions(action.trueEventId)}</select><label class="trigger-form-label">If not equipped</label><select class="trigger-form-select event-action-field" data-field="falseEventId">${renderEventOptions(action.falseEventId)}</select><p class="trigger-description">Checks the target player's JSON inventory card by exact name and slot.</p>`;
            }
            case 'consumeInventoryItem': {
                const list = getListVariables().find(variable => variable.id === action.variableId);
                const selectedTarget = action.playerTarget === 'touched' ? 'touched' : 'triggering';
                const targetControl = list?.scope === 'player'
                    ? `<label class="trigger-form-label">Target player</label><select class="trigger-form-select event-action-field" data-field="playerTarget"><option value="triggering" ${selectedTarget === 'triggering' ? 'selected' : ''}>Triggering player</option><option value="touched" ${selectedTarget === 'touched' ? 'selected' : ''}>Touched player</option></select>`
                    : '';
                return `<label class="trigger-form-label">Player List</label><select class="trigger-form-select event-action-field" data-field="variableId">${renderPlayerStringListOptions(action.variableId)}</select>${targetControl}<label class="trigger-form-label">Item name</label>${field('itemName', action.itemName || '', 'text', 'Potion', 80)}<label class="trigger-form-label">Equipment slot</label>${field('slot', action.slot || 'default', 'text', 'default', 32)}<label class="trigger-form-label">When found and used</label><select class="trigger-form-select event-action-field" data-field="trueEventId">${renderEventOptions(action.trueEventId)}</select><label class="trigger-form-label">When missing</label><select class="trigger-form-select event-action-field" data-field="falseEventId">${renderEventOptions(action.falseEventId)}</select><p class="trigger-description">Consumes one use: items with a count above 1 decrement; items with no count or a count of 1 are removed. The successful Event can apply the item effect.</p>`;
            }
            case 'setInventoryItemEquipped': {
                const list = getListVariables().find(variable => variable.id === action.variableId);
                return `<label class="trigger-form-label">Player List</label><select class="trigger-form-select event-action-field" data-field="variableId">${renderPlayerStringListOptions(action.variableId)}</select>${playerTarget(list)}<label class="trigger-form-label">Item name</label>${field('itemName', action.itemName || '', 'text', 'Iron Key', 80)}<label class="trigger-form-label">Equipment slot</label>${field('slot', action.slot || 'default', 'text', 'default', 32)}<label class="trigger-form-label">State</label><select class="trigger-form-select event-action-field" data-field="equipped"><option value="true" ${action.equipped !== false ? 'selected' : ''}>Equipped</option><option value="false" ${action.equipped === false ? 'selected' : ''}>Unequipped</option></select><p class="trigger-description">Inventory cards are string List items with JSON names and optional slots. Equipping clears other equipped cards in the same slot for the target player.</p>`;
            }
            case 'showList':
                return `<label class="trigger-form-label">List</label><select class="trigger-form-select event-action-field" data-field="variableId">${renderListVariableOptions(action.variableId)}</select><label class="trigger-form-label">Panel title</label>${field('title', action.title || '', 'text', 'Inventory', 64)}<p class="trigger-description">Opens a local, scrollable panel and refreshes it while the game runs. Player Lists show the triggering player’s own values; hosted snapshots are visible to everyone in the room. String List values may use JSON item cards with name, icon, description, count, slot, and equipped fields. The panel does not pause gameplay.</p>`;
            case 'showVariablePanel':
                return `<label class="trigger-form-label">Variable</label><select class="trigger-form-select event-action-field" data-field="variableId">${renderVariableOptions(action.variableId)}</select><label class="trigger-form-label">Panel title</label>${field('title', action.title || '', 'text', 'Score', 64)}<p class="trigger-description">Opens a local status panel that refreshes while the game runs. Map variables show shared map state; Player variables show the triggering local player’s value. The panel does not pause gameplay.</p>`;
            case 'setObjectEnabled':
                return `<label class="trigger-form-label">Map object</label><select class="trigger-form-select event-action-field" data-field="objectId">${renderObjectOptions(action.objectId)}</select><label class="trigger-form-label">State</label><select class="trigger-form-select event-action-field" data-field="enabled"><option value="true" ${action.enabled !== false ? 'selected' : ''}>Enabled</option><option value="false" ${action.enabled === false ? 'selected' : ''}>Disabled</option></select><label class="trigger-form-label" style="display:flex; gap:8px; align-items:center;"><input class="event-action-field" data-field="persist" type="checkbox" ${action.persist === true ? 'checked' : ''}> Remember this object state between visits</label><p class="trigger-description">Saved locally for solo play on this browser. Test runs and hosted rooms stay temporary.</p>`;
            case 'setObjectHealth': {
                const targetMode = action.targetMode === 'touched' ? 'touched' : 'fixed';
                return `<label class="trigger-form-label">Target</label><select class="trigger-form-select event-action-field" data-field="targetMode"><option value="fixed" ${targetMode === 'fixed' ? 'selected' : ''}>Selected map object</option><option value="touched" ${targetMode === 'touched' ? 'selected' : ''}>Object that triggered this Event</option></select><label class="trigger-form-label">Map object</label><select class="trigger-form-select event-action-field" data-field="objectId" ${targetMode === 'touched' ? 'disabled' : ''}>${renderObjectOptions(action.objectId)}</select><label class="trigger-form-label">Current health</label>${field('health', action.health ?? 3, 'number').replace('type="number"', 'type="number" min="0" max="99999" step="1"')}<label class="trigger-form-label">Maximum health</label>${field('maxHealth', action.maxHealth ?? 3, 'number').replace('type="number"', 'type="number" min="1" max="99999" step="1"')}<p class="trigger-description">Sets temporary object health for this play session. Setting health to 0 disables the object; setting positive health enables it again. Use a touched target from an object contact or attack Event.</p>`;
            }
            case 'damageObject': {
                const targetMode = action.targetMode === 'fixed' ? 'fixed' : 'touched';
                return `<label class="trigger-form-label">Target</label><select class="trigger-form-select event-action-field" data-field="targetMode"><option value="touched" ${targetMode === 'touched' ? 'selected' : ''}>Object that triggered this Event</option><option value="fixed" ${targetMode === 'fixed' ? 'selected' : ''}>Selected map object</option></select><label class="trigger-form-label">Map object</label><select class="trigger-form-select event-action-field" data-field="objectId" ${targetMode === 'touched' ? 'disabled' : ''}>${renderObjectOptions(action.objectId)}</select><label class="trigger-form-label">Damage per hit</label>${field('amount', action.amount ?? 1, 'number').replace('type="number"', 'type="number" min="1" max="99999" step="1"')}<label class="trigger-form-label">Health when first hit</label>${field('maxHealth', action.maxHealth ?? 3, 'number').replace('type="number"', 'type="number" min="1" max="99999" step="1"')}<label class="trigger-form-label">Event when defeated (optional)</label><select class="trigger-form-select event-action-field" data-field="defeatedEventId">${renderEventOptions(action.defeatedEventId)}</select><p class="trigger-description">Health is initialized on the first hit, stored separately for each object, and resets when the game restarts. Defeated objects are disabled. This is client-local in hosted rooms; use it for solo combat or local effects.</p>`;
            }
            case 'branchObjectHealth': {
                const targetMode = action.targetMode === 'touched' ? 'touched' : 'fixed';
                const comparisons = [
                    ['lessThanOrEqual', 'At or below'], ['lessThan', 'Below'], ['equals', 'Equals'],
                    ['notEquals', 'Does not equal'], ['greaterThan', 'Above'], ['greaterThanOrEqual', 'At or above']
                ];
                return `<label class="trigger-form-label">Target</label><select class="trigger-form-select event-action-field" data-field="targetMode"><option value="fixed" ${targetMode === 'fixed' ? 'selected' : ''}>Selected map object</option><option value="touched" ${targetMode === 'touched' ? 'selected' : ''}>Object that triggered this Event</option></select><label class="trigger-form-label">Map object</label><select class="trigger-form-select event-action-field" data-field="objectId" ${targetMode === 'touched' ? 'disabled' : ''}>${renderObjectOptions(action.objectId)}</select><label class="trigger-form-label">Health condition</label><select class="trigger-form-select event-action-field" data-field="operator">${comparisons.map(([id, label]) => `<option value="${id}" ${id === action.operator ? 'selected' : ''}>${label}</option>`).join('')}</select><label class="trigger-form-label">Health value</label>${field('value', action.value ?? 1, 'number').replace('type="number"', 'type="number" min="0" max="99999" step="1"')}<label class="trigger-form-label">When true</label><select class="trigger-form-select event-action-field" data-field="trueEventId">${renderEventOptions(action.trueEventId)}</select><label class="trigger-form-label">When false (optional)</label><select class="trigger-form-select event-action-field" data-field="falseEventId">${renderEventOptions(action.falseEventId)}</select><p class="trigger-description">Checks temporary Mechanics health after Set Object Health or Damage Object initializes it. Supported hosted trigger flows evaluate synchronized health from the room host; local-only triggers stay local. A missing health value reports a runtime error instead of guessing.</p>`;
            }
            case 'setTriggerEnabled': {
                const triggers = getCodeData().triggers || [];
                const triggerOptions = triggers.map(trigger => `<option value="${escapeHtml(trigger.id)}" ${trigger.id === action.triggerId ? 'selected' : ''}>${escapeHtml(trigger.name || trigger.triggerType || 'Trigger')}</option>`).join('');
                return `<label class="trigger-form-label">Trigger</label><select class="trigger-form-select event-action-field" data-field="triggerId"><option value="">Select a trigger…</option>${triggerOptions}</select><label class="trigger-form-label">State</label><select class="trigger-form-select event-action-field" data-field="enabled"><option value="true" ${action.enabled !== false ? 'selected' : ''}>Enabled</option><option value="false" ${action.enabled === false ? 'selected' : ''}>Disabled</option></select><p class="trigger-description">Changes this trigger for the current play session. The room host shares the state with players; reset restores the map's saved setting.</p>`;
            }
            case 'spawnObject':
                return `<label class="trigger-form-label">Object template</label><select class="trigger-form-select event-action-field" data-field="objectId">${renderSpawnTemplateOptions(action.objectId)}</select><label class="trigger-form-label">Horizontal offset from triggering player</label>${field('xOffset', action.xOffset ?? 32, 'number')}<label class="trigger-form-label">Vertical offset from triggering player</label>${field('yOffset', action.yOffset ?? 0, 'number')}<label class="trigger-form-label">Spawn tag</label>${field('tag', action.tag || 'spawned', 'text', 'enemy', 64)}<label class="trigger-form-label">Maximum active with this tag</label>${field('maxInstances', action.maxInstances ?? 16, 'number').replace('type="number"', `type="number" min="1" max="${CODE_MAX_MECHANICS_SPAWNED_OBJECTS}" step="1"`)}<label class="trigger-form-label">Lifetime in seconds (0 means until removed)</label>${field('lifetime', action.lifetime ?? 10, 'number').replace('type="number"', `type="number" min="0" max="${CODE_MAX_MECHANICS_SPAWN_LIFETIME_SECONDS}" step="any"`)}<p class="trigger-description">Creates a temporary copy near the triggering player. Disable the source template with Set Object Enabled if it should stay hidden. Zones, buttons, portals, checkpoints, spawn points, and endpoints are excluded. The room host shares spawned copies; test/game reset removes them.</p>`;
            case 'removeSpawnedObjects':
                return `<label class="trigger-form-label">Spawn tag</label>${field('tag', action.tag || '', 'text', 'enemy', 64)}<p class="trigger-description">Removes every temporary object spawned with this tag.</p>`;
            case 'setObjectPosition':
                return `<label class="trigger-form-label">Map object</label><select class="trigger-form-select event-action-field" data-field="objectId">${renderObjectOptions(action.objectId)}</select><label class="trigger-form-label">X</label>${field('x', action.x ?? 0, 'number')}<label class="trigger-form-label">Y</label>${field('y', action.y ?? 0, 'number')}<p class="trigger-description">Moves the selected object immediately to map coordinates. In hosted rooms, the host shares the position with everyone.</p>`;
            case 'setObjectSpriteFrame': {
                const spriteObjects = (getWorld()?.objects || []).filter(object => object.spriteSheet);
                const options = `<option value="">${spriteObjects.length ? 'Select a sprite-sheet object…' : 'No objects have sprite sheets'}</option>${spriteObjects.map(object => {
                    const label = `${object.name || object.appearanceType || object.type || 'Object'} · ${object.spriteSheet.frameCount} frames`;
                    return `<option value="${escapeHtml(object.id)}" ${object.id === action.objectId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                }).join('')}`;
                const selected = spriteObjects.find(object => object.id === action.objectId);
                const frameCount = Math.max(1, selected?.spriteSheet?.frameCount || 1);
                const mode = action.mode === 'automatic' ? 'automatic' : 'custom';
                return `<label class="trigger-form-label">Sprite-sheet object</label><select class="trigger-form-select event-action-field" data-field="objectId">${options}</select><label class="trigger-form-label">Frame mode</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="custom" ${mode === 'custom' ? 'selected' : ''}>Show selected frame</option><option value="automatic" ${mode === 'automatic' ? 'selected' : ''}>Resume automatic animation</option></select><label class="trigger-form-label">Frame (0–${frameCount - 1})</label>${field('frame', action.frame ?? 0, 'number').replace('type="number"', `type="number" min="0" max="${frameCount - 1}" step="1" ${mode === 'automatic' ? 'disabled' : ''}`)}<p class="trigger-description">Switch a sprite-sheet object into a state such as alert, attack, or defeated. The chosen frame syncs with the hosted room.</p>`;
            }
            case 'setObjectOpacity': {
                const mode = action.mode === 'custom' ? 'custom' : 'map';
                return `<label class="trigger-form-label">Map object</label><select class="trigger-form-select event-action-field" data-field="objectId">${renderObjectOptions(action.objectId)}</select><label class="trigger-form-label">Opacity mode</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="map" ${mode === 'map' ? 'selected' : ''}>Restore Map Config opacity</option><option value="custom" ${mode === 'custom' ? 'selected' : ''}>Custom opacity</option></select><label class="trigger-form-label">Opacity (0–1)</label>${field('opacity', action.opacity ?? 1, 'number').replace('type="number"', `type="number" min="0" max="1" step="0.05" ${mode === 'map' ? 'disabled' : ''}`)}<p class="trigger-description">Fades an object without changing its saved appearance or collision. Zero is invisible; one is fully opaque. Hosted rooms sync from the host and session reset restores the saved opacity.</p>`;
            }
            case 'playObjectSpriteAnimation': {
                const spriteObjects = (getWorld()?.objects || []).filter(object => object.spriteSheet);
                const options = `<option value="">${spriteObjects.length ? 'Select a sprite-sheet object…' : 'No objects have sprite sheets'}</option>${spriteObjects.map(object => {
                    const label = `${object.name || object.appearanceType || object.type || 'Object'} · ${object.spriteSheet.frameCount} frames`;
                    return `<option value="${escapeHtml(object.id)}" ${object.id === action.objectId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                }).join('')}`;
                const selected = spriteObjects.find(object => object.id === action.objectId);
                const sheetFrameCount = Math.max(1, selected?.spriteSheet?.frameCount || 1);
                const mode = ['play', 'clip', 'automatic'].includes(action.mode) ? action.mode : 'play';
                const startFrame = Number.isSafeInteger(Number(action.startFrame)) ? Number(action.startFrame) : 0;
                const maxCount = Math.max(1, sheetFrameCount - startFrame);
                const clips = Array.isArray(selected?.spriteSheet?.animations) ? selected.spriteSheet.animations : [];
                const selectedClip = clips.find(clip => clip.name === action.animationName);
                const clipOptions = `<option value="">${clips.length ? 'Select a named clip…' : 'No named clips on this object'}</option>${clips.map(clip => `<option value="${escapeHtml(clip.name)}" ${clip.name === action.animationName ? 'selected' : ''}>${escapeHtml(clip.name)} · ${clip.frameCount} frames · ${clip.loop ? 'loop' : 'once'}</option>`).join('')}`;
                const completionDisabled = mode === 'automatic' || (mode === 'play' ? action.loop === true : !selectedClip || selectedClip.loop);
                return `<label class="trigger-form-label">Sprite-sheet object</label><select class="trigger-form-select event-action-field" data-field="objectId">${options}</select><label class="trigger-form-label">Animation</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="play" ${mode === 'play' ? 'selected' : ''}>Play frame range</option><option value="clip" ${mode === 'clip' ? 'selected' : ''}>Play named clip</option><option value="automatic" ${mode === 'automatic' ? 'selected' : ''}>Resume automatic animation</option></select>${mode === 'clip' ? `<label class="trigger-form-label">Named clip</label><select class="trigger-form-select event-action-field" data-field="animationName">${clipOptions}</select>` : ''}${mode === 'play' ? `<label class="trigger-form-label">First frame (0–${sheetFrameCount - 1})</label>${field('startFrame', action.startFrame ?? 0, 'number').replace('type="number"', `type="number" min="0" max="${sheetFrameCount - 1}" step="1"`)}<label class="trigger-form-label">Frame count (1–${maxCount})</label>${field('frameCount', action.frameCount ?? 1, 'number').replace('type="number"', `type="number" min="1" max="${maxCount}" step="1"`)}<label class="trigger-form-label">Speed (1–30 FPS)</label>${field('fps', action.fps ?? 8, 'number').replace('type="number"', 'type="number" min="1" max="30" step="1"')}<label class="trigger-form-label">Playback</label><select class="trigger-form-select event-action-field" data-field="loop"><option value="false" ${action.loop !== true ? 'selected' : ''}>Play once and hold last frame</option><option value="true" ${action.loop === true ? 'selected' : ''}>Loop</option></select>` : ''}<label class="trigger-form-label">When the one-shot animation finishes (optional)</label><select class="trigger-form-select event-action-field" data-field="completionEventId" ${completionDisabled ? 'disabled' : ''}>${renderEventOptions(action.completionEventId)}</select><p class="trigger-description">Play a frame range or reuse a named clip on this object. One-shot animations can run a completion Event once; hosted rooms run that Event on the host and publish shared changes. Configure reusable clips in the object's Sprite Sheet settings.</p>`;
            }
            case 'moveObject':
                return `<label class="trigger-form-label">Map object</label><select class="trigger-form-select event-action-field" data-field="objectId">${renderObjectOptions(action.objectId)}</select><label class="trigger-form-label">Destination X</label>${field('x', action.x ?? 0, 'number')}<label class="trigger-form-label">Destination Y</label>${field('y', action.y ?? 0, 'number')}<label class="trigger-form-label">Movement time in seconds</label>${field('duration', action.duration ?? 1, 'number').replace('type="number"', `type="number" min="0.01" max="${CODE_MAX_OBJECT_MOVE_DURATION_SECONDS}" step="any"`)}<label class="trigger-form-label">Easing</label><select class="trigger-form-select event-action-field" data-field="easing">${CODE_OBJECT_MOTION_EASINGS.map(easing => `<option value="${easing.id}" ${easing.id === action.easing ? 'selected' : ''}>${escapeHtml(easing.label)}</option>`).join('')}</select><p class="trigger-description">Moves a solid object over time and carries a player standing on top. A new move replaces the current one; Set Object Position cancels it. Hosted rooms sync the host's move.</p>`;
            case 'setCameraFollowMode':
                return `<label class="trigger-form-label">Follow axes</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="both" ${action.mode === 'both' ? 'selected' : ''}>Horizontal and vertical</option><option value="horizontal" ${action.mode === 'horizontal' ? 'selected' : ''}>Horizontal only</option><option value="vertical" ${action.mode === 'vertical' ? 'selected' : ''}>Vertical only</option></select><p class="trigger-description">Changes this client's camera for the current play session. The saved map setting is restored when the session resets. Use it for room transitions or side-scrolling sections.</p>`;
            case 'setCameraBounds':
                return `<label class="trigger-form-label">Bounds mode</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="map" ${action.mode === 'map' ? 'selected' : ''}>Use Map Config bounds</option><option value="unbounded" ${action.mode === 'unbounded' ? 'selected' : ''}>Disable bounds</option><option value="bounds" ${action.mode === 'bounds' ? 'selected' : ''}>Use custom rectangle</option></select><label class="trigger-form-label">Left X</label>${field('x', action.x ?? 0, 'number').replace('type="number"', 'type="number" min="-10000000" max="10000000" step="any"')}<label class="trigger-form-label">Top Y</label>${field('y', action.y ?? 0, 'number').replace('type="number"', 'type="number" min="-10000000" max="10000000" step="any"')}<label class="trigger-form-label">Width</label>${field('width', action.width ?? 2000, 'number').replace('type="number"', 'type="number" min="0.01" max="20000000" step="any"')}<label class="trigger-form-label">Height</label>${field('height', action.height ?? 1200, 'number').replace('type="number"', 'type="number" min="0.01" max="20000000" step="any"')}<p class="trigger-description">Changes the camera rectangle for this client's current session. Custom bounds must stay within ±10,000,000 map pixels. Use Map Config restores the authored setting; reset also restores it.</p>`;
            case 'setGravity':
                return `<label class="trigger-form-label">Gravity mode</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="map" ${action.mode === 'map' ? 'selected' : ''}>Use Map Config gravity</option><option value="custom" ${action.mode === 'custom' ? 'selected' : ''}>Custom gravity</option></select><label class="trigger-form-label">Gravity (0–5)</label>${field('gravity', action.gravity ?? 0.8, 'number').replace('type="number"', 'type="number" min="0" max="5" step="any"')}<p class="trigger-description">Changes gravity for the current play session and syncs from the host in multiplayer. Use Map Config or reset to restore the saved value.</p>`;
            case 'setJumpForce':
                return `<label class="trigger-form-label">Jump force mode</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="map" ${action.mode === 'map' ? 'selected' : ''}>Use Map Config jump force</option><option value="custom" ${action.mode === 'custom' ? 'selected' : ''}>Custom jump force</option></select><label class="trigger-form-label">Jump force (-100 to -0.1)</label>${field('jumpForce', action.jumpForce ?? -13.2, 'number').replace('type="number"', 'type="number" min="-100" max="-0.1" step="any"')}<p class="trigger-description">Changes jump strength for core and Hollow Knight jumps for this session. Hosted rooms sync the host's value; Use Map Config or reset to restore the saved value.</p>`;
            case 'setPlayerSpeed':
                return `<label class="trigger-form-label">Player speed mode</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="map" ${action.mode === 'map' ? 'selected' : ''}>Use Map Config player speed</option><option value="custom" ${action.mode === 'custom' ? 'selected' : ''}>Custom player speed</option></select><label class="trigger-form-label">Speed (0.1–100 px/tick)</label>${field('speed', action.speed ?? 5, 'number').replace('type="number"', 'type="number" min="0.1" max="100" step="any"')}<p class="trigger-description">Changes horizontal movement speed for the current session, including Hollow Knight wall movement. Hosted rooms sync the host's value; Use Map Config or reset to restore the saved speed.</p>`;
            case 'setMovementControl': {
                const property = ['horizontalAcceleration', 'airControl', 'terminalFallSpeed'].includes(action.property)
                    ? action.property : 'horizontalAcceleration';
                const range = property === 'horizontalAcceleration' ? [0, 20]
                    : property === 'airControl' ? [0, 1] : [1, 100];
                const label = property === 'horizontalAcceleration' ? 'Horizontal acceleration (0–20 px/tick²)'
                    : property === 'airControl' ? 'Air control (0–1)' : 'Terminal fall speed (1–100 px/tick)';
                return `<label class="trigger-form-label">Movement control</label><select class="trigger-form-select event-action-field" data-field="property"><option value="horizontalAcceleration" ${property === 'horizontalAcceleration' ? 'selected' : ''}>Horizontal acceleration</option><option value="airControl" ${property === 'airControl' ? 'selected' : ''}>Air control</option><option value="terminalFallSpeed" ${property === 'terminalFallSpeed' ? 'selected' : ''}>Terminal fall speed</option></select><label class="trigger-form-label">Value mode</label><select class="trigger-form-select event-action-field" data-field="mode"><option value="map" ${action.mode === 'map' ? 'selected' : ''}>Use Map Config value</option><option value="custom" ${action.mode === 'custom' ? 'selected' : ''}>Custom value</option></select><label class="trigger-form-label">${label}</label>${field('value', action.value ?? 0, 'number').replace('type="number"', `type="number" min="${range[0]}" max="${range[1]}" step="any"`)}<p class="trigger-description">Changes the selected movement rule for the current session. Hosted rooms synchronize the host's value; Map Config or reset restores the saved setting.</p>`;
            }
            case 'setTilemapCellBehavior': {
                const tilemaps = getWorld()?.tilemaps || [];
                const selectedMode = action.targetMode === 'touched' ? 'touched' : 'fixed';
                const gridSize = window.GRID_SIZE || 32;
                return `<label class="trigger-form-label">Tilemap</label><select class="trigger-form-select event-action-field" data-field="tilemapId"><option value="">Select a tilemap…</option>${tilemaps.map(tilemap => `<option value="${escapeHtml(tilemap.id)}" ${tilemap.id === action.tilemapId ? 'selected' : ''}>${escapeHtml(tilemap.name || `Layer ${tilemap.layer}`)}</option>`).join('')}</select><label class="trigger-form-label">Cell to change</label><select class="trigger-form-select event-action-field" data-field="targetMode"><option value="fixed" ${selectedMode === 'fixed' ? 'selected' : ''}>Fixed coordinates</option><option value="touched" ${selectedMode === 'touched' ? 'selected' : ''}>Cell touched by this event</option></select><label class="trigger-form-label">Cell X</label>${field('x', action.x ?? 0, 'number').replace('type="number"', `type="number" min="-10000000" max="10000000" step="${gridSize}"`)}<label class="trigger-form-label">Cell Y</label>${field('y', action.y ?? 0, 'number').replace('type="number"', `type="number" min="-10000000" max="10000000" step="${gridSize}"`)}<label class="trigger-form-label">New behavior</label><select class="trigger-form-select event-action-field" data-field="collisionType">${[['solid', 'Solid'], ['oneWay', 'One-way platform'], ['rampUpRight', 'Ramp rising to the right'], ['rampUpLeft', 'Ramp rising to the left'], ['hazard', 'Damage on touch'], ['decorative', 'Decorative (no collision)']].map(([id, label]) => `<option value="${id}" ${id === action.collisionType ? 'selected' : ''}>${label}</option>`).join('')}</select><p class="trigger-description">Changes an existing cell for this play session and restores it on reset. Fixed coordinates must match the ${gridSize} px tile grid. “Cell touched by this event” requires a Player Touches Tilemap trigger on the selected tilemap. Hosted rooms apply the host’s validated cell state.</p>`;
            }
            case 'setCheckpoint':
                return `<label class="trigger-form-label">Checkpoint object</label><select class="trigger-form-select event-action-field" data-field="objectId">${renderCheckpointOptions(action.objectId)}</select><p class="trigger-description">Sets the triggering player's respawn checkpoint and runs the checkpoint hook.</p>`;
            case 'startTimer': {
                const repeats = action.repeat === true || action.repeat === 'true';
                return `<label class="trigger-form-label">Timer name</label>${field('timerName', action.timerName, 'text', 'round-start')}<label class="trigger-form-label">Delay in seconds</label>${field('seconds', action.seconds ?? 1, 'number', '1').replace('type="number"', `type="number" min="0.01" max="${CODE_MAX_TIMER_DELAY_SECONDS}" step="any"`)}<label class="trigger-form-label">Event when it fires</label><select class="trigger-form-select event-action-field" data-field="eventId">${renderEventOptions(action.eventId)}</select><label class="trigger-form-label">Repeat</label><select class="trigger-form-select event-action-field" data-field="repeat"><option value="false" ${!repeats ? 'selected' : ''}>No, run once</option><option value="true" ${repeats ? 'selected' : ''}>Yes</option></select>${repeats ? `<label class="trigger-form-label">Total fires (up to ${CODE_MAX_TIMER_REPEAT_COUNT})</label>${field('repeatCount', action.repeatCount ?? 1, 'number', '1').replace('type="number"', `type="number" min="1" max="${CODE_MAX_TIMER_REPEAT_COUNT}" step="1"`)}` : ''}<p class="trigger-description">Starting a timer with the same name replaces it. Up to ${CODE_MAX_ACTIVE_TIMERS} timers can run at once per map.</p>`;
            }
            case 'stopTimer':
                return `<label class="trigger-form-label">Timer name</label>${field('timerName', action.timerName, 'text', 'round-start')}`;
            case 'teleportPlayer':
                return `<label class="trigger-form-label">X</label>${field('x', action.x ?? 0, 'number').replace('type="number"', `type="number" min="-${CODE_MAX_PLAYER_TELEPORT_COORDINATE}" max="${CODE_MAX_PLAYER_TELEPORT_COORDINATE}" step="any"`)}<label class="trigger-form-label">Y</label>${field('y', action.y ?? 0, 'number').replace('type="number"', `type="number" min="-${CODE_MAX_PLAYER_TELEPORT_COORDINATE}" max="${CODE_MAX_PLAYER_TELEPORT_COORDINATE}" step="any"`)}<p class="trigger-description">Coordinates are limited to ±${CODE_MAX_PLAYER_TELEPORT_COORDINATE.toLocaleString()} map pixels.</p>`;
            case 'teleportPlayerToObject':
                return `<label class="trigger-form-label">Destination object</label><select class="trigger-form-select event-action-field" data-field="objectId">${renderObjectOptions(action.objectId)}</select><p class="trigger-description">Places the player centered above the object's top edge and clears current velocity. Choose a Checkpoint, Spawn Point, platform, or other map object as an anchor.</p>`;
            case 'transitionToMap': {
                const pickerId = `scene-map-picker-${index}`;
                const inputId = `scene-map-id-${index}`;
                loadSavedSceneMaps(pickerId, inputId, action.mapId);
                return `<label class="trigger-form-label">Saved map</label><select class="trigger-form-select scene-map-picker" id="${pickerId}" aria-label="Choose a saved destination map" disabled><option value="">Loading your maps…</option></select><label class="trigger-form-label">Map ID</label><input class="trigger-form-input event-action-field" id="${inputId}" data-field="mapId" type="text" value="${escapeHtml(action.mapId || '')}" maxlength="128" placeholder="Select a map above or paste its ID"><p class="trigger-description">Loads the destination at its saved checkpoint during solo Play, otherwise at its Spawn Point or default start. A final action here can continue to another scene from Game Ends; destination logic belongs in that map’s Game Starts event. This ends the current event and skips its legacy Python. It works in solo Play and Test modes; multiplayer map transitions are not available yet.</p>`;
            }
            case 'restartScene':
                return '<p class="trigger-description">Restarts the current scene and runs its Game Starts events again. Solo Play uses the remembered checkpoint when enabled; Test always starts at the Spawn Point or default start. This ends the current Event chain. Multiplayer restarts are not available yet.</p>';
            case 'setVelocity':
                return `<label class="trigger-form-label">Horizontal speed</label>${field('vx', action.vx ?? 0, 'number').replace('type="number"', `type="number" min="-${CODE_MAX_PLAYER_VELOCITY}" max="${CODE_MAX_PLAYER_VELOCITY}" step="any"`)}<label class="trigger-form-label">Vertical speed</label>${field('vy', action.vy ?? 0, 'number').replace('type="number"', `type="number" min="-${CODE_MAX_PLAYER_VELOCITY}" max="${CODE_MAX_PLAYER_VELOCITY}" step="any"`)}<p class="trigger-description">Speed components are limited to ±${CODE_MAX_PLAYER_VELOCITY.toLocaleString()} map pixels per update.</p>`;
            case 'damagePlayer':
                return `<label class="trigger-form-label">Damage amount</label>${field('amount', action.amount ?? 1, 'number', '1')}<p class="trigger-description">Uses the HP plugin damage hook when available; otherwise the player dies.</p>`;
            case 'healPlayer':
                return `<label class="trigger-form-label">Heal amount</label>${field('amount', action.amount ?? 1, 'number', '1')}<p class="trigger-description">Requires the HP plugin.</p>`;
            case 'playSound':
                return `<label class="trigger-form-label">Sound</label><select class="trigger-form-select event-action-field" data-field="soundName">${CODE_CORE_SOUND_NAMES.map(name => `<option value="${name}" ${name === action.soundName ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>`;
            case 'playPluginSound':
            case 'stopPluginSound': {
                const includeVolume = action.type === 'playPluginSound';
                const manager = window.PluginManager;
                const plugins = Array.from(manager?.plugins?.entries?.() || [])
                    .filter(([pluginId, plugin]) => manager.isEnabled?.(pluginId) &&
                        plugin?.sounds && Object.keys(plugin.sounds).length > 0);
                const selectedPlugin = plugins.find(([pluginId]) => pluginId === action.pluginId);
                const soundNames = selectedPlugin ? Object.keys(selectedPlugin[1].sounds) : [];
                const missingPlugin = action.pluginId && !selectedPlugin
                    ? `<option value="${escapeHtml(action.pluginId)}" selected disabled>Unavailable: ${escapeHtml(action.pluginId)}</option>` : '';
                const pluginOptions = plugins.map(([pluginId, plugin]) =>
                    `<option value="${escapeHtml(pluginId)}" ${pluginId === action.pluginId ? 'selected' : ''}>${escapeHtml(plugin.name || pluginId)}</option>`).join('');
                const missingSound = action.soundName && !soundNames.includes(action.soundName)
                    ? `<option value="${escapeHtml(action.soundName)}" selected disabled>Unavailable: ${escapeHtml(action.soundName)}</option>` : '';
                const volumeField = includeVolume
                    ? `<label class="trigger-form-label">Volume (0–1)</label>${field('volume', action.volume ?? 1, 'number', '1').replace('type="number"', 'type="number" min="0" max="1" step="0.05"')}`
                    : '';
                const operationDescription = includeVolume
                    ? 'Plays a declared sound on the client running this Event. The sound is not broadcast to other players.'
                    : 'Stops playback of the selected declared sound on the client running this Event. This is useful for ending looping audio after a dash, scene change, or round.';
                return `<label class="trigger-form-label">Enabled plugin</label><select class="trigger-form-select event-action-field" data-field="pluginId">${missingPlugin}${plugins.length ? '<option value="">Choose a plugin</option>' : '<option value="">No enabled plugins have declared sounds</option>'}${pluginOptions}</select><label class="trigger-form-label">Declared sound</label><select class="trigger-form-select event-action-field" data-field="soundName">${missingSound}${soundNames.length ? '<option value="">Choose a sound</option>' : '<option value="">Choose a plugin with declared sounds</option>'}${soundNames.map(name => `<option value="${escapeHtml(name)}" ${name === action.soundName ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>${volumeField}<p class="trigger-description">${operationDescription}</p>`;
            }
            case 'runEvent':
                return `<label class="trigger-form-label">Event to run</label><select class="trigger-form-select event-action-field" data-field="eventId">${renderEventOptions(action.eventId)}</select>`;
            case 'showMessage':
                return `<label class="trigger-form-label">Message</label>${field('text', action.text || '', 'text', 'Message for players')}<label class="trigger-form-label">Seconds</label>${field('duration', action.duration ?? 3, 'number')}`;
           case 'showDialogue':
               return `<label class="trigger-form-label">Speaker (optional)</label>${field('speaker', action.speaker || '', 'text', 'Guide', CODE_MAX_DIALOGUE_SPEAKER_LENGTH)}<label class="trigger-form-label">Dialogue pages</label><textarea class="trigger-form-input event-action-field" data-field="pages" rows="5" maxlength="${CODE_MAX_DIALOGUE_PAGES * CODE_MAX_DIALOGUE_PAGE_LENGTH + CODE_MAX_DIALOGUE_PAGES}" placeholder="One page per line">${escapeHtml(action.pages || '')}</textarea><p class="trigger-description">Each non-empty line is one page. Enter or Space advances; the local player pauses until the final page is closed. This must be the last action in the event. Up to ${CODE_MAX_DIALOGUE_PAGES} pages, ${CODE_MAX_DIALOGUE_PAGE_LENGTH} characters each.</p>`;
            case 'showChoice': {
                const speakerField = '<label class="trigger-form-label">Speaker (optional)</label>' + field('speaker', action.speaker || '', 'text', 'Guide', CODE_MAX_DIALOGUE_SPEAKER_LENGTH);
                const promptField = '<label class="trigger-form-label">Prompt</label>' + field('prompt', action.prompt || '', 'text', 'What will you do?', CODE_MAX_DIALOGUE_PAGE_LENGTH);
                const choices = Array.from({ length: CODE_MAX_DIALOGUE_CHOICES }, (_, choiceIndex) => {
                    const choice = (Array.isArray(action.choices) ? action.choices : [])[choiceIndex] || {};
                    return '<div style="display:grid;gap:6px;padding:10px;border:1px solid var(--surface-light,#2a2a3a);border-radius:8px;">' +
                        '<label class="trigger-form-label">Choice ' + (choiceIndex + 1) + ' label</label>' +
                        '<input class="trigger-form-input event-choice-field event-choice-label" data-choice-index="' + choiceIndex + '" type="text" maxlength="' + CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH + '" value="' + escapeHtml(choice.label || '') + '" placeholder="Talk">' +
                        '<label class="trigger-form-label">Event for this choice</label>' +
                        '<select class="trigger-form-select event-choice-field event-choice-event" data-choice-index="' + choiceIndex + '">' + renderEventOptions(choice.eventId) + '</select>' +
                        '</div>';
                }).join('');
                return speakerField + promptField + choices + '<p class="trigger-description">Choose 2–' + CODE_MAX_DIALOGUE_CHOICES + ' unique labeled options and an enabled event for each. The selected event runs before this event’s Python resumes. For supported hosted trigger flows, the host replays the trigger-linked declarative Event in order and records enabled routes when it reaches this choice; the Worker and host validate the selected route before the host runs its shared actions. This must be the last action. The local player pauses while choosing.</p>';
            }
            case 'showMenu': {
                const titleField = '<label class="trigger-form-label">Menu title</label>' + field('title', action.title || '', 'text', 'Pause Menu', 64);
                const choices = Array.from({ length: CODE_MAX_DIALOGUE_CHOICES }, (_, choiceIndex) => {
                    const choice = (Array.isArray(action.choices) ? action.choices : [])[choiceIndex] || {};
                    return '<div style="display:grid;gap:6px;padding:10px;border:1px solid var(--surface-light,#2a2a3a);border-radius:8px;">' +
                        '<label class="trigger-form-label">Option ' + (choiceIndex + 1) + ' label</label>' +
                        '<input class="trigger-form-input event-choice-field event-choice-label" data-choice-index="' + choiceIndex + '" type="text" maxlength="' + CODE_MAX_DIALOGUE_CHOICE_LABEL_LENGTH + '" value="' + escapeHtml(choice.label || '') + '" placeholder="Resume">' +
                        '<label class="trigger-form-label">Event for this option</label>' +
                        '<select class="trigger-form-select event-choice-field event-choice-event" data-choice-index="' + choiceIndex + '">' + renderEventOptions(choice.eventId) + '</select>' +
                        '</div>';
                }).join('');
                const cancelRoute = '<label class="trigger-form-label">Cancel / Escape route (optional)</label><select class="trigger-form-select event-action-field" data-field="cancelEventId">' + renderEventOptions(action.cancelEventId) + '</select>';
                const pauseWorldField = `<label class="trigger-form-label" style="display:flex;align-items:center;gap:8px;margin:12px 0;"><input class="event-action-field" data-field="pauseWorld" type="checkbox" ${action.pauseWorld === true ? 'checked' : ''}> Pause scene simulation and Mechanics timers in solo Play</label>`;
                return titleField + choices + cancelRoute + pauseWorldField + '<p class="trigger-description">Choose 1–' + CODE_MAX_DIALOGUE_CHOICES + ' unique options. Clicking outside or pressing Escape closes the menu, or runs the optional cancel Event. Option Events run before this Event’s Python resumes. For supported hosted trigger flows, the host replays the trigger-linked declarative Event in order and records enabled routes when it reaches this menu; the Worker and host validate the selected route before the host runs its shared actions. This must be the last action. The menu always pauses the local player; the checkbox also pauses the full simulation and Mechanics timers in solo play. Hosted rooms only pause the local player.</p>';
            }
            default:
                return '<p class="trigger-description error">This action type is not supported. Remove it or choose another action.</p>';
        }
    };

    const readEventActionRow = (row, originalActions = []) => {
        const type = row.querySelector('.event-action-type')?.value;
        const originalIndex = Number(row.dataset.index);
        const originalAction = Array.isArray(originalActions) ? originalActions[originalIndex] : null;
        // Keep fields the current editor does not understand. This lets newer
        // action types survive an edit, reorder, or save in an older client.
        const action = originalAction && typeof originalAction === 'object'
            ? { ...originalAction, type }
            : { type };
       row.querySelectorAll('.event-action-field').forEach(input => {
           const fieldName = input.dataset.field;
           if (!fieldName) return;
           if (input.type === 'checkbox') action[fieldName] = input.checked;
           else if (input.type === 'number') action[fieldName] = input.value.trim() === '' ? '' : Number(input.value);
                else if (fieldName === 'enabled' || fieldName === 'repeat' || fieldName === 'equipped' || fieldName === 'loop') action[fieldName] = input.value === 'true';
           else action[fieldName] = input.value;
       });
       if (type === 'setMovementControl') {
           const defaults = { horizontalAcceleration: 0, airControl: 1, terminalFallSpeed: 16 };
           const limits = { horizontalAcceleration: [0, 20], airControl: [0, 1], terminalFallSpeed: [1, 100] };
           const propertyChanged = originalAction?.property !== action.property;
           const modeBecameCustom = originalAction?.mode !== 'custom' && action.mode === 'custom';
           const [minimum, maximum] = limits[action.property] || [];
           if (propertyChanged || (modeBecameCustom &&
               (!isFiniteActionNumber(action.value) || Number(action.value) < minimum || Number(action.value) > maximum))) {
               action.value = defaults[action.property] ?? 0;
           }
       }
       if (type === 'playObjectSpriteAnimation' && getObjectSpriteAnimationPlayback(action)?.loop !== false) {
           action.completionEventId = '';
       }
       if (type === 'showChoice' || type === 'showMenu') {
            const labels = Array.from(row.querySelectorAll('.event-choice-label'));
            const events = Array.from(row.querySelectorAll('.event-choice-event'));
            action.choices = labels.map((input, index) => ({ label: input.value, eventId: events[index]?.value || '' }))
                .filter(choice => choice.label.trim() || choice.eventId);
       }
        return action;
    };

    const renderEventActions = (event) => {
        const container = document.getElementById('event-actions-list');
        if (!container) return;
        if (!Array.isArray(event.actions)) event.actions = [];
        event.actions = event.actions.filter(action => action && typeof action === 'object');
        container.innerHTML = event.actions.map((action, index) => `
            <div class="trigger-form-group event-action-row" data-index="${index}" style="padding: 16px; border: 1px solid var(--surface-light, #2a2a3a); border-radius: 10px;">
                <div style="display:flex; gap:8px; align-items:center;">
                    <select class="trigger-form-select event-action-type" aria-label="Action type" style="flex:1; min-width:0;">
                        ${CODE_EVENT_ACTION_TYPES.some(option => option.id === action.type) ? '' : `<option value="${escapeHtml(String(action.type ?? ''))}" selected>Unsupported action: ${escapeHtml(String(action.type ?? '(missing type)'))}</option>`}
                        ${CODE_EVENT_ACTION_TYPES.map(option => `<option value="${option.id}" ${option.id === action.type ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                    </select>
                    <button type="button" class="btn btn-secondary event-action-move-up" title="Move action up" aria-label="Move action ${index + 1} up" style="padding:4px 9px; min-width:32px;" ${index === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="btn btn-secondary event-action-move-down" title="Move action down" aria-label="Move action ${index + 1} down" style="padding:4px 9px; min-width:32px;" ${index === event.actions.length - 1 ? 'disabled' : ''}>↓</button>
                    <button type="button" class="btn btn-danger event-action-remove" title="Remove action" aria-label="Remove action">×</button>
                </div>
                <div class="event-action-config" style="display:grid; gap:8px; margin-top:12px;">
                    ${renderEventActionConfig(action, index)}
                </div>
            </div>
        `).join('');
        const addActionButton = document.getElementById('event-add-action');
        if (addActionButton) {
            addActionButton.disabled = event.actions.length >= CODE_MAX_EVENT_ACTIONS;
            addActionButton.title = addActionButton.disabled ? `Maximum ${CODE_MAX_EVENT_ACTIONS} actions` : 'Add an action';
        }

        container.querySelectorAll('.event-action-type').forEach(select => {
            select.addEventListener('change', () => {
                const rows = Array.from(container.querySelectorAll('.event-action-row'));
                event.actions = rows.map(row => readEventActionRow(row, event.actions));
                const index = Number(select.closest('.event-action-row').dataset.index);
                event.actions[index] = createEventAction(select.value);
                renderEventActions(event);
                markUnsaved();
            });
        });
        container.querySelectorAll('.event-action-remove').forEach(button => {
            button.addEventListener('click', () => {
                event.actions = Array.from(container.querySelectorAll('.event-action-row')).map(row => readEventActionRow(row, event.actions));
                event.actions.splice(Number(button.closest('.event-action-row').dataset.index), 1);
                renderEventActions(event);
                markUnsaved();
            });
        });
        container.querySelectorAll('.event-action-move-up, .event-action-move-down').forEach(button => {
            button.addEventListener('click', () => {
                event.actions = Array.from(container.querySelectorAll('.event-action-row')).map(row => readEventActionRow(row, event.actions));
                const fromIndex = Number(button.closest('.event-action-row').dataset.index);
                const toIndex = fromIndex + (button.classList.contains('event-action-move-up') ? -1 : 1);
                if (toIndex < 0 || toIndex >= event.actions.length) return;
                const [action] = event.actions.splice(fromIndex, 1);
                event.actions.splice(toIndex, 0, action);
                renderEventActions(event);
                const movedRow = container.querySelectorAll('.event-action-row')[toIndex];
                movedRow?.querySelector('.event-action-move-up:not(:disabled), .event-action-move-down:not(:disabled)')?.focus();
                markUnsaved();
            });
        });
        container.querySelectorAll('.event-action-field').forEach(input => {
            input.addEventListener('input', markUnsaved);
            input.addEventListener('change', () => {
                markUnsaved();
                if (['variableId', 'playerVariableId', 'operator', 'filterOperator', 'repeat', 'loop', 'pluginId', 'targetMode', 'property', 'objectId', 'mode', 'startFrame', 'animationName'].includes(input.dataset.field)) {
                    event.actions = Array.from(container.querySelectorAll('.event-action-row')).map(row => readEventActionRow(row, event.actions));
                    renderEventActions(event);
                }
            });
        });
        container.querySelectorAll('.event-choice-field').forEach(input => {
            input.addEventListener('input', markUnsaved);
            input.addEventListener('change', markUnsaved);
        });
    };

    const saveEvent = () => {
        if (!editingBlock) return;
        const name = document.getElementById('event-name')?.value.trim();
        if (!name || !isValidName(name)) {
            showToast(name ? 'Invalid name. Cannot use reserved names.' : 'Please enter a name', 'error');
            document.getElementById('event-name')?.focus();
            return;
        }
        const actions = Array.from(document.querySelectorAll('#event-actions-list .event-action-row'))
            .map(row => readEventActionRow(row, editingBlock.actions));
        if (actions.length > CODE_MAX_EVENT_ACTIONS) {
            showToast(`An event can contain at most ${CODE_MAX_EVENT_ACTIONS} actions`, 'error');
            return;
        }
        const draftEvent = { ...editingBlock, name, actions };
        const eventError = getEventError(draftEvent);
        if (eventError) {
            showToast(eventError, 'error');
            return;
        }
        editingBlock.name = name;
        editingBlock.actions = actions;
        const codeData = getCodeData();
        saveCodeData(codeData);
        showToast('Event saved', 'success');
        showDashboard();
    };

    // Show event editor
    const showEventEditor = (event) => {
        currentView = 'editEvent';
        editingBlock = event;
        
        // Update header
        const backBtn = document.getElementById('code-editor-back');
        if (backBtn) {
            backBtn.querySelector('.material-symbols-outlined').textContent = 'arrow_back';
            backBtn.title = 'Back (Escape)';
        }
        
        const title = document.querySelector('.code-editor-title');
        if (title) {
            title.innerHTML = `
                <span class="material-symbols-outlined" style="color: #3b82f6;">code_blocks</span>
                Edit Event
            `;
        }
        
        const newBtn = document.getElementById('code-new-block');
        if (newBtn) newBtn.style.display = 'none';
        const templatesBtn = document.getElementById('code-templates-btn');
        if (templatesBtn) templatesBtn.style.display = 'none';
        
        const content = document.getElementById('code-editor-content');
        if (!content) return;
        
        content.innerHTML = `
            <div class="trigger-editor">
                <div class="trigger-form-group">
                    <label class="trigger-form-label">Event Name</label>
                    <input type="text" class="trigger-form-input" id="event-name" value="${escapeHtml(event.name)}" spellcheck="false">
                </div>

                <div class="trigger-form-group">
                    <label class="trigger-form-label">Actions</label>
                    <p class="trigger-description">Actions run in order when a linked trigger fires.</p>
                    <div id="event-actions-list"></div>
                    <button type="button" class="btn btn-secondary" id="event-add-action" style="width:100%; margin-top:8px;">
                        <span class="material-symbols-outlined">add</span> Add Action
                    </button>
                </div>
                
                <button class="btn btn-primary trigger-save-btn" id="event-save" style="width: 100%;">
                    <span class="material-symbols-outlined">save</span>
                    Save Event
                </button>
            </div>
        `;
        
        if (!Array.isArray(event.actions)) event.actions = [];
        renderEventActions(event);
        document.getElementById('event-add-action').addEventListener('click', () => {
            event.actions = Array.from(document.querySelectorAll('#event-actions-list .event-action-row'))
                .map(row => readEventActionRow(row, event.actions));
            if (event.actions.length >= CODE_MAX_EVENT_ACTIONS) {
                showToast(`An event can contain at most ${CODE_MAX_EVENT_ACTIONS} actions`, 'error');
                return;
            }
            event.actions.push(createEventAction('showMessage'));
            renderEventActions(event);
            markUnsaved();
        });
        document.getElementById('event-name').addEventListener('input', markUnsaved);
        document.getElementById('event-save').addEventListener('click', saveEvent);
    };

    // Show variable editor
    const showVariableEditor = (variable) => {
        currentView = 'editVariable';
        editingBlock = variable;
        if (!['map', 'player'].includes(variable.scope)) variable.scope = 'map';

        // Update header
        const backBtn = document.getElementById('code-editor-back');
        if (backBtn) {
            backBtn.querySelector('.material-symbols-outlined').textContent = 'arrow_back';
            backBtn.title = 'Back (Escape)';
        }

        const title = document.querySelector('.code-editor-title');
        if (title) {
            title.innerHTML = `
                <span class="material-symbols-outlined" style="color: #10b981;">data_object</span>
                Edit Variable
            `;
        }

        const newBtn = document.getElementById('code-new-block');
        if (newBtn) newBtn.style.display = 'none';
        const templatesBtn = document.getElementById('code-templates-btn');
        if (templatesBtn) templatesBtn.style.display = 'none';

        const content = document.getElementById('code-editor-content');
        if (!content) return;

        // Get other variables for import option
        const codeData = getCodeData();
        const otherVariables = codeData.variables.filter(v => v.id !== variable.id);

        const isListType = variable.variableType === CODE_VARIABLE_TYPES.LIST;
        const isSupportedVariableType = [CODE_VARIABLE_TYPES.VARIABLE, CODE_VARIABLE_TYPES.LIST].includes(variable.variableType);

        content.innerHTML = `
            <div class="trigger-editor">
                <div class="trigger-form-group">
                    <label class="trigger-form-label">Variable Name</label>
                    <input type="text" class="trigger-form-input" id="variable-name" value="${escapeHtml(variable.name)}" spellcheck="false">
                </div>

                <div class="trigger-form-group">
                    <label class="trigger-form-label">Variable Type</label>
                    <div class="trigger-option-grid" style="grid-template-columns: repeat(2, 1fr);">
                        <div class="trigger-option-btn ${!isListType ? 'selected' : ''}" data-var-type="variable">
                            <span class="material-symbols-outlined">data_object</span>
                            <span>Variable</span>
                            <small>Single value</small>
                        </div>
                        <div class="trigger-option-btn ${isListType ? 'selected' : ''}" data-var-type="list">
                            <span class="material-symbols-outlined">list</span>
                            <span>List</span>
                            <small>Array of values</small>
                        </div>
                    </div>
                    ${isSupportedVariableType ? '' : `<p class="trigger-description error">This variable type (${escapeHtml(String(variable.variableType))}) is not supported by this version. Its data will be preserved unless you choose Variable or List.</p>`}
                </div>

                <div id="variable-config-section">
                    ${isListType ? renderListConfig(variable, otherVariables) : renderVariableConfig(variable)}
                </div>

                <button class="btn btn-primary trigger-save-btn" id="variable-save" style="width: 100%; margin-top: 24px;">
                    <span class="material-symbols-outlined">save</span>
                    Save Variable
                </button>
            </div>
        `;

        // Variable type selection
        content.querySelectorAll('[data-var-type]').forEach(btn => {
            btn.addEventListener('click', () => {
                content.querySelectorAll('[data-var-type]').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                variable.variableType = btn.dataset.varType;
                if (!['map', 'player'].includes(variable.scope)) variable.scope = 'map';
                
                // Re-render config section
                const configSection = document.getElementById('variable-config-section');
                if (configSection) {
                    const isList = variable.variableType === CODE_VARIABLE_TYPES.LIST;
                    configSection.innerHTML = isList ? renderListConfig(variable, otherVariables) : renderVariableConfig(variable);
                    attachVariableConfigListeners(variable, otherVariables);
                }
                markUnsaved();
            });
        });

        attachVariableConfigListeners(variable, otherVariables);

        // Save button
        document.getElementById('variable-save').addEventListener('click', () => saveVariable());
    };

    // Render variable config (single value)
    const renderVariableConfig = (variable) => {
        const supportedValueType = CODE_VALUE_TYPES.some(type => type.id !== 'variable' && type.id === variable.valueType);
        const valueTypeOptions = CODE_VALUE_TYPES
            .filter(v => v.id !== 'variable')
            .map(v => `<option value="${v.id}" ${variable.valueType === v.id ? 'selected' : ''}>${v.label}</option>`)
            .join('') + (supportedValueType ? '' : `<option value="${escapeHtml(String(variable.valueType ?? ''))}" selected>Unsupported: ${escapeHtml(String(variable.valueType ?? '(missing type)'))}</option>`);

        let defaultValueInput = '';
        switch (variable.valueType) {
            case 'boolean':
                defaultValueInput = `
                    <select class="trigger-form-input" id="variable-default-value">
                        <option value="false" ${variable.defaultValue === false || variable.defaultValue === 'false' ? 'selected' : ''}>false</option>
                        <option value="true" ${variable.defaultValue === true || variable.defaultValue === 'true' ? 'selected' : ''}>true</option>
                    </select>
                `;
                break;
            case 'integer':
            case 'float':
                defaultValueInput = `<input type="number" class="trigger-form-input" id="variable-default-value" value="${escapeHtml(String(variable.defaultValue ?? ''))}" ${variable.valueType === 'integer' ? 'step="1"' : 'step="0.01"'}>`;
                break;
            case 'string':
                defaultValueInput = `<input type="text" class="trigger-form-input" id="variable-default-value" value="${escapeHtml(variable.defaultValue || '')}" maxlength="${CODE_MAX_VARIABLE_STRING_LENGTH}" spellcheck="false">`;
                break;
            default: {
                const savedValue = JSON.stringify(variable.defaultValue);
                defaultValueInput = `<pre class="trigger-description" style="white-space:pre-wrap;overflow-wrap:anywhere;">Preserved value: ${escapeHtml(savedValue === undefined ? 'undefined' : savedValue)}</pre>`;
                break;
            }
        }

        return `
            <div class="trigger-form-group">
                <label class="trigger-form-label">Scope</label>
                <select class="trigger-form-input" id="variable-scope">
                    <option value="map" ${variable.scope !== 'player' ? 'selected' : ''}>Map (shared)</option>
                    <option value="player" ${variable.scope === 'player' ? 'selected' : ''}>Player (separate value per player)</option>
                </select>
                <small class="trigger-description">Player variables are stored separately for each player and can drive that player's conditions and event branches.</small>
            </div>
            <div class="trigger-form-group">
                <label class="trigger-form-label">Value Type</label>
                <select class="trigger-form-input" id="variable-value-type">
                    ${valueTypeOptions}
                </select>
            </div>
            <div class="trigger-form-group">
                <label class="trigger-form-label">Default Value</label>
                ${defaultValueInput}
            </div>
            <div class="trigger-form-group">
                <label class="trigger-form-label" style="display:flex; align-items:center; gap:8px;">
                    <input type="checkbox" id="variable-persist" ${variable.persist === true ? 'checked' : ''}>
                    Save this variable between visits
                </label>
                <small class="trigger-description">Saved in this browser under your account, or under this browser if signed out. It does not sync to other devices.</small>
            </div>
        `;
    };

    // Render list config
    const renderListConfig = (variable, otherVariables) => {
        const listItems = Array.isArray(variable.listItems) ? variable.listItems : [];
        const configuredLength = variable.listLength === undefined ? listItems.length : variable.listLength;
        const validConfiguredLength = Number.isInteger(configuredLength) && configuredLength >= 0 && configuredLength <= CODE_MAX_LIST_ITEMS;
        const listLength = validConfiguredLength ? configuredLength : Math.min(CODE_MAX_LIST_ITEMS, listItems.length);

        let itemsHtml = '';
        for (let i = 0; i < listLength; i++) {
            const item = listItems[i] || { valueType: 'string', value: '' };
            itemsHtml += renderListItem(i, item, otherVariables);
        }

        return `
            <div class="trigger-form-group">
                <label class="trigger-form-label">Scope</label>
                <select class="trigger-form-input" id="variable-scope">
                    <option value="map" ${variable.scope !== 'player' ? 'selected' : ''}>Map (shared)</option>
                    <option value="player" ${variable.scope === 'player' ? 'selected' : ''}>Player (separate List per player)</option>
                </select>
                <small class="trigger-description">Player Lists keep separate values for each player, such as inventory items. Hosted values sync from the host to every client.</small>
            </div>
            <div class="trigger-form-group">
                <label class="trigger-form-label">List Length</label>
                <input type="number" class="trigger-form-input" id="list-length" value="${escapeHtml(String(configuredLength))}" min="0" max="${CODE_MAX_LIST_ITEMS}" step="1">
                <small class="trigger-description">Lists support typed add, remove, and contains branches in Events, up to ${CODE_MAX_LIST_ITEMS} items. String items can use an inventory card: {"name":"Key","icon":"🗝️","description":"Opens the east gate","count":2,"slot":"key","equipped":false}.</small>
            </div>
            <div id="list-items-container">
                ${itemsHtml}
            </div>
            <div class="trigger-form-group">
                <label class="trigger-form-label" style="display:flex; align-items:center; gap:8px;">
                    <input type="checkbox" id="variable-persist" ${variable.persist === true ? 'checked' : ''}>
                    Save this list between visits
                </label>
                <small class="trigger-description">Stored locally for this map and browser account. Test runs and hosted rooms neither load nor write local list saves.</small>
            </div>
        `;
    };

    // Render a single list item
    const renderListItem = (index, item, otherVariables) => {
        const eligibleVariables = otherVariables.filter(v => v.enabled !== false && v.scope !== 'player' && v.variableType !== CODE_VARIABLE_TYPES.LIST);
        const valueTypeOptions = CODE_VALUE_TYPES.map(v => {
            if (v.id === 'variable' && eligibleVariables.length === 0 && item.valueType !== 'variable') return '';
            return `<option value="${v.id}" ${item.valueType === v.id ? 'selected' : ''}>${v.label}</option>`;
        }).join('') + (CODE_VALUE_TYPES.some(type => type.id === item.valueType) ? '' : `<option value="${escapeHtml(String(item.valueType ?? ''))}" selected>Unsupported: ${escapeHtml(String(item.valueType ?? '(missing type)'))}</option>`);

        let valueInput = '';
        if (item.valueType === 'variable') {
            const hasSelectedVariable = eligibleVariables.some(v => v.id === item.value);
            const varOptions = eligibleVariables.map(v =>
                `<option value="${escapeHtml(v.id)}" ${item.value === v.id ? 'selected' : ''}>${escapeHtml(v.name)}</option>`
            ).join('');
            const replacementPrompt = hasSelectedVariable ? '' : `<option value="" selected>${eligibleVariables.length ? 'Choose a replacement variable' : 'No eligible variables available'}</option>`;
            valueInput = `<select class="trigger-form-input list-item-value" data-index="${index}">${replacementPrompt}${varOptions}</select>`;
        } else if (item.valueType === 'boolean') {
            valueInput = `
                <select class="trigger-form-input list-item-value" data-index="${index}">
                    <option value="false" ${item.value === false || item.value === 'false' ? 'selected' : ''}>false</option>
                    <option value="true" ${item.value === true || item.value === 'true' ? 'selected' : ''}>true</option>
                </select>
            `;
        } else if (item.valueType === 'integer' || item.valueType === 'float') {
            valueInput = `<input type="number" class="trigger-form-input list-item-value" data-index="${index}" value="${escapeHtml(String(item.value ?? ''))}" ${item.valueType === 'integer' ? 'step="1"' : 'step="0.01"'}>`;
        } else if (['string', 'integer', 'float'].includes(item.valueType)) {
            valueInput = `<input type="text" class="trigger-form-input list-item-value" data-index="${index}" value="${escapeHtml(item.value || '')}" spellcheck="false">`;
        } else {
            const savedValue = JSON.stringify(item.value);
            valueInput = `<pre class="trigger-description" style="white-space:pre-wrap;overflow-wrap:anywhere;">Preserved value: ${escapeHtml(savedValue === undefined ? 'undefined' : savedValue)}</pre>`;
        }

        return `
            <div class="list-item-row" data-index="${index}" style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
                <span style="min-width: 30px; color: var(--text-muted);">[${index}]</span>
                <select class="trigger-form-input list-item-type" data-index="${index}" style="width: 120px;">
                    ${valueTypeOptions}
                </select>
                <div style="flex: 1;">${valueInput}</div>
            </div>
        `;
    };

    // Attach listeners for variable config
    const attachVariableConfigListeners = (variable, otherVariables) => {
        const scopeSelect = document.getElementById('variable-scope');
        if (scopeSelect) {
            scopeSelect.addEventListener('change', (event) => {
                variable.scope = event.target.value === 'player' ? 'player' : 'map';
                markUnsaved();
            });
        }

        const persistInput = document.getElementById('variable-persist');
        if (persistInput) {
            persistInput.addEventListener('change', (event) => {
                variable.persist = event.target.checked;
                markUnsaved();
            });
        }

        // Value type change (for single variable)
        const valueTypeSelect = document.getElementById('variable-value-type');
        if (valueTypeSelect) {
            valueTypeSelect.addEventListener('change', (e) => {
                variable.valueType = e.target.value;
                // Reset default value to type default
                const typeInfo = CODE_VALUE_TYPES.find(v => v.id === variable.valueType);
                variable.defaultValue = typeInfo?.default ?? '';
                
                // Re-render config
                const configSection = document.getElementById('variable-config-section');
                if (configSection) {
                    configSection.innerHTML = renderVariableConfig(variable);
                    attachVariableConfigListeners(variable, otherVariables);
                }
                markUnsaved();
            });
        }

        // Default value change
        const defaultValueInput = document.getElementById('variable-default-value');
        if (defaultValueInput) {
            defaultValueInput.addEventListener('change', (e) => {
                let value = e.target.value;
                const parsedNumber = value.trim() === '' ? NaN : Number(value);
                if (variable.valueType === 'integer') value = Number.isInteger(parsedNumber) ? parsedNumber : value;
                else if (variable.valueType === 'float') value = Number.isFinite(parsedNumber) ? parsedNumber : value;
                else if (variable.valueType === 'boolean') value = value === 'true';
                variable.defaultValue = value;
                markUnsaved();
            });
        }

        // List length change
        const listLengthInput = document.getElementById('list-length');
        if (listLengthInput) {
            listLengthInput.addEventListener('change', (e) => {
                const rawLength = e.target.value;
                const newLength = rawLength.trim() === '' ? NaN : Number(rawLength);
                if (!Number.isInteger(newLength) || newLength < 0 || newLength > CODE_MAX_LIST_ITEMS) {
                    variable.listLength = Number.isNaN(newLength) ? rawLength : newLength;
                    markUnsaved();
                    return;
                }
                variable.listLength = newLength;
                
                // Adjust list items array
                if (!variable.listItems) variable.listItems = [];
                while (variable.listItems.length < newLength) {
                    variable.listItems.push({ valueType: 'string', value: '' });
                }
                variable.listItems = variable.listItems.slice(0, newLength);
                
                // Re-render list items
                const container = document.getElementById('list-items-container');
                if (container) {
                    let itemsHtml = '';
                    for (let i = 0; i < newLength; i++) {
                        itemsHtml += renderListItem(i, variable.listItems[i], otherVariables);
                    }
                    container.innerHTML = itemsHtml;
                    attachListItemListeners(variable, otherVariables);
                }
                markUnsaved();
            });
        }

        attachListItemListeners(variable, otherVariables);
    };

    // Attach listeners for list items
    const attachListItemListeners = (variable, otherVariables) => {
        // List item type change
        document.querySelectorAll('.list-item-type').forEach(select => {
            select.addEventListener('change', (e) => {
                const index = parseInt(e.target.dataset.index);
                if (!variable.listItems[index]) variable.listItems[index] = {};
                variable.listItems[index].valueType = e.target.value;
                
                // Reset value to type default
                const typeInfo = CODE_VALUE_TYPES.find(v => v.id === e.target.value);
                variable.listItems[index].value = typeInfo?.default ?? '';
                
                // Re-render just this item's value
                const row = e.target.closest('.list-item-row');
                if (row) {
                    const container = document.getElementById('list-items-container');
                    if (container) {
                        let itemsHtml = '';
                        for (let i = 0; i < variable.listLength; i++) {
                            itemsHtml += renderListItem(i, variable.listItems[i], otherVariables);
                        }
                        container.innerHTML = itemsHtml;
                        attachListItemListeners(variable, otherVariables);
                    }
                }
                markUnsaved();
            });
        });

        // List item value change
        document.querySelectorAll('.list-item-value').forEach(input => {
            input.addEventListener('change', (e) => {
                const index = parseInt(e.target.dataset.index);
                if (!variable.listItems[index]) variable.listItems[index] = { valueType: 'string' };
                
                let value = e.target.value;
                const itemType = variable.listItems[index].valueType;
                const parsedNumber = value.trim() === '' ? NaN : Number(value);
                if (itemType === 'integer') value = Number.isInteger(parsedNumber) ? parsedNumber : value;
                else if (itemType === 'float') value = Number.isFinite(parsedNumber) ? parsedNumber : value;
                else if (itemType === 'boolean') value = value === 'true';
                
                variable.listItems[index].value = value;
                markUnsaved();
            });
        });
    };

    // Save variable
    const saveVariable = () => {
        const name = document.getElementById('variable-name')?.value.trim();

        if (!isValidName(name)) {
            showToast('Invalid name. Cannot use reserved names.', 'error');
            return;
        }

        if (!name) {
            showToast('Please enter a name', 'error');
            return;
        }

        if (editingBlock.variableType !== CODE_VARIABLE_TYPES.LIST && editingBlock.valueType === 'string' &&
            String(editingBlock.defaultValue ?? '').length > CODE_MAX_VARIABLE_STRING_LENGTH) {
            showToast(`String defaults can contain at most ${CODE_MAX_VARIABLE_STRING_LENGTH} characters`, 'error');
            document.getElementById('variable-default-value')?.focus();
            return;
        }

        if (editingBlock.variableType === CODE_VARIABLE_TYPES.LIST) {
            const items = Array.isArray(editingBlock.listItems) ? editingBlock.listItems : [];
            const listLength = editingBlock.listLength === undefined ? items.length : editingBlock.listLength;
            if (!Number.isInteger(listLength) || listLength < 0 || listLength > CODE_MAX_LIST_ITEMS || items.length < listLength) {
                showToast(`Lists must contain between 0 and ${CODE_MAX_LIST_ITEMS} configured items`, 'error');
                document.getElementById('list-length')?.focus();
                return;
            }
            for (const item of items.slice(0, listLength)) {
                if (item?.valueType === 'variable') {
                    const reference = getCodeData().variables.find(candidate => candidate.id === item.value && candidate.enabled !== false &&
                        candidate.id !== editingBlock.id && candidate.scope !== 'player' && candidate.variableType !== CODE_VARIABLE_TYPES.LIST &&
                        ['string', 'integer', 'float', 'boolean'].includes(candidate.valueType));
                    if (!reference) {
                        showToast('List items can only reference enabled map-scoped single-value variables', 'error');
                        return;
                    }
                } else if (['string', 'integer', 'float', 'boolean'].includes(item?.valueType) &&
                    !isValidListActionItem(item.valueType, item.value)) {
                    showToast('Fix the typed values in this list before saving it', 'error');
                    return;
                }
            }
        }

        editingBlock.name = name;
        editingBlock.scope = document.getElementById('variable-scope')?.value === 'player' ? 'player' : 'map';
        editingBlock.persist = editingBlock.persist === true;
        if (editingBlock.variableType === CODE_VARIABLE_TYPES.LIST && !Number.isInteger(editingBlock.listLength)) {
            editingBlock.listLength = (Array.isArray(editingBlock.listItems) ? editingBlock.listItems : []).length;
        }

        const variableError = getVariableError(editingBlock);
        const preservesUnknownScalarType = editingBlock.variableType !== CODE_VARIABLE_TYPES.LIST &&
            !['string', 'integer', 'float', 'boolean'].includes(editingBlock.valueType) &&
            variableError === 'Choose a supported variable value type';
        const preservesUnknownListItemType = editingBlock.variableType === CODE_VARIABLE_TYPES.LIST &&
            (Array.isArray(editingBlock.listItems) ? editingBlock.listItems : [])
                .slice(0, editingBlock.listLength)
                .some(item => !CODE_VALUE_TYPES.some(type => type.id === item?.valueType)) &&
            typeof variableError === 'string' && /^List item \d+ has an invalid typed value$/.test(variableError);
        if (variableError && !preservesUnknownScalarType && !preservesUnknownListItemType) {
            showToast(variableError, 'error');
            return;
        }

        const codeData = getCodeData();
        saveCodeData(codeData);

        showToast('Variable saved', 'success');
        showDashboard();
    };
    
    // Open code editor
    const openCodeEditor = () => {
        const overlay = createCodeEditorOverlay();
        overlay.classList.add('active');
        overlay.focus();
        showDashboard();
        
        if (typeof CODE_STATE !== 'undefined') {
            CODE_STATE.isEditorOpen = true;
        }
    };
    
    // Close code editor
    const closeCodeEditor = () => {
        if (codeEditorOverlay) {
            codeEditorOverlay.classList.remove('active');
        }
        hasUnsavedChanges = false;
        
        if (typeof CODE_STATE !== 'undefined') {
            CODE_STATE.isEditorOpen = false;
            CODE_STATE.hasUnsavedChanges = false;
        }
    };
    
    // Escape HTML helper
    const escapeHtml = (text) => {
        if (text == null) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    };
    
    // Export functions
    if (typeof window !== 'undefined') {
        window.CodeEditor = {
            open: openCodeEditor,
            close: closeCodeEditor,
            isOpen: () => typeof CODE_STATE !== 'undefined' ? CODE_STATE.isEditorOpen : false
        };
    }
})();
