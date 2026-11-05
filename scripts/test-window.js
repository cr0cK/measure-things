#!/usr/bin/env -S gjs -m
// A plain GTK 4 window for the headless tests: a flat background with colored blocks at known CSS
// positions, and no visible title bar, so CSS (0, 0) is the frame's top-left corner.
// Usage: test-window.js TITLE WIDTHxHEIGHT BACKGROUND [X,Y,WIDTH,HEIGHT,COLOR ...]
// With TEST_WINDOW_MENU=X,Y it also opens a native popup menu there, once the window shows.
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {programArgs} from 'system';

const [title, size, background, ...blocks] = programArgs;
const [width, height] = size.split('x').map(Number);
const app = new Gtk.Application({application_id: null, flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    const rules = [
        `.test-background { background: ${background}; }`,
        'window .titlebar { min-height: 0; padding: 0; margin: 0; border: none; box-shadow: none; }',
    ];
    const fixed = new Gtk.Fixed({css_classes: ['test-background']});
    blocks.forEach((block, i) => {
        const [x, y, blockWidth, blockHeight, color] = block.split(',');
        rules.push(`.test-block-${i} { background: ${color}; }`);
        fixed.put(new Gtk.Box({
            css_classes: [`test-block-${i}`],
            width_request: Number(blockWidth),
            height_request: Number(blockHeight),
        }), Number(x), Number(y));
    });
    const css = new Gtk.CssProvider();
    css.load_from_string(rules.join('\n'));
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
        Gtk.STYLE_PROVIDER_PRIORITY_USER);
    const window = new Gtk.ApplicationWindow({
        application: app,
        title,
        default_width: width,
        default_height: height,
    });
    window.set_titlebar(new Gtk.Box());
    window.set_child(fixed);
    window.present();

    const menuAt = GLib.getenv('TEST_WINDOW_MENU');
    if (menuAt) {
        const [x, y] = menuAt.split(',').map(Number);
        const menu = new Gio.Menu();
        menu.append('First entry', null);
        menu.append('Second entry', null);
        const button = new Gtk.MenuButton({popover: Gtk.PopoverMenu.new_from_model(menu), label: 'Menu'});
        fixed.put(button, x, y);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            button.popup();
            return GLib.SOURCE_REMOVE;
        });
    }
});
app.run([]);
