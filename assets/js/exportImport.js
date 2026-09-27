/**
 * PARKOREEN - Export/Import System
 * Handles .pkrn file format and map data serialization
 * 
 * .pkrn format v2.0:
 * - Actually a ZIP file renamed to .pkrn
 * - Contains: data.json or data.dat, plus uploaded media files
 * - Backward compatible with v1.x (raw JSON)
 */

// ============================================
// FILE FORMAT VERSION
// ============================================
const PKRN_VERSION = '2.0';
const PKRN_FORMAT_JSON = 'json';
const PKRN_FORMAT_DAT = 'dat';
const PKRN_SPIKE_TOUCHBOX_MODES = ['full', 'normal', 'tip', 'ground', 'flag', 'air', 'all-spike'];

// Default values for backward compatibility
const PKRN_DEFAULTS = {
    background: 'sky',
    defaultBlockColor: '#787878',
    defaultSpikeColor: '#c45a3f',
    defaultTextColor: '#000000',
    defaultPortalColor: '#9b59b6',
    defaultBouncerColor: '#461A0C',
    showCoinCounter: true,
    cloudColorSky: '#ffffff',
    cloudColorGalaxy: '#9382a8',
    checkpointDefaultColor: '#808080',
    checkpointActiveColor: '#4CAF50',
    checkpointTouchedColor: '#2196F3',
    persistCheckpoints: false,
    maxJumps: 1,
    infiniteJumps: false,
    additionalAirjump: false,
    collideWithEachOther: true,
    dieLineY: 1000,
    playerSpeed: 5,
    horizontalAcceleration: 0,
    airControl: 1,
    terminalFallSpeed: null,
    jumpForce: -14,
    gravity: 0.8,
    cameraLerpX: 0.12,
    cameraLerpY: 0.12,
    cameraFollowMode: 'both',
    cameraBounds: { enabled: false, x: 0, y: 0, width: 2000, height: 1200 },
    spikeTouchbox: 'normal',
    dropHurtOnly: false,
    storedDataType: 'json', // 'json' or 'dat'
    customBackground: {
        enabled: false,
        type: null,
        data: null,
        playMode: 'loop',
        loopCount: -1,
        endType: 'freeze',
        endBackground: null,
        sameAcrossScreens: false,
        reverse: false
    },
    music: {
        type: 'none',
        customData: null,
        customName: null,
        volume: 50,
        loop: true
    },
    plugins: {
        enabled: []
    },
    codeData: {
        triggers: [],
        events: []
    }
};

// ============================================
// BINARY DATA UTILITIES
// ============================================
class BinaryUtils {
    /**
     * Encode data to binary format (.dat)
     * Uses a simple but efficient binary format
     */
    static encode(data) {
        const json = JSON.stringify(data);
        const encoder = new TextEncoder();
        const bytes = encoder.encode(json);
        
        // Simple compression: RLE for repeated bytes
        const compressed = this.compress(bytes);
        return compressed;
    }
    
    /**
     * Decode binary format back to data
     */
    static decode(buffer) {
        const decompressed = this.decompress(new Uint8Array(buffer));
        const decoder = new TextDecoder();
        const json = decoder.decode(decompressed);
        return JSON.parse(json);
    }
    
    /**
     * Simple RLE compression
     */
    static compress(bytes) {
        const result = [];
        let i = 0;
        
        while (i < bytes.length) {
            const byte = bytes[i];
            let count = 1;
            
            // Count consecutive same bytes (max 255)
            while (i + count < bytes.length && bytes[i + count] === byte && count < 255) {
                count++;
            }
            
            if (count >= 4) {
                // RLE marker: 0xFF, count, byte
                result.push(0xFF, count, byte);
                i += count;
            } else {
                // Store byte directly (escape 0xFF as 0xFF 0x00)
                if (byte === 0xFF) {
                    result.push(0xFF, 0x00);
                } else {
                    result.push(byte);
                }
                i++;
            }
        }
        
        return new Uint8Array(result);
    }
    
    /**
     * Simple RLE decompression
     */
    static decompress(bytes) {
        const result = [];
        let i = 0;
        
        while (i < bytes.length) {
            if (bytes[i] === 0xFF) {
                i++;
                if (bytes[i] === 0x00) {
                    // Escaped 0xFF
                    result.push(0xFF);
                    i++;
                } else {
                    // RLE: count, byte
                    const count = bytes[i++];
                    const byte = bytes[i++];
                    for (let j = 0; j < count; j++) {
                        result.push(byte);
                    }
                }
            } else {
                result.push(bytes[i++]);
            }
        }
        
        return new Uint8Array(result);
    }
}

// ============================================
// MEDIA EXTRACTOR
// ============================================
class MediaExtractor {
    /**
     * Extract base64 media from world data and return references
     * @param {Object} data - Serialized world data
     * @returns {Object} { data: modifiedData, files: Map<filename, base64> }
     */
    static extract(data) {
        const files = new Map();
        let imgIndex = 1;
        let soundIndex = 1;
        
        // Clone data to avoid modifying original
        const modified = JSON.parse(JSON.stringify(data));
        
        // Extract custom background
        if (modified.settings?.customBackground?.data) {
            const bgData = modified.settings.customBackground.data;
            if (bgData.startsWith('data:')) {
                const ext = this.getExtensionFromDataUrl(bgData);
                const filename = `uploaded_img_${imgIndex++}.${ext}`;
                files.set(filename, bgData);
                modified.settings.customBackground.data = `@file:${filename}`;
            }
        }
        
        // Extract nested end background
        if (modified.settings?.customBackground?.endBackground?.data) {
            const bgData = modified.settings.customBackground.endBackground.data;
            if (bgData.startsWith('data:')) {
                const ext = this.getExtensionFromDataUrl(bgData);
                const filename = `uploaded_img_${imgIndex++}.${ext}`;
                files.set(filename, bgData);
                modified.settings.customBackground.endBackground.data = `@file:${filename}`;
            }
        }
        
        // Extract custom music
        if (modified.settings?.music?.customData) {
            const musicData = modified.settings.music.customData;
            if (musicData.startsWith('data:')) {
                const ext = this.getExtensionFromDataUrl(musicData);
                const filename = `uploaded_sound_${soundIndex++}.${ext}`;
                files.set(filename, musicData);
                modified.settings.music.customData = `@file:${filename}`;
            }
        }

        if (typeof modified.settings?.playerSpriteSheet?.data === 'string' &&
            modified.settings.playerSpriteSheet.data.startsWith('data:')) {
            const spriteData = modified.settings.playerSpriteSheet.data;
            const ext = this.getExtensionFromDataUrl(spriteData);
            const filename = `uploaded_img_${imgIndex++}.${ext}`;
            files.set(filename, spriteData);
            modified.settings.playerSpriteSheet.data = `@file:${filename}`;
        }

        // Keep sprite sheets as separate ZIP assets instead of repeating large
        // base64 strings in the map JSON. Object stamps may also contain them.
        const spriteObjects = [
            ...(Array.isArray(modified.objects) ? modified.objects : []),
            ...(Array.isArray(modified.objectStamps) ? modified.objectStamps.flatMap(stamp =>
                Array.isArray(stamp?.objects) ? stamp.objects : []) : [])
        ];
        const spriteFiles = new Map();
        for (const object of spriteObjects) {
            const spriteData = object?.spriteSheet?.data;
            if (typeof spriteData !== 'string' || !spriteData.startsWith('data:')) continue;
            let filename = spriteFiles.get(spriteData);
            if (!filename) {
                const ext = this.getExtensionFromDataUrl(spriteData);
                filename = `uploaded_img_${imgIndex++}.${ext}`;
                files.set(filename, spriteData);
                spriteFiles.set(spriteData, filename);
            }
            object.spriteSheet.data = `@file:${filename}`;
        }

        const tilemapFiles = new Map();
        for (const tilemap of Array.isArray(modified.tilemaps) ? modified.tilemaps : []) {
            const atlasData = tilemap?.atlas?.data;
            if (typeof atlasData !== 'string' || !atlasData.startsWith('data:')) continue;
            let filename = tilemapFiles.get(atlasData);
            if (!filename) {
                const ext = this.getExtensionFromDataUrl(atlasData);
                filename = `uploaded_img_${imgIndex++}.${ext}`;
                files.set(filename, atlasData);
                tilemapFiles.set(atlasData, filename);
            }
            tilemap.atlas.data = `@file:${filename}`;
        }
        
        return { data: modified, files };
    }
    
    /**
     * Inject file references back into data
     * @param {Object} data - Data with file references
     * @param {Map} files - Map of filename to base64 data
     * @returns {Object} Data with embedded base64
     */
    static inject(data, files) {
        const modified = JSON.parse(JSON.stringify(data));
        
        // Inject custom background
        if (modified.settings?.customBackground?.data?.startsWith('@file:')) {
            const filename = modified.settings.customBackground.data.substring(6);
            if (files.has(filename)) {
                modified.settings.customBackground.data = files.get(filename);
            }
        }
        
        // Inject nested end background
        if (modified.settings?.customBackground?.endBackground?.data?.startsWith('@file:')) {
            const filename = modified.settings.customBackground.endBackground.data.substring(6);
            if (files.has(filename)) {
                modified.settings.customBackground.endBackground.data = files.get(filename);
            }
        }
        
        // Inject custom music
        if (modified.settings?.music?.customData?.startsWith('@file:')) {
            const filename = modified.settings.music.customData.substring(6);
            if (files.has(filename)) {
                modified.settings.music.customData = files.get(filename);
            }
        }

        if (modified.settings?.playerSpriteSheet?.data?.startsWith('@file:')) {
            const filename = modified.settings.playerSpriteSheet.data.substring(6);
            if (files.has(filename)) modified.settings.playerSpriteSheet.data = files.get(filename);
        }

        const spriteObjects = [
            ...(Array.isArray(modified.objects) ? modified.objects : []),
            ...(Array.isArray(modified.objectStamps) ? modified.objectStamps.flatMap(stamp =>
                Array.isArray(stamp?.objects) ? stamp.objects : []) : [])
        ];
        for (const object of spriteObjects) {
            const reference = object?.spriteSheet?.data;
            if (typeof reference !== 'string' || !reference.startsWith('@file:')) continue;
            const filename = reference.substring(6);
            if (files.has(filename)) object.spriteSheet.data = files.get(filename);
        }

        for (const tilemap of Array.isArray(modified.tilemaps) ? modified.tilemaps : []) {
            const reference = tilemap?.atlas?.data;
            if (typeof reference !== 'string' || !reference.startsWith('@file:')) continue;
            const filename = reference.substring(6);
            if (files.has(filename)) tilemap.atlas.data = files.get(filename);
        }
        
        return modified;
    }
    
    /**
     * Get file extension from data URL
     */
    static getExtensionFromDataUrl(dataUrl) {
        const match = dataUrl.match(/data:([^;]+)/);
        if (match) {
            const mimeType = match[1];
            const extensions = {
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/gif': 'gif',
                'image/webp': 'webp',
                'video/mp4': 'mp4',
                'video/webm': 'webm',
                'audio/mpeg': 'mp3',
                'audio/mp3': 'mp3',
                'audio/wav': 'wav',
                'audio/ogg': 'ogg',
                'audio/webm': 'webm'
            };
            return extensions[mimeType] || 'bin';
        }
        return 'bin';
    }

    /** Restore the MIME type that ZIP containers do not preserve for blobs. */
    static getMimeTypeFromFilename(filename) {
        const extension = filename.split('.').pop()?.toLowerCase();
        if (filename.startsWith('uploaded_sound_')) {
            return ({ mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm' })[extension] || null;
        }
        return ({
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
            mp4: 'video/mp4', webm: 'video/webm'
        })[extension] || null;
    }
    
    /**
     * Convert base64 data URL to binary
     */
    static dataUrlToBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)[1];
        const binary = atob(parts[1]);
        const array = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            array[i] = binary.charCodeAt(i);
        }
        return new Blob([array], { type: mime });
    }
    
    /**
     * Convert binary to base64 data URL
     */
    static blobToDataUrl(blob, mimeType = blob.type) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                resolve(typeof dataUrl === 'string' && mimeType
                    ? dataUrl.replace(/^data:[^;]+;/, `data:${mimeType};`)
                    : dataUrl);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
}

// ============================================
// EXPORT MANAGER
// ============================================
class ExportManager {
    constructor() {
        this.version = PKRN_VERSION;
    }

    /**
     * Export world data to .pkrn file (ZIP format)
     * @param {World} world - The world object to export
     * @param {string} filename - Optional filename (without extension)
     * @param {string} format - 'json' or 'dat'
     */
    async exportToFile(world, filename = null, format = null) {
        const dataFormat = format || world.storedDataType || PKRN_FORMAT_JSON;
        
        try {
            const zip = new JSZip();
            const serialized = this.serialize(world);
            
            // Extract media files
            const { data, files } = MediaExtractor.extract(serialized);
            
            // Add data file
            if (dataFormat === PKRN_FORMAT_DAT) {
                const binary = BinaryUtils.encode(data);
                zip.file('data.dat', binary);
            } else {
        const json = JSON.stringify(data, null, 2);
                zip.file('data.json', json);
            }
            
            // Add media files
            for (const [filename, dataUrl] of files) {
                const blob = MediaExtractor.dataUrlToBlob(dataUrl);
                zip.file(filename, blob);
            }
            
            // Generate ZIP
            const blob = await zip.generateAsync({ 
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 }
            });
            
            // Download
        const url = URL.createObjectURL(blob);
        const name = filename || world.mapName || 'untitled_map';
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeName}.pkrn`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        return true;
        } catch (err) {
            console.error('Export failed:', err);
            throw new Error('Failed to export: ' + err.message);
        }
    }

    /**
     * Export world data to JSON string (for internal use)
     * @param {World} world - The world object to export
     * @returns {string} JSON string
     */
    exportToString(world) {
        const data = this.serialize(world);
        return JSON.stringify(data);
    }

    /**
     * Export world data to base64 string (for URL sharing)
     * @param {World} world - The world object to export
     * @returns {string} Base64 encoded string
     */
    exportToBase64(world) {
        const json = this.exportToString(world);
        return btoa(encodeURIComponent(json));
    }

    /**
     * Serialize world to exportable format
     * @param {World} world - The world object
    * @returns {Object} Serialized data
     */
    serialize(world) {
        const normalizeCodeData = globalThis.normalizeParkoreenCodeData;
        const serializedCodeData = typeof normalizeCodeData === 'function'
            ? normalizeCodeData(world.codeData)
            : world.codeData;
        return {
            version: this.version,
            metadata: {
                name: world.mapName,
                createdAt: new Date().toISOString(),
                objectCount: world.objects.length
            },
            mechanicsSaveId: world.mechanicsSaveId,
            settings: {
                background: world.background,
                defaultBlockColor: world.defaultBlockColor,
                defaultSpikeColor: world.defaultSpikeColor,
                defaultTextColor: world.defaultTextColor,
                defaultPortalColor: world.defaultPortalColor,
                defaultBouncerColor: world.defaultBouncerColor,
                showCoinCounter: world.showCoinCounter,
                cloudColorSky: world.cloudColorSky,
                cloudColorGalaxy: world.cloudColorGalaxy,
                checkpointDefaultColor: world.checkpointDefaultColor,
                checkpointActiveColor: world.checkpointActiveColor,
                checkpointTouchedColor: world.checkpointTouchedColor,
                persistCheckpoints: world.persistCheckpoints,
                maxJumps: world.maxJumps,
                infiniteJumps: world.infiniteJumps,
                additionalAirjump: world.additionalAirjump,
                collideWithEachOther: world.collideWithEachOther,
                dieLineY: world.dieLineY,
                // Physics settings
                playerSpeed: world.playerSpeed,
                horizontalAcceleration: world.horizontalAcceleration,
                airControl: world.airControl,
                terminalFallSpeed: world.terminalFallSpeed,
                jumpForce: world.jumpForce,
                gravity: world.gravity,
                // Camera settings
                cameraLerpX: world.cameraLerpX,
                cameraLerpY: world.cameraLerpY,
                cameraFollowMode: world.cameraFollowMode,
                cameraBounds: world.cameraBounds,
                // Spike settings
                spikeTouchbox: world.spikeTouchbox,
                dropHurtOnly: world.dropHurtOnly,
                // Storage preference
                storedDataType: world.storedDataType || 'json',
                // Custom background
                customBackground: world.customBackground,
                playerSpriteSheet: world.playerSpriteSheet,
                // Music
                music: world.music
            },
            // Named draw layers; older maps omit this and retain the three defaults.
            layerDefinitions: world.layerDefinitions,
            // Reusable groups of map objects for editor placement.
            objectStamps: world.objectStamps || [],
            // Compact native 32 px tilemaps, normalized again by World.fromJSON.
            tilemaps: Array.isArray(world.tilemaps) ? world.tilemaps.map(tilemap => ({
                id: tilemap.id,
                name: tilemap.name,
                layer: tilemap.layer,
                ...(tilemap.atlas ? { atlas: { ...tilemap.atlas } } : {}),
                cells: tilemap.cells.map(cell => ({ ...cell }))
            })) : [],
            // Plugins configuration
            plugins: world.plugins,
            // Code plugin data (triggers & events)
            codeData: serializedCodeData,
            // Objects
            objects: world.objects.map(obj => this.serializeObject(obj))
        };
    }

    /**
     * Serialize a single world object
     * @param {WorldObject} obj - The object to serialize
     * @returns {Object} Serialized object data
     */
    serializeObject(obj) {
        const data = {
            id: obj.id,
            x: obj.x,
            y: obj.y,
            w: obj.width,
            h: obj.height,
            t: obj.type,
            at: obj.appearanceType,
            act: obj.actingType,
            col: obj.collision ? 1 : 0,
            c: obj.color,
            o: obj.opacity,
            l: obj.layer,
            r: obj.rotation,
            fh: obj.flipHorizontal ? 1 : 0,
            n: obj.name,
            tex: obj.texture || 'solid'
        };

        if (obj.oneWayPlatform === true) data.owp = 1;
        if (obj.collisionShape && obj.collisionShape !== 'box') data.cs = obj.collisionShape;
        if (obj.collisionShape === 'polygon' && Array.isArray(obj.collisionPoints)) data.cp = obj.collisionPoints.map(point => point.slice());
        if (obj.collisionShape === 'polygon' && obj.polygonOneWay === false) data.po = 0;
        if (obj.spriteSheet) data.spriteSheet = { ...obj.spriteSheet };

        // Preserve behavior settings that World.toJSON stores explicitly.
        // Older .pkrn files omit these and receive WorldObject defaults.
        if (obj.appearanceType === 'bouncer' || obj.actingType === 'bouncer') {
            data.bouncerStrength = obj.bouncerStrength;
            data.bouncerDirection = obj.bouncerDirection;
            data.bouncerMatchAppearance = obj.bouncerMatchAppearance;
            data.bouncerAppearanceDirection = obj.bouncerAppearanceDirection;
        }
        if (obj.appearanceType === 'coin' || obj.actingType === 'coin') {
            data.coinAmount = obj.coinAmount;
            data.coinActivityScope = obj.coinActivityScope;
        }
        if (obj.appearanceType === 'endpoint' || obj.actingType === 'endpoint') {
            data.endpointRequireCoins = obj.endpointRequireCoins;
            if (obj.endpointRequiredCoins !== undefined) data.endpointRequiredCoins = obj.endpointRequiredCoins;
        }

        // Damage amount (spikes and spinners)
        if (obj.damageAmount !== undefined && obj.damageAmount !== 1) {
            data.da = obj.damageAmount;
        }

        // Spinner-specific properties
        if (obj.type === 'spinner' || obj.appearanceType === 'spinner') {
            data.ss = obj.spinSpeed !== undefined ? obj.spinSpeed : 1;
            if (obj.spinDirection === -1) data.sd = -1;
        }

        // Button-specific properties
        if (obj.appearanceType === 'button' || obj.actingType === 'button') {
            if (obj.displayName) data.bdn = obj.displayName;
            if (obj.displayDescription) data.bdd = obj.displayDescription;
            if (obj.buttonVisible === false) data.bv = 0;
            if (obj.buttonWidth) data.bw = obj.buttonWidth;
            if (obj.buttonHeight) data.bh = obj.buttonHeight;
            if (obj.buttonInteraction !== undefined) data.buttonInteraction = obj.buttonInteraction;
            if (obj.buttonOnlyOnce !== undefined) data.buttonOnlyOnce = obj.buttonOnlyOnce;
            if (obj.buttonColor2 !== undefined) data.buttonColor2 = obj.buttonColor2;
        }

        // Text-specific properties
        if (obj.type === 'text') {
            data.txt = obj.content;
            data.f = obj.font;
            data.fs = obj.fontSize;
            data.ha = obj.hAlign;
            data.va = obj.vAlign;
            data.hs = obj.hSpacing;
            data.vs = obj.vSpacing;
        }
        
        // Spike-specific properties
        if (obj.spikeTouchbox) {
            data.stb = obj.spikeTouchbox;
        }
        if (obj.dropHurtOnly !== undefined) {
            data.dho = obj.dropHurtOnly;
        }
        
        // Zone-specific properties
        if (obj.zoneName) {
            data.zn = obj.zoneName;
        }
        
        // Teleportal-specific properties
        if (obj.teleportalName) {
            data.tpn = obj.teleportalName;
        }
        if (obj.sendTo && obj.sendTo.length > 0) {
            data.tps = obj.sendTo;
        }
        if (obj.receiveFrom && obj.receiveFrom.length > 0) {
            data.tpr = obj.receiveFrom;
        }
        if ((obj.appearanceType === 'teleportal' || obj.actingType === 'teleportal' || obj.type === 'teleportal') &&
            obj.particleOpacity !== undefined) {
            data.particleOpacity = obj.particleOpacity;
        }

        return data;
    }
}

// ============================================
// IMPORT MANAGER
// ============================================
class ImportManager {
    constructor() {
        this.supportedVersions = ['1.0', '1.1', '1.2', '2.0'];
    }

    /**
     * Import from file (supports both old JSON and new ZIP format)
     * @param {File} file - The file to import
     * @returns {Promise<Object>} Parsed data
     */
    async importFromFile(file) {
            if (!file.name.endsWith('.pkrn')) {
            throw new Error('Invalid file type. Please select a .pkrn file.');
        }

        const buffer = await this.readFileAsArrayBuffer(file);
        
        // Check if it's a ZIP file (starts with PK signature)
        const header = new Uint8Array(buffer.slice(0, 4));
        const isZip = header[0] === 0x50 && header[1] === 0x4B;
        
        if (isZip) {
            return await this.importFromZip(buffer);
        } else {
            // Legacy format: raw JSON
            return await this.importFromLegacyFormat(buffer);
        }
    }
    
    /**
     * Import from ZIP format (.pkrn v2.0)
     */
    async importFromZip(buffer) {
        try {
            const zip = await JSZip.loadAsync(buffer);
            
            // Find data file
            let data;
            if (zip.files['data.json']) {
                const json = await zip.files['data.json'].async('string');
                data = JSON.parse(json);
            } else if (zip.files['data.dat']) {
                const binary = await zip.files['data.dat'].async('arraybuffer');
                data = BinaryUtils.decode(binary);
            } else {
                throw new Error('Invalid .pkrn file: missing data file');
            }
            
            // Load media files
            const files = new Map();
            for (const filename of Object.keys(zip.files)) {
                if (filename.startsWith('uploaded_')) {
                    const blob = await zip.files[filename].async('blob');
                    const dataUrl = await MediaExtractor.blobToDataUrl(
                        blob, MediaExtractor.getMimeTypeFromFilename(filename) || blob.type);
                    files.set(filename, dataUrl);
                }
            }
            
            // Inject media back into data
            const injected = MediaExtractor.inject(data, files);
            
            // Validate and deserialize
            const result = this.validate(injected);
            if (result.valid) {
                return this.deserialize(injected);
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            throw new Error('Failed to parse ZIP file: ' + err.message);
        }
    }
    
    /**
     * Import from legacy JSON format (.pkrn v1.x)
     */
    async importFromLegacyFormat(buffer) {
        try {
            const decoder = new TextDecoder();
            const json = decoder.decode(buffer);
            const data = JSON.parse(json);
            
                    const result = this.validate(data);
                    if (result.valid) {
                return this.deserialize(data);
                    } else {
                throw new Error(result.error);
                    }
                } catch (err) {
            throw new Error('Failed to parse legacy format: ' + err.message);
                }
    }
    
    /**
     * Read file as ArrayBuffer
     */
    readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Import from JSON string
     * @param {string} json - JSON string to import
     * @returns {Object} Parsed data
     */
    importFromString(json) {
        try {
            const data = JSON.parse(json);
            const result = this.validate(data);
            if (result.valid) {
                return this.deserialize(data);
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            throw new Error('Failed to parse data: ' + err.message);
        }
    }

    /**
     * Import from base64 string
     * @param {string} base64 - Base64 encoded string
     * @returns {Object} Parsed data
     */
    importFromBase64(base64) {
        try {
            const json = decodeURIComponent(atob(base64));
            return this.importFromString(json);
        } catch (err) {
            throw new Error('Failed to decode data: ' + err.message);
        }
    }

    /**
     * Validate imported data
     * @param {Object} data - Data to validate
     * @returns {Object} Validation result
     */
    validate(data) {
        if (!data || typeof data !== 'object') {
            return { valid: false, error: 'Invalid data format' };
        }

        if (!data.version) {
            return { valid: false, error: 'Missing version information' };
        }

        if (!this.supportedVersions.includes(data.version)) {
            return { valid: false, error: `Unsupported version: ${data.version}` };
        }

        if (!data.objects || !Array.isArray(data.objects)) {
            return { valid: false, error: 'Missing or invalid objects array' };
        }

        return { valid: true };
    }

    /**
     * Deserialize data to world format
     * Uses PKRN_DEFAULTS for any missing or invalid values (backward compatibility)
     * @param {Object} data - Serialized data
     * @returns {Object} World-compatible data
     */
    deserialize(data) {
        const settings = data.settings || {};
        
        // Helper to get value with type validation and default fallback
        const getNumber = (val, def, validator = () => true) => {
            return (typeof val === 'number' && validator(val)) ? val : def;
        };
        const getBool = (val, def) => {
            return typeof val === 'boolean' ? val : def;
        };
        const getString = (val, def) => {
            return typeof val === 'string' && val.length > 0 ? val : def;
        };
        
        return {
            mapName: data.metadata?.name || 'Imported Map',
            mechanicsSaveId: typeof data.mechanicsSaveId === 'string' ? data.mechanicsSaveId : null,
            persistCheckpoints: getBool(settings.persistCheckpoints, PKRN_DEFAULTS.persistCheckpoints),
            background: getString(settings.background, PKRN_DEFAULTS.background),
            defaultBlockColor: getString(settings.defaultBlockColor, PKRN_DEFAULTS.defaultBlockColor),
            defaultSpikeColor: getString(settings.defaultSpikeColor, PKRN_DEFAULTS.defaultSpikeColor),
            defaultTextColor: getString(settings.defaultTextColor, PKRN_DEFAULTS.defaultTextColor),
            defaultPortalColor: getString(settings.defaultPortalColor, PKRN_DEFAULTS.defaultPortalColor),
            defaultBouncerColor: getString(settings.defaultBouncerColor, PKRN_DEFAULTS.defaultBouncerColor),
            showCoinCounter: getBool(settings.showCoinCounter, PKRN_DEFAULTS.showCoinCounter),
            cloudColorSky: getString(settings.cloudColorSky, PKRN_DEFAULTS.cloudColorSky),
            cloudColorGalaxy: getString(settings.cloudColorGalaxy, PKRN_DEFAULTS.cloudColorGalaxy),
            checkpointDefaultColor: getString(settings.checkpointDefaultColor, PKRN_DEFAULTS.checkpointDefaultColor),
            checkpointActiveColor: getString(settings.checkpointActiveColor, PKRN_DEFAULTS.checkpointActiveColor),
            checkpointTouchedColor: getString(settings.checkpointTouchedColor, PKRN_DEFAULTS.checkpointTouchedColor),
            maxJumps: getNumber(settings.maxJumps, PKRN_DEFAULTS.maxJumps, v => v >= 0),
            infiniteJumps: getBool(settings.infiniteJumps, PKRN_DEFAULTS.infiniteJumps),
            additionalAirjump: getBool(settings.additionalAirjump, PKRN_DEFAULTS.additionalAirjump),
            collideWithEachOther: settings.collideWithEachOther !== false,
            dieLineY: getNumber(settings.dieLineY, PKRN_DEFAULTS.dieLineY),
            // Physics settings with validation
            playerSpeed: getNumber(settings.playerSpeed, PKRN_DEFAULTS.playerSpeed, v => v > 0),
            horizontalAcceleration: getNumber(settings.horizontalAcceleration, PKRN_DEFAULTS.horizontalAcceleration, v => v >= 0 && v <= 20),
            airControl: getNumber(settings.airControl, PKRN_DEFAULTS.airControl, v => v >= 0 && v <= 1),
            terminalFallSpeed: getNumber(settings.terminalFallSpeed, null, v => v > 0 && v <= 100),
            jumpForce: getNumber(settings.jumpForce, PKRN_DEFAULTS.jumpForce, v => v < 0),
            gravity: getNumber(settings.gravity, PKRN_DEFAULTS.gravity, v => v > 0),
            // Camera settings (default to 0.12 if not specified)
            cameraLerpX: getNumber(settings.cameraLerpX, 0.12, v => v > 0 && v <= 1),
            cameraLerpY: getNumber(settings.cameraLerpY, 0.12, v => v > 0 && v <= 1),
            cameraFollowMode: ['both', 'horizontal', 'vertical'].includes(settings.cameraFollowMode)
                ? settings.cameraFollowMode : PKRN_DEFAULTS.cameraFollowMode,
            cameraBounds: (() => {
                const bounds = settings.cameraBounds;
                const valid = bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
                    Number.isFinite(bounds.width) && bounds.width > 0 &&
                    Number.isFinite(bounds.height) && bounds.height > 0 &&
                    Number.isFinite(bounds.x + bounds.width) && Number.isFinite(bounds.y + bounds.height);
                return valid
                    ? { enabled: bounds.enabled === true, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
                    : { ...PKRN_DEFAULTS.cameraBounds };
            })(),
            // Spike settings
            spikeTouchbox: PKRN_SPIKE_TOUCHBOX_MODES.includes(settings.spikeTouchbox)
                ? settings.spikeTouchbox : PKRN_DEFAULTS.spikeTouchbox,
            dropHurtOnly: settings.dropHurtOnly === true,
            // Storage preference
            storedDataType: ['json', 'dat'].includes(settings.storedDataType) 
                ? settings.storedDataType : PKRN_DEFAULTS.storedDataType,
            // Custom background with validation
            customBackground: this.deserializeCustomBackground(settings.customBackground),
            playerSpriteSheet: settings.playerSpriteSheet || null,
            // Music with validation
            music: this.deserializeMusic(settings.music),
            // Named draw layers are validated again by World.fromJSON.
            layerDefinitions: data.layerDefinitions,
            // Object stamp snapshots are normalized by World.fromJSON.
            objectStamps: Array.isArray(data.objectStamps) ? data.objectStamps : [],
            // Native tilemaps are normalized and bounded by World.fromJSON.
            tilemaps: Array.isArray(data.tilemaps) ? data.tilemaps : [],
            // Plugins configuration
            plugins: this.deserializePlugins(data.plugins),
            // Code plugin data (triggers & events)
            codeData: this.deserializeCodeData(data.codeData),
            // Objects
            objects: (data.objects || []).map(obj => this.deserializeObject(obj))
        };
    }
    
    /**
     * Deserialize plugins configuration
     * @param {Object} plugins - Plugins data
     * @returns {Object} Validated plugins data
     */
    deserializePlugins(plugins) {
        if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
            const emptyPlugins = Object.create(null);
            emptyPlugins.enabled = [];
            return emptyPlugins;
        }
        
        const result = Object.create(null);
        result.enabled = Array.isArray(plugins.enabled) ? plugins.enabled : [];
        
        // Copy plugin configs (hp, hk, code, etc.)
        for (const key of Object.keys(plugins)) {
            if (key !== 'enabled' && plugins[key] && typeof plugins[key] === 'object' && !Array.isArray(plugins[key])) {
                result[key] = { ...plugins[key] };
            }
        }
        
        return result;
    }
    
    /**
     * Deserialize code plugin data (triggers & events)
     * @param {Object} codeData - Code data
     * @returns {Object} Validated code data
     */
    deserializeCodeData(codeData) {
        const normalize = globalThis.normalizeParkoreenCodeData;
        if (typeof normalize === 'function') return normalize(codeData);
        if (!codeData || typeof codeData !== 'object' || Array.isArray(codeData)) {
            return { triggers: [], events: [], variables: [] };
        }
        // Keep import usable in older host pages while retaining both versions
        // of the event list if the shared game normalizer is unavailable.
        const events = [...(Array.isArray(codeData.events) ? codeData.events : []),
            ...(Array.isArray(codeData.actions) ? codeData.actions : [])]
            .map(event => event && typeof event === 'object' && !Array.isArray(event) && event.type === 'action'
                ? { ...event, type: 'event' }
                : event);
        const result = {
            ...codeData,
            triggers: Array.isArray(codeData.triggers) ? codeData.triggers : [],
            events,
            variables: Array.isArray(codeData.variables) ? codeData.variables : []
        };
        delete result.actions;
        return result;
    }
    
    /**
     * Deserialize music settings with defaults
     * @param {Object} music - Music settings
     * @returns {Object} Validated music data
     */
    deserializeMusic(music) {
        const validTypes = ['none', 'maccary-bay', 'reggae-party', 'custom'];
        
        if (!music) {
            return {
                type: 'none',
                customData: null,
                customName: null,
                volume: 50,
                loop: true
            };
        }
        
        return {
            type: validTypes.includes(music.type) ? music.type : 'none',
            customData: music.customData || null,
            customName: music.customName || null,
            volume: (typeof music.volume === 'number' && music.volume >= 0 && music.volume <= 100) ? music.volume : 50,
            loop: music.loop !== false
        };
    }

    /**
     * Deserialize custom background with defaults
     * @param {Object} cb - Custom background settings
     * @returns {Object} Validated custom background data
     */
    deserializeCustomBackground(cb) {
        if (!cb || typeof cb !== 'object' || !cb.enabled) {
            return { ...PKRN_DEFAULTS.customBackground };
        }

        return {
            enabled: true,
            type: ['image', 'gif', 'video'].includes(cb.type) ? cb.type : null,
            data: typeof cb.data === 'string' ? cb.data : null,
            playMode: ['once', 'loop', 'bounce'].includes(cb.playMode) ? cb.playMode : 'loop',
            loopCount: typeof cb.loopCount === 'number' ? cb.loopCount : -1,
            endType: ['freeze', 'replace'].includes(cb.endType) ? cb.endType : 'freeze',
            endBackground: cb.endBackground && typeof cb.endBackground === 'object' 
                ? this.deserializeCustomBackground(cb.endBackground) : null,
            sameAcrossScreens: !!cb.sameAcrossScreens,
            reverse: !!cb.reverse
        };
    }

    /**
     * Deserialize a single object
     * @param {Object} obj - Serialized object
     * @returns {Object} WorldObject-compatible data
     */
    deserializeObject(obj) {
        const data = {
            id: obj.id,
            x: obj.x,
            y: obj.y,
            width: obj.w || obj.width || 32,
            height: obj.h || obj.height || 32,
            type: obj.t || obj.type || 'block',
            appearanceType: obj.at || obj.appearanceType || 'ground',
            actingType: obj.act || obj.actingType || 'ground',
            collision: obj.col !== undefined ? !!obj.col : (obj.collision !== false),
            color: obj.c || obj.color || '#787878',
            opacity: obj.o !== undefined ? obj.o : (obj.opacity !== undefined ? obj.opacity : 1),
            layer: obj.l !== undefined ? obj.l : (obj.layer !== undefined ? obj.layer : 1),
            rotation: obj.r || obj.rotation || 0,
            flipHorizontal: obj.fh ? !!obj.fh : (obj.flipHorizontal || false),
            oneWayPlatform: obj.owp !== undefined ? obj.owp === 1 || obj.owp === true : obj.oneWayPlatform === true,
            collisionShape: ['circle', 'capsule', 'slopeUpRight', 'slopeUpLeft', 'polygon'].includes(obj.cs !== undefined ? obj.cs : obj.collisionShape)
                ? (obj.cs !== undefined ? obj.cs : obj.collisionShape) : 'box',
            collisionPoints: obj.cp || obj.collisionPoints || null,
            polygonOneWay: obj.po === 0 ? false : (obj.polygonOneWay !== false),
            name: obj.n || obj.name || 'Object',
            texture: obj.tex || obj.texture || 'solid',
            spriteSheet: obj.spriteSheet || null
        };

        // Damage amount (spikes and spinners)
        if (obj.da !== undefined || obj.damageAmount !== undefined) {
            data.damageAmount = obj.da !== undefined ? obj.da : obj.damageAmount;
        }

        // Spinner-specific properties
        if (data.type === 'spinner' || data.appearanceType === 'spinner') {
            data.spinSpeed = obj.ss !== undefined ? obj.ss : (obj.spinSpeed !== undefined ? obj.spinSpeed : 1);
            data.spinDirection = obj.sd !== undefined ? obj.sd : (obj.spinDirection !== undefined ? obj.spinDirection : 1);
        }

        const optionalNumberFields = [
            'bouncerStrength', 'bouncerDirection', 'bouncerAppearanceDirection',
            'coinAmount', 'endpointRequiredCoins', 'particleOpacity'
        ];
        for (const key of optionalNumberFields) {
            if (typeof obj[key] === 'number' && Number.isFinite(obj[key])) data[key] = obj[key];
        }
        for (const key of ['bouncerMatchAppearance', 'endpointRequireCoins', 'buttonOnlyOnce']) {
            if (typeof obj[key] === 'boolean') data[key] = obj[key];
        }
        if (['global', 'player'].includes(obj.coinActivityScope)) data.coinActivityScope = obj.coinActivityScope;

        // Button-specific properties
        if (data.appearanceType === 'button' || data.actingType === 'button') {
            data.displayName = obj.bdn || obj.displayName || '';
            data.displayDescription = obj.bdd || obj.displayDescription || '';
            data.buttonVisible = obj.bv !== undefined ? !!obj.bv : (obj.buttonVisible !== false);
            data.buttonWidth = obj.bw || obj.buttonWidth || null;
            data.buttonHeight = obj.bh || obj.buttonHeight || null;
            if (obj.buttonInteraction === 'click' || obj.buttonInteraction === 'collide') data.buttonInteraction = obj.buttonInteraction;
            if (typeof obj.buttonOnlyOnce === 'boolean') data.buttonOnlyOnce = obj.buttonOnlyOnce;
            if (typeof obj.buttonColor2 === 'string' && obj.buttonColor2) data.buttonColor2 = obj.buttonColor2;
        }

        // Text-specific properties
        if (data.type === 'text') {
            data.content = obj.txt || obj.content || '';
            data.font = obj.f || obj.font || 'Arial';
            data.fontSize = obj.fs || obj.fontSize || 24;
            data.hAlign = obj.ha || obj.hAlign || 'center';
            data.vAlign = obj.va || obj.vAlign || 'center';
            data.hSpacing = obj.hs || obj.hSpacing || 0;
            data.vSpacing = obj.vs || obj.vSpacing || 0;
        }
        
        // Spike-specific properties
        const spikeTouchbox = obj.stb || obj.spikeTouchbox;
        if (spikeTouchbox && PKRN_SPIKE_TOUCHBOX_MODES.includes(spikeTouchbox)) {
            data.spikeTouchbox = spikeTouchbox;
        }
        const dropHurtOnly = obj.dho !== undefined ? obj.dho : obj.dropHurtOnly;
        if (dropHurtOnly !== undefined) {
            data.dropHurtOnly = dropHurtOnly === true;
        }
        
        // Zone-specific properties
        const zoneName = obj.zn || obj.zoneName;
        if (zoneName) {
            data.zoneName = zoneName;
        }

        if (typeof obj.bouncerMatchAppearance === 'boolean') data.bouncerMatchAppearance = obj.bouncerMatchAppearance;
        if (typeof obj.endpointRequireCoins === 'boolean') data.endpointRequireCoins = obj.endpointRequireCoins;
        if (typeof obj.coinActivityScope === 'string' && ['global', 'player'].includes(obj.coinActivityScope)) {
            data.coinActivityScope = obj.coinActivityScope;
        }
        for (const key of ['bouncerStrength', 'bouncerDirection', 'bouncerAppearanceDirection', 'coinAmount', 'endpointRequiredCoins', 'particleOpacity']) {
            if (typeof obj[key] === 'number' && Number.isFinite(obj[key])) data[key] = obj[key];
        }
        
        // Teleportal-specific properties
        const teleportalName = obj.tpn || obj.teleportalName;
        if (teleportalName) {
            data.teleportalName = teleportalName;
        }
        
        // Teleportal connections
        const sendTo = obj.tps || obj.sendTo;
        if (sendTo && Array.isArray(sendTo)) {
            data.sendTo = sendTo;
        }
        
        const receiveFrom = obj.tpr || obj.receiveFrom;
        if (receiveFrom && Array.isArray(receiveFrom)) {
            data.receiveFrom = receiveFrom;
        }

        return data;
    }
}

// ============================================
// CLOUD SYNC MANAGER
// ============================================
class CloudSyncManager {
    constructor(apiUrl) {
        this.apiUrl = apiUrl;
        this.exportManager = new ExportManager();
        this.importManager = new ImportManager();
    }

    /**
     * Handle unauthorized response - sign out user
     * @param {Response} response - Fetch response
     */
    handleUnauthorized(response) {
        if (response.status === 401) {
            console.warn('[CloudSync] Unauthorized - signing out user');
            // Clear auth tokens from localStorage
            localStorage.removeItem('parkoreen_auth_token');
            localStorage.removeItem('parkoreen_user');
            // Redirect to login/dashboard
            if (typeof window !== 'undefined') {
                window.location.href = '/parkoreen/dashboard/';
            }
            throw new Error('Session expired. Please sign in again.');
        }
    }

    /**
     * Save map to cloud
     * @param {World} world - World to save
     * @param {string} token - Auth token
     * @param {string} mapId - Optional map ID for updates
     * @returns {Promise<Object>} Save result
     */
    async saveToCloud(world, token, mapId = null) {
        const data = this.exportManager.serialize(world);
        
        const response = await fetch(`${this.apiUrl}/maps${mapId ? '/' + mapId : ''}`, {
            method: mapId ? 'PUT' : 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(data)
        });

        this.handleUnauthorized(response);

        if (!response.ok) {
            throw new Error('Failed to save to cloud');
        }

        return await response.json();
    }

    /**
     * Load map from cloud
     * @param {string} mapId - Map ID to load
     * @param {string} token - Auth token
     * @returns {Promise<Object>} Map data
     */
    async loadFromCloud(mapId, token) {
        const response = await fetch(`${this.apiUrl}/maps/${mapId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        this.handleUnauthorized(response);

        if (!response.ok) {
            throw new Error('Failed to load from cloud');
        }

        const data = await response.json();
        return this.importManager.importFromString(JSON.stringify(data));
    }

    /**
     * List user's maps
     * @param {string} token - Auth token
     * @returns {Promise<Array>} List of maps
     */
    async listMaps(token) {
        const response = await fetch(`${this.apiUrl}/maps`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        this.handleUnauthorized(response);
        
        if (!response.ok) {
            throw new Error('Failed to list maps');
        }

        return await response.json();
    }

    /**
     * Delete map from cloud
     * @param {string} mapId - Map ID to delete
     * @param {string} token - Auth token
     * @returns {Promise<boolean>} Success status
     */
    async deleteFromCloud(mapId, token) {
        const response = await fetch(`${this.apiUrl}/maps/${mapId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        this.handleUnauthorized(response);
        
        return response.ok;
        }
    }

// Export for use
if (typeof window !== 'undefined') {
window.ExportManager = ExportManager;
window.ImportManager = ImportManager;
window.CloudSyncManager = CloudSyncManager;
    window.PKRN_VERSION = PKRN_VERSION;
    window.PKRN_DEFAULTS = PKRN_DEFAULTS;
}
