package com.hookrelay.worker;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hookrelay.ingest.event.entity.EventStatus;
import com.hookrelay.relay.RelayMessage;
import com.hookrelay.security.SecretService;
import com.hookrelay.shared.RabbitTopology;
import com.rabbitmq.client.Channel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageBuilder;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
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
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Takes relay messages off the delivery queue and POSTs each event to its endpoint.
 *
 * Every attempt is saved first, then a failed one is re-queued (retry.10s) or parked (dead.q),
 * and only then is the original acked: a crash at any point leaves it unacked, so RabbitMQ
 * redelivers it instead of losing it.
 */
@Component
@Profile("worker")
public class DeliveryWorker {

    private static final Logger log = LoggerFactory.getLogger(DeliveryWorker.class);

    private static final String OUTBOUND = "outbound";
    private static final String TIMESTAMP_HEADER = "X-Hookrelay-Timestamp";
    private static final String SIGNATURE_HEADER = "X-Hookrelay-Signature";
    private static final String LAST_RESULT_HEADER = "x-last-result";
    private static final Duration TIMEOUT = Duration.ofSeconds(10);

    private static final int MAX_ATTEMPTS = 5;
    private static final long CONFIRM_TIMEOUT_MS = 5_000;
    private static final long REQUEUE_PAUSE_MS = 1_000;

    // The default exchange routes a message straight to the queue whose name is the routing key.
    private static final String DEFAULT_EXCHANGE = "";

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
    private static final String SET_STATUS = """
            UPDATE events SET status = ?
            WHERE id = ? AND status = ?
            """;

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final RabbitTemplate rabbit;
    private final SecretService secretService;
    private final ObjectMapper objectMapper;
    private final HttpClient http;

    public DeliveryWorker(JdbcTemplate jdbc,
                          TransactionTemplate tx,
                          RabbitTemplate rabbit,
                          SecretService secretService,
                          ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.rabbit = rabbit;
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
            // Without the pause a requeued message comes straight back and fails again in a tight loop.
            pause();
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
        DeliveryOutcome outcome = decide(attempt, relayMessage.attempt());

        tx.executeWithoutResult(status -> {
            jdbc.update(INSERT_ATTEMPT, event.id(), relayMessage.attempt(),
                    attempt.statusCode(), attempt.error(), attempt.latencyMs());
            if (outcome == DeliveryOutcome.SUCCESS) {
                jdbc.update(SET_STATUS, EventStatus.DELIVERED.getValue(), event.id(), EventStatus.PENDING.getValue());
            } else if (outcome == DeliveryOutcome.DEAD) {
                jdbc.update(SET_STATUS, EventStatus.DEAD.getValue(), event.id(), EventStatus.PENDING.getValue());
            }
        });

        // Published after the commit: if the publish fails, the nack redelivers the original and it is tried again.
        // A lost dead.q copy costs nothing, since events.status already says dead.
        switch (outcome) {
            case RETRY -> publishConfirmed(RabbitTopology.RETRY_QUEUE, nextAttempt(relayMessage), attempt);
            case DEAD -> publishConfirmed(RabbitTopology.DEAD_QUEUE, relayMessage, attempt);
            case SUCCESS -> {
            }
        }

        log.info("event {} attempt {} -> {} in {}ms, {}", event.id(), relayMessage.attempt(),
                attempt.summary(), attempt.latencyMs(), outcome);
    }

    private DeliveryOutcome decide(Attempt attempt, int attemptNumber) {
        // A target_url that cannot even be parsed will never work, whatever the classifier would say.
        if (attempt.invalidTarget()) {
            return DeliveryOutcome.DEAD;
        }

        DeliveryOutcome outcome = DeliveryClassifier.classify(attempt.statusCode());

        if (outcome == DeliveryOutcome.RETRY && attemptNumber >= MAX_ATTEMPTS) {
            return DeliveryOutcome.DEAD;
        }
        return outcome;
    }

    private Attempt post(EventRow event) {
        Instant now = Instant.now();
        String signature = secretService.signWebhook(event.endpointId(), OUTBOUND, event.payload(), now);
        long start = System.nanoTime();

        HttpRequest request;
        try {
            request = HttpRequest.newBuilder(URI.create(event.targetUrl()))
                    .timeout(TIMEOUT)
                    .header("Content-Type", "application/json")
                    .header(TIMESTAMP_HEADER, String.valueOf(now.getEpochSecond()))
                    .header(SIGNATURE_HEADER, signature)
                    .POST(HttpRequest.BodyPublishers.ofString(event.payload()))
                    .build();
        } catch (IllegalArgumentException e) {
            return new Attempt(null, "invalid target_url: " + e.getMessage(), 0, true);
        }

        try {
            HttpResponse<Void> response = http.send(request, HttpResponse.BodyHandlers.discarding());
            return new Attempt(response.statusCode(), null, elapsedMs(start), false);

        } catch (IOException e) {
            // Timeouts and refused connections are IOExceptions: the target never answered.
            return new Attempt(null, e.getClass().getSimpleName() + ": " + e.getMessage(), elapsedMs(start), false);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while delivering " + event.id(), e);
        }
    }

    /**
     * Publishes to a queue and waits for the broker to confirm it, the same guarantee the relay
     * relies on; anything short of a clean confirm throws so the caller nacks and tries again.
     */
    private void publishConfirmed(String queue, RelayMessage body, Attempt attempt) {
        Message message = MessageBuilder.withBody(toJson(body))
                .setContentType(MessageProperties.CONTENT_TYPE_JSON)
                .setDeliveryMode(MessageDeliveryMode.PERSISTENT)
                .setMessageId(body.eventId().toString())
                .setHeader(LAST_RESULT_HEADER, attempt.summary())
                .build();

        CorrelationData correlation = new CorrelationData(UUID.randomUUID().toString());
        rabbit.send(DEFAULT_EXCHANGE, queue, message, correlation);

        try {
            CorrelationData.Confirm confirm = correlation.getFuture().get(CONFIRM_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            // An ack with a return means the broker took it but no queue matched, so it was dropped.
            if (!confirm.isAck() || correlation.getReturned() != null) {
                throw new IllegalStateException("publish to " + queue + " not confirmed for event " + body.eventId());
            }
        } catch (TimeoutException | ExecutionException e) {
            throw new IllegalStateException("publish to " + queue + " failed for event " + body.eventId(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while publishing event " + body.eventId(), e);
        }
    }

    private static RelayMessage nextAttempt(RelayMessage message) {
        return new RelayMessage(message.eventId(), message.endpointId(), message.attempt() + 1, message.ordered());
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

    private byte[] toJson(RelayMessage body) {
        try {
            return objectMapper.writeValueAsBytes(body);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cannot serialise relay message " + body.eventId(), e);
        }
    }

    private static void pause() {
        try {
            Thread.sleep(REQUEUE_PAUSE_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static int elapsedMs(long start) {
        return (int) TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
    }

    private record EventRow(UUID id, UUID endpointId, String status, String payload, String targetUrl) {
    }

    private record Attempt(Integer statusCode, String error, int latencyMs, boolean invalidTarget) {

        String summary() {
            return statusCode != null ? String.valueOf(statusCode) : error;
        }
    }
}
