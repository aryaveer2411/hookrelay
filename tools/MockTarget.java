import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A standalone mock target that plays the part of the customer's server — the far end of a
 * delivery, the thing HookRelay's worker POSTs to.
 *
 * It does three jobs that a real URL on the internet will not do for you:
 *
 *   1. verifies the outbound signature, so a broken signing change is caught here instead of
 *      being silently accepted;
 *   2. lets you force the response code, so a delivery can be made to fail on purpose and the
 *      retry ladder has something to climb;
 *   3. keeps a log of what arrived, so a test can assert on it instead of you reading stdout.
 *
 * Nothing is persisted and nothing is read from the environment. Secrets live in memory for
 * the life of the process and are never written to the log.
 *
 * Run it (no build step, no Maven — Java runs the source file directly):
 *   java tools/MockTarget.java [port] [masterKey]
 *   java tools/MockTarget.java 9091 "$ENV_MASTER_KEY"
 *
 * Passing the master key is optional and only a convenience: with it the outbound secret for
 * any endpoint is derived on the fly, so deliveries verify without registering anything. Leave
 * it off and register secrets one at a time instead — or not at all, in which case signatures
 * are recorded as "skipped" and delivery still works.
 *
 * Point an endpoint at it by setting target_url to:
 *   http://localhost:9091/hook/<endpointId>
 *
 * The id in the path is not decoration: the signature covers the endpoint id, so the receiver
 * has to know which endpoint a request claims to be from before it can check anything.
 *
 * Routes:
 *
 *   POST /hook/{endpointId}   the delivery receiver. Verifies and logs, answers with whatever
 *                             the current mode says.
 *
 *   POST /mode                changes how the receiver answers. All params optional:
 *                               status=<code>     steady-state response code (default 200)
 *                               failures=<n>      fail the next n requests, then go back to
 *                                                 status — for "retries, then succeeds"
 *                               failStatus=<code> what those n failures answer with (default 500)
 *                               delayMs=<ms>      stall before answering, to trip the timeout
 *                             curl -X POST "http://localhost:9091/mode?status=500"
 *
 *   POST /register            teaches it one endpoint's outbound secret.
 *                             curl -X POST "http://localhost:9091/register?endpointId=<id>&secret=<secret>"
 *
 *   GET  /received            everything received so far, newest last, as JSON.
 *                             Optional: ?endpointId=<id> to filter.
 *
 *   POST /reset               clears the log and returns to plain 200 mode.
 *
 *   GET  /health              liveness check, plus the current mode.
 */
public class MockTarget {

    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private static final String TIMESTAMP_HEADER = "X-Hookrelay-Timestamp";
    private static final String SIGNATURE_HEADER = "X-Hookrelay-Signature";

    /** Matches the server's replay window, so a stale timestamp is reported rather than accepted. */
    private static final long REPLAY_TOLERANCE_SECONDS = 300;

    /** Oldest entries fall off the end — this is a test rig, not storage. */
    private static final int LOG_LIMIT = 500;

    /** Outbound secrets, by endpoint id. In memory only, never logged, never written out. */
    private static final Map<String, String> SECRETS = new ConcurrentHashMap<>();

    private static final Deque<Received> LOG = new ConcurrentLinkedDeque<>();
    private static final AtomicInteger COUNTER = new AtomicInteger();

    private static volatile String masterKey = null;
    private static volatile int steadyStatus = 200;
    private static volatile int failStatus = 500;
    private static volatile int remainingFailures = 0;
    private static volatile long delayMs = 0;

    private static int listenPort = 9091;

    /** One delivery as it was seen on the wire. */
    private record Received(int seq, String at, String endpointId, String signatureCheck,
                            long timestamp, long skewSeconds, int answeredWith, String body) {
    }

    public static void main(String[] args) throws IOException {
        if (args.length > 0) {
            listenPort = Integer.parseInt(args[0]);
        }
        if (args.length > 1 && !isBlank(args[1])) {
            masterKey = args[1];
        }

        HttpServer server = HttpServer.create(new InetSocketAddress(listenPort), 0);
        server.createContext("/hook", MockTarget::handleHook);
        server.createContext("/mode", MockTarget::handleMode);
        server.createContext("/register", MockTarget::handleRegister);
        server.createContext("/received", MockTarget::handleReceived);
        server.createContext("/reset", MockTarget::handleReset);
        server.createContext("/health", exchange -> respond(exchange, 200,
                "{\"status\":\"up\"," + modeFields() + "}"));

        // One virtual thread per request: a delayMs stall holds up that one delivery and
        // leaves the control routes answering normally.
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.start();

        System.out.println("mock target listening on http://localhost:" + listenPort);
        System.out.println("  point an endpoint at http://localhost:" + listenPort + "/hook/<endpointId>");
        System.out.println("  signature verification: "
                + (masterKey != null ? "on (secrets derived from the master key)"
                                     : "off until a secret is registered"));
        System.out.println();
        printRoutes();
    }

    private static void printRoutes() {
        printTable(
                new String[]{"case", "result"},
                new String[][]{
                        {"POST /hook/<endpointId>", "200 by default, signature verified and logged"},
                        {"POST /mode?status=500", "every later delivery answers 500"},
                        {"POST /mode?failures=3", "next 3 deliveries fail, then back to normal"},
                        {"POST /mode?delayMs=15000", "stalls, so the worker's 10s timeout fires"},
                        {"POST /register", "teaches it one endpoint's outbound secret"},
                        {"GET  /received", "everything received, newest last"},
                        {"POST /reset", "clears the log, back to plain 200"},
                        {"GET  /health", "200, plus the current mode"},
                        {"  bad signature", "still answered, logged as signature=invalid"},
                        {"  no secret known", "still answered, logged as signature=skipped"},
                });
    }

    /**
     * The delivery receiver. It always answers something — a signature it cannot verify is
     * recorded as a failure rather than rejected, because the point of this process is to show
     * you what arrived, not to be a second implementation of the security rules.
     */
    private static void handleHook(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("use POST"));
            return;
        }

        String endpointId = endpointIdFromPath(exchange.getRequestURI().getPath());
        String body = readBody(exchange);
        String signature = exchange.getRequestHeaders().getFirst(SIGNATURE_HEADER);
        String rawTimestamp = exchange.getRequestHeaders().getFirst(TIMESTAMP_HEADER);

        long timestamp = parseLongOrZero(rawTimestamp);
        long skew = timestamp == 0 ? 0 : Instant.now().getEpochSecond() - timestamp;

        String check = verify(endpointId, body, timestamp, signature);

        int status = nextStatus();
        long stall = delayMs;

        Received entry = new Received(COUNTER.incrementAndGet(), Instant.now().toString(),
                endpointId, check, timestamp, skew, status, body);
        record(entry);

        System.out.printf("#%d  %s  endpoint=%s  signature=%s  skew=%ds  -> %d%s%n",
                entry.seq(), entry.at(), endpointId == null ? "(none)" : endpointId,
                check, skew, status, stall > 0 ? "  after " + stall + "ms" : "");
        System.out.println("     " + body);

        if (stall > 0) {
            try {
                Thread.sleep(stall);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        respond(exchange, status, "{"
                + "\"received\":true,"
                + "\"seq\":" + entry.seq() + ","
                + "\"signature\":" + quote(check)
                + "}");
    }

    /**
     * Works out this delivery's response code and burns one off the failure budget if there is
     * one. Synchronized so two deliveries arriving together cannot both claim the same slot.
     */
    private static synchronized int nextStatus() {
        if (remainingFailures > 0) {
            remainingFailures--;
            return failStatus;
        }

        return steadyStatus;
    }

    /**
     * Recomputes the signature over the exact bytes that arrived and compares in constant time.
     * The secret comes from an explicit registration if there is one, otherwise it is derived
     * from the master key the same way the server derives it.
     */
    private static String verify(String endpointId, String body, long timestamp, String signature) {
        if (endpointId == null) {
            return "skipped (no endpoint id in the path)";
        }
        if (isBlank(signature) || timestamp == 0) {
            return "missing (no " + SIGNATURE_HEADER + " / " + TIMESTAMP_HEADER + ")";
        }

        String secret = SECRETS.get(endpointId);
        if (secret == null && masterKey != null) {
            secret = hmac(masterKey, endpointId + ":outbound");
        }
        if (secret == null) {
            return "skipped (no secret known for this endpoint)";
        }

        String expected = hmac(secret, timestamp + ":" + endpointId + ":" + body);

        byte[] expectedBytes = decode(expected);
        byte[] providedBytes = decode(signature);

        if (providedBytes == null || !MessageDigest.isEqual(expectedBytes, providedBytes)) {
            return "invalid";
        }

        if (Math.abs(Instant.now().getEpochSecond() - timestamp) > REPLAY_TOLERANCE_SECONDS) {
            return "valid but stale (outside the " + REPLAY_TOLERANCE_SECONDS + "s replay window)";
        }

        return "valid";
    }

    private static void handleMode(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("use POST"));
            return;
        }

        try {
            Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());

            if (query.containsKey("status")) {
                steadyStatus = Integer.parseInt(query.get("status"));
            }
            if (query.containsKey("failStatus")) {
                failStatus = Integer.parseInt(query.get("failStatus"));
            }
            if (query.containsKey("failures")) {
                remainingFailures = Integer.parseInt(query.get("failures"));
            }
            if (query.containsKey("delayMs")) {
                delayMs = Long.parseLong(query.get("delayMs"));
            }

            System.out.println("mode -> " + modeFields());

            respond(exchange, 200, "{" + modeFields() + "}");

        } catch (NumberFormatException e) {
            respond(exchange, 400, error("status, failStatus, failures and delayMs must be numbers"));
        }
    }

    private static void handleRegister(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("use POST"));
            return;
        }

        Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());
        String endpointId = query.get("endpointId");
        String secret = query.get("secret");

        if (isBlank(endpointId) || isBlank(secret)) {
            respond(exchange, 400, error("endpointId and secret are required"));
            return;
        }

        SECRETS.put(endpointId, secret);
        System.out.println("registered outbound secret for " + endpointId);

        respond(exchange, 200, "{\"registered\":" + quote(endpointId) + "}");
    }

    private static void handleReceived(HttpExchange exchange) throws IOException {
        Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());
        String filter = query.get("endpointId");

        List<String> items = new ArrayList<>();
        for (Received entry : LOG) {
            if (filter != null && !filter.equals(entry.endpointId())) {
                continue;
            }
            items.add(toJson(entry));
        }

        respond(exchange, 200, "{"
                + "\"count\":" + items.size() + ","
                + "\"received\":[" + String.join(",", items) + "]"
                + "}");
    }

    private static void handleReset(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, error("use POST"));
            return;
        }

        LOG.clear();
        COUNTER.set(0);
        steadyStatus = 200;
        failStatus = 500;
        remainingFailures = 0;
        delayMs = 0;

        System.out.println("reset");

        respond(exchange, 200, "{\"reset\":true," + modeFields() + "}");
    }

    /** Keeps the log bounded by dropping from the front once it is full. */
    private static void record(Received entry) {
        LOG.addLast(entry);

        while (LOG.size() > LOG_LIMIT) {
            LOG.pollFirst();
        }
    }

    private static String toJson(Received entry) {
        return "{"
                + "\"seq\":" + entry.seq() + ","
                + "\"at\":" + quote(entry.at()) + ","
                + "\"endpointId\":" + (entry.endpointId() == null ? "null" : quote(entry.endpointId())) + ","
                + "\"signature\":" + quote(entry.signatureCheck()) + ","
                + "\"timestamp\":" + entry.timestamp() + ","
                + "\"skewSeconds\":" + entry.skewSeconds() + ","
                + "\"answeredWith\":" + entry.answeredWith() + ","
                + "\"body\":" + quote(entry.body())
                + "}";
    }

    private static String modeFields() {
        return "\"status\":" + steadyStatus + ","
                + "\"failStatus\":" + failStatus + ","
                + "\"remainingFailures\":" + remainingFailures + ","
                + "\"delayMs\":" + delayMs + ","
                + "\"knownSecrets\":" + SECRETS.size() + ","
                + "\"derivesSecrets\":" + (masterKey != null);
    }

    /** Pulls the id out of /hook/<endpointId>; anything else gives null. */
    private static String endpointIdFromPath(String path) {
        int slash = path.indexOf('/', 1);
        if (slash < 0 || slash == path.length() - 1) {
            return null;
        }

        String rest = path.substring(slash + 1);
        int next = rest.indexOf('/');

        return next < 0 ? rest : rest.substring(0, next);
    }

    private static String hmac(String key, String data) {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM));

            byte[] hash = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));

            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to generate HMAC", e);
        }
    }

    private static byte[] decode(String signature) {
        try {
            return Base64.getUrlDecoder().decode(signature);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static long parseLongOrZero(String value) {
        try {
            return value == null ? 0 : Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
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

    /**
     * Reads the body as the exact bytes that arrived — the signature covers those bytes, so
     * nothing may be trimmed or re-formatted before checking it.
     */
    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream in = exchange.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
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

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    /** Shared table printing, same shape as the sender's, so both tools read alike. */
    private static void printTable(String[] headers, String[][] rows) {
        int columns = headers.length;
        int[] widths = new int[columns];

        for (int c = 0; c < columns; c++) {
            widths[c] = headers[c].length();
            for (String[] row : rows) {
                widths[c] = Math.max(widths[c], row[c].length());
            }
        }

        System.out.println(rule(widths, '┌', '┬', '┐'));
        System.out.println(row(headers, widths));

        for (String[] cells : rows) {
            System.out.println(rule(widths, '├', '┼', '┤'));
            System.out.println(row(cells, widths));
        }

        System.out.println(rule(widths, '└', '┴', '┘'));
    }

    private static String rule(int[] widths, char left, char middle, char right) {
        StringBuilder line = new StringBuilder().append(left);

        for (int c = 0; c < widths.length; c++) {
            line.append(String.valueOf('─').repeat(widths[c] + 2));
            line.append(c == widths.length - 1 ? right : middle);
        }

        return line.toString();
    }

    private static String row(String[] cells, int[] widths) {
        StringBuilder line = new StringBuilder().append('│');

        for (int c = 0; c < widths.length; c++) {
            line.append(' ').append(pad(cells[c], widths[c])).append(" │");
        }

        return line.toString();
    }

    private static String pad(String value, int width) {
        return value + " ".repeat(width - value.length());
    }
}
