import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Asks for an image through the desktop's file chooser portal. Resolves with its path, or null
 * when the user cancels; rejects when the portal fails. `cancellable` drops the request.
 */
export function chooseImage(title, cancellable) {
    const bus = Gio.DBus.session;
    const token = `measure_things_${GLib.random_int()}`;
    const sender = bus.get_unique_name().slice(1).replace(/\./g, '_');
    const handle = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
    return new Promise((resolve, reject) => {
        let subscription = 0;
        let cancelId = 0;
        const finish = (settle, value) => {
            if (!subscription)
                return;
            bus.signal_unsubscribe(subscription);
            subscription = 0;
            if (cancelId)
                cancellable.disconnect(cancelId);
            settle(value);
        };
        // Subscribed before the call, so a quick response is never missed.
        subscription = bus.signal_subscribe('org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request', 'Response', handle, null, Gio.DBusSignalFlags.NONE,
            (_bus, _sender, _path, _interface, _signal, parameters) => {
                const [response, results] = parameters.deepUnpack();
                const uri = response === 0 ? results.uris?.deepUnpack()[0] : null;
                finish(resolve, uri ? Gio.File.new_for_uri(uri).get_path() : null);
            });
        if (cancellable)
            cancelId = cancellable.connect(() => finish(resolve, null));
        const options = {
            handle_token: new GLib.Variant('s', token),
            modal: new GLib.Variant('b', true),
            filters: new GLib.Variant('a(sa(us))', [['Images', [[1, 'image/*']]]]),
        };
        bus.call('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.FileChooser', 'OpenFile',
            new GLib.Variant('(ssa{sv})', ['', title, options]), null, Gio.DBusCallFlags.NONE, -1,
            null, (_bus, result) => {
                try {
                    bus.call_finish(result);
                } catch (error) {
                    finish(reject, error);
                }
            });
    });
}
