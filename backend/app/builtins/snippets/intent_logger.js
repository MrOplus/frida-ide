// frida-ide://snippet
// name: Intent Logger
// description: Logs every Activity.startActivity / startService / sendBroadcast call so you can see how the app dispatches between components.
// tags: intent, ipc, android, observability

Java.perform(function () {
    send("[*] Intent logger installed");

    function dumpIntent(intent) {
        if (intent === null) return "<null>";
        var out = {
            action: intent.getAction() ? intent.getAction().toString() : null,
            data: intent.getDataString() ? intent.getDataString().toString() : null,
        };
        var comp = intent.getComponent();
        if (comp !== null) {
            out.component = comp.getPackageName() + "/" + comp.getClassName();
        }
        var extras = intent.getExtras();
        if (extras !== null) {
            try { out.extras = extras.toString(); } catch (e) { out.extras = "<unprintable>"; }
        }
        return out;
    }

    var Activity = Java.use("android.app.Activity");
    Activity.startActivity.overload("android.content.Intent").implementation = function (intent) {
        send({ kind: "startActivity", from: this.getClass().getName(), intent: dumpIntent(intent) });
        return this.startActivity(intent);
    };
    Activity.startActivityForResult.overload("android.content.Intent", "int").implementation = function (intent, rc) {
        send({ kind: "startActivityForResult", from: this.getClass().getName(), requestCode: rc, intent: dumpIntent(intent) });
        return this.startActivityForResult(intent, rc);
    };

    var ContextImpl = Java.use("android.app.ContextImpl");
    try {
        ContextImpl.startService.implementation = function (intent) {
            send({ kind: "startService", intent: dumpIntent(intent) });
            return this.startService(intent);
        };
    } catch (e) {}

    try {
        ContextImpl.sendBroadcast.overload("android.content.Intent").implementation = function (intent) {
            send({ kind: "sendBroadcast", intent: dumpIntent(intent) });
            return this.sendBroadcast(intent);
        };
    } catch (e) {}
});
