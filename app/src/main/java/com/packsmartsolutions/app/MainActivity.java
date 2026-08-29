package com.packsmartsolutions.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String STORE_URL = "https://packsmartsolutions.com";
    private static final int MAX_EBAY_PHOTOS = 24;
    private static final int MAX_MAIN_FRAME_RETRIES = 2;
    private WebView webView;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileChooserCallback;
    private int mainFrameRetryCount = 0;
    private static final int FILE_CHOOSER_REQUEST = 1901;

    private static final String INSTAGRAM = "https://www.instagram.com/packsmartsolutions/";
    private static final String TIKTOK = "https://www.tiktok.com/@packsmartsolutions";
    private static final String FACEBOOK = "https://www.facebook.com/share/1KYm69ht9X/";
    private static final String LINKEDIN = "https://www.linkedin.com/company/packsmart-solutions-ltd/";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " PacksmartSolutionsAndroid/2.1.2");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        Uri uri = request.getUrl();
                        if (!handleNavigation(uri)) webView.loadUrl(uri.toString());
                        v.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = filePathCallback;
                try {
                    Intent pickerIntent = fileChooserParams.createIntent();
                    pickerIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(pickerIntent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileChooserCallback = null;
                    Toast.makeText(MainActivity.this, "No file picker available", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (isPacksmartUrl(url)) {
                    mainFrameRetryCount = 0;
                    injectAppSafeArea(view);
                    injectPacksmartSocialFooter(view);
                    injectMultiImageUpload(view);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;

                String failedUrl = request.getUrl() == null ? "" : request.getUrl().toString();

                // A WebView can report harmless/cancelled main-frame errors during
                // redirects. Never replace a checkout or third-party page with our
                // offline screen just because one of those redirects was cancelled.
                if (!isPacksmartUrl(failedUrl)) return;

                if (!hasInternetNetwork()) {
                    showConnectionPage(view);
                    return;
                }

                int code = error.getErrorCode();
                if (isRetryableNetworkError(code) && mainFrameRetryCount < MAX_MAIN_FRAME_RETRIES) {
                    mainFrameRetryCount++;
                    long delayMs = 700L * mainFrameRetryCount;
                    view.postDelayed(() -> {
                        if (webView == null) return;
                        if (hasInternetNetwork()) {
                            webView.loadUrl(failedUrl);
                        } else {
                            showConnectionPage(webView);
                        }
                    }, delayMs);
                    return;
                }

                // For generic ERR_FAILED / cancelled redirects we leave the current
                // page alone instead of falsely telling the customer they are offline.
                if (isRetryableNetworkError(code)) {
                    showConnectionPage(view);
                }
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> openExternal(Uri.parse(url)));

        if (savedInstanceState == null) {
            Uri incoming = getIntent() != null ? getIntent().getData() : null;
            if (incoming != null && isPacksmartUrl(incoming.toString())) webView.loadUrl(incoming.toString());
            else webView.loadUrl(STORE_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private boolean hasInternetNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network network = cm.getActiveNetwork();
            if (network == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception ignored) {
            // If Android cannot tell us, avoid a false "offline" result.
            return true;
        }
    }

    private boolean isRetryableNetworkError(int code) {
        return code == WebViewClient.ERROR_HOST_LOOKUP
                || code == WebViewClient.ERROR_CONNECT
                || code == WebViewClient.ERROR_TIMEOUT
                || code == WebViewClient.ERROR_IO;
    }

    private void showConnectionPage(WebView view) {
        if (view == null) return;
        view.loadUrl("file:///android_asset/offline.html");
    }

    private boolean handleNavigation(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();

        if (scheme.equals("mailto") || scheme.equals("tel") || scheme.equals("sms") || scheme.equals("geo")) {
            openExternal(uri);
            return true;
        }

        if (!scheme.equals("http") && !scheme.equals("https")) {
            openExternal(uri);
            return true;
        }

        if (isSocialHost(host)) {
            openExternal(uri);
            return true;
        }

        return false;
    }

    private boolean isPacksmartUrl(String url) {
        try {
            String host = Uri.parse(url).getHost();
            if (host == null) return false;
            host = host.toLowerCase();
            return host.equals("packsmartsolutions.com") || host.equals("www.packsmartsolutions.com");
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isSocialHost(String host) {
        return host.contains("instagram.com") || host.contains("tiktok.com") || host.contains("facebook.com") || host.contains("linkedin.com");
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Toast.makeText(this, "Unable to open link", Toast.LENGTH_SHORT).show();
        }
    }

    private void injectAppSafeArea(WebView view) {
        String js = "(function(){" +
                "if(window.__packsmartSafeAreaInstalled){if(window.__packsmartApplySafeArea)window.__packsmartApplySafeArea();return;}" +
                "window.__packsmartSafeAreaInstalled=true;" +
                "window.__packsmartApplySafeArea=function(){" +
                "var nodes=document.querySelectorAll('body *');" +
                "for(var i=0;i<nodes.length;i++){" +
                "var el=nodes[i];var t=(el.innerText||el.textContent||'').trim().toLowerCase();" +
                "if(t==='ask packsmart'||(t.indexOf('ask packsmart')>-1&&t.length<80)){" +
                "var target=el;" +
                "for(var j=0;j<6&&target&&target!==document.body;j++,target=target.parentElement){" +
                "var cs=window.getComputedStyle(target);" +
                "if(cs.position==='fixed'){" +
                "target.style.setProperty('bottom','56px','important');" +
                "target.style.setProperty('z-index','2147483000','important');" +
                "break;" +
                "}" +
                "}" +
                "}" +
                "}" +
                "};" +
                "window.__packsmartApplySafeArea();" +
                "var mo=new MutationObserver(function(){" +
                "clearTimeout(window.__packsmartSafeTimer);" +
                "window.__packsmartSafeTimer=setTimeout(window.__packsmartApplySafeArea,100);" +
                "});" +
                "mo.observe(document.documentElement,{childList:true,subtree:true});" +
                "})();";
        view.evaluateJavascript(js, null);
    }

    private void injectPacksmartSocialFooter(WebView view) {
        String js = "(function(){" +
                "if(document.getElementById('packsmart-app-socials'))return;" +
                "var a=[].slice.call(document.querySelectorAll('a[href]'));" +
                "var has=function(x){return a.some(function(n){return (n.href||'').toLowerCase().indexOf(x)>-1;});};" +
                "if(has('instagram.com')&&has('tiktok.com')&&has('facebook.com')&&has('linkedin.com'))return;" +
                "var s=document.createElement('section');s.id='packsmart-app-socials';" +
                "s.innerHTML='" +
                "<div style=\"max-width:1200px;margin:0 auto;padding:28px 20px 34px;text-align:center\">" +
                "<div style=\"font-size:12px;letter-spacing:2px;font-weight:800;color:#D4AF37;margin-bottom:8px\">FOLLOW PACKSMART</div>" +
                "<div style=\"font-size:24px;font-weight:800;color:#fff;margin-bottom:18px\">Stay connected</div>" +
                "<div style=\"display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;max-width:520px;margin:0 auto\">" +
                "<a href=\"" + INSTAGRAM + "\" style=\"padding:13px 10px;border:1px solid #5b461d;border-radius:12px;color:#fff;text-decoration:none;background:#0d0e0f;font-weight:700\">Instagram</a>" +
                "<a href=\"" + TIKTOK + "\" style=\"padding:13px 10px;border:1px solid #5b461d;border-radius:12px;color:#fff;text-decoration:none;background:#0d0e0f;font-weight:700\">TikTok</a>" +
                "<a href=\"" + FACEBOOK + "\" style=\"padding:13px 10px;border:1px solid #5b461d;border-radius:12px;color:#fff;text-decoration:none;background:#0d0e0f;font-weight:700\">Facebook</a>" +
                "<a href=\"" + LINKEDIN + "\" style=\"padding:13px 10px;border:1px solid #5b461d;border-radius:12px;color:#fff;text-decoration:none;background:#0d0e0f;font-weight:700\">LinkedIn</a>" +
                "</div></div>';" +
                "s.style.background='#080808';s.style.borderTop='1px solid #3b2f19';" +
                "document.body.appendChild(s);" +
                "})();";
        view.evaluateJavascript(js, null);
    }

    private void injectMultiImageUpload(WebView view) {
        String js = "(function(){" +
                "function enable(){" +
                "var inputs=document.querySelectorAll('input[type=file]');" +
                "for(var i=0;i<inputs.length;i++){" +
                "var el=inputs[i];" +
                "var accept=(el.getAttribute('accept')||'').toLowerCase();" +
                "var context=((el.parentElement&&el.parentElement.innerText)||'').toLowerCase();" +
                "if(accept.indexOf('image')>-1||context.indexOf('ebay')>-1||context.indexOf('photo')>-1||context.indexOf('image')>-1){" +
                "el.setAttribute('multiple','multiple');" +
                "if(!accept)el.setAttribute('accept','image/*');" +
                "}" +
                "}" +
                "}" +
                "enable();" +
                "if(window.__packsmartMultiUploadObserver)return;" +
                "window.__packsmartMultiUploadObserver=new MutationObserver(function(){enable();});" +
                "window.__packsmartMultiUploadObserver.observe(document.documentElement,{childList:true,subtree:true});" +
                "})();";
        view.evaluateJavascript(js, null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri incoming = intent != null ? intent.getData() : null;
        if (incoming != null && isPacksmartUrl(incoming.toString()) && webView != null) {
            webView.loadUrl(incoming.toString());
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileChooserCallback != null) {
            Uri[] results = collectSelectedUris(resultCode, data);
            fileChooserCallback.onReceiveValue(results);
            fileChooserCallback = null;
        }
    }

    private Uri[] collectSelectedUris(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) return null;

        List<Uri> selected = new ArrayList<>();
        ClipData clipData = data.getClipData();

        if (clipData != null) {
            int count = Math.min(clipData.getItemCount(), MAX_EBAY_PHOTOS);
            for (int i = 0; i < count; i++) {
                Uri uri = clipData.getItemAt(i).getUri();
                if (uri != null) selected.add(uri);
            }
            if (clipData.getItemCount() > MAX_EBAY_PHOTOS) {
                Toast.makeText(this, "eBay allows up to 24 photos. First 24 selected.", Toast.LENGTH_LONG).show();
            }
        } else if (data.getData() != null) {
            selected.add(data.getData());
        }

        return selected.isEmpty() ? null : selected.toArray(new Uri[0]);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }
}
