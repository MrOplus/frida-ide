// frida-ide://snippet
// name: Root Detection Bypass (Android)
// description: Defeats common root checks — RootBeer, file existence checks for su/Magisk, and `which su` execution.
// tags: root, anti-tamper, android

Java.perform(function () {
    send("[*] Root detection bypass installed");

    // ---------- File-based checks ----------
    var rootIndicators = [
        "/system/app/Superuser.apk",
        "/sbin/su", "/system/bin/su", "/system/xbin/su", "/data/local/xbin/su",
        "/data/local/bin/su", "/system/sd/xbin/su", "/system/bin/failsafe/su",
        "/data/local/su", "/su/bin/su",
        "/system/etc/init.d/99SuperSUDaemon",
        "/system/xbin/daemonsu", "/system/xbin/busybox",
        "/system/etc/.has_su_daemon", "/system/etc/.installed_su_daemon",
        "/dev/com.koushikdutta.superuser.daemon/",
        "/system/app/Kinguser.apk",
        "/data/adb/magisk", "/sbin/.magisk"
    ];

    try {
        var File = Java.use("java.io.File");
        File.exists.implementation = function () {
            var path = this.getAbsolutePath();
            for (var i = 0; i < rootIndicators.length; i++) {
                if (path.indexOf(rootIndicators[i]) !== -1) {
                    send("[+] File.exists hidden: " + path);
                    return false;
                }
            }
            return this.exists();
        };
    } catch (e) { send("[-] File hook: " + e); }

    // ---------- Runtime.exec("which su") / "su" ----------
    try {
        var Runtime = Java.use("java.lang.Runtime");
        Runtime.exec.overload("java.lang.String").implementation = function (cmd) {
            if (cmd.indexOf("su") !== -1 || cmd.indexOf("which") !== -1) {
                send("[+] Runtime.exec blocked: " + cmd);
                return this.exec("echo");
            }
            return this.exec(cmd);
        };
        Runtime.exec.overload("[Ljava.lang.String;").implementation = function (cmds) {
            for (var i = 0; i < cmds.length; i++) {
                if (cmds[i].indexOf("su") !== -1) {
                    send("[+] Runtime.exec[] blocked: " + cmds.join(" "));
                    return this.exec(["echo"]);
                }
            }
            return this.exec(cmds);
        };
    } catch (e) { send("[-] Runtime hook: " + e); }

    // ---------- RootBeer ----------
    var rootBeerMethods = [
        "isRooted", "isRootedWithoutBusyBoxCheck",
        "detectRootManagementApps", "detectPotentiallyDangerousApps",
        "detectTestKeys", "checkForBusyBoxBinary", "checkForSuBinary",
        "checkSuExists", "checkForRWPaths", "checkForDangerousProps",
        "checkForRootNative", "detectRootCloakingApps"
    ];
    try {
        var RootBeer = Java.use("com.scottyab.rootbeer.RootBeer");
        rootBeerMethods.forEach(function (m) {
            try {
                RootBeer[m].implementation = function () {
                    send("[+] RootBeer." + m + " -> false");
                    return false;
                };
            } catch (e) {}
        });
    } catch (e) {
        send("[-] RootBeer not present in this app");
    }
});
