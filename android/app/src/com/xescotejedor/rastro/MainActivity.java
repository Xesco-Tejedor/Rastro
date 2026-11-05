package com.xescotejedor.rastro;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.os.Message;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.OutputStream;

/* Rastro para Android: envuelve la app web publicada (online primero).
   - JavaScript y DOM storage activados: la lista de referencias vive en localStorage.
   - Los enlaces externos (tiendas, fichas Archive.org) se abren en el navegador.
   - La exportacion de referencias (.txt/.html) usa blob:; el WebView no la descarga
     solo, asi que se intercepta y se guarda en Descargas con MediaStore (sin permisos
     de almacenamiento en Android 10+). */
public class MainActivity extends Activity {
    private static final String HOME = "https://xesco-tejedor.github.io/Rastro/";
    private static final String HOME_HOST = "xesco-tejedor.github.io";
    private static final int MAX_DOWNLOAD_B64 = 7_000_000; // ~5 MB binario
    private WebView web;

    public static class Downloads {
        private final Activity act;
        private final WebView webView;
        Downloads(Activity a, WebView w) { this.act = a; this.webView = w; }
        @JavascriptInterface
        public void save(String base64, String name) {
            // Solo la propia app web puede guardar: nunca una pagina externa.
            Uri cur = webView.getUrl() != null ? Uri.parse(webView.getUrl()) : null;
            if (cur == null || !HOME_HOST.equals(cur.getHost())) return;
            if (base64 == null || base64.length() > MAX_DOWNLOAD_B64) return;
            // Nombre saneado: sin rutas, extension limitada a las exportaciones de la app.
            String base = name == null ? "" : name.replaceAll("^.*/", "").replaceAll("[^A-Za-z0-9._-]", "_");
            if (base.length() > 64 || !(base.endsWith(".txt") || base.endsWith(".html"))) base = "rastro-export.txt";
            try {
                final String safe = base;
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                v.put(MediaStore.Downloads.MIME_TYPE,
                      safe.endsWith(".html") ? "text/html" : "text/plain");
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = act.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                try (OutputStream os = act.getContentResolver().openOutputStream(uri)) {
                    os.write(data);
                }
                final String done = safe;
                act.runOnUiThread(() -> Toast.makeText(act, "Guardado en Descargas: " + done, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                act.runOnUiThread(() -> Toast.makeText(act, "No se pudo guardar el archivo", Toast.LENGTH_LONG).show());
            }
        }
    }

    private void openExternal(Uri uri) {
        String sch = uri.getScheme();
        if (!"https".equals(sch) && !"http".equals(sch)) return; // nada de intent:/javascript:/file:
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.addJavascriptInterface(new Downloads(this, web), "RastroDl");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOME_HOST.equals(u.getHost())) return false; // navega dentro
                openExternal(u); // tiendas y fichas: navegador del sistema (solo http/https)
                return true;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                // Intercepta a.download con blob: para conservar el nombre de archivo
                view.evaluateJavascript(
                    "(function(){if(window.__rastroDl)return;window.__rastroDl=1;" +
                    "var oc=HTMLAnchorElement.prototype.click;" +
                    "HTMLAnchorElement.prototype.click=function(){" +
                    "if(this.download&&this.href&&this.href.indexOf('blob:')===0){" +
                    "var n=this.download,h=this.href;" +
                    "fetch(h).then(function(r){return r.blob()}).then(function(b){" +
                    "var rd=new FileReader();rd.onload=function(){RastroDl.save(String(rd.result).split(',')[1],n)};" +
                    "rd.readAsDataURL(b)});return;}oc.call(this);};})();", null);
            }
        });

        // window.open (fichas y tiendas): abrir en el navegador externo
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView temp = new WebView(view.getContext());
                temp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        openExternal(req.getUrl());
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(temp);
                resultMsg.sendToTarget();
                return true;
            }
        });

        // Fallback de descarga para URL no-blob
        web.setDownloadListener((url, ua, disp, mime, len) -> openExternal(Uri.parse(url)));

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(HOME);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
