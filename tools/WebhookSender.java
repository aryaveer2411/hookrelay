import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A tiny standalone webhook sender that runs on its own port, separate from the app.
 *
 * It plays the part of the outside world: you hand it an endpoint id and that endpoint's
 * inbound secret, it builds the event body, signs it the way HookRelay expects, and posts
 * it to POST /api/event for you.
 *
 * Nothing is read from the environment and no secret is stored — whatever you pass in on
 * the request is used for that one call and then forgotten.
 *
 * Run it (no build step, no Maven — Java runs the source file directly):
 *   java tools/WebhookSender.java [port] [hookrelayBaseUrl]
 *   java tools/WebhookSender.java 9090 http://localhost:3001
 *
 * Routes (all POST):
 *
 *   /create   creates an endpoint and hands back its id and secrets, plus a ready-to-paste
 *             send command so you never copy values by hand. Add send=true to also fire a
 *             first event at it immediately.
 *               curl -X POST "http://localhost:9090/create?name=test&send=true"
 *
 *   /send     signs and delivers an event. The request body IS the payload.
 *               curl -X POST "http://localhost:9090/send?endpointId=<id>&secret=<secret>" \
 *                    -H 'Content-Type: application/json' -d '{"type":"order.paid"}'
 *
 *   /sign     same inputs as /send, but returns the headers instead of sending — paste
 *             them into Postman.
 *
 *   /health   liveness check.
 *
 * Query params for /send and /sign:
 *   endpointId=<uuid>    required
 *   secret=<string>      required, or send it as the X-Inbound-Secret header to keep it
 *                        out of shell history and server logs
 *   externalId=<string>  reuse one to exercise the dedup path (default: random)
 *   skew=<seconds>       shift the timestamp, e.g. skew=-600 to test replay rejection
 *   badSig=true          send a deliberately wrong signature (expect 401)
 *   baseUrl=<url>        override the HookRelay base url for this one call
 *
 * Query params for /create:
 *   name, targetUrl, ratePerSec, ordered, baseUrl, send
 */
public class WebhookSender {

    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private static final String TIMESTAMP_HEADER = "X-Hookrelay-Timestamp";
    private static final String SIGNATURE_HEADER = "X-Hookrelay-Signature";
    private static final String SECRET_HEADER = "X-Inbound-Secret";

    private static final String DEMO_PAYLOAD = "{\"type\":\"demo.ping\",\"data\":{\"hello\":\"world\"}}";

    /** Pulled out with a regex so this file stays dependency-free — no Jackson, no build step. */
    private static final Pattern ID = Pattern.compile("\"id\"\\s*:\\s*\"([0-9a-fA-F-]{36})\"");
    private static final Pattern INBOUND_SECRET = Pattern.compile("\"inboundSecret\"\\s*:\\s*\"([^\"]+)\"");

    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private static String defaultBaseUrl = "http://localhost:8080";
    private static int listenPort = 9090;

    /** Everything needed to send one signed event, built once so the bytes never change. */
    private record Prepared(String body, long timestamp, String signature) {
    }

    public static void main(String[] args) throws IOException {
        if (args.length > 0) {
            listenPort = Integer.parseInt(args[0]);
        }
        if (args.length > 1) {
            defaultBaseUrl = stripTrailingSlash(args[1]);
        }

        HttpServer server = HttpServer.create(new InetSocketAddress(listenPort), 0);
        server.createContext("/create", WebhookSender::handleCreate);
        server.createContext("/send", exchange -> handleEvent(exchange, true));
        server.createContext("/sign", exchange -> handleEvent(exchange, false));
        server.createContext("/health", exchange -> respond(exchange, 200, "{\"status\":\"up\"}"));
        server.setExecutor(null);
        server.start();

        System.out.println("webhook sender listening on http://localhost:" + listenPort);
        System.out.println("  forwarding to " + defaultBaseUrl);
        System.out.println();
        printRoutes();
    }

    /**
     * Prints what each route does and the status it should come back with, so the expected
     * behaviour is in front of you instead of in a README you have to go find.
     */
    private static void printRoutes() {
        printTable(
                new String[]{"case", "result"},
                new String[][]{
                        {"POST /create", "201, endpoint created, returns id + secret + ready curl"},
                        {"POST /create?send=true", "201, also fires one demo event at it"},
                        {"POST /send  (body = payload)", "201, event signed, delivered and stored"},
                        {"  &externalId=<reused>", "201, same stored row returned (dedup works)"},
                        {"  &badSig=true", "401, deliberately wrong signature"},
                        {"  &skew=-600", "401, timestamp outside the replay window"},
                        {"  wrong secret", "401"},
                        {"  X-Inbound-Secret header", "201, secret sent as a header instead"},
                        {"POST /sign", "returns headers + exact body, sends nothing"},
                        {"GET  /health", "200"},
                        {"app unreachable", "502"},
                });
    }

    private static void printTable(String[] headers, String[][] rows) {
        int columns = headers.length;
        int[] widths = new int[columns];

        for (int c = 0; c < columns; c++) {
            widths[c] = headers[c].length();
            for (String[] row : rows) {
                widths[c] = Math.max(widths[c], row[c].length());
            }
        }

        System.out.println(rule(widths, '\u250c', '\u252c', '\u2510'));
        System.out.println(row(headers, widths));

        for (String[] cells : rows) {
            System.out.println(rule(widths, '\u251c', '\u253c', '\u2524'));
            System.out.println(row(cells, widths));
        }

        System.out.println(rule(widths, '\u2514', '\u2534', '\u2518'));
    }

    private static String rule(int[] widths, char left, char middle, char right) {
        StringBuilder line = new StringBuilder().append(left);

        for (int c = 0; c < widths.length; c++) {
            line.append(String.valueOf('\u2500').repeat(widths[c] + 2));
            line.append(c == widths.length - 1 ? right : middle);
        }

        return line.toString();
    }

    private static String row(String[] cells, int[] widths) {
        StringBuilder line = new StringBuilder().append('\u2502');

        for (int c = 0; c < widths.length; c++) {
            line.append(' ').append(pad(cells[c], widths[c])).append(" \u2502");
        }

        return line.toString();
    }

    private static String pad(String value, int width) {
        return value + " ".repeat(width - value.length());
    }

    /**
     * Creates an endpoint through the normal public API and reports back everything you need
     * to send to it — so the id and secret are never copied by hand.
     */
    private static void handleCreate(HttpExchange exchange) throws IOException {
        try {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 405, error("use POST"));
                return;
            }

            Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());
            String baseUrl = baseUrl(query);

            String endpointBody = "{"
                    + "\"name\":" + quote(query.getOrDefault("name", "local-test")) + ","
                    + "\"target_url\":" + quote(query.getOrDefault("targetUrl", "https://example.com/hook")) + ","
                    + "\"ratePerSec\":" + Integer.parseInt(query.getOrDefault("ratePerSec", "50")) + ","
                    + "\"ordered\":" + Boolean.parseBoolean(query.getOrDefault("ordered", "false"))
                    + "}";

            HttpResponse<String> created = post(baseUrl + "/api/endpoint", endpointBody, Map.of());

            if (created.statusCode() >= 300) {
                // Mirror the failure as-is rather than dressing it up as our own error.
                respond(exchange, created.statusCode(), created.body());
                return;
            }

            String endpointId = firstMatch(ID, created.body());
            String secret = firstMatch(INBOUND_SECRET, created.body());

            if (endpointId == null || secret == null) {
                respond(exchange, 502, error("endpoint was created but the id or inbound secret "
                        + "could not be read from the response: " + created.body()));
                return;
            }

            String sendUrl = "http://localhost:" + listenPort + "/send"
                    + "?endpointId=" + endpointId
                    + "&secret=" + URLEncoder.encode(secret, StandardCharsets.UTF_8);

            StringBuilder out = new StringBuilder("{"
                    + "\"endpoint\":" + created.body() + ","
                    + "\"endpointId\":" + quote(endpointId) + ","
                    + "\"inboundSecret\":" + quote(secret) + ","
                    + "\"sendUrl\":" + quote(sendUrl) + ","
                    + "\"curl\":" + quote("curl -X POST \"" + sendUrl + "\" -H 'Content-Type: application/json' -d '"
                    + DEMO_PAYLOAD + "'"));

            if (Boolean.parseBoolean(query.getOrDefault("send", "false"))) {
                Prepared prepared = prepare(endpointId, secret, randomExternalId(), DEMO_PAYLOAD, 0L, false);
                HttpResponse<String> sent = send(baseUrl, prepared);

                System.out.println("created " + endpointId + " -> first event " + sent.statusCode());

                out.append(",\"firstEvent\":{")
                        .append("\"status\":").append(sent.statusCode()).append(",")
                        .append("\"response\":").append(quote(sent.body()))
                        .append("}");
            } else {
                System.out.println("created " + endpointId);
            }

            respond(exchange, created.statusCode(), out.append("}").toString());

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respond(exchange, 502, error("interrupted while calling HookRelay"));
        } catch (IOException e) {
            respond(exchange, 502, error("could not reach HookRelay: " + e));
        } catch (RuntimeException e) {
            respond(exchange, 400, error(String.valueOf(e.getMessage())));
        }
    }

    private static void handleEvent(HttpExchange exchange, boolean forward) throws IOException {
        try {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 405, error("use POST"));
                return;
            }

            Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());

            String endpointId = query.get("endpointId");
            String secret = exchange.getRequestHeaders().getFirst(SECRET_HEADER);
            if (secret == null) {
                secret = query.get("secret");
            }

            if (isBlank(endpointId) || isBlank(secret)) {
                respond(exchange, 400, error("endpointId and secret are required "
                        + "(secret may be sent as the " + SECRET_HEADER + " header)"));
                return;
            }

            // The payload is taken verbatim from the request body, so whatever JSON you send
            // is exactly what lands in the event — no re-formatting, no key reordering.
            String payload = readBody(exchange);
            if (isBlank(payload)) {
                payload = DEMO_PAYLOAD;
            }

            String baseUrl = baseUrl(query);
            Prepared prepared = prepare(
                    endpointId,
                    secret,
                    query.getOrDefault("externalId", randomExternalId()),
                    payload,
                    query.containsKey("skew") ? Long.parseLong(query.get("skew")) : 0L,
                    Boolean.parseBoolean(query.getOrDefault("badSig", "false")));

            if (!forward) {
                respond(exchange, 200, "{"
                        + "\"url\":" + quote(baseUrl + "/api/event") + ","
                        + "\"" + TIMESTAMP_HEADER + "\":" + quote(String.valueOf(prepared.timestamp())) + ","
                        + "\"" + SIGNATURE_HEADER + "\":" + quote(prepared.signature()) + ","
                        + "\"body\":" + quote(prepared.body())
                        + "}");
                return;
            }

            HttpResponse<String> response = send(baseUrl, prepared);

            System.out.println(response.statusCode() + " <- " + prepared.body());

            // The upstream status is mirrored back so a 401 or 409 stays visible to the caller
            // instead of being flattened into a 200 from this sender.
            respond(exchange, response.statusCode(), response.body());

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respond(exchange, 502, error("interrupted while calling HookRelay"));
        } catch (IOException e) {
            respond(exchange, 502, error("could not reach HookRelay: " + e));
        } catch (RuntimeException e) {
            respond(exchange, 400, error(String.valueOf(e.getMessage())));
        }
    }

    /**
     * Builds the event body once and signs those exact bytes. Rebuilding the string later
     * would change the text, and the server verifies against the bytes it receives.
     */
    private static Prepared prepare(String endpointId, String secret, String externalId,
                                    String payload, long skew, boolean badSig) {
        String body = "{\"endpointId\":" + quote(endpointId) + ","
                + "\"externalId\":" + quote(externalId) + ","
                + "\"payload\":" + payload + "}";

        long timestamp = Instant.now().getEpochSecond() + skew;
        String signature = badSig ? "not-a-real-signature" : sign(endpointId, secret, body, timestamp);

        return new Prepared(body, timestamp, signature);
    }

    private static HttpResponse<String> send(String baseUrl, Prepared prepared)
            throws IOException, InterruptedException {
        return post(baseUrl + "/api/event", prepared.body(), Map.of(
                TIMESTAMP_HEADER, String.valueOf(prepared.timestamp()),
                SIGNATURE_HEADER, prepared.signature()));
    }

    private static HttpResponse<String> post(String url, String body, Map<String, String> headers)
            throws IOException, InterruptedException {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));

        headers.forEach(request::header);

        return CLIENT.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    /**
     * Same construction the server verifies: HMAC-SHA256 over
     * "<epochSeconds>:<endpointId>:<body>", base64url encoded without padding.
     */
    private static String sign(String endpointId, String secret, String body, long timestamp) {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM));

            byte[] hash = mac.doFinal(
                    (timestamp + ":" + endpointId + ":" + body).getBytes(StandardCharsets.UTF_8));

            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to sign request", e);
        }
    }

    private static String baseUrl(Map<String, String> query) {
        return query.containsKey("baseUrl") ? stripTrailingSlash(query.get("baseUrl")) : defaultBaseUrl;
    }

    private static String randomExternalId() {
        return "evt-" + UUID.randomUUID();
    }

    private static String firstMatch(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);

        return matcher.find() ? matcher.group(1) : null;
    }

    private static Map<String, String> parseQuery(String rawQuery) {
        Map<String, String> params = new HashMap<>();
        if (rawQuery == null || rawQuery.isEmpty()) {
            return params;
        }

        for (String pair : rawQuery.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            params.put(
                    URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8),
                    URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
        }

        return params;
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream in = exchange.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8).trim();
        }
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static String error(String message) {
        return "{\"error\":" + quote(message) + "}";
    }

    private static String quote(String value) {
        return "\"" + escape(value) + "\"";
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
    }

    private static String stripTrailingSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
