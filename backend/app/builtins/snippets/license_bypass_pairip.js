// frida-ide://snippet
// name: License Bypass (pairip / Play Integrity)
// description: Defeats Google Play's pairip license check that crashes the app on emulators or sideloaded installs. Same technique used to unlock the Teleporti VPN sample.
// tags: license, drm, anti-tamper, android

Java.perform(function () {
    send("[*] pairip license bypass installed");

    // 1. Block any startActivity targeting com.pairip.licensecheck.LicenseActivity
    try {
        var Activity = Java.use("android.app.Activity");
        Activity.startActivity.overload("android.content.Intent").implementation = function (intent) {
            var comp = intent.getComponent();
            if (comp !== null && comp.getClassName().indexOf("pairip") !== -1) {
                send("[+] BLOCKED startActivity -> " + comp.getClassName());
                return;
            }
            this.startActivity(intent);
        };
        Activity.startActivityForResult.overload("android.content.Intent", "int").implementation = function (intent, rc) {
            var comp = intent.getComponent();
            if (comp !== null && comp.getClassName().indexOf("pairip") !== -1) {
                send("[+] BLOCKED startActivityForResult -> " + comp.getClassName());
                return;
            }
            this.startActivityForResult(intent, rc);
        };
        send("[+] Activity.startActivity hooks installed");
    } catch (e) { send("[-] Activity hook: " + e); }

    // 2. Block self-kill paths the license check uses on failure
    try {
        var System = Java.use("java.lang.System");
        System.exit.implementation = function (code) { send("[+] BLOCKED System.exit(" + code + ")"); };
        var Process = Java.use("android.os.Process");
        Process.killProcess.implementation = function (pid) { send("[+] BLOCKED killProcess(" + pid + ")"); };
        var Activity2 = Java.use("android.app.Activity");
        Activity2.finishAndRemoveTask.implementation = function () { send("[+] BLOCKED finishAndRemoveTask"); };
        Activity2.finishAffinity.implementation = function () { send("[+] BLOCKED finishAffinity"); };
        send("[+] Self-kill hooks installed");
    } catch (e) { send("[-] Self-kill hooks: " + e); }

    // 3. If LicenseActivity is already on screen, dismiss it and re-launch the main activity
    Java.choose("com.pairip.licensecheck.LicenseActivity", {
        onMatch: function (instance) {
            send("[+] Found LicenseActivity instance — dismissing");
            var Intent = Java.use("android.content.Intent");
            var ComponentName = Java.use("android.content.ComponentName");
            var ctx = instance.getApplicationContext();
            var pkg = ctx.getPackageName();
            // Best-effort: relaunch the package's main activity via PackageManager
            var pm = ctx.getPackageManager();
            var launchIntent = pm.getLaunchIntentForPackage(pkg);
            if (launchIntent !== null) {
                launchIntent.addFlags(0x10000000 | 0x04000000); // NEW_TASK | CLEAR_TOP
                ctx.startActivity(launchIntent);
            }
            instance.finish();
        },
        onComplete: function () { send("[*] LicenseActivity scan done"); }
    });
});
