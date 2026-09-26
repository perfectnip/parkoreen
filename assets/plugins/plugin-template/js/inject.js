/**
 * Parkoreen plugin API v1 starter: a configurable player marker and a tiny sprite-sheet animation.
 * This file runs as trusted page code only after the plugin is bundled and
 * listed in assets/plugins/manifest.json.
 */
/** @param {import('../types/plugin-api-v1').ParkoreenPluginContext} ctx */
(function(ctx) {
    'use strict';

    const { api } = ctx;
    const config = /** @type {{ showPlayerMarker?: boolean, animateMarker?: boolean }} */ (
        /** @type {unknown} */ (api.getConfig())
    );
    const loadImageAsset = name => {
        const image = new Image();
        const url = api.getAssetUrl(name);
        if (url) image.src = url;
        api.onCleanup(() => {
            image.onload = null;
            image.onerror = null;
            image.src = '';
        });
        return image;
    };
    const marker = loadImageAsset('playerMarker');
    const spriteSheet = loadImageAsset('playerSheet');

    api.registerHook('render.player', (data) => {
        const { ctx: canvas, player, camera } = data;
        if (!canvas || !player || !camera || config.showPlayerMarker === false) return data;

        const centerX = player.x + player.width / 2 - camera.x;
        const topY = player.y - camera.y - 8;
        if (player.input?.markerPulse === true) {
            canvas.save();
            canvas.strokeStyle = '#ffe082';
            canvas.lineWidth = 2;
            canvas.beginPath();
            canvas.arc(centerX, topY - 7, 12, 0, Math.PI * 2);
            canvas.stroke();
            canvas.restore();
        }
        const hasSpriteSheet = spriteSheet.complete && spriteSheet.naturalWidth >= 96 && spriteSheet.naturalHeight >= 32;
        if (config.animateMarker !== false && hasSpriteSheet) {
            const frame = Math.floor(Date.now() / 140) % 3;
            canvas.drawImage(spriteSheet, frame * 32, 0, 32, 32, centerX - 8, topY - 16, 16, 16);
        } else if (marker.complete && marker.naturalWidth > 0) {
            canvas.drawImage(marker, centerX - 8, topY - 16, 16, 16);
        } else {
            canvas.save();
            canvas.fillStyle = '#ffe082';
            canvas.beginPath();
            canvas.moveTo(centerX, topY - 5);
            canvas.lineTo(centerX - 4, topY + 1);
            canvas.lineTo(centerX + 4, topY + 1);
            canvas.closePath();
            canvas.fill();
            canvas.restore();
        }
        return data;
    });
})(ctx);
