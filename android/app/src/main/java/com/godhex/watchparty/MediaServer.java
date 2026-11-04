package com.godhex.watchparty;

import android.net.Uri;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A small video server on the phone itself (127.0.0.1). The room's player loads
 * http://127.0.0.1:<port>/v/<key>?u=<CDN url>, and this fetches the CDN with the headers it
 * insists on. The WebView's video player doesn't reliably go through shouldInterceptRequest,
 * but it always talks to a real HTTP server properly (ranges, seeking).
 * Only CDN hosts the page registered are fetched, and only with the random key, so other apps on
 * the phone can't use it.
 */
final class MediaServer {
    private static final String[] PASS_HEADERS = {
        "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"
    };

    private final ServerSocket socket;
    private final String key;
    private final Map<String, Map<String, String>> hostHeaders = new ConcurrentHashMap<>();   // host -> headers
    private final ExecutorService pool = Executors.newCachedThreadPool();

    MediaServer() throws IOException {
        socket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        StringBuilder k = new StringBuilder();
        for (byte x : b) k.append(String.format("%02x", x));
        key = k.toString();
        Thread t = new Thread(this::acceptLoop, "hx-media");
        t.setDaemon(true);
        t.start();
    }

    /** The local address the player should use for this CDN url. */
    String urlFor(String cdnUrl, Map<String, String> headers) {
        hostHeaders.put(Uri.parse(cdnUrl).getHost(), headers);
        return "http://127.0.0.1:" + socket.getLocalPort() + "/v/" + key + "?u=" + Uri.encode(cdnUrl);
    }

    private void acceptLoop() {
        while (!socket.isClosed()) {
            try {
                final Socket s = socket.accept();
                pool.execute(() -> serve(s));
            } catch (IOException e) {
                // closed
            }
        }
    }

    private void serve(Socket client) {
        HttpURLConnection c = null;
        try (Socket s = client) {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream());
            String[] request = String.valueOf(readLine(in)).split(" ");
            Map<String, String> reqHeaders = new HashMap<>();
            for (String h; (h = readLine(in)) != null && !h.isEmpty(); ) {
                int i = h.indexOf(':');
                if (i > 0) reqHeaders.put(h.substring(0, i).trim().toLowerCase(), h.substring(i + 1).trim());
            }

            String method = request[0];
            Uri local = request.length > 1 ? Uri.parse("http://127.0.0.1" + request[1]) : null;
            String target = local != null ? local.getQueryParameter("u") : null;
            Uri cdn = target != null ? Uri.parse(target) : null;
            Map<String, String> extra = cdn != null ? hostHeaders.get(cdn.getHost()) : null;
            if (!("GET".equals(method) || "HEAD".equals(method)) || extra == null
                    || !("/v/" + key).equals(local.getPath()) || !"https".equals(cdn.getScheme())) {
                write(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                return;
            }

            c = (HttpURLConnection) new URL(target).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("Accept-Encoding", "identity");   // byte ranges must match the file
            if (reqHeaders.containsKey("range")) c.setRequestProperty("Range", reqHeaders.get("range"));
            for (Map.Entry<String, String> h : extra.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());

            int status = c.getResponseCode();
            String reason = c.getResponseMessage();
            StringBuilder head = new StringBuilder("HTTP/1.1 ").append(status).append(' ')
                .append(reason == null || reason.isEmpty() ? "OK" : reason).append("\r\n");
            for (String name : PASS_HEADERS) {
                String v = c.getHeaderField(name);
                if (v != null) head.append(name).append(": ").append(v).append("\r\n");
            }
            head.append("Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n");
            write(out, head.toString());

            if ("GET".equals(method)) {
                InputStream body = status >= 400 ? c.getErrorStream() : c.getInputStream();
                if (body != null) {
                    byte[] buf = new byte[64 * 1024];
                    for (int n; (n = body.read(buf)) != -1; ) out.write(buf, 0, n);
                    body.close();
                }
            }
            out.flush();
        } catch (IOException e) {
            // the player hung up (a seek, a quality change) or the CDN dropped
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void write(OutputStream out, String s) throws IOException {
        out.write(s.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    /** One header line (ASCII, CRLF or LF), or null at the end of the stream. */
    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (int ch; (ch = in.read()) != -1; ) {
            if (ch == '\n') return sb.toString();
            if (ch != '\r') sb.append((char) ch);
            if (sb.length() > 8192) throw new IOException("header too long");
        }
        return sb.length() > 0 ? sb.toString() : null;
    }
}
