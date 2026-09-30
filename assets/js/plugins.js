/**
 * PARKOREEN - Plugin Manager
 * Handles loading, enabling, and managing game plugins
 */

const PLUGIN_SCRIPT_ROLES = new Set(['skulpt', 'skulptStdlib', 'pythonCompiler', 'globals', 'inject', 'script', 'editor', 'editorUi']);
const PLUGIN_CONFIG_TYPES = new Set(['boolean', 'number', 'select', 'string']);
const PLUGIN_RESERVED_INPUTS = new Set(['left', 'right', 'up', 'down', 'jump', 'shift', 'space', 'attack', 'heal', 'dash', 'superDash']);
const PLUGIN_ACTION_INPUTS = new Set(['attack', 'heal', 'dash', 'superDash']);
const PLUGIN_CORE_MOVEMENT_INPUTS = new Set(['left', 'right', 'up', 'down', 'jump', 'shift', 'space']);
const PLUGIN_HOOK_FAILURE_LIMIT = 3;

// ============================================
// PLUGIN MANAGER
// ============================================
class PluginManager {
    constructor() {
        this.plugins = new Map(); // pluginId -> plugin metadata
        this.enabled = new Set(); // Set of enabled plugin IDs
        this.loadedScripts = new Map(); // pluginId -> { globals, inject, script }
        this.sounds = new Map(); // pluginId -> { soundName: Audio }
        this.hooks = {}; // Hook name -> array of callbacks
        this.pluginCleanups = new Map(); // pluginId -> Set<cleanup callback>
        this.hookDiagnostics = new Map(); // pluginId -> bounded list of quarantined hook errors
        this.loadDiagnostics = new Map(); // pluginId -> last bounded load or initialization error
        this.enabling = new Set();
        this.basePath = '/parkoreen/assets/plugins/';
        this.apiVersion = 1;
        this.localDevelopmentEventSource = null;
        this.localDevelopmentToken = null;
    }

    startLocalDevelopmentWatcher(pluginId, token) {
        if (typeof window.EventSource !== 'function') return;
        const endpoint = new URL('/__plugin_dev__/events', window.location.origin);
        endpoint.searchParams.set('id', pluginId);
        endpoint.searchParams.set('token', token);
        const source = new window.EventSource(endpoint.href);
        source.addEventListener('change', () => {
            if (this.localDevelopmentEventSource?.has(source)) window.location.reload();
        });
        if (!this.localDevelopmentEventSource) this.localDevelopmentEventSource = new Set();
        this.localDevelopmentEventSource.add(source);
    }

    getLocalDevelopmentPluginIds() {
        const hostname = window.location?.hostname?.toLowerCase();
        const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
        const params = new URLSearchParams(window.location?.search || '');
        const requestedIds = params.get('pluginDev');
        if (!requestedIds) return [];
        if (!isLoopback) {
            console.warn('[PluginManager] Local plugin development is available only on localhost or loopback.');
            return [];
        }
        const token = params.get('pluginDevToken');
        if (!/^[A-Za-z0-9_-]{40,64}$/.test(token || '')) {
            console.warn('[PluginManager] Local plugin preview requires the one-time token printed by tools/serve-plugin-dev.mjs.');
            return [];
        }
        this.localDevelopmentToken = token;
        const ids = [...new Set(requestedIds.split(',').map(id => id.trim()).filter(Boolean))];
        if (!ids.length || ids.length > 8 || ids.some(id => !this.isValidPluginId(id))) {
            console.warn('[PluginManager] Ignoring invalid local plugin ids in pluginDev (provide up to 8 comma-separated lowercase ids).');
            return [];
        }
        return ids;
    }

    isValidPluginId(id) {
        return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(id);
    }

    isSafePluginAssetPath(path) {
        if (typeof path !== 'string' || !/^[a-zA-Z0-9._/-]+$/.test(path)) return false;
        if (path.startsWith('/') || path.includes('\\') || path.includes(':')) return false;
        return path.split('/').every(part => part && part !== '.' && part !== '..');
    }

    isValidPluginConfig(config) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
        for (const [key, field] of Object.entries(config)) {
            if (!key || !field || typeof field !== 'object' || Array.isArray(field) || !PLUGIN_CONFIG_TYPES.has(field.type) ||
                !Object.hasOwn(field, 'default')) return false;
            if (field.label !== undefined && (typeof field.label !== 'string' || !field.label.trim())) return false;
            if (field.type === 'boolean' && typeof field.default !== 'boolean') return false;
            if (field.type === 'string' && typeof field.default !== 'string') return false;
            if (field.type === 'number') {
                if (typeof field.default !== 'number' || !Number.isFinite(field.default)) return false;
                if (field.min !== undefined && (typeof field.min !== 'number' || !Number.isFinite(field.min))) return false;
                if (field.max !== undefined && (typeof field.max !== 'number' || !Number.isFinite(field.max))) return false;
                if (field.min !== undefined && field.max !== undefined && field.min > field.max) return false;
                if (field.min !== undefined && field.default < field.min) return false;
                if (field.max !== undefined && field.default > field.max) return false;
            }
            if (field.type === 'select') {
                if (!Array.isArray(field.options) || field.options.length === 0) return false;
                const options = new Set();
                for (const option of field.options) {
                    if (!option || typeof option !== 'object' || Array.isArray(option) || typeof option.label !== 'string' || !option.label.trim() ||
                        !['string', 'number', 'boolean'].includes(typeof option.value) ||
                        (typeof option.value === 'number' && !Number.isFinite(option.value))) return false;
                    const optionKey = `${typeof option.value}:${String(option.value)}`;
                    if (options.has(optionKey)) return false;
                    options.add(optionKey);
                }
                if (!options.has(`${typeof field.default}:${String(field.default)}`)) return false;
            }
            if (field.showIf !== undefined &&
                (typeof field.showIf !== 'string' || !Object.hasOwn(config, field.showIf) || config[field.showIf]?.type !== 'boolean')) return false;
        }
        return true;
    }

    isValidPluginManifest(folderId, metadata) {
        if (!this.isValidPluginId(folderId) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            return false;
        }
        // API v1 plugins are trusted page scripts. Reject permission claims
        // until a runtime can enforce them, rather than silently ignoring them.
        if (Object.hasOwn(metadata, 'permissions')) {
            console.warn(`[PluginManager] Skipping ${folderId}: API v1 does not support manifest permissions`);
            return false;
        }
        if (metadata.id !== folderId || typeof metadata.name !== 'string' || !metadata.name.trim() ||
            typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version) ||
            typeof metadata.description !== 'string' || !metadata.description.trim() ||
            typeof metadata.author !== 'string' || !metadata.author.trim()) return false;
        if (metadata.color !== undefined && (typeof metadata.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(metadata.color))) return false;
        if (metadata.icon !== undefined && (typeof metadata.icon !== 'string' || !metadata.icon.trim() || metadata.icon.length > 32)) return false;
        if (metadata.coverHeight !== undefined && (typeof metadata.coverHeight !== 'number' ||
            !Number.isFinite(metadata.coverHeight) || metadata.coverHeight < 1 || metadata.coverHeight > 600)) return false;
        if (metadata.beta !== undefined && typeof metadata.beta !== 'boolean') return false;
        if (metadata.hideInPluginLibrary !== undefined && typeof metadata.hideInPluginLibrary !== 'boolean') return false;
        if (metadata.features !== undefined && (!Array.isArray(metadata.features) ||
            metadata.features.some(feature => typeof feature !== 'string' || !/^[a-z][A-Za-z0-9_-]{0,63}$/.test(feature)) ||
            new Set(metadata.features).size !== metadata.features.length)) return false;

        const apiVersion = metadata.apiVersion;
        if (!Number.isInteger(apiVersion) || apiVersion !== this.apiVersion) {
            console.warn(`[PluginManager] Skipping ${folderId}: unsupported plugin API version ${apiVersion}`);
            return false;
        }

        const assetPaths = [];
        if (metadata.cover !== undefined) assetPaths.push(metadata.cover);
        if (!metadata.scripts || typeof metadata.scripts !== 'object' || Array.isArray(metadata.scripts) || Object.keys(metadata.scripts).length === 0) return false;
        for (const [role, assetPath] of Object.entries(metadata.scripts)) {
            if (!PLUGIN_SCRIPT_ROLES.has(role) || typeof assetPath !== 'string' || !assetPath.toLowerCase().endsWith('.js')) return false;
            assetPaths.push(assetPath);
        }
        if (metadata.assets !== undefined) {
            if (!metadata.assets || typeof metadata.assets !== 'object' || Array.isArray(metadata.assets)) return false;
            for (const [name, assetPath] of Object.entries(metadata.assets)) {
                if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return false;
                assetPaths.push(assetPath);
            }
        }
        if (!assetPaths.every(path => this.isSafePluginAssetPath(path))) {
            console.warn(`[PluginManager] Skipping ${folderId}: manifest contains an unsafe asset path`);
            return false;
        }

        if (!Array.isArray(metadata.dependencies || [])) return false;
        const dependencies = metadata.dependencies || [];
        if (!dependencies.every(id => this.isValidPluginId(id) && id !== folderId) || new Set(dependencies).size !== dependencies.length) return false;
        if (!this.isValidPluginConfig(metadata.config)) return false;
        if (metadata.sounds !== undefined) {
            if (!metadata.sounds || typeof metadata.sounds !== 'object' || Array.isArray(metadata.sounds)) return false;
            for (const [name, paths] of Object.entries(metadata.sounds)) {
                const assetList = Array.isArray(paths) ? paths : [paths];
                if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || !assetList.length || !assetList.every(path => this.isSafePluginAssetPath(path))) return false;
            }
        }
        if (metadata.controls !== undefined) {
            if (!metadata.controls || typeof metadata.controls !== 'object' || Array.isArray(metadata.controls)) return false;
            for (const [controlId, control] of Object.entries(metadata.controls)) {
                if (PLUGIN_CORE_MOVEMENT_INPUTS.has(controlId)) {
                    console.warn(`[PluginManager] Skipping ${folderId}: control id "${controlId}" is reserved by core movement input`);
                    return false;
                }
                if (!/^[a-z][A-Za-z0-9_-]{0,63}$/.test(controlId) || !control || typeof control !== 'object' || Array.isArray(control) ||
                    typeof control.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(control.key) ||
                    typeof control.label !== 'string' || !control.label.trim() || control.label.length > 64 ||
                    (control.description !== undefined && (typeof control.description !== 'string' || control.description.length > 256)) ||
                    Object.keys(control).some(key => !['key', 'label', 'description'].includes(key))) return false;
            }
            for (const [existingPluginId, existingPlugin] of this.plugins) {
                if (existingPluginId === folderId) continue;
                const collision = Object.keys(metadata.controls).find(controlId =>
                    Object.hasOwn(existingPlugin?.controls || {}, controlId));
                if (collision) {
                    console.warn(`[PluginManager] Skipping ${folderId}: control id "${collision}" is already declared by ${existingPluginId}`);
                    return false;
                }
            }
        }
        if (metadata.editorFeatures !== undefined && (!metadata.editorFeatures || typeof metadata.editorFeatures !== 'object' || Array.isArray(metadata.editorFeatures) ||
            Object.entries(metadata.editorFeatures).some(([featureId, enabled]) =>
                !/^[a-z][A-Za-z0-9_-]{0,63}$/.test(featureId) || typeof enabled !== 'boolean'))) return false;
        if (metadata.worldObjectGuards !== undefined && (!Array.isArray(metadata.worldObjectGuards) || metadata.worldObjectGuards.length > 128 ||
            !metadata.worldObjectGuards.every(guard => {
                if (!guard || typeof guard !== 'object' || Array.isArray(guard)) return false;
                const allowed = ['type', 'actingType', 'appearanceType', 'section', 'name'];
                if (Object.keys(guard).some(key => !allowed.includes(key))) return false;
                if (!['type', 'actingType', 'appearanceType'].some(key => typeof guard[key] === 'string' && guard[key].trim())) return false;
                return ['type', 'actingType', 'appearanceType'].every(key => guard[key] === undefined ||
                    (typeof guard[key] === 'string' && Boolean(guard[key].trim()) && guard[key].length <= 128)) &&
                    ['section', 'name'].every(key => guard[key] === undefined ||
                        (typeof guard[key] === 'string' && Boolean(guard[key].trim()) && guard[key].length <= (key === 'section' ? 64 : 128)));
            }))) return false;
        return true;
    }

    registerPluginCleanup(pluginId, cleanup) {
        if (typeof cleanup !== 'function') return () => {};
        let cleanups = this.pluginCleanups.get(pluginId);
        if (!cleanups) {
            cleanups = new Set();
            this.pluginCleanups.set(pluginId, cleanups);
        }
        const dispose = () => {
            if (!cleanups.delete(dispose)) return;
            if (cleanups.size === 0 && this.pluginCleanups.get(pluginId) === cleanups) {
                this.pluginCleanups.delete(pluginId);
            }
            try {
                cleanup();
            } catch (error) {
                console.warn(`[PluginManager] Cleanup failed for ${pluginId}:`, error);
            }
        };
        cleanups.add(dispose);
        return dispose;
    }

    cleanupPluginResources(pluginId) {
        const cleanups = this.pluginCleanups.get(pluginId);
        if (!cleanups) return;
        this.pluginCleanups.delete(pluginId);
        for (const dispose of Array.from(cleanups)) dispose();
    }

    addPluginEventListener(pluginId, target, eventName, listener, options) {
        if (!target?.addEventListener || typeof listener !== 'function') {
            throw new TypeError('Plugin event listeners require an EventTarget and callback');
        }
        target.addEventListener(eventName, listener, options);
        return this.registerPluginCleanup(pluginId, () => {
            target.removeEventListener(eventName, listener, options);
        });
    }

    createPluginApi(pluginId, world) {
        const plugin = this.plugins.get(pluginId);
        return Object.freeze({
            apiVersion: this.apiVersion,
            pluginId,
            registerHook: (hookName, callback, priority = 10) =>
                this.registerHook(hookName, callback, pluginId, priority),
            addEventListener: (target, eventName, listener, options) =>
                this.addPluginEventListener(pluginId, target, eventName, listener, options),
            onCleanup: cleanup => this.registerPluginCleanup(pluginId, cleanup),
            getConfig: () => ({ ...(world?.plugins?.[pluginId] || {}) }),
            getAssetUrl: name => {
                if (typeof name !== 'string' || !plugin?.assets || !Object.hasOwn(plugin.assets, name)) return null;
                return this.getPluginAssetUrl(plugin, plugin.assets[name]);
            },
            playSound: (soundName, volume = 1) => this.playSound(pluginId, soundName, volume)
        });
    }

    ensureWorldPluginConfig(pluginId, plugin, world) {
        if (!world) return;
        const currentPlugins = world.plugins;
        const validPluginMap = currentPlugins && typeof currentPlugins === 'object' && !Array.isArray(currentPlugins);
        if (!validPluginMap || Object.getPrototypeOf(currentPlugins) !== null) {
            const safePlugins = Object.create(null);
            if (validPluginMap) {
                for (const key of Object.keys(currentPlugins)) safePlugins[key] = currentPlugins[key];
            }
            world.plugins = safePlugins;
        }
        if (!Array.isArray(world.plugins.enabled)) world.plugins.enabled = [];

        const defaults = Object.create(null);
        for (const [key, config] of Object.entries(plugin.config || {})) {
            defaults[key] = config.default;
        }
        const saved = world.plugins[pluginId];
        const savedConfig = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
        world.plugins[pluginId] = Object.assign(Object.create(null), defaults, savedConfig);
    }
    
    // ============================================
    // PLUGIN DISCOVERY & LOADING
    // ============================================
    
    async discoverPlugins() {
        let ids = [];
        try {
            const man = await fetch(`${this.basePath}manifest.json`);
            if (man.ok) {
                const j = await man.json();
                ids = Array.isArray(j.plugins) ? j.plugins : [];
            }
        } catch (e) {
            console.warn('[PluginManager] manifest.json failed:', e);
        }
        if (ids.length === 0) {
            ids = ['code', 'cj', 'hp', 'hk'];
        }

        const localDevelopmentPluginIds = this.getLocalDevelopmentPluginIds();
        const localDevelopmentIds = new Set();
        for (const localId of localDevelopmentPluginIds) {
            if (ids.includes(localId)) {
                console.warn(`[PluginManager] Local development mode cannot override registered plugin ${localId}.`);
            } else {
                ids.push(localId);
                localDevelopmentIds.add(localId);
                this.startLocalDevelopmentWatcher(localId, this.localDevelopmentToken);
            }
        }

        const discoveredIds = new Set();
        for (const id of ids) {
            if (!this.isValidPluginId(id) || discoveredIds.has(id)) {
                console.warn(`[PluginManager] Skipping invalid or duplicate plugin id: ${id}`);
                continue;
            }
            discoveredIds.add(id);
            try {
                const manifestUrl = new URL(`${this.basePath}${id}/plugin.json`, document.baseURI);
                const isLocalDevelopmentPlugin = localDevelopmentIds.has(id);
                if (isLocalDevelopmentPlugin) {
                    manifestUrl.searchParams.set('dev', String(Date.now()));
                    manifestUrl.searchParams.set('devToken', this.localDevelopmentToken);
                }
                const response = await fetch(manifestUrl.href, isLocalDevelopmentPlugin ? { cache: 'no-store' } : undefined);
                if (response.ok) {
                    const metadata = await response.json();
                    if (!this.isValidPluginManifest(id, metadata)) {
                        console.warn(`[PluginManager] Skipping invalid plugin manifest: ${id}`);
                        continue;
                    }
                    const folderId = id;
                    this.plugins.set(folderId, {
                        ...metadata,
                        apiVersion: metadata.apiVersion,
                        path: `${this.basePath}${id}/`,
                        localDevelopment: isLocalDevelopmentPlugin
                    });
                }
            } catch (e) {
                console.warn(`Failed to load plugin ${id}:`, e);
            }
        }

        let removedDependency = true;
        while (removedDependency) {
            removedDependency = false;
            for (const [id, plugin] of this.plugins) {
                const missingDependency = (plugin.dependencies || []).find(dependency => !this.plugins.has(dependency));
                if (!missingDependency) continue;
                console.warn(`[PluginManager] Skipping ${id}: missing dependency ${missingDependency}`);
                this.plugins.delete(id);
                removedDependency = true;
            }
        }

        return Array.from(this.plugins.values());
    }
    
    async loadPluginScripts(pluginId) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) throw new Error(`Plugin ${pluginId} is not registered`);
        if (this.loadedScripts.has(pluginId)) return;

        const assetUrl = relativePath => this.getPluginAssetUrl(plugin, relativePath);
        
        const scripts = {};
        const loadTextScript = async role => {
            const response = await fetch(assetUrl(plugin.scripts[role]));
            if (!response.ok) throw new Error(`${role} returned HTTP ${response.status}`);
            scripts[role] = await response.text();
        };
        
        // Load library scripts first (executed as <script> tags for global scope)
        // These are scripts that need to run in global scope (like Skulpt)
        const libraryScripts = ['skulpt', 'skulptStdlib', 'pythonCompiler'];
        for (const scriptName of libraryScripts) {
            if (plugin.scripts?.[scriptName]) {
                await this.loadScriptTag(assetUrl(plugin.scripts[scriptName]));
            }
        }
        
        // These source roles run only after the complete plugin package loads.
        for (const role of ['globals', 'inject', 'script']) {
            if (plugin.scripts?.[role]) await loadTextScript(role);
        }

        // Load editor script (for plugins with editor UI).
        if (plugin.scripts?.editor) {
            await this.loadScriptTag(assetUrl(plugin.scripts.editor));
        }
        
        this.loadedScripts.set(pluginId, scripts);
        
        // Load sounds
        if (plugin.sounds) {
            await this.loadPluginSounds(pluginId, plugin);
        }
    }
    
    // Load a script as a <script> tag (for libraries that need global scope)
    loadScriptTag(src) {
        return new Promise((resolve, reject) => {
            const scriptUrl = new URL(src, document.baseURI).href;
            // Check if already loaded
            if (Array.from(document.scripts).some(script => script.src === scriptUrl)) {
                resolve();
                return;
            }
            
            const script = document.createElement('script');
            script.src = scriptUrl;
            script.onload = resolve;
            script.onerror = () => {
                script.remove();
                reject(new Error(`Failed to load plugin script: ${src}`));
            };
            document.head.appendChild(script);
        });
    }
    
    async loadPluginSounds(pluginId, plugin) {
        const sounds = {};
        const assetUrl = relativePath => this.getPluginAssetUrl(plugin, relativePath);
        
        for (const [name, path] of Object.entries(plugin.sounds)) {
            if (Array.isArray(path)) {
                // Multiple sounds (for random selection)
                sounds[name] = path.map(p => {
                    const audio = new Audio(assetUrl(p));
                    audio.volume = 1;
                    return audio;
                });
            } else {
                const audio = new Audio(assetUrl(path));
                audio.volume = 1;
                if (name === 'superdashFlying') {
                    audio.loop = true;
                }
                sounds[name] = audio;
            }
        }
        
        this.sounds.set(pluginId, sounds);
    }
    
    // ============================================
    // PLUGIN ENABLE/DISABLE
    // ============================================
    
    async enablePlugin(pluginId, world) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) {
            const error = 'Plugin is not registered in this runtime';
            this.loadDiagnostics.set(pluginId, error);
            return { success: false, error };
        }
        if (this.enabled.has(pluginId)) {
            this.loadDiagnostics.delete(pluginId);
            return { success: true };
        }
        if (this.enabling.has(pluginId)) {
            const error = `Cyclic plugin dependency involving ${pluginId}`;
            this.loadDiagnostics.set(pluginId, error);
            return { success: false, error };
        }
        this.enabling.add(pluginId);
        
        // Check dependencies
        for (const depId of plugin.dependencies || []) {
            if (!this.enabled.has(depId)) {
                // Auto-enable dependency
                const result = await this.enablePlugin(depId, world);
                if (!result.success) {
                    this.enabling.delete(pluginId);
                    const error = `Dependency ${depId} failed: ${result.error}`;
                    this.loadDiagnostics.set(pluginId, error.slice(0, 300));
                    return { success: false, error };
                }
            }
        }
        this.enabling.delete(pluginId);

        // Plugins read config while their inject script runs, so materialize
        // manifest defaults and preserve saved values before creating context.
        this.ensureWorldPluginConfig(pluginId, plugin, world);
        
        // Load scripts if not loaded
        try {
            await this.loadPluginScripts(pluginId);
        } catch (error) {
            this.cleanupPluginResources(pluginId);
            const message = `Could not load ${plugin.name}: ${error.message}`.slice(0, 300);
            this.loadDiagnostics.set(pluginId, message);
            return { success: false, error: message };
        }
        
        // Execute globals (defines constants/variables)
        const scripts = this.loadedScripts.get(pluginId);
        if (scripts?.globals) {
            try {
                eval(scripts.globals);
            } catch (e) {
                this.cleanupPluginResources(pluginId);
                const message = `${plugin.name} failed during globals initialization: ${e.message}`.slice(0, 300);
                this.loadDiagnostics.set(pluginId, message);
                return { success: false, error: message };
            }
        }
        
        // Execute inject (hooks into game systems)
        if (scripts?.inject) {
            try {
                // Create a context for the plugin
                const ctx = {
                    api: this.createPluginApi(pluginId, world),
                    pluginManager: this,
                    pluginId,
                    world,
                    hooks: this.hooks,
                    sounds: this.sounds.get(pluginId) || {}
                };
                const injectFn = new Function('ctx', scripts.inject);
                injectFn(ctx);
            } catch (e) {
                this.cleanupPluginResources(pluginId);
                const message = `${plugin.name} failed during inject initialization: ${e.message}`.slice(0, 300);
                this.loadDiagnostics.set(pluginId, message);
                return { success: false, error: message };
            }
        }
        
        // Execute main script
        if (scripts?.script) {
            try {
                eval(scripts.script);
            } catch (e) {
                this.cleanupPluginResources(pluginId);
                const message = `${plugin.name} failed during script initialization: ${e.message}`.slice(0, 300);
                this.loadDiagnostics.set(pluginId, message);
                return { success: false, error: message };
            }
        }
        
        this.enabled.add(pluginId);
        this.loadDiagnostics.delete(pluginId);
        
        // Add to world's enabled plugins and initialize config if needed
        if (world) {
            if (!world.plugins.enabled.includes(pluginId)) {
                world.plugins.enabled.push(pluginId);
            }
        }
        
        return { success: true };
    }
    
    disablePlugin(pluginId, world) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) return { success: false, error: 'Plugin not found' };
        
        // Check if other enabled plugins depend on this one
        for (const [otherId, otherPlugin] of this.plugins) {
            if (this.enabled.has(otherId) && (otherPlugin.dependencies || []).includes(pluginId)) {
                return { 
                    success: false, 
                    error: `Cannot disable: ${otherPlugin.name} depends on this plugin`
                };
            }
        }
        
        // Check for plugin objects in the world
        if (world) {
            const pluginObjects = this.getPluginObjects(pluginId, world);
            if (pluginObjects.length > 0) {
                const locations = pluginObjects.map(o => `${o.section}/${o.name}`).join(', ');
                return {
                    success: false,
                    error: `Cannot disable: Objects still using this plugin at: ${locations}`
                };
            }
        }
        
        this.enabled.delete(pluginId);
        
        // Remove from world's enabled plugins
        if (world) {
            const idx = world.plugins.enabled.indexOf(pluginId);
            if (idx !== -1) {
                world.plugins.enabled.splice(idx, 1);
            }
        }
        
        this.cleanupPluginResources(pluginId);
        this.hookDiagnostics.delete(pluginId);
        
        return { success: true };
    }
    
    isEnabled(pluginId) {
        return this.enabled.has(pluginId);
    }

    getLoadDiagnostic(pluginId) {
        return this.loadDiagnostics.get(pluginId) || '';
    }
    
    getPluginObjects(pluginId, world) {
        const objects = [];
        const plugin = this.plugins.get(pluginId);
        const guards = plugin?.worldObjectGuards;
        if (!guards || !world?.objects) return objects;

        for (const obj of world.objects) {
            for (const g of guards) {
                let match = true;
                if (g.actingType !== undefined && obj.actingType !== g.actingType) match = false;
                if (g.appearanceType !== undefined && obj.appearanceType !== g.appearanceType) match = false;
                if (g.type !== undefined && obj.type !== g.type) match = false;
                if (match) {
                    objects.push({
                        section: g.section || 'Map',
                        name: g.name || 'Object',
                        obj
                    });
                    break;
                }
            }
        }
        return objects;
    }

    /** True if any enabled plugin on the world declares editorFeatures[key] === true */
    hasEditorFeature(world, featureKey) {
        if (!world?.plugins?.enabled) return false;
        for (const id of world.plugins.enabled) {
            const p = this.plugins.get(id);
            if (p?.editorFeatures?.[featureKey]) return true;
        }
        return false;
    }

    /** Plugins that list depId in dependencies and are currently enabled */
    getEnabledDependents(world, depId) {
        const out = [];
        if (!world?.plugins?.enabled) return out;
        for (const id of world.plugins.enabled) {
            const p = this.plugins.get(id);
            if ((p?.dependencies || []).includes(depId)) out.push(id);
        }
        return out;
    }

    /** Load optional editor UI scripts (editorUi from plugin.json), then invoke ParkoreenEditorPluginUI[id](editor) */
    async loadEditorPluginPanels(editor) {
        if (this.plugins.size === 0) await this.discoverPlugins();
        const loadOrder = Array.from(this.plugins.keys());
        for (const id of loadOrder) {
            const p = this.plugins.get(id);
            const rel = p?.scripts?.editorUi;
            if (!rel) continue;
            const url = new URL(rel, new URL(p.path, document.baseURI));
            if (typeof p.version === 'string' && p.version) url.searchParams.set('v', p.version);
            if (p.localDevelopment) {
                url.searchParams.set('dev', String(Date.now()));
                url.searchParams.set('devToken', this.localDevelopmentToken);
            }
            try {
                await this.loadScriptTag(url.href);
            } catch (e) {
                console.warn(`[PluginManager] editor UI load failed ${id}:`, e);
            }
        }
        const reg = window.ParkoreenEditorPluginUI;
        if (reg && typeof reg === 'object') {
            for (const id of loadOrder) {
                if (typeof reg[id] === 'function') {
                    try {
                        reg[id](editor);
                    } catch (e) {
                        console.error(`[PluginManager] editor UI init failed ${id}:`, e);
                    }
                }
            }
        }
    }
    
    // ============================================
    // HOOK SYSTEM
    // ============================================
    
    /**
     * Register a hook callback
     * @param {string} hookName - Name of the hook
     * @param {Function} callback - Callback function
     * @param {string} pluginId - ID of the plugin registering the hook
     * @param {number} priority - Lower priority runs first (default: 10)
     */
    registerHook(hookName, callback, pluginId, priority = 10) {
        if (typeof hookName !== 'string' || !hookName.trim()) {
            throw new TypeError('Plugin hook names must be non-empty strings');
        }
        if (typeof callback !== 'function') {
            throw new TypeError(`Plugin hook ${hookName} requires a callback`);
        }
        if (!Number.isFinite(priority)) priority = 10;
        if (!this.hooks[hookName]) {
            this.hooks[hookName] = [];
        }

        const hook = { callback, pluginId, priority, consecutiveFailures: 0, disabled: false, dispose: null };
        this.hooks[hookName].push(hook);
        this.hooks[hookName].sort((a, b) => a.priority - b.priority);
        hook.dispose = this.registerPluginCleanup(pluginId, () => {
            hook.disabled = true;
            const hooks = this.hooks[hookName];
            if (!hooks) return;
            const index = hooks.indexOf(hook);
            if (index !== -1) hooks.splice(index, 1);
        });
        return hook.dispose;
    }
    
    /**
     * Execute all callbacks for a hook
     * @param {string} hookName - Name of the hook
     * @param {Object} data - Data to pass to callbacks
     * @returns {Object} - Modified data after all callbacks
     */
    executeHook(hookName, data = {}) {
        const hooks = this.hooks[hookName];
        if (!hooks || hooks.length === 0) return data;

        for (const hook of hooks.slice()) {
            if (hook.disabled) continue;
            try {
                const result = hook.callback(data);
                hook.consecutiveFailures = 0;
                if (result !== undefined) {
                    data = { ...data, ...result };
                }
            } catch (e) {
                hook.consecutiveFailures++;
                if (hook.consecutiveFailures >= PLUGIN_HOOK_FAILURE_LIMIT) {
                    hook.disabled = true;
                    hook.dispose?.();
                    const diagnostics = this.hookDiagnostics.get(hook.pluginId) || [];
                    diagnostics.push({
                        hookName,
                        message: String(e?.message || e).slice(0, 240),
                        time: Date.now()
                    });
                    if (diagnostics.length > 16) diagnostics.shift();
                    this.hookDiagnostics.set(hook.pluginId, diagnostics);
                    console.error(`Disabled plugin hook ${hookName} from ${hook.pluginId} after ${PLUGIN_HOOK_FAILURE_LIMIT} consecutive failures:`, e);
                } else {
                    console.error(`Error in hook ${hookName} from ${hook.pluginId} (${hook.consecutiveFailures}/${PLUGIN_HOOK_FAILURE_LIMIT} consecutive failures):`, e);
                }
            }
        }

        return data;
    }

    getHookDiagnostics(pluginId) {
        return (this.hookDiagnostics.get(pluginId) || []).map(item => ({ ...item }));
    }

    updatePlayerControls(player, keys) {
        if (!player?.input || !keys) return;
        if (!this.playerControlIds) this.playerControlIds = new Set();
        if (!this.playerControlKeys) this.playerControlKeys = new WeakMap();
        this.playerControlKeys.set(player, keys);
        const touchInputs = this.touchPlayerControls?.get(player) || new Set();

        // Clear previous custom controls first so disabling a plugin or changing
        // maps cannot leave a held input stuck on the player.
        for (const controlId of this.playerControlIds) player.input[controlId] = false;

        const bindings = new Map();
        for (const pluginId of this.enabled) {
            const plugin = this.plugins.get(pluginId);
            for (const [controlId, control] of Object.entries(plugin?.controls || {})) {
                // Core input names belong to Parkoreen's keyboard and touch layouts.
                if (PLUGIN_RESERVED_INPUTS.has(controlId) || Object.hasOwn(player.input, controlId)) continue;
                if (!bindings.has(controlId)) bindings.set(controlId, new Set());
                bindings.get(controlId).add(control.key);
            }
        }

        for (const [controlId, keyCodes] of bindings) {
            player.input[controlId] = touchInputs.has(controlId) || Array.from(keyCodes).some(keyCode => keys[keyCode] === true);
            this.playerControlIds.add(controlId);
        }
    }

    getTouchControls() {
        const controls = new Map();
        for (const pluginId of this.enabled) {
            for (const [controlId, control] of Object.entries(this.plugins.get(pluginId)?.controls || {})) {
                if (PLUGIN_RESERVED_INPUTS.has(controlId)) continue;
                controls.set(controlId, { id: controlId, label: control.label });
            }
        }
        return Array.from(controls.values());
    }

    getMechanicsActionControls() {
        const controls = new Map(this.getTouchControls().map(control => [control.id, control]));
        // These reserved fields have built-in keyboard/touch mappings, so they
        // are deliberately absent from the generic plugin touch-control list.
        // They remain valid Player Action Input triggers when an enabled plugin
        // (such as Hollow Knight) explicitly declares them.
        for (const pluginId of this.enabled) {
            for (const [controlId, control] of Object.entries(this.plugins.get(pluginId)?.controls || {})) {
                if (!PLUGIN_ACTION_INPUTS.has(controlId)) continue;
                controls.set(controlId, { id: controlId, label: control.label, pluginId });
            }
        }
        return Array.from(controls.values());
    }

    setPlayerTouchControl(player, controlId, pressed) {
        if (!player?.input || PLUGIN_RESERVED_INPUTS.has(controlId)) return false;
        if (!this.touchPlayerControls) this.touchPlayerControls = new WeakMap();
        let touchInputs = this.touchPlayerControls.get(player);
        if (!touchInputs) {
            touchInputs = new Set();
            this.touchPlayerControls.set(player, touchInputs);
        }
        const declaredAndEnabled = Array.from(this.enabled).some(pluginId =>
            Object.hasOwn(this.plugins.get(pluginId)?.controls || {}, controlId));
        if (pressed && !declaredAndEnabled) return false;
        if (pressed) touchInputs.add(controlId);
        else touchInputs.delete(controlId);
        this.updatePlayerControls(player, this.playerControlKeys?.get(player) || {});
        return true;
    }

    hasEnabledControlKey(keyCode) {
        for (const pluginId of this.enabled) {
            const controls = this.plugins.get(pluginId)?.controls || {};
            if (Object.values(controls).some(control => control.key === keyCode)) return true;
        }
        return false;
    }
    
    /**
     * Check if a hook should prevent default behavior
     * @param {string} hookName - Name of the hook
     * @param {Object} data - Data to pass to callbacks
     * @returns {boolean} - True if any callback returned { preventDefault: true }
     */
    shouldPreventDefault(hookName, data = {}) {
        const result = this.executeHook(hookName, data);
        return result.preventDefault === true;
    }
    
    // ============================================
    // SOUND HELPERS
    // ============================================
    
    playSound(pluginId, soundName, volume = 1) {
        const sounds = this.sounds.get(pluginId);
        if (!sounds) return;
        
        const sound = sounds[soundName];
        if (!sound) return;
        const requestedVolume = Number(volume);
        const safeVolume = Number.isFinite(requestedVolume)
            ? Math.max(0, Math.min(1, requestedVolume))
            : 1;
        
        if (Array.isArray(sound)) {
            // Play random from array
            if (sound.length === 0) return;
            const s = sound[Math.floor(Math.random() * sound.length)];
            s.volume = safeVolume;
            s.currentTime = 0;
            s.play().catch(() => {});
        } else {
            sound.volume = safeVolume;
            sound.currentTime = 0;
            sound.play().catch(() => {});
        }
    }
    
    stopSound(pluginId, soundName) {
        const sounds = this.sounds.get(pluginId);
        if (!sounds) return;
        
        const sound = sounds[soundName];
        const players = Array.isArray(sound) ? sound : sound ? [sound] : [];
        for (const player of players) {
            player.pause();
            player.currentTime = 0;
        }
    }
    
    // ============================================
    // CONFIG HELPERS
    // ============================================
    
    getDefaultConfig(pluginId) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin || !plugin.config) return {};
        
        const config = {};
        for (const [key, def] of Object.entries(plugin.config)) {
            config[key] = def.default;
        }
        return config;
    }
    
    // ============================================
    // RESOURCE HELPERS
    // ============================================
    
    /**
     * Get all script URLs that will be loaded for a plugin
     * Used for progress tracking during preload
     * @param {string} pluginId - Plugin ID
     * @returns {string[]} - Array of script URLs
     */
    getPluginScriptUrls(pluginId) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin || !plugin.scripts) return [];
        
        const urls = [];
        
        // Library scripts (skulpt, skulptStdlib, pythonCompiler)
        const libraryScripts = ['skulpt', 'skulptStdlib', 'pythonCompiler'];
        for (const scriptName of libraryScripts) {
            if (plugin.scripts[scriptName]) {
                urls.push(this.getPluginAssetUrl(plugin, plugin.scripts[scriptName]));
            }
        }
        
        // Text scripts (globals, inject, script, editor)
        const textScripts = ['globals', 'inject', 'script', 'editor'];
        for (const scriptName of textScripts) {
            if (plugin.scripts[scriptName]) {
                urls.push(this.getPluginAssetUrl(plugin, plugin.scripts[scriptName]));
            }
        }
        
        return urls;
    }
    
    /**
     * Get all sound URLs that will be loaded for a plugin
     * Used for progress tracking during preload
     * @param {string} pluginId - Plugin ID
     * @returns {string[]} - Array of sound URLs
     */
    getPluginSoundUrls(pluginId) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin || !plugin.sounds) return [];
        
        const urls = [];
        
        for (const [name, path] of Object.entries(plugin.sounds)) {
            if (Array.isArray(path)) {
                for (const p of path) {
                    urls.push(this.getPluginAssetUrl(plugin, p));
                }
            } else {
                urls.push(this.getPluginAssetUrl(plugin, path));
            }
        }
        
        return urls;
    }

    getPluginAssetUrl(plugin, relativePath) {
        const url = new URL(relativePath, new URL(plugin.path, document.baseURI));
        if (typeof plugin.version === 'string' && plugin.version) url.searchParams.set('v', plugin.version);
        if (plugin.localDevelopment) {
            url.searchParams.set('dev', String(Date.now()));
            url.searchParams.set('devToken', this.localDevelopmentToken);
        }
        return url.href;
    }
    
    // ============================================
    // SERIALIZATION
    // ============================================
    
    /**
     * Initialize plugins from world data (called when loading a map)
     */
    async initFromWorld(world) {
        if (typeof window.CodePluginReset === 'function') window.CodePluginReset();
        // Ensure plugins are discovered first
        if (this.plugins.size === 0) {
            await this.discoverPlugins();
        }
        
        // Tear down plugin-owned hooks and listeners before re-initializing
        // plugins for the newly loaded map.
        for (const pluginId of [...this.enabled]) this.cleanupPluginResources(pluginId);
        this.loadDiagnostics.clear();

        // Clear current state
        this.enabled.clear();
        this.enabling.clear();
        for (const hookName in this.hooks) {
            this.hooks[hookName] = [];
        }
        
        // The Code mechanics runtime is a built-in service, not an optional map plugin.
        // Always restore its hooks after clearing hook state, but don't persist it as
        // an enabled plugin in the map's optional-plugin list.
        if (this.plugins.has('code')) {
            await this.enablePlugin('code', world);
            const codeIndex = world.plugins?.enabled?.indexOf('code') ?? -1;
            if (codeIndex !== -1) world.plugins.enabled.splice(codeIndex, 1);
        }

        // Iterate a snapshot: enabling dependencies can append ids to the map list.
        const requestedPlugins = [...new Set((world.plugins?.enabled || []).filter(pluginId => pluginId !== 'code'))];
        for (const pluginId of requestedPlugins) {
            await this.enablePlugin(pluginId, world);
        }
    }
}

// Global plugin manager instance
window.PluginManager = new PluginManager();

// ============================================
// AVAILABLE HOOKS
// ============================================
/*
Hooks that plugins can register for. Callbacks receive one mutable data
object (rather than positional arguments) and should return it when they
modify or preserve it:

PLAYER HOOKS:
- player.init({ player, world }) - Called when a player is initialized
- player.update({ player, world, audioManager, deltaTime, skipPhysics }) - Called each frame; set skipPhysics to keep core physics from updating this frame
- player.damage({ player, source, world, preventDefault }) - Called when the player takes damage; set preventDefault to cancel the default death behavior
- player.died({ player, world, source }) - Called once when the player enters the dead state, before automatic respawn
- player.respawn({ player, world }) - Called when the player respawns
- player.jump({ player, canJump }) - Called when the core jump is unavailable and plugins may provide one
- player.jumped({ player, world, wasGrounded, source }) - Called after a core or plugin jump succeeds
- player.land({ player, world, surface }) - Called only on an airborne-to-floor collision transition
- game.ended({ player, world, elapsedMs, wasTestMode }) - Called once after endpoint completion and runtime cleanup
- game.sceneLoaded({ player, world, mapId, previousMapName, mapName }) - Called after a solo scene transition loads its destination and initializes that map's plugins
- player.checkpoint({ player, world, checkpoint }) - Called each update while the player overlaps a checkpoint, and when mechanics set one
- button.pressed({ button, player, world }) - Called when a map button activates

INPUT HOOKS:
- input.keydown({ key, player }) - Called on keydown
- input.keyup({ key, player }) - Called on keyup
- input.update({ player, keys, layout }) - Called after player input state is updated

RENDER HOOKS:
- render.hud({ ctx, canvas, player, world, xOffset, yOffset }) - Called to render HUD elements
- render.player({ ctx, player, camera, world }) - Called after player is rendered
- render.soulStatue({ ctx, screenX, screenY, width, height, obj, handled }) - Called to render soul statue objects; set handled when drawn
*/
