/**
 * Python Compiler - Standalone Module
 * Compiles and executes Python code in the browser using Skulpt
 * All files in assets/plugins/code/js/
 * 
 * Required files (same folder):
 *   - skulpt.min.js
 *   - skulpt-stdlib.js
 */

(function(global) {
    'use strict';
    
    // Local paths for Skulpt (relative to HTML page)
    const SKULPT_LOCAL = 'assets/plugins/code/js/skulpt.min.js';
    const SKULPT_STDLIB_LOCAL = 'assets/plugins/code/js/skulpt-stdlib.js';
    const PYTHON_EVENT_EXECUTION_LIMIT_MS = 100;
    
    // Alternative: absolute path from plugin base
    let basePath = '';
    
    // Loading state
    let skulptLoading = null;
    let skulptLoaded = false;
    let pythonExecutionQueue = Promise.resolve();

    const PARKOREEN_MODULE_FILENAME = 'src/lib/parkoreen.js';
    const PARKOREEN_MODULE_SOURCE = [
        'var $builtinmodule = function () {',
        '    var api = {};',
        '    var getRuntime = function () {',
        '        var runtime = window.__parkoreenPythonRuntimeContext;',
        '        if (!runtime) throw new Sk.builtin.RuntimeError("Parkoreen event context is only available while an event script is running.");',
        '        return runtime;',
        '    };',
        '    api.__name__ = new Sk.builtin.str("parkoreen");',
        '    api.API_VERSION = new Sk.builtin.int_(1);',
        '    api.get_context = new Sk.builtin.func(function () {',
        '        return Sk.ffi.remapToPy(getRuntime().getContext());',
        '    });',
        '    api.get_object = new Sk.builtin.func(function (objectId) {',
        '        var id = Sk.ffi.remapToJs(objectId);',
        '        var object = getRuntime().getObject(id);',
        '        return object === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(object);',
        '    });',
        '    api.get_objects = new Sk.builtin.func(function (offset, limit) {',
        '        var start = offset === undefined || offset === Sk.builtin.none.none$ ? 0 : Sk.ffi.remapToJs(offset);',
        '        var count = limit === undefined || limit === Sk.builtin.none.none$ ? 100 : Sk.ffi.remapToJs(limit);',
        '        var objects = getRuntime().getObjects(start, count);',
        '        return objects === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(objects);',
        '    });',
        '    api.get_players = new Sk.builtin.func(function (offset, limit) {',
        '        var start = offset === undefined || offset === Sk.builtin.none.none$ ? 0 : Sk.ffi.remapToJs(offset);',
        '        var count = limit === undefined || limit === Sk.builtin.none.none$ ? 32 : Sk.ffi.remapToJs(limit);',
        '        var players = getRuntime().getPlayers(start, count);',
        '        return players === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(players);',
        '    });',
        '    api.get_tilemaps = new Sk.builtin.func(function (offset, limit) {',
        '        var start = offset === undefined || offset === Sk.builtin.none.none$ ? 0 : Sk.ffi.remapToJs(offset);',
        '        var count = limit === undefined || limit === Sk.builtin.none.none$ ? 64 : Sk.ffi.remapToJs(limit);',
        '        var tilemaps = getRuntime().getTilemaps(start, count);',
        '        return tilemaps === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(tilemaps);',
        '    });',
        '    api.get_tilemap_cells = new Sk.builtin.func(function (tilemapId, offset, limit) {',
        '        var id = Sk.ffi.remapToJs(tilemapId);',
        '        var start = offset === undefined || offset === Sk.builtin.none.none$ ? 0 : Sk.ffi.remapToJs(offset);',
        '        var count = limit === undefined || limit === Sk.builtin.none.none$ ? 100 : Sk.ffi.remapToJs(limit);',
        '        var cells = getRuntime().getTilemapCells(id, start, count);',
        '        return cells === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(cells);',
        '    });',
        '    api.set_tilemap_cell_behavior = new Sk.builtin.func(function (tilemapId, x, y, collisionType) {',
        '        var id = Sk.ffi.remapToJs(tilemapId);',
        '        var cellX = Sk.ffi.remapToJs(x);',
        '        var cellY = Sk.ffi.remapToJs(y);',
        '        var behavior = Sk.ffi.remapToJs(collisionType);',
        '        return Sk.ffi.remapToPy(getRuntime().setTilemapCellBehavior(id, cellX, cellY, behavior));',
        '    });',
        '    api.set_object_enabled = new Sk.builtin.func(function (objectId, enabled) {',
        '        var id = Sk.ffi.remapToJs(objectId);',
        '        var nextEnabled = Sk.ffi.remapToJs(enabled);',
        '        return Sk.ffi.remapToPy(getRuntime().setObjectEnabled(id, nextEnabled));',
        '    });',
        '    api.set_object_position = new Sk.builtin.func(function (objectId, x, y) {',
        '        var id = Sk.ffi.remapToJs(objectId);',
        '        var nextX = Sk.ffi.remapToJs(x);',
        '        var nextY = Sk.ffi.remapToJs(y);',
        '        return Sk.ffi.remapToPy(getRuntime().setObjectPosition(id, nextX, nextY));',
        '    });',
        '    api.get_object_health = new Sk.builtin.func(function (objectId) {',
        '        var id = Sk.ffi.remapToJs(objectId);',
        '        var health = getRuntime().getObjectHealth(id);',
        '        return health === undefined || health === null ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(health);',
        '    });',
        '    api.set_object_health = new Sk.builtin.func(function (objectId, current, maximum) {',
        '        var id = Sk.ffi.remapToJs(objectId);',
        '        var health = Sk.ffi.remapToJs(current);',
        '        var maxHealth = Sk.ffi.remapToJs(maximum);',
        '        return Sk.ffi.remapToPy(getRuntime().setObjectHealth(id, health, maxHealth));',
        '    });',
        '    api.set_player_velocity = new Sk.builtin.func(function (vx, vy) {',
        '        var nextVx = Sk.ffi.remapToJs(vx);',
        '        var nextVy = Sk.ffi.remapToJs(vy);',
        '        return Sk.ffi.remapToPy(getRuntime().setPlayerVelocity(nextVx, nextVy));',
        '    });',
        '    api.get_variable = new Sk.builtin.func(function (key, scope) {',
        '        var variableKey = Sk.ffi.remapToJs(key);',
        '        var variableScope = scope === undefined || scope === Sk.builtin.none.none$ ? null : Sk.ffi.remapToJs(scope);',
        '        var value = getRuntime().getVariable(variableKey, variableScope);',
        '        return value === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(value);',
        '    });',
        '    api.set_variable = new Sk.builtin.func(function (key, value, scope) {',
        '        var variableKey = Sk.ffi.remapToJs(key);',
        '        var nextValue = Sk.ffi.remapToJs(value);',
        '        var variableScope = scope === undefined || scope === Sk.builtin.none.none$ ? null : Sk.ffi.remapToJs(scope);',
        '        return Sk.ffi.remapToPy(getRuntime().setVariable(variableKey, nextValue, variableScope));',
        '    });',
        '    api.get_player_variable = new Sk.builtin.func(function (key, playerId) {',
        '        var variableKey = Sk.ffi.remapToJs(key);',
        '        var id = Sk.ffi.remapToJs(playerId);',
        '        var value = getRuntime().getPlayerVariable(variableKey, id);',
        '        return value === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(value);',
        '    });',
        '    api.set_player_variable = new Sk.builtin.func(function (key, value, playerId) {',
        '        var variableKey = Sk.ffi.remapToJs(key);',
        '        var nextValue = Sk.ffi.remapToJs(value);',
        '        var id = Sk.ffi.remapToJs(playerId);',
        '        return Sk.ffi.remapToPy(getRuntime().setPlayerVariable(variableKey, nextValue, id));',
        '    });',
        '    api.get_list = new Sk.builtin.func(function (key) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var value = getRuntime().getList(listKey);',
        '        return value === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(value);',
        '    });',
        '    api.clear_list = new Sk.builtin.func(function (key) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        return Sk.ffi.remapToPy(getRuntime().clearList(listKey));',
        '    });',
        '    api.list_contains = new Sk.builtin.func(function (key, value, valueType) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var item = Sk.ffi.remapToJs(value);',
        '        var itemType = valueType === undefined || valueType === Sk.builtin.none.none$ ? null : Sk.ffi.remapToJs(valueType);',
        '        var result = getRuntime().listContains(listKey, item, itemType);',
        '        return result === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(result);',
        '    });',
        '    api.append_list_item = new Sk.builtin.func(function (key, value, valueType) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var item = Sk.ffi.remapToJs(value);',
        '        var itemType = valueType === undefined || valueType === Sk.builtin.none.none$ ? null : Sk.ffi.remapToJs(valueType);',
        '        return Sk.ffi.remapToPy(getRuntime().appendListItem(listKey, item, itemType));',
        '    });',
        '    api.remove_list_item = new Sk.builtin.func(function (key, value, valueType) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var item = Sk.ffi.remapToJs(value);',
        '        var itemType = valueType === undefined || valueType === Sk.builtin.none.none$ ? null : Sk.ffi.remapToJs(valueType);',
        '        return Sk.ffi.remapToPy(getRuntime().removeListItem(listKey, item, itemType));',
        '    });',
        '    api.get_player_list = new Sk.builtin.func(function (key, playerId) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var id = Sk.ffi.remapToJs(playerId);',
        '        var value = getRuntime().getPlayerList(listKey, id);',
        '        return value === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(value);',
        '    });',
        '    api.clear_player_list = new Sk.builtin.func(function (key, playerId) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var id = Sk.ffi.remapToJs(playerId);',
        '        return Sk.ffi.remapToPy(getRuntime().clearPlayerList(listKey, id));',
        '    });',
        '    api.player_list_contains = new Sk.builtin.func(function (key, playerId, value, valueType) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var id = Sk.ffi.remapToJs(playerId);',
        '        var item = Sk.ffi.remapToJs(value);',
        '        var itemType = valueType === undefined || valueType === Sk.builtin.none.none$ ? null : Sk.ffi.remapToJs(valueType);',
        '        var result = getRuntime().playerListContains(listKey, id, item, itemType);',
        '        return result === undefined ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(result);',
        '    });',
        '    api.append_player_list_item = new Sk.builtin.func(function (key, playerId, value, valueType) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var id = Sk.ffi.remapToJs(playerId);',
        '        var item = Sk.ffi.remapToJs(value);',
        '        var itemType = valueType === undefined || valueType === Sk.builtin.none.none$ ? null : Sk.ffi.remapToJs(valueType);',
        '        return Sk.ffi.remapToPy(getRuntime().appendPlayerListItem(listKey, id, item, itemType));',
        '    });',
        '    api.remove_player_list_item = new Sk.builtin.func(function (key, playerId, value, valueType) {',
        '        var listKey = Sk.ffi.remapToJs(key);',
        '        var id = Sk.ffi.remapToJs(playerId);',
        '        var item = Sk.ffi.remapToJs(value);',
        '        var itemType = valueType === undefined || valueType === Sk.builtin.none.none$ ? null : Sk.ffi.remapToJs(valueType);',
        '        return Sk.ffi.remapToPy(getRuntime().removePlayerListItem(listKey, id, item, itemType));',
        '    });',
        '    api.show_message = new Sk.builtin.func(function (message, duration) {',
        '        var text = Sk.ffi.remapToJs(message);',
        '        var seconds = duration === undefined || duration === Sk.builtin.none.none$ ? 3 : Sk.ffi.remapToJs(duration);',
        '        return Sk.ffi.remapToPy(getRuntime().showMessage(text, seconds));',
        '    });',
        '    return api;',
        '};'
    ].join('\n');
    
    /**
     * Set the base path for loading Skulpt files
     * @param {string} path - Base path (e.g., '/parkoreen/')
     */
    function setBasePath(path) {
        basePath = path.endsWith('/') ? path : path + '/';
    }
    
    /**
     * Load a script from URL
     * @param {string} src - Script URL
     * @returns {Promise}
     */
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            // Check if already loaded
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                resolve();
                return;
            }
            
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(script);
        });
    }
    
    /**
     * Ensure Skulpt is loaded from local files
     * @returns {Promise}
     */
    async function ensureSkulptLoaded() {
        // Check if already loaded (either by us or by plugin loader)
        if (typeof Sk !== 'undefined' && Sk.builtinFiles) {
            skulptLoaded = true;
            return Promise.resolve();
        }
        
        // Currently loading - wait for it
        if (skulptLoading) {
            return skulptLoading;
        }
        
        // Start loading (fallback if not pre-loaded by plugin system)
        skulptLoading = (async () => {
            try {
                const skulptPath = basePath + SKULPT_LOCAL;
                const stdlibPath = basePath + SKULPT_STDLIB_LOCAL;
                
                // Load main Skulpt library
                await loadScript(skulptPath);
                
                // Wait a moment for Sk to be defined
                await new Promise(resolve => setTimeout(resolve, 50));
                
                if (typeof Sk === 'undefined') {
                    throw new Error('Skulpt failed to load from: ' + skulptPath);
                }
                
                // Load standard library
                await loadScript(stdlibPath);
                
                // Wait for stdlib to initialize
                await new Promise(resolve => setTimeout(resolve, 50));
                
                skulptLoaded = true;
            } catch (error) {
                skulptLoading = null;
                throw error;
            }
        })();
        
        return skulptLoading;
    }
    
    /**
     * Python Compiler Class
     */
    class PythonCompiler {
        constructor(options = {}) {
            this.output = '';
            this.errors = [];
            this.isRunning = false;
            this.startTime = 0;
            this.executionTime = 0;
            
            // Callbacks
            this.onOutput = options.onOutput || null;
            this.onError = options.onError || null;
            this.onComplete = options.onComplete || null;
            this.onInput = options.onInput || null;
            this.parkoreenContext = options.parkoreenContext || null;
            
            // Set base path if provided
            if (options.basePath) {
                setBasePath(options.basePath);
            }
        }
        
        /**
         * Configure Skulpt with output and input handlers
         */
        configure() {
            const self = this;
            
            Sk.configure({
                // Output function - called when Python prints something
                output: (text) => {
                    self.output += text;
                    if (self.onOutput) {
                        self.onOutput(text);
                    }
                },
                
                // Input function - called when Python needs input
                inputfun: (prompt) => {
                    if (self.parkoreenContext) {
                        throw new Error('input() is not available in game event scripts.');
                    }
                    if (self.onInput) {
                        return self.onInput(prompt);
                    }
                    return window.prompt(prompt);
                },
                inputfunTakesPrompt: true,
                
                // Read built-in files (standard library)
                read: (filename) => {
                    if (filename === PARKOREEN_MODULE_FILENAME) {
                        return PARKOREEN_MODULE_SOURCE;
                    }
                    if (Sk.builtinFiles === undefined || Sk.builtinFiles["files"][filename] === undefined) {
                        throw new Error("File not found: '" + filename + "'");
                    }
                    return Sk.builtinFiles["files"][filename];
                },
                
                // Use Python 3 syntax
                __future__: Sk.python3,
                yieldLimit: 8,
                execLimit: PYTHON_EVENT_EXECUTION_LIMIT_MS,
                timeoutMsg: () => `Python event script exceeded the ${PYTHON_EVENT_EXECUTION_LIMIT_MS} ms execution limit.`
            });
        }
        
        /**
         * Compile and run Python code
         * @param {string} code - Python source code
         * @returns {Promise} - Resolves with result object
         */
        async run(code) {
            const run = pythonExecutionQueue.then(
                () => this.runExclusive(code),
                () => this.runExclusive(code)
            );
            pythonExecutionQueue = run.then(() => undefined, () => undefined);
            return run;
        }

        async runExclusive(code) {
            // Ensure Skulpt is loaded
            try {
                await ensureSkulptLoaded();
            } catch (loadError) {
                const response = {
                    success: false,
                    output: '',
                    error: 'Failed to load Python compiler: ' + loadError.message,
                    executionTime: 0
                };
                if (this.onError) this.onError(loadError);
                if (this.onComplete) this.onComplete(response);
                return response;
            }
            
            // Reset state
            this.output = '';
            this.errors = [];
            this.isRunning = true;
            this.startTime = Date.now();
            
            const runtimeContext = this.parkoreenContext;
            if (runtimeContext) {
                global.__parkoreenPythonRuntimeContext = runtimeContext;
            } else {
                delete global.__parkoreenPythonRuntimeContext;
            }
            try {
                // Skulpt has process-wide configuration and a module cache, so
                // event executions are serialized and the active context is
                // looked up when each Parkoreen API function is called.
                this.configure();

                // Compile and execute
                const result = await Sk.misceval.asyncToPromise(() => {
                    return Sk.importMainWithBody("<stdin>", false, code, true);
                });
                
                this.executionTime = Date.now() - this.startTime;
                this.isRunning = false;
                
                const response = {
                    success: true,
                    output: this.output,
                    executionTime: this.executionTime,
                    result: result
                };
                
                if (this.onComplete) {
                    this.onComplete(response);
                }
                
                return response;
                
            } catch (error) {
                this.executionTime = Date.now() - this.startTime;
                this.isRunning = false;
                this.errors.push(error);
                
                const response = {
                    success: false,
                    output: this.output,
                    error: this.formatError(error),
                    executionTime: this.executionTime
                };
                
                if (this.onError) {
                    this.onError(error);
                }
                
                if (this.onComplete) {
                    this.onComplete(response);
                }

                return response;
            } finally {
                if (global.__parkoreenPythonRuntimeContext === runtimeContext) {
                    delete global.__parkoreenPythonRuntimeContext;
                }
            }
        }
        
        /**
         * Format error for display
         * @param {Error} error - Error object
         * @returns {string} - Formatted error string
         */
        formatError(error) {
            if (error.toString) {
                return error.toString();
            }
            return String(error);
        }
        
        /**
         * Get execution time in milliseconds
         * @returns {number}
         */
        getExecutionTime() {
            return this.executionTime;
        }
        
        /**
         * Get all output as string
         * @returns {string}
         */
        getOutput() {
            return this.output;
        }
        
        /**
         * Clear output and errors
         */
        clear() {
            this.output = '';
            this.errors = [];
            this.executionTime = 0;
        }
        
        /**
         * Check if Skulpt is loaded and ready
         * @returns {boolean}
         */
        static isReady() {
            return skulptLoaded && typeof Sk !== 'undefined';
        }
        
        /**
         * Preload Skulpt (call early to avoid delay on first run)
         * @returns {Promise}
         */
        static preload() {
            return ensureSkulptLoaded();
        }
        
        /**
         * Set the base path for loading Skulpt files
         * @param {string} path - Base path
         */
        static setBasePath(path) {
            setBasePath(path);
        }
    }
    
    /**
     * Simple function to run Python code (convenience wrapper)
     * @param {string} code - Python code to execute
     * @param {object} options - Optional callbacks
     * @returns {Promise} - Result object
     */
    async function runPython(code, options = {}) {
        const compiler = new PythonCompiler(options);
        return compiler.run(code);
    }
    
    // Export for module systems
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { PythonCompiler, runPython };
    }
    
    // Make available globally
    global.PythonCompiler = PythonCompiler;
    global.runPython = runPython;
    
})(typeof window !== 'undefined' ? window : this);
