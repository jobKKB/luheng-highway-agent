'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { exactKeys } = require('./vault.cjs');
class DesktopPreferences {
  constructor(stateRoot) {
    this.file = path.join(stateRoot, 'desktop-preferences.json');
    this.backgroundEnabled = false;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.size > 1024) return;
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (exactKeys(saved, ['backgroundEnabled']) && typeof saved.backgroundEnabled === 'boolean') this.backgroundEnabled = saved.backgroundEnabled;
    } catch {}
  }
  set(value) {
    if (!exactKeys(value, ['backgroundEnabled']) || typeof value.backgroundEnabled !== 'boolean') throw new Error('只允许设置关闭后后台运行选项。');
    const temp = path.join(path.dirname(this.file), `.preferences-${randomBytes(16).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, this.file);
      this.backgroundEnabled = value.backgroundEnabled;
    } catch { throw new Error('桌面偏好保存失败。'); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
}
function shouldHideOnClose({ backgroundEnabled, trayAvailable, exiting }) { return backgroundEnabled === true && trayAvailable === true && exiting !== true; }

// Tray ownership and shutdown are kept outside the renderer. In particular, a
// failed/destroyed tray can never turn the close button into an invisible app.
class TrayLifecycle {
  constructor({ Tray, Menu, nativeImage, iconPath, showWindow, quit }) {
    Object.assign(this, { Tray, Menu, nativeImage, iconPath, showWindow, quit });
    this.tray = null;
  }
  available() {
    try { return Boolean(this.tray && !this.tray.isDestroyed()); } catch { return false; }
  }
  create() {
    if (this.available()) return true;
    try {
      const image = this.nativeImage.createFromPath(this.iconPath);
      if (image.isEmpty()) return false;
      this.tray = new this.Tray(image);
      this.tray.setToolTip('路衡 · 办公智能体');
      this.tray.setContextMenu(this.Menu.buildFromTemplate([
        { label: '打开路衡', click: () => this.showWindow() },
        { type: 'separator' },
        { label: '退出路衡（停止后台任务）', click: () => this.quit() },
      ]));
      this.tray.on('click', () => this.showWindow());
      this.tray.on('double-click', () => this.showWindow());
      if (!this.available()) throw new Error('tray unavailable');
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }
  handleClose(event, window, { backgroundEnabled, exiting }) {
    if (!shouldHideOnClose({ backgroundEnabled, exiting, trayAvailable: this.available() })) return false;
    event.preventDefault();
    window.hide();
    return true;
  }
  destroy() {
    try { if (this.available()) this.tray.destroy(); } catch {}
    this.tray = null;
  }
}
module.exports = { DesktopPreferences, shouldHideOnClose, TrayLifecycle };
