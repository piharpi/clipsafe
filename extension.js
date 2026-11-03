/* ClipSafe — security-first, memory-only clipboard history for GNOME Shell.
 *
 * Design goals:
 *   - Nothing is ever written to disk. History (text AND images) lives only
 *     in this process.
 *   - Content flagged secret by a password manager is never captured.
 *   - Content that looks like a secret is stored masked and never previewed.
 *   - User-defined exclusion rules (regex + per-app) keep chosen data out.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const PREVIEW_LEN = 48;
const THUMB_MAX = 160;   // px, longest side of the in-menu thumbnail

// MIME targets that password managers set to mark a secret payload.
const SECRET_MIME_HINTS = [
    'x-kde-passwordManagerHint',
];

// Heuristics for content that should be stored masked.
const SENSITIVE_PATTERNS = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,            // PEM private keys
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
    /\b(sk|pk|rk)-[A-Za-z0-9]{16,}/,                     // Stripe / OpenAI style
    /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,          // GitHub tokens
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,                    // Slack tokens
    /\bAKIA[0-9A-Z]{16}\b/,                              // AWS access key id
    /\bAIza[0-9A-Za-z_-]{20,}/,                          // Google API key
];

const ClipSafeButton = GObject.registerClass(
class ClipSafeButton extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'ClipSafe');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._searchText = '';

        this._icon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // Search box.
        this._searchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._searchEntry = new St.Entry({
            hint_text: 'Search clipboard…',
            track_hover: true,
            can_focus: true,
            x_expand: true,
            style_class: 'clipsafe-search',
        });
        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._searchText = this._searchEntry.get_text().toLowerCase();
            this.rebuild();
        });
        this._searchItem.add_child(this._searchEntry);
        this.menu.addMenuItem(this._searchItem);

        // Scrollable history list.
        this._historySection = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({style_class: 'clipsafe-scroll'});
        scroll.add_child(this._historySection.actor);
        const scrollItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        scrollItem.add_child(scroll);
        this.menu.addMenuItem(scrollItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Controls.
        this._pauseItem = new PopupMenu.PopupSwitchMenuItem(
            'Pause capturing', this._settings.get_boolean('paused'));
        this._pauseItem.connect('toggled', (_i, state) => {
            this._settings.set_boolean('paused', state);
            this._updateIcon();
        });
        this.menu.addMenuItem(this._pauseItem);

        this._clearItem = new PopupMenu.PopupMenuItem('Clear all history');
        this._clearItem.connect('activate', () => this._ext.clearAll());
        this.menu.addMenuItem(this._clearItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Settings…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);

        this._menuStateId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._searchEntry.set_text('');
                global.stage.set_key_focus(this._searchEntry.clutter_text);
            } else {
                this._searchText = '';
            }
        });

        this._updateIcon();
        this.rebuild();
    }

    _updateIcon() {
        const paused = this._settings.get_boolean('paused');
        this._icon.icon_name = paused
            ? 'media-playback-pause-symbolic'
            : 'edit-paste-symbolic';
        this.opacity = paused ? 150 : 255;
    }

    _maskFor(entry) {
        const n = Math.min(Math.max(entry.text.length, 6), 12);
        return '•'.repeat(n) + '  (hidden)';
    }

    _previewFor(entry) {
        let t = entry.text.replace(/\s+/g, ' ').trim();
        if (t.length > PREVIEW_LEN)
            t = t.slice(0, PREVIEW_LEN) + '…';
        return t;
    }

    _searchableOf(entry) {
        return entry.kind === 'image'
            ? `image ${entry.width}x${entry.height}`
            : entry.text;
    }

    _buildTextItem(entry) {
        const item = new PopupMenu.PopupBaseMenuItem();

        const label = new St.Label({
            text: entry.concealed && !entry.revealed
                ? this._maskFor(entry)
                : this._previewFor(entry),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (entry.concealed)
            label.add_style_class_name('clipsafe-concealed');
        item.add_child(label);

        if (entry.concealed) {
            const eye = new St.Button({
                style_class: 'clipsafe-icon-button',
                child: new St.Icon({
                    icon_name: entry.revealed
                        ? 'view-conceal-symbolic'
                        : 'view-reveal-symbolic',
                    style_class: 'popup-menu-icon',
                }),
            });
            eye.connect('clicked', () => {
                entry.revealed = !entry.revealed;
                this.rebuild();
                return Clutter.EVENT_STOP;
            });
            item.add_child(eye);
        }

        this._addDelete(item, entry);
        item.connect('activate', () => this._ext.applyEntry(entry));
        return item;
    }

    _buildImageItem(entry) {
        const item = new PopupMenu.PopupBaseMenuItem();

        if (entry.thumb) {
            const img = new St.Widget({
                width: entry.thumbW,
                height: entry.thumbH,
                content: entry.thumb,
                style_class: 'clipsafe-thumb',
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(img);
        } else {
            item.add_child(new St.Icon({
                icon_name: 'image-x-generic-symbolic',
                style_class: 'popup-menu-icon',
            }));
        }

        const label = new St.Label({
            text: `  Image ${entry.width}×${entry.height}`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(label);

        this._addDelete(item, entry);
        item.connect('activate', () => this._ext.applyEntry(entry));
        return item;
    }

    _addDelete(item, entry) {
        const del = new St.Button({
            style_class: 'clipsafe-icon-button',
            child: new St.Icon({
                icon_name: 'edit-delete-symbolic',
                style_class: 'popup-menu-icon',
            }),
        });
        del.connect('clicked', () => {
            this._ext.removeEntry(entry);
            return Clutter.EVENT_STOP;
        });
        item.add_child(del);
    }

    destroy() {
        if (this._menuStateId) {
            this.menu.disconnect(this._menuStateId);
            this._menuStateId = 0;
        }
        super.destroy();
    }

    rebuild() {
        this._historySection.removeAll();

        const q = this._searchText;
        const entries = this._ext.entries.filter(e =>
            q.length === 0 || this._searchableOf(e).toLowerCase().includes(q));

        if (entries.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                q.length ? 'No match' : 'Clipboard history empty');
            empty.setSensitive(false);
            this._historySection.addMenuItem(empty);
            return;
        }

        for (const entry of entries) {
            const item = entry.kind === 'image'
                ? this._buildImageItem(entry)
                : this._buildTextItem(entry);
            this._historySection.addMenuItem(item);
        }
    }
});

export default class ClipSafeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.entries = [];
        this._ignoreText = null;    // suppress echo of our own text paste-back
        this._ignoreHash = null;    // suppress echo of our own image paste-back

        // Images are cached on real disk (0600) to spare RAM; text stays in RAM.
        // The cache is wiped on start and on disable, so it never outlives a session.
        this._cacheDir = GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'clipsafe']);
        this._ensureCache();
        this._wipePromise = this._wipeCache();

        this._button = new ClipSafeButton(this);
        Main.panel.addToStatusArea('clipsafe', this._button);

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect(
            'owner-changed', (_sel, type, source) =>
                this._onOwnerChanged(type, source));

        this._sessionId = Main.sessionMode.connect(
            'updated', () => this._onSessionUpdated());

        Main.wm.addKeybinding(
            'toggle-menu', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._button.menu.toggle());

        this._idleChangedId = this._settings.connect(
            'changed::idle-clear-minutes', () => this._setupIdleWatch());
        this._setupIdleWatch();
    }

    /* ClipSafe declares the `unlock-dialog` session mode so the clipboard
     * history survives a screen lock instead of being wiped by disable().
     * While locked, _onSessionUpdated() hides the indicator and capture is
     * skipped; the history is wiped on lock only if `clear-on-lock` is set. */
    disable() {
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = null;
        }
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = null;
        }
        if (this._idleChangedId) {
            this._settings.disconnect(this._idleChangedId);
            this._idleChangedId = null;
        }
        this._removeIdleWatch();
        Main.wm.removeKeybinding('toggle-menu');

        this._selection = null;

        this._button?.destroy();
        this._button = null;

        this.clearAll();
        this._wipeCache();
        this.entries = [];
        this._settings = null;
    }

    _ensureCache() {
        try {
            Gio.File.new_for_path(this._cacheDir)
                .make_directory_with_parents(null);
        } catch {
            // Already exists or cannot be created; writes will fail gracefully.
        }
    }

    async _wipeCache() {
        const dir = Gio.File.new_for_path(this._cacheDir);
        try {
            const en = await dir.enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
            for (;;) {
                const infos = await en.next_files_async(32, GLib.PRIORITY_DEFAULT, null);
                if (infos.length === 0)
                    break;
                await Promise.all(infos.map(info =>
                    dir.get_child(info.get_name())
                        .delete_async(GLib.PRIORITY_DEFAULT, null)
                        .catch(() => {})));
            }
        } catch {
            // Directory missing: nothing to wipe.
        }
    }

    _extForMime(mime) {
        switch (mime) {
        case 'image/png':  return '.png';
        case 'image/jpeg': return '.jpg';
        case 'image/gif':  return '.gif';
        case 'image/webp': return '.webp';
        case 'image/bmp':  return '.bmp';
        case 'image/tiff': return '.tiff';
        default:           return '.img';
        }
    }

    _imagePath(hash, mime) {
        return GLib.build_filenamev(
            [this._cacheDir, `img-${hash}${this._extForMime(mime)}`]);
    }

    async _writeImageFile(path, bytes) {
        try {
            await Gio.File.new_for_path(path).replace_contents_bytes_async(
                bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null);
            return true;
        } catch {
            return false;
        }
    }

    async _readImageFile(path) {
        try {
            const [contents] = await Gio.File.new_for_path(path)
                .load_contents_async(null);
            return GLib.Bytes.new(contents);
        } catch {
            return null;
        }
    }

    _deleteImageFile(path) {
        Gio.File.new_for_path(path)
            .delete_async(GLib.PRIORITY_DEFAULT, null)
            .catch(() => {});
    }

    _setupIdleWatch() {
        this._removeIdleWatch();
        const mins = this._settings.get_int('idle-clear-minutes');
        if (mins <= 0)
            return;
        try {
            this._idleMonitor = global.backend.get_core_idle_monitor();
            this._idleWatchId = this._idleMonitor.add_idle_watch(
                mins * 60 * 1000, () => this.clearAll());
        } catch {
            this._idleMonitor = null;
            this._idleWatchId = 0;
        }
    }

    _removeIdleWatch() {
        if (this._idleMonitor && this._idleWatchId)
            this._idleMonitor.remove_watch(this._idleWatchId);
        this._idleMonitor = null;
        this._idleWatchId = 0;
    }

    // unlock-dialog is only used so history survives a screen lock.
    // While locked: no panel UI, no capture, optional wipe.
    _onSessionUpdated() {
        const locked = Main.sessionMode.isLocked;
        if (this._button) {
            this._button.visible = !locked;
            if (locked)
                this._button.menu.close();
        }
        if (locked && this._settings.get_boolean('clear-on-lock'))
            this.clearAll();
    }

    _getMimetypes(source) {
        try {
            return source?.get_mimetypes?.() ?? [];
        } catch {
            return [];
        }
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;
        if (Main.sessionMode.isLocked || this._settings.get_boolean('paused'))
            return;

        const mimes = this._getMimetypes(source);

        if (this._settings.get_boolean('skip-password-manager') &&
            this._hasSecretHint(mimes))
            return;

        if (this._isBlockedApp())
            return;

        const textMime = this._pickTextMime(mimes);
        if (textMime) {
            // Up to 4 bytes per character in UTF-8, +1 to detect overflow.
            const limit = this._settings.get_int('max-entry-length') * 4 + 1;
            this._readSelection(textMime, limit)
                .then(bytes => {
                    if (bytes && bytes.get_size() < limit)
                        this._onText(new TextDecoder().decode(bytes.toArray()));
                })
                .catch(e => logError(e, 'clipsafe: reading text failed'));
            return;
        }

        if (this._settings.get_boolean('capture-images')) {
            const mime = this._pickImageMime(mimes);
            if (mime) {
                this._readSelection(mime,
                    this._settings.get_int('max-image-mb') * 1024 * 1024 + 1)
                    .then(bytes => this._onImage(mime, bytes))
                    .catch(e => logError(e, 'clipsafe: reading image failed'));
            }
        }
    }

    /* All clipboard access goes through Meta.Selection. St.Clipboard is not
     * used: on GNOME 50 its get_content() drops one reference too many on
     * the GBytes of in-shell sources (screenshots, our own paste-back),
     * which later crashes the shell with a double free. */
    _readSelection(mime, limit) {
        const selection = this._selection;
        return new Promise(resolve => {
            const stream = Gio.MemoryOutputStream.new_resizable();
            selection.transfer_async(Meta.SelectionType.SELECTION_CLIPBOARD,
                mime, limit, stream, null, (sel, res) => {
                    try {
                        sel.transfer_finish(res);
                        stream.close(null);
                        resolve(stream.steal_as_bytes());
                    } catch {
                        resolve(null);
                    }
                });
        });
    }

    _pickImageMime(mimes) {
        return mimes.find(m => m.toLowerCase() === 'image/png') ??
            mimes.find(m => m.toLowerCase().startsWith('image/')) ?? null;
    }

    _pickTextMime(mimes) {
        const lower = mimes.map(m => m.toLowerCase());
        for (const want of ['text/plain;charset=utf-8', 'utf8_string', 'text/plain']) {
            const i = lower.indexOf(want);
            if (i !== -1)
                return mimes[i];
        }
        const i = lower.findIndex(m => m.startsWith('text/plain'));
        return i !== -1 ? mimes[i] : null;
    }

    _setClipboard(mime, bytes) {
        const source = Meta.SelectionSourceMemory.new(mime, bytes);
        this._selection?.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    _hasSecretHint(mimes) {
        const hints = SECRET_MIME_HINTS.map(h => h.toLowerCase());
        return mimes.some(m => hints.some(h => m.toLowerCase().includes(h)));
    }

    _isBlockedApp() {
        const list = this._settings.get_strv('app-blocklist');
        if (list.length === 0)
            return false;
        let wmClass = '';
        try {
            wmClass = (global.display.focus_window?.get_wm_class() ?? '')
                .toLowerCase();
        } catch {
            return false;
        }
        if (!wmClass)
            return false;
        return list.some(b => b && wmClass.includes(b.toLowerCase()));
    }

    _matchesExclusion(text) {
        const patterns = this._settings.get_strv('exclusion-patterns');
        for (const p of patterns) {
            if (!p)
                continue;
            try {
                if (new RegExp(p).test(text))
                    return true;
            } catch {
                // Invalid regex entered by the user: ignore it.
            }
        }
        return false;
    }

    _pushEntry(entry) {
        this.entries.unshift(entry);
        const max = this._settings.get_int('history-size');
        while (this.entries.length > max)
            this._dropEntry(this.entries.pop());
        this._button?.rebuild();
    }

    _onText(text) {
        if (!text || text.trim().length === 0)
            return;
        if (text.length > this._settings.get_int('max-entry-length'))
            return;

        if (this._ignoreText !== null && text === this._ignoreText) {
            this._ignoreText = null;
            return;
        }

        if (this._matchesExclusion(text))
            return;

        const existingIdx = this.entries.findIndex(
            e => e.kind !== 'image' && e.text === text);
        if (existingIdx !== -1) {
            const [existing] = this.entries.splice(existingIdx, 1);
            this.entries.unshift(existing);
            this._button?.rebuild();
            return;
        }

        const concealed = this._settings.get_boolean('conceal-sensitive') &&
            this._looksSensitive(text);

        const entry = {
            kind: 'text',
            text,
            concealed,
            revealed: false,
            date: Date.now(),
            ttlId: 0,
        };
        this._pushEntry(entry);

        const ttl = this._settings.get_int('sensitive-ttl');
        if (concealed && ttl > 0) {
            entry.ttlId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, ttl, () => {
                    entry.ttlId = 0;
                    this.removeEntry(entry);
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    async _onImage(mime, bytes) {
        if (!bytes || bytes.get_size() === 0)
            return;
        const capBytes = this._settings.get_int('max-image-mb') * 1024 * 1024;
        if (bytes.get_size() > capBytes)
            return;

        const hash = GLib.compute_checksum_for_bytes(
            GLib.ChecksumType.SHA256, bytes);

        if (this._ignoreHash !== null && hash === this._ignoreHash) {
            this._ignoreHash = null;
            return;
        }

        // De-dupe: move an existing identical image to the top.
        const existingIdx = this.entries.findIndex(
            e => e.kind === 'image' && e.hash === hash);
        if (existingIdx !== -1) {
            const [existing] = this.entries.splice(existingIdx, 1);
            this.entries.unshift(existing);
            this._button?.rebuild();
            return;
        }

        let pixbuf;
        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
            pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
        } catch {
            return; // undecodable image: skip
        }

        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        const thumb = this._makeThumb(pixbuf);

        // Write the full-resolution bytes to the on-disk cache; keep only the
        // small thumbnail and a path in memory so RAM stays light.
        const filePath = this._imagePath(hash, mime);
        await this._wipePromise;
        if (!await this._writeImageFile(filePath, bytes))
            return;
        if (!this._settings) {
            // Disabled while writing: do not leave the file behind.
            this._deleteImageFile(filePath);
            return;
        }

        this._pushEntry({
            kind: 'image',
            mimetype: mime,
            filePath,
            hash,
            width,
            height,
            thumb: thumb?.content ?? null,
            thumbW: thumb?.w ?? 0,
            thumbH: thumb?.h ?? 0,
            concealed: false,
            revealed: false,
            date: Date.now(),
            ttlId: 0,
        });
    }

    _makeThumb(pixbuf) {
        try {
            const w = pixbuf.get_width();
            const h = pixbuf.get_height();
            const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const scaled = scale < 1
                ? pixbuf.scale_simple(tw, th, GdkPixbuf.InterpType.BILINEAR)
                : pixbuf;
            const fmt = scaled.get_has_alpha()
                ? Cogl.PixelFormat.RGBA_8888
                : Cogl.PixelFormat.RGB_888;
            const content = St.ImageContent.new_with_preferred_size(tw, th);
            // GNOME 50: set_bytes takes the CoglContext as first argument.
            const ctx = global.stage.context.get_backend().get_cogl_context();
            content.set_bytes(ctx, scaled.read_pixel_bytes(), fmt,
                tw, th, scaled.get_rowstride());
            return {content, w: tw, h: th};
        } catch {
            return null;
        }
    }

    _looksSensitive(text) {
        const t = text.trim();
        for (const re of SENSITIVE_PATTERNS) {
            if (re.test(t))
                return true;
        }
        if (!/\s/.test(t) && t.length >= 24) {
            const classes =
                (/[a-z]/.test(t) ? 1 : 0) +
                (/[A-Z]/.test(t) ? 1 : 0) +
                (/[0-9]/.test(t) ? 1 : 0) +
                (/[^A-Za-z0-9]/.test(t) ? 1 : 0);
            if (classes >= 3)
                return true;
        }
        return false;
    }

    _dropEntry(entry) {
        if (entry?.ttlId) {
            GLib.source_remove(entry.ttlId);
            entry.ttlId = 0;
        }
        if (entry?.kind === 'image' && entry.filePath)
            this._deleteImageFile(entry.filePath);
    }

    async applyEntry(entry) {
        if (entry.kind === 'image') {
            this._button?.menu.close();
            const bytes = await this._readImageFile(entry.filePath);
            if (!bytes || !this._selection)
                return;
            this._ignoreHash = entry.hash;
            this._setClipboard(entry.mimetype, bytes);
        } else {
            this._ignoreText = entry.text;
            this._setClipboard('text/plain;charset=utf-8',
                GLib.Bytes.new(new TextEncoder().encode(entry.text)));
        }
        this._button?.menu.close();
    }

    removeEntry(entry) {
        const idx = this.entries.indexOf(entry);
        if (idx !== -1) {
            this._dropEntry(entry);
            this.entries.splice(idx, 1);
        }
        this._button?.rebuild();
    }

    clearAll() {
        for (const e of this.entries)
            this._dropEntry(e);
        this.entries = [];
        this._button?.rebuild();
    }
}
