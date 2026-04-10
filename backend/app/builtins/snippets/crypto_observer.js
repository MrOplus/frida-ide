// frida-ide://snippet
// name: Crypto Observer
// description: Logs every javax.crypto.Cipher.doFinal call — useful for spotting AES keys, hardcoded IVs, and tracing encryption flow.
// tags: crypto, observability, android

Java.perform(function () {
    send("[*] Crypto observer installed");

    function bytesToHex(b) {
        if (b === null) return null;
        var len = Math.min(b.length, 64);
        var s = "";
        for (var i = 0; i < len; i++) {
            var v = b[i] & 0xff;
            s += (v < 16 ? "0" : "") + v.toString(16);
        }
        if (b.length > len) s += "...(" + b.length + " bytes total)";
        return s;
    }

    var Cipher = Java.use("javax.crypto.Cipher");

    Cipher.init.overload("int", "java.security.Key").implementation = function (mode, key) {
        send({
            kind: "Cipher.init",
            mode: mode,
            algorithm: this.getAlgorithm(),
            keyAlgorithm: key.getAlgorithm(),
        });
        return this.init(mode, key);
    };

    Cipher.init.overload("int", "java.security.Key", "java.security.spec.AlgorithmParameterSpec").implementation = function (mode, key, spec) {
        var ivHex = null;
        try {
            var IvParameterSpec = Java.use("javax.crypto.spec.IvParameterSpec");
            if (Java.cast(spec, IvParameterSpec) !== null) {
                ivHex = bytesToHex(Java.cast(spec, IvParameterSpec).getIV());
            }
        } catch (e) {}
        send({
            kind: "Cipher.init+spec",
            mode: mode,
            algorithm: this.getAlgorithm(),
            keyAlgorithm: key.getAlgorithm(),
            iv: ivHex,
        });
        return this.init(mode, key, spec);
    };

    Cipher.doFinal.overload("[B").implementation = function (input) {
        var output = this.doFinal(input);
        send({
            kind: "Cipher.doFinal",
            algorithm: this.getAlgorithm(),
            inputHex: bytesToHex(input),
            outputHex: bytesToHex(output),
        });
        return output;
    };
});
