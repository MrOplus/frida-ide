// frida-ide://snippet
// name: SharedPreferences Logger
// description: Logs every read and write to SharedPreferences so you can see what the app stores locally — credentials, tokens, flags, etc.
// tags: storage, observability, android

Java.perform(function () {
    send("[*] SharedPreferences logger installed");

    var SharedPreferencesImpl = Java.use("android.app.SharedPreferencesImpl");

    // Reads
    ["getString", "getInt", "getLong", "getFloat", "getBoolean"].forEach(function (m) {
        try {
            SharedPreferencesImpl[m].implementation = function (key, defValue) {
                var value = this[m](key, defValue);
                send({
                    op: "read",
                    method: m,
                    file: this.getFile().getName(),
                    key: key,
                    value: String(value),
                });
                return value;
            };
        } catch (e) {}
    });

    try {
        SharedPreferencesImpl.getStringSet.implementation = function (key, defValue) {
            var value = this.getStringSet(key, defValue);
            send({
                op: "read",
                method: "getStringSet",
                file: this.getFile().getName(),
                key: key,
                value: value !== null ? value.toString() : "null",
            });
            return value;
        };
    } catch (e) {}

    // Writes — hook the EditorImpl
    var EditorImpl = Java.use("android.app.SharedPreferencesImpl$EditorImpl");
    var writeMethods = {
        putString: "string",
        putInt: "int",
        putLong: "long",
        putFloat: "float",
        putBoolean: "boolean",
    };
    Object.keys(writeMethods).forEach(function (m) {
        try {
            EditorImpl[m].implementation = function (key, value) {
                send({
                    op: "write",
                    method: m,
                    type: writeMethods[m],
                    key: key,
                    value: String(value),
                });
                return this[m](key, value);
            };
        } catch (e) {}
    });

    try {
        EditorImpl.remove.implementation = function (key) {
            send({ op: "remove", key: key });
            return this.remove(key);
        };
    } catch (e) {}

    try {
        EditorImpl.clear.implementation = function () {
            send({ op: "clear" });
            return this.clear();
        };
    } catch (e) {}
});
