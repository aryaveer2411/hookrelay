package com.hookrelay.worker;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hookrelay.ingest.event.entity.EventStatus;
import com.hookrelay.relay.RelayMessage;
import com.hookrelay.security.SecretService;
import com.hookrelay.shared.RabbitTopology;
import com.rabbitmq.client.Channel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * Takes relay messages off the delivery queue and POSTs each event to its endpoint.
 *
 * Acks only after the attempt is saved: a crash before that leaves the message unacked, so
 * RabbitMQ hands it to another consumer instead of losing it.
 */
@Component
@Profile("worker")
public class DeliveryWorker {

    private static final Logger log = LoggerFactory.getLogger(DeliveryWorker.class);

    private static final String OUTBOUND = "outbound";
    private static final String TIMESTAMP_HEADER = "X-Hookrelay-Timestamp";
    private static final String SIGNATURE_HEADER = "X-Hookrelay-Signature";
    private static final Duration TIMEOUT = Duration.ofSeconds(10);

    private static final String SELECT_EVENT = """
            SELECT e.id, e.endpoint_id, e.status, e.payload::text AS payload, ep.target_url
            FROM events e
            JOIN endpoints ep ON ep.id = e.endpoint_id
            WHERE e.id = ?
            """;

    private static final String INSERT_ATTEMPT = """
            INSERT INTO delivery_attempts (event_id, attempt, status_code, error, latency_ms)
            VALUES (?, ?, ?, ?, ?)
            """;

    // The status guard keeps a slow duplicate from overwriting a state another worker already set.
    private static final String MARK_DELIVERED = """
            UPDATE events SET status = ?
            WHERE id = ? AND status = ?
            """;

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final SecretService secretService;
    private final ObjectMapper objectMapper;
    private final HttpClient http;

    public DeliveryWorker(JdbcTemplate jdbc,
                          TransactionTemplate tx,
                          SecretService secretService,
                          ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.secretService = secretService;
        this.objectMapper = objectMapper;
        this.http = HttpClient.newBuilder()
                .connectTimeout(TIMEOUT)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    @RabbitListener(queues = RabbitTopology.DELIVER_QUEUE, ackMode = "MANUAL")
    public void onMessage(Message message, Channel channel) throws IOException {
        long tag = message.getMessageProperties().getDeliveryTag();
        try {
            deliver(message);
            channel.basicAck(tag, false);
        } catch (RuntimeException e) {
            // Infrastructure failure (e.g. Postgres down): put it back so a later try can finish the job.
            log.warn("delivery failed, requeueing: {}", e.getMessage());
            channel.basicNack(tag, false, true);
        }
    }

    private void deliver(Message message) {
        RelayMessage relayMessage = parse(message);
        if (relayMessage == null) {
            return;
        }

        EventRow event = jdbc.query(SELECT_EVENT, (rs, i) -> new EventRow(
                rs.getObject("id", UUID.class),
                rs.getObject("endpoint_id", UUID.class),
                rs.getString("status"),
                rs.getString("payload"),
                rs.getString("target_url")
        ), relayMessage.eventId()).stream().findFirst().orElse(null);

        if (event == null) {
            log.warn("event {} not found, dropping message", relayMessage.eventId());
            return;
        }

        // A redelivered duplicate lands here once the first copy has finished the event.
        if (!EventStatus.PENDING.getValue().equals(event.status())) {
            log.debug("event {} already {}, skipping", event.id(), event.status());
            return;
        }

        // The HTTP call runs outside any transaction so a slow target never holds a DB connection.
        Attempt attempt = post(event);

        tx.executeWithoutResult(status -> {
            jdbc.update(INSERT_ATTEMPT, event.id(), relayMessage.attempt(),
                    attempt.statusCode(), attempt.error(), attempt.latencyMs());
            if (attempt.isSuccess()) {
                jdbc.update(MARK_DELIVERED, EventStatus.DELIVERED.getValue(), event.id(), EventStatus.PENDING.getValue());
            }
        });

        log.info("event {} attempt {} -> {} in {}ms", event.id(), relayMessage.attempt(),
                attempt.statusCode() != null ? attempt.statusCode() : attempt.error(), attempt.latencyMs());
    }

    private Attempt post(EventRow event) {
        Instant now = Instant.now();
        String signature = secretService.signWebhook(event.endpointId(), OUTBOUND, event.payload(), now);
        long start = System.nanoTime();

        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(event.targetUrl()))
                    .timeout(TIMEOUT)
                    .header("Content-Type", "application/json")
                    .header(TIMESTAMP_HEADER, String.valueOf(now.getEpochSecond()))
                    .header(SIGNATURE_HEADER, signature)
                    .POST(HttpRequest.BodyPublishers.ofString(event.payload()))
                    .build();

            HttpResponse<Void> response = http.send(request, HttpResponse.BodyHandlers.discarding());
            return new Attempt(response.statusCode(), null, elapsedMs(start));

        } catch (IOException | IllegalArgumentException e) {
            // Timeouts and refused connections are IOExceptions; a malformed target_url is an IllegalArgumentException.
            return new Attempt(null, e.getClass().getSimpleName() + ": " + e.getMessage(), elapsedMs(start));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while delivering " + event.id(), e);
        }
    }

    // An unreadable message can never succeed, so it is acked and dropped rather than requeued forever.
    private RelayMessage parse(Message message) {
        try {
            return objectMapper.readValue(message.getBody(), RelayMessage.class);
        } catch (IOException e) {
            log.warn("unreadable message {}, dropping: {}", message.getMessageProperties().getMessageId(), e.getMessage());
            return null;
        }
    }

    private static int elapsedMs(long start) {
        return (int) TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
    }

    private record EventRow(UUID id, UUID endpointId, String status, String payload, String targetUrl) {
    }

    private record Attempt(Integer statusCode, String error, int latencyMs) {

        boolean isSuccess() {
            return statusCode != null && statusCode >= 200 && statusCode < 300;
        }
    }
}
