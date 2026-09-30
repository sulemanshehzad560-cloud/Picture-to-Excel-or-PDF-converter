package com.sulemanshehzad.omniscan;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new IsolatedWebViewClient(bridge));
    }

    /**
     * Serves the bundled app with cross-origin isolation headers. That enables SharedArrayBuffer,
     * which lets the on-device OCR engine (ONNX Runtime WebAssembly) use several CPU cores.
     * Everything the app loads is local, so the stricter policy blocks nothing.
     */
    static class IsolatedWebViewClient extends BridgeWebViewClient {
        IsolatedWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            WebResourceResponse response = super.shouldInterceptRequest(view, request);
            if (response != null) {
                Map<String, String> headers = response.getResponseHeaders() == null
                    ? new HashMap<>()
                    : new HashMap<>(response.getResponseHeaders());
                headers.put("Cross-Origin-Opener-Policy", "same-origin");
                headers.put("Cross-Origin-Embedder-Policy", "require-corp");
                headers.put("Cross-Origin-Resource-Policy", "same-origin");
                response.setResponseHeaders(headers);
            }
            return response;
        }
    }
}
