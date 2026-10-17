import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * End-to-end smoke test for the MVP pipeline:
 *
 *   ingest -> outbox -> relay -> deliver.p0 -> worker -> mock target
 *                                     ^                     |
 *                                     └── retry.10s <───────┘ (on a retryable failure)
 *
 * It drives everything through public HTTP routes only — the app's API and the mock target's
 * control routes — so a pass proves the pipeline works without anyone touching the database.
 *
 * Each scenario gets a fresh endpoint so the mock target's log can be filtered per scenario:
 *
 *   delivered      mock answers 200              -> 1 attempt, event delivered
 *   recovers       mock fails twice, then 200    -> 3 attempts ~10s apart, event delivered
 *   dead on 4xx    mock answers 400              -> 1 attempt, event dead (no retry)
 *   dead after 5   mock answers 500              -> 5 attempts ~10s apart, event dead
 *
 * Takes about 70 seconds, almost all of it waiting on the 10-second retry queue.
 *
 * Prerequisites: docker compose up, the app running (relay + worker profiles), and the mock
 * target running — ideally with the master key, so signatures are checked rather than skipped:
 *   java tools/MockTarget.java 9091 "$ENV_MASTER_KEY"
 *
 * Run it (no build step, no Maven — Java runs the source file directly):
 *   java tools/SmokeTest.java [hookrelayBaseUrl] [mockTargetBaseUrl]
 *   java tools/SmokeTest.java http://localhost:8080 http://localhost:9091
 *
 * Exit code 0 when every scenario passes, 1 otherwise. The inbound secrets it receives belong
 * to the throwaway endpoints it creates, are held in memory only, and are never printed.
 */
public class SmokeTest {

    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private static final String TIMESTAMP_HEADER = "X-Hookrelay-Timestamp";
    private static final String SIGNATURE_HEADER = "X-Hookrelay-Signature";

    private static final int MAX_ATTEMPTS = 5;
    /** The retry queue's TTL is 10s; a little under it allows for clock and scheduling jitter. */
    private static final Duration MIN_RETRY_GAP = Duration.ofSeconds(9);
    private static final Duration POLL_INTERVAL = Duration.ofMillis(500);

    /** Pulled out with regexes so this file stays dependency-free — no Jackson, no build step. */
    private static final Pattern ID = Pattern.compile("\"id\"\\s*:\\s*\"([0-9a-fA-F-]{36})\"");
    private static final Pattern INBOUND_SECRET = Pattern.compile("\"inboundSecret\"\\s*:\\s*\"([^\"]+)\"");
    private static final Pattern STATUS = Pattern.compile("\"status\"\\s*:\\s*\"(\\w+)\"");
    private static final Pattern ATTEMPT = Pattern.compile(
            "\\{\"attempt\":(\\d+),\"statusCode\":(null|\\d+),\"error\":(null|\"(?:[^\"\\\\]|\\\\.)*\"),"
                    + "\"latencyMs\":(null|\\d+),\"createdAt\":\"([^\"]+)\"}");
    private static final Pattern COUNT = Pattern.compile("\"count\"\\s*:\\s*(\\d+)");
    private static final Pattern SIGNATURE_CHECK = Pattern.compile("\"signature\"\\s*:\\s*\"([^\"]*)\"");

    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private static String app = "http://localhost:8080";
    private static String mock = "http://localhost:9091";

    private record Endpoint(String id, String inboundSecret) {
    }

    private record Attempt(int number, Integer statusCode, Instant createdAt) {
    }

    private record Event(String status, List<Attempt> attempts) {
    }

    /** Thrown on the first failed check of a scenario, so the rest of that scenario is skipped. */
    private static class CheckFailed extends RuntimeException {
        CheckFailed(String message) {
            super(message);
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            app = stripTrailingSlash(args[0]);
        }
        if (args.length > 1) {
            mock = stripTrailingSlash(args[1]);
        }

        System.out.println("smoke test: app=" + app + "  mock=" + mock);
        preflight();

        List<String[]> results = new ArrayList<>();
        results.add(run("delivered", SmokeTest::delivered));
        results.add(run("recovers", SmokeTest::recovers));
        results.add(run("dead on 4xx", SmokeTest::deadOnClientError));
        results.add(run("dead after 5", SmokeTest::deadAfterMaxAttempts));

        post(mock + "/reset", "", Map.of());

        System.out.println();
        printTable(new String[]{"scenario", "result"}, results.toArray(new String[0][]));

        boolean allPassed = results.stream().allMatch(r -> r[1].startsWith("PASS"));
        System.out.println(allPassed ? "all scenarios passed" : "some scenarios FAILED");
        System.exit(allPassed ? 0 : 1);
    }

    private interface Scenario {
        String run() throws Exception;
    }

    private static String[] run(String name, Scenario scenario) {
        System.out.println();
        System.out.println("== " + name);
        try {
            String detail = scenario.run();
            System.out.println("   PASS: " + detail);
            return new String[]{name, "PASS  " + detail};
        } catch (CheckFailed e) {
            System.out.println("   FAIL: " + e.getMessage());
            return new String[]{name, "FAIL  " + e.getMessage()};
        } catch (Exception e) {
            System.out.println("   ERROR: " + e);
            return new String[]{name, "ERROR " + e};
        }
    }

    // ---- scenarios -------------------------------------------------------------------------

    private static String delivered() throws Exception {
        mode("status=200");
        Endpoint endpoint = createEndpoint("smoke-delivered");
        String eventId = sendEvent(endpoint);

        Event event = awaitFinal(eventId, Duration.ofSeconds(20));
        expect("delivered", event);
        expectAttempts(event, 1);
        expectStatusCodes(event, 200);
        String signature = expectReceived(endpoint, 1);

        return "1 attempt, 200, signature " + signature;
    }

    private static String recovers() throws Exception {
        mode("status=200&failures=2&failStatus=503");
        Endpoint endpoint = createEndpoint("smoke-recovers");
        String eventId = sendEvent(endpoint);

        Event event = awaitFinal(eventId, Duration.ofSeconds(45));
        expect("delivered", event);
        expectAttempts(event, 3);
        expectStatusCodes(event, 503, 503, 200);
        expectRetryGaps(event);
        expectReceived(endpoint, 3);

        return "503, 503, 200 — " + gaps(event);
    }

    private static String deadOnClientError() throws Exception {
        mode("status=400");
        Endpoint endpoint = createEndpoint("smoke-dead-4xx");
        String eventId = sendEvent(endpoint);

        Event event = awaitFinal(eventId, Duration.ofSeconds(20));
        expect("dead", event);
        expectAttempts(event, 1);
        expectStatusCodes(event, 400);

        // Give a wrongly scheduled retry time to show up before declaring there was none.
        Thread.sleep(MIN_RETRY_GAP.plusSeconds(3).toMillis());
        expectAttempts(fetchEvent(eventId), 1);
        expectReceived(endpoint, 1);

        return "1 attempt, 400, no retry";
    }

    private static String deadAfterMaxAttempts() throws Exception {
        mode("status=500");
        Endpoint endpoint = createEndpoint("smoke-dead-5");
        String eventId = sendEvent(endpoint);

        Event event = awaitFinal(eventId, Duration.ofSeconds(90));
        expect("dead", event);
        expectAttempts(event, MAX_ATTEMPTS);
        expectStatusCodes(event, 500, 500, 500, 500, 500);
        expectRetryGaps(event);
        expectReceived(endpoint, MAX_ATTEMPTS);

        return MAX_ATTEMPTS + " x 500 — " + gaps(event);
    }

    // ---- checks ----------------------------------------------------------------------------

    private static void expect(String status, Event event) {
        if (!status.equalsIgnoreCase(event.status())) {
            throw new CheckFailed("expected status " + status + ", got " + event.status());
        }
    }

    private static void expectAttempts(Event event, int count) {
        if (event.attempts().size() != count) {
            throw new CheckFailed("expected " + count + " attempts, got " + event.attempts().size());
        }
        for (int i = 0; i < count; i++) {
            if (event.attempts().get(i).number() != i + 1) {
                throw new CheckFailed("attempt numbers out of sequence: " + numbers(event));
            }
        }
    }

    private static void expectStatusCodes(Event event, int... codes) {
        for (int i = 0; i < codes.length; i++) {
            Integer actual = event.attempts().get(i).statusCode();
            if (actual == null || actual != codes[i]) {
                throw new CheckFailed("attempt " + (i + 1) + " expected " + codes[i] + ", got " + actual);
            }
        }
    }

    /** Retries must come from the retry queue's TTL, not straight back from the worker. */
    private static void expectRetryGaps(Event event) {
        List<Attempt> attempts = event.attempts();
        for (int i = 1; i < attempts.size(); i++) {
            Duration gap = Duration.between(attempts.get(i - 1).createdAt(), attempts.get(i).createdAt());
            if (gap.compareTo(MIN_RETRY_GAP) < 0) {
                throw new CheckFailed("attempt " + (i + 1) + " came only " + gap.toMillis() + "ms after the previous one");
            }
        }
    }

    /**
     * The mock target's own log must agree with the app's: the right number of requests, every
     * one signed correctly. "skipped" (mock started without the master key) is allowed but noted.
     */
    private static String expectReceived(Endpoint endpoint, int count) throws Exception {
        HttpResponse<String> response = get(mock + "/received?endpointId=" + endpoint.id());
        int received = Integer.parseInt(firstMatch(COUNT, response.body()));
        if (received != count) {
            throw new CheckFailed("mock target received " + received + " requests, expected " + count);
        }

        String result = "valid";
        Matcher matcher = SIGNATURE_CHECK.matcher(response.body());
        while (matcher.find()) {
            String check = matcher.group(1);
            if (check.startsWith("skipped")) {
                result = "skipped (start the mock with the master key to verify)";
            } else if (!check.equals("valid")) {
                throw new CheckFailed("mock target reported signature " + check);
            }
        }
        return result;
    }

    // ---- app and mock calls ----------------------------------------------------------------

    private static void preflight() throws Exception {
        try {
            if (get(mock + "/health").statusCode() != 200) {
                fail("mock target at " + mock + " is not healthy");
            }
        } catch (IOException e) {
            fail("mock target not reachable at " + mock + " — start it with: java tools/MockTarget.java 9091 \"$ENV_MASTER_KEY\"");
        }
        try {
            // Any HTTP answer proves the app is up; 404 is the expected one for a random id.
            get(app + "/api/event/" + UUID.randomUUID());
        } catch (IOException e) {
            fail("app not reachable at " + app);
        }
        post(mock + "/reset", "", Map.of());
    }

    /** Resets first so a failure budget left over from an earlier scenario cannot leak into this one. */
    private static void mode(String query) throws Exception {
        post(mock + "/reset", "", Map.of());
        HttpResponse<String> response = post(mock + "/mode?" + query, "", Map.of());
        if (response.statusCode() != 200) {
            throw new IllegalStateException("could not set mock mode " + query + ": " + response.body());
        }
    }

    /**
     * Creates the endpoint first and points it at the mock afterwards: the mock needs the
     * endpoint id in the path to verify the signature, and the id only exists once created.
     */
    private static Endpoint createEndpoint(String name) throws Exception {
        String body = "{\"name\":" + quote(name) + ",\"target_url\":" + quote(mock + "/hook/pending") + "}";
        HttpResponse<String> created = post(app + "/api/endpoint", body, Map.of());
        if (created.statusCode() != 201) {
            throw new IllegalStateException("create endpoint returned " + created.statusCode());
        }

        String id = firstMatch(ID, created.body());
        String secret = firstMatch(INBOUND_SECRET, created.body());
        if (id == null || secret == null) {
            throw new IllegalStateException("could not read id / inbound secret from the create response");
        }

        String patch = "{\"target_url\":" + quote(mock + "/hook/" + id) + "}";
        HttpResponse<String> updated = request("PATCH", app + "/api/endpoint/" + id, patch, Map.of());
        if (updated.statusCode() != 200) {
            throw new IllegalStateException("update endpoint returned " + updated.statusCode() + ": " + updated.body());
        }

        System.out.println("   endpoint " + id);
        return new Endpoint(id, secret);
    }

    /** Signs exactly the bytes it sends, the way the ingest API verifies them. */
    private static String sendEvent(Endpoint endpoint) throws Exception {
        String body = "{\"endpointId\":" + quote(endpoint.id()) + ","
                + "\"externalId\":" + quote("smoke-" + UUID.randomUUID()) + ","
                + "\"payload\":{\"type\":\"smoke.test\",\"sentAt\":" + quote(Instant.now().toString()) + "}}";

        long timestamp = Instant.now().getEpochSecond();
        String signature = sign(endpoint.id(), endpoint.inboundSecret(), body, timestamp);

        HttpResponse<String> response = post(app + "/api/event", body, Map.of(
                TIMESTAMP_HEADER, String.valueOf(timestamp),
                SIGNATURE_HEADER, signature));

        if (response.statusCode() != 201) {
            throw new IllegalStateException("ingest returned " + response.statusCode() + ": " + response.body());
        }

        String eventId = firstMatch(ID, response.body());
        System.out.println("   event    " + eventId);
        return eventId;
    }

    /** Polls the event until it leaves pending; anything still pending at the deadline fails. */
    private static Event awaitFinal(String eventId, Duration timeout) throws Exception {
        Instant deadline = Instant.now().plus(timeout);
        int lastSeen = 0;

        while (true) {
            Event event = fetchEvent(eventId);

            if (event.attempts().size() > lastSeen) {
                for (Attempt a : event.attempts().subList(lastSeen, event.attempts().size())) {
                    System.out.println("   attempt " + a.number() + " -> " + a.statusCode() + " at " + a.createdAt());
                }
                lastSeen = event.attempts().size();
            }

            if (!"pending".equalsIgnoreCase(event.status())) {
                return event;
            }
            if (Instant.now().isAfter(deadline)) {
                throw new CheckFailed("still pending after " + timeout.toSeconds() + "s with "
                        + event.attempts().size() + " attempts");
            }
            Thread.sleep(POLL_INTERVAL.toMillis());
        }
    }

    private static Event fetchEvent(String eventId) throws Exception {
        HttpResponse<String> response = get(app + "/api/event/" + eventId);
        if (response.statusCode() != 200) {
            throw new IllegalStateException("GET event returned " + response.statusCode() + ": " + response.body());
        }

        List<Attempt> attempts = new ArrayList<>();
        Matcher matcher = ATTEMPT.matcher(response.body());
        while (matcher.find()) {
            attempts.add(new Attempt(
                    Integer.parseInt(matcher.group(1)),
                    "null".equals(matcher.group(2)) ? null : Integer.valueOf(matcher.group(2)),
                    Instant.parse(matcher.group(5))));
        }

        return new Event(firstMatch(STATUS, response.body()), attempts);
    }

    // ---- plumbing --------------------------------------------------------------------------

    private static HttpResponse<String> get(String url) throws IOException, InterruptedException {
        return CLIENT.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> post(String url, String body, Map<String, String> headers)
            throws IOException, InterruptedException {
        return request("POST", url, body, headers);
    }

    private static HttpResponse<String> request(String method, String url, String body, Map<String, String> headers)
            throws IOException, InterruptedException {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));

        headers.forEach(request::header);

        return CLIENT.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    /** Same construction the server verifies: HMAC-SHA256 over "<epochSeconds>:<endpointId>:<body>". */
    private static String sign(String endpointId, String secret, String body, long timestamp) {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM));

            byte[] hash = mac.doFinal((timestamp + ":" + endpointId + ":" + body).getBytes(StandardCharsets.UTF_8));

            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to sign request", e);
        }
    }

    private static String gaps(Event event) {
        List<String> parts = new ArrayList<>();
        List<Attempt> attempts = event.attempts();
        for (int i = 1; i < attempts.size(); i++) {
            Duration gap = Duration.between(attempts.get(i - 1).createdAt(), attempts.get(i).createdAt());
            parts.add(String.format("%.1fs", gap.toMillis() / 1000.0));
        }
        return "gaps " + String.join(", ", parts);
    }

    private static String numbers(Event event) {
        return event.attempts().stream().map(a -> String.valueOf(a.number())).toList().toString();
    }

    private static String firstMatch(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static void fail(String message) {
        System.out.println("cannot start: " + message);
        System.exit(1);
    }

    private static String quote(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static String stripTrailingSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    /** Shared table printing, same shape as the other tools, so all three read alike. */
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
}
