// Updates the app without visiting GitHub. A while after the app opens, and every
// 4 hours, it asks the newest release whether there is a newer version. If there
// is, it downloads it quietly and shows Update ready in the top bar. Clicking that
// installs it and reopens the app; otherwise it installs when the app closes.
// Every update is checked against the signing key in tauri.conf.json before it runs.

import { isDesktop } from './backend/index.js';

let pending = null; // a downloaded update waiting to install
let checking = null;
let ui = null;

/** This app's version, such as 1.2.41. */
export async function appVersion() {
  if (!isDesktop) return 'dev';
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '?';
  }
}

/**
 * ui: { badge, panel, text, later, install, busy() } where busy() returns how many
 * downloads are running, since installing closes the app.
 */
export function startUpdater(parts) {
  ui = parts;
  ui.badge.addEventListener('click', offerInstall);
  ui.later.addEventListener('click', () => (ui.panel.hidden = true));
  ui.install.addEventListener('click', installNow);
  // a copy started from the .bat runs from source and updates through git instead
  if (!isDesktop || import.meta.env.DEV) return;
  setTimeout(() => checkForUpdate({ quiet: true }), 20000);
  setInterval(() => checkForUpdate({ quiet: true }), 4 * 3600 * 1000);
  installOnClose();
}

/**
 * Looks for a newer version and downloads it. Returns a line to show in Settings:
 * quiet checks return nothing.
 */
export async function checkForUpdate({ quiet = false } = {}) {
  if (!isDesktop || import.meta.env.DEV) return 'Updates only work in the installed app.';
  if (pending) {
    if (!quiet) offerInstall();
    return `Version ${pending.version} is downloaded and ready to install.`;
  }
  if (checking) return checking;
  checking = (async () => {
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const upd = await check({ timeout: 30000 });
      if (!upd) return `This is the newest version (${await appVersion()}).`;
      await upd.download();
      pending = upd;
      ui.badge.hidden = false;
      ui.badge.title = `Version ${upd.version} is downloaded. Click to install it now, or it installs when you close the app.`;
      if (!quiet) offerInstall();
      return `Version ${upd.version} is downloaded and ready to install.`;
    } catch (e) {
      return quiet ? null : `Could not check for updates: ${e?.message || e}`;
    } finally {
      checking = null;
    }
  })();
  return checking;
}

function offerInstall() {
  if (!pending) return;
  const n = ui.busy();
  ui.text.textContent =
    `Version ${pending.version} is downloaded. Installing closes the app for a few seconds and opens it again.` +
    (n ? ` ${n === 1 ? '1 download is' : `${n} downloads are`} still running and will stop, so press Later to let ${n === 1 ? 'it' : 'them'} finish. The update then installs when you close the app.` : '');
  ui.panel.hidden = false;
}

async function installNow() {
  ui.panel.hidden = true;
  ui.badge.textContent = 'Installing';
  try {
    await pending.install();
    // Windows closes the app here and opens the new one; a Mac needs a restart
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    ui.badge.textContent = 'Update ready';
    ui.text.textContent = `The update did not install: ${e?.message || e}`;
    ui.panel.hidden = false;
  }
}

/** Installs a downloaded update as the window closes, without opening the app again. */
async function installOnClose() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().onCloseRequested(async () => {
      if (!pending) return;
      try {
        await pending.install();
      } catch {
        // a failed install leaves the old version, which checks again next time
      }
    });
  } catch {
    // without the window API the update waits for Install now
  }
}
