// frida-ide://snippet
// name: Method Tracer (parameterized)
// description: Trace every call into a single Java class. Logs method name, arg types, and return value. Set CLASS_NAME below to the fully-qualified class you want to trace.
// tags: tracing, observability, android
// param: CLASS_NAME / Fully-qualified class name (e.g. com.example.app.LoginManager) / required

Java.perform(function () {
    var TARGET = "{{CLASS_NAME}}";
    send("[*] Tracing all methods on " + TARGET);

    try {
        var Klass = Java.use(TARGET);
        var methods = Klass.class.getDeclaredMethods();
        send("[*] Found " + methods.length + " declared methods");

        for (var i = 0; i < methods.length; i++) {
            var method = methods[i];
            var name = method.getName();
            try {
                var overloads = Klass[name].overloads;
                overloads.forEach(function (overload) {
                    overload.implementation = function () {
                        var argTypes = overload.argumentTypes.map(function (t) { return t.className; });
                        send({
                            kind: "call",
                            method: TARGET + "." + name,
                            args: Array.from(arguments).map(function (a) {
                                try { return String(a); } catch (e) { return "<unprintable>"; }
                            }),
                            argTypes: argTypes,
                        });
                        var result = overload.apply(this, arguments);
                        send({
                            kind: "return",
                            method: TARGET + "." + name,
                            value: result === undefined ? "void" : String(result),
                        });
                        return result;
                    };
                });
            } catch (e) {
                send("[-] Failed to hook " + name + ": " + e);
            }
        }
    } catch (e) {
        send("[-] Class not found: " + TARGET + " — " + e);
    }
});
