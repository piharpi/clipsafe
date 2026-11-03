import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClipSafePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'ClipSafe',
            icon_name: 'edit-paste-symbolic',
        });
        window.add(page);

        // ---------- Security ----------
        const security = new Adw.PreferencesGroup({
            title: 'Security',
            description: 'Memory-only: history is never written to disk and is wiped on logout.',
        });
        page.add(security);

        const skipPm = new Adw.SwitchRow({
            title: 'Honor password-manager hints',
            subtitle: 'Never store entries flagged secret (Bitwarden, KeePassXC, 1Password…)',
        });
        security.add(skipPm);
        settings.bind('skip-password-manager', skipPm, 'active', Gio.SettingsBindFlags.DEFAULT);

        const conceal = new Adw.SwitchRow({
            title: 'Mask sensitive entries',
            subtitle: 'Tokens, JWTs, API keys and private keys are stored masked',
        });
        security.add(conceal);
        settings.bind('conceal-sensitive', conceal, 'active', Gio.SettingsBindFlags.DEFAULT);

        const clearLock = new Adw.SwitchRow({
            title: 'Clear history on screen lock',
            subtitle: 'Wipe everything the moment the session locks',
        });
        security.add(clearLock);
        settings.bind('clear-on-lock', clearLock, 'active', Gio.SettingsBindFlags.DEFAULT);

        const ttl = new Adw.SpinRow({
            title: 'Auto-expire masked entries',
            subtitle: 'Seconds before a masked entry is removed (0 = off)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        security.add(ttl);
        settings.bind('sensitive-ttl', ttl, 'value', Gio.SettingsBindFlags.DEFAULT);

        const idle = new Adw.SpinRow({
            title: 'Wipe history when idle',
            subtitle: 'Minutes of inactivity before clearing everything (0 = off)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1440, step_increment: 1, page_increment: 10}),
        });
        security.add(idle);
        settings.bind('idle-clear-minutes', idle, 'value', Gio.SettingsBindFlags.DEFAULT);

        // ---------- Behavior ----------
        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
        page.add(behavior);

        behavior.add(this._buildShortcutRow(settings, 'toggle-menu'));

        const size = new Adw.SpinRow({
            title: 'History size',
            subtitle: 'Maximum entries kept in memory',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 200, step_increment: 1, page_increment: 10}),
        });
        behavior.add(size);
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);

        const maxLen = new Adw.SpinRow({
            title: 'Max entry length',
            subtitle: 'Skip clipboard content larger than this (characters)',
            adjustment: new Gtk.Adjustment({lower: 256, upper: 1048576, step_increment: 256, page_increment: 4096}),
        });
        behavior.add(maxLen);
        settings.bind('max-entry-length', maxLen, 'value', Gio.SettingsBindFlags.DEFAULT);

        const captureImg = new Adw.SwitchRow({
            title: 'Capture images',
            subtitle: 'Also keep images copied to the clipboard (memory-only)',
        });
        behavior.add(captureImg);
        settings.bind('capture-images', captureImg, 'active', Gio.SettingsBindFlags.DEFAULT);

        const maxImg = new Adw.SpinRow({
            title: 'Max image size',
            subtitle: 'Skip images larger than this (megabytes)',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1, page_increment: 5}),
        });
        behavior.add(maxImg);
        settings.bind('max-image-mb', maxImg, 'value', Gio.SettingsBindFlags.DEFAULT);

        // ---------- Exclusion rules ----------
        page.add(this._buildListGroup(settings, 'exclusion-patterns', {
            title: 'Exclusion patterns (regex)',
            description: 'Clipboard content matching any regex is never stored.',
            placeholder: 'e.g. ^\\d{16}$   or   secret',
        }));

        page.add(this._buildListGroup(settings, 'app-blocklist', {
            title: 'App blocklist (WM_CLASS)',
            description: 'Clipboard copied while one of these apps is focused is never stored.',
            placeholder: 'e.g. bitwarden   or   keepassxc',
        }));
    }

    _buildListGroup(settings, key, {title, description, placeholder}) {
        const group = new Adw.PreferencesGroup({title, description});

        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            has_frame: false,
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add',
        });
        group.set_header_suffix(addBtn);

        const rows = [];
        const render = () => {
            for (const r of rows)
                group.remove(r);
            rows.length = 0;

            const items = settings.get_strv(key);
            if (items.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'None',
                    subtitle: 'Click + to add a rule',
                });
                group.add(empty);
                rows.push(empty);
                return;
            }

            items.forEach((val, idx) => {
                const row = new Adw.EntryRow({
                    title: placeholder,
                    text: val,
                    show_apply_button: true,
                });
                const del = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    has_frame: false,
                    valign: Gtk.Align.CENTER,
                });
                del.connect('clicked', () => {
                    const arr = settings.get_strv(key);
                    arr.splice(idx, 1);
                    settings.set_strv(key, arr);
                    render();
                });
                row.add_suffix(del);
                row.connect('apply', () => {
                    const arr = settings.get_strv(key);
                    arr[idx] = row.get_text();
                    settings.set_strv(key, arr.filter(s => s.length > 0));
                    render();
                });
                group.add(row);
                rows.push(row);
            });
        };

        addBtn.connect('clicked', () => {
            const arr = settings.get_strv(key);
            arr.push('');
            settings.set_strv(key, arr);
            render();
        });

        render();
        return group;
    }

    _buildShortcutRow(settings, key) {
        const row = new Adw.ActionRow({
            title: 'Open clipboard shortcut',
            subtitle: 'Click to set · Backspace clears · Esc cancels',
        });

        const label = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Disabled',
        });
        const refresh = () => {
            const arr = settings.get_strv(key);
            label.set_accelerator(arr.length ? arr[0] : '');
        };

        const btn = new Gtk.Button({child: label, valign: Gtk.Align.CENTER});
        row.add_suffix(btn);
        row.activatable_widget = btn;

        btn.connect('clicked', () => {
            label.set_accelerator('');
            label.set_disabled_text('Press shortcut…');

            const ctl = new Gtk.EventControllerKey();
            btn.add_controller(ctl);
            ctl.connect('key-pressed', (_c, keyval, _keycode, state) => {
                let mask = state & Gtk.accelerator_get_default_mod_mask();
                mask &= ~Gdk.ModifierType.LOCK_MASK;

                if (keyval === Gdk.KEY_Escape && mask === 0) {
                    btn.remove_controller(ctl);
                    label.set_disabled_text('Disabled');
                    refresh();
                    return Gdk.EVENT_STOP;
                }
                if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                    settings.set_strv(key, []);
                    btn.remove_controller(ctl);
                    label.set_disabled_text('Disabled');
                    refresh();
                    return Gdk.EVENT_STOP;
                }
                // Require at least one modifier and a valid accelerator.
                if (mask === 0 || !Gtk.accelerator_valid(keyval, mask))
                    return Gdk.EVENT_STOP;

                const name = Gtk.accelerator_name(keyval, mask);
                settings.set_strv(key, [name]);
                btn.remove_controller(ctl);
                label.set_disabled_text('Disabled');
                refresh();
                return Gdk.EVENT_STOP;
            });
        });

        refresh();
        return row;
    }
}
