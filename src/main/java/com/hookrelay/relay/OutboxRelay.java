package com.hookrelay.relay;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hookrelay.shared.RabbitTopology;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageBuilder;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Moves unsent outbox rows into RabbitMQ.
 *
 * Rows are marked sent only after the broker confirms them: a crash before marking means a
 * duplicate publish (harmless under at-least-once), marking first could lose the event.
 */
@Component
@Profile("relay")
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private static final int BATCH_SIZE = 200;
    private static final long CONFIRM_TIMEOUT_MS = 5_000;

    // SKIP LOCKED lets several relays run side by side without picking or waiting on the same rows.
    private static final String SELECT_UNSENT = """
            SELECT o.id, o.event_id, e.endpoint_id, ep.ordered
            FROM outbox o
            JOIN events e ON e.id = o.event_id
            JOIN endpoints ep ON ep.id = e.endpoint_id
            WHERE o.sent_at IS NULL
            ORDER BY o.id
            LIMIT ?
            FOR UPDATE OF o SKIP LOCKED
            """;

    private static final String MARK_SENT = """
            UPDATE outbox SET sent_at = now(), partition = ?
            WHERE id = ANY (?)
            """;

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final RabbitTemplate rabbit;
    private final ObjectMapper objectMapper;

    public OutboxRelay(JdbcTemplate jdbc,
                       TransactionTemplate tx,
                       RabbitTemplate rabbit,
                       ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.rabbit = rabbit;
        this.objectMapper = objectMapper;
    }

    // fixedDelay waits 100 ms after the previous run ends, so ticks never overlap.
    @Scheduled(fixedDelay = 100)
    public void tick() {
        try {
            Integer relayed = tx.execute(status -> relayBatch());
            if (relayed != null && relayed > 0) {
                log.debug("relayed {} outbox rows", relayed);
            }
        } catch (RuntimeException e) {
            // Rows stay unsent and locks are released on rollback; the next tick retries them.
            log.warn("relay tick failed: {}", e.getMessage());
        }
    }

    private int relayBatch() {
        List<OutboxRow> rows = jdbc.query(SELECT_UNSENT, (rs, i) -> new OutboxRow(
                rs.getLong("id"),
                rs.getObject("event_id", UUID.class),
                rs.getObject("endpoint_id", UUID.class),
                rs.getBoolean("ordered")
        ), BATCH_SIZE);

        if (rows.isEmpty()) {
            return 0;
        }

        // Publish all first, then wait: confirms arrive asynchronously, so waiting per message would serialise the batch.
        List<Published> published = new ArrayList<>(rows.size());
        for (OutboxRow row : rows) {
            published.add(publish(row));
        }

        List<Long> confirmed = awaitConfirms(published);

        if (!confirmed.isEmpty()) {
            jdbc.update(MARK_SENT, ps -> {
                ps.setString(1, RabbitTopology.PARTITION);
                ps.setArray(2, ps.getConnection().createArrayOf("bigint", confirmed.toArray()));
            });
        }
        return confirmed.size();
    }

    private Published publish(OutboxRow row) {
        RelayMessage body = new RelayMessage(row.eventId(), row.endpointId(), 1, row.ordered());

        Message message = MessageBuilder.withBody(toJson(body))
                .setContentType(MessageProperties.CONTENT_TYPE_JSON)
                .setDeliveryMode(MessageDeliveryMode.PERSISTENT)
                .setMessageId(row.eventId().toString())
                .build();

        CorrelationData correlation = new CorrelationData(row.outboxId().toString());
        rabbit.send(RabbitTopology.DELIVER_EXCHANGE, RabbitTopology.PARTITION, message, correlation);
        return new Published(row.outboxId(), correlation);
    }

    private List<Long> awaitConfirms(List<Published> published) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(CONFIRM_TIMEOUT_MS);
        List<Long> confirmed = new ArrayList<>(published.size());

        for (Published p : published) {
            try {
                long remaining = Math.max(0, deadline - System.nanoTime());
                CorrelationData.Confirm confirm = p.correlation().getFuture().get(remaining, TimeUnit.NANOSECONDS);

                // An ack with a return means the broker took it but no queue was bound, so it was dropped.
                if (confirm.isAck() && p.correlation().getReturned() == null) {
                    confirmed.add(p.outboxId());
                } else {
                    log.warn("outbox {} not confirmed: ack={} reason={} returned={}",
                            p.outboxId(), confirm.isAck(), confirm.getReason(), p.correlation().getReturned() != null);
                }
            } catch (TimeoutException e) {
                log.warn("outbox {} confirm timed out", p.outboxId());
            } catch (ExecutionException e) {
                log.warn("outbox {} confirm failed: {}", p.outboxId(), e.getCause().getMessage());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return confirmed;
    }

    private byte[] toJson(RelayMessage body) {
        try {
            return objectMapper.writeValueAsBytes(body);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cannot serialise relay message " + body.eventId(), e);
        }
    }

    private record OutboxRow(Long outboxId, UUID eventId, UUID endpointId, boolean ordered) {
    }

    private record Published(Long outboxId, CorrelationData correlation) {
    }
}
