import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

/**
 * Shows the named cursor, such as 'CROSSHAIR' or 'NW_RESIZE', over `actor`. GNOME 50 sets
 * cursors per actor with Clutter.CursorType; GNOME 49 sets one for the whole display with
 * Meta.Cursor, which GNOME 50 removed. Both enums use the same names.
 */
export function setCursor(actor, name) {
    if (actor.set_cursor_type)
        actor.set_cursor_type(Clutter.CursorType[name]);
    else
        global.display.set_cursor(Meta.Cursor[name]);
}
