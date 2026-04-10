// frida-ide://snippet
// name: SSL Pinning Bypass (Android)
// description: Bypasses common Android SSL pinning implementations: TrustManagerImpl, OkHttp CertificatePinner, Conscrypt, and HostnameVerifier.
// tags: ssl, network, android

Java.perform(function () {
    send("[*] SSL pinning bypass installed");

    // 1. TrustManagerImpl.verifyChainCleared (Android 7+)
    try {
        var TrustManagerImpl = Java.use("com.android.org.conscrypt.TrustManagerImpl");
        TrustManagerImpl.checkTrustedRecursive.implementation = function () {
            send("[+] TrustManagerImpl.checkTrustedRecursive bypassed");
            return Java.use("java.util.ArrayList").$new();
        };
    } catch (e) {
        send("[-] TrustManagerImpl: " + e);
    }

    // 2. OkHttp 3 CertificatePinner.check
    try {
        var CertificatePinner = Java.use("okhttp3.CertificatePinner");
        CertificatePinner.check.overload("java.lang.String", "java.util.List").implementation = function (host, certs) {
            send("[+] OkHttp CertificatePinner bypassed for " + host);
        };
    } catch (e) {
        send("[-] OkHttp CertificatePinner: " + e);
    }

    // 3. Custom HostnameVerifier
    try {
        var HostnameVerifier = Java.use("javax.net.ssl.HostnameVerifier");
        // Shouldn't be hooked at the interface level — replace below
    } catch (e) {}

    // 4. Default HttpsURLConnection HostnameVerifier
    try {
        var HttpsURLConnection = Java.use("javax.net.ssl.HttpsURLConnection");
        var TrustAllVerifier = Java.registerClass({
            name: "frida.TrustAllVerifier",
            implements: [Java.use("javax.net.ssl.HostnameVerifier")],
            methods: {
                verify: function (hostname, session) { return true; }
            }
        });
        HttpsURLConnection.setDefaultHostnameVerifier(TrustAllVerifier.$new());
        send("[+] Replaced default HostnameVerifier");
    } catch (e) {
        send("[-] Default HostnameVerifier: " + e);
    }

    // 5. SSLContext.init — install all-trusting trust manager
    try {
        var X509TrustManager = Java.use("javax.net.ssl.X509TrustManager");
        var SSLContext = Java.use("javax.net.ssl.SSLContext");
        var TrustManager = Java.registerClass({
            name: "frida.AllTrustingManager",
            implements: [X509TrustManager],
            methods: {
                checkClientTrusted: function (chain, authType) {},
                checkServerTrusted: function (chain, authType) {},
                getAcceptedIssuers: function () { return []; }
            }
        });
        var trustManagers = [TrustManager.$new()];
        var SSLContextInit = SSLContext.init.overload(
            "[Ljavax.net.ssl.KeyManager;",
            "[Ljavax.net.ssl.TrustManager;",
            "java.security.SecureRandom"
        );
        SSLContextInit.implementation = function (km, tm, sr) {
            send("[+] SSLContext.init() — installing all-trusting TrustManager");
            SSLContextInit.call(this, km, trustManagers, sr);
        };
    } catch (e) {
        send("[-] SSLContext: " + e);
    }
});
