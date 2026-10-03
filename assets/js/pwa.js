(() => {
    if (!('serviceWorker' in navigator)) return;

    const manifestLink = document.querySelector('link[rel="manifest"]');
    const manifestUrl = manifestLink?.href || new URL('/parkoreen/manifest.json', location.origin).href;
    const appBase = new URL('.', manifestUrl);
    const workerUrl = new URL('sw.js', appBase);
    let installPrompt = null;

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        installPrompt = event;
        window.dispatchEvent(new Event('parkoreen-install-available'));
    });

    window.addEventListener('appinstalled', () => {
        installPrompt = null;
        window.dispatchEvent(new Event('parkoreen-app-installed'));
    });

    window.ParkoreenInstall = {
        get available() { return Boolean(installPrompt); },
        async prompt() {
            if (!installPrompt) return false;
            const promptEvent = installPrompt;
            installPrompt = null;
            await promptEvent.prompt();
            const choice = await promptEvent.userChoice;
            return choice?.outcome === 'accepted';
        }
    };

    navigator.serviceWorker.register(workerUrl.href, { scope: appBase.pathname })
        .then(registration => {
            // Ask for an update on launch and when a long-running app returns.
            // The worker activates the new cache without forcing a reload mid-game.
            registration.update().catch(() => {});
            let lastCheck = Date.now();
            window.addEventListener('focus', () => {
                if (Date.now() - lastCheck < 6 * 60 * 60 * 1000) return;
                lastCheck = Date.now();
                registration.update().catch(() => {});
            });
        })
        .catch(error => console.warn('[PWA] Service worker registration failed:', error));
})();
