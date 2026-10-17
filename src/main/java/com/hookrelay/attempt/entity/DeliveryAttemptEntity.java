package com.hookrelay.attempt.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.Immutable;

import java.time.Instant;
import java.util.UUID;

/**
 * One try at delivering an event, as the worker recorded it.
 *
 * Read-only here: the worker writes these rows with plain SQL, the API only reads them back.
 */
@Entity
@Immutable
@Table(name = "delivery_attempts")
public class DeliveryAttemptEntity {

    @Id
    private Long id;

    @Column(name = "event_id", nullable = false)
    private UUID eventId;

    @Column(name = "attempt", nullable = false)
    private int attempt;

    // Null when no response arrived (timeout, refused connection).
    @Column(name = "status_code")
    private Integer statusCode;

    @Column(name = "error")
    private String error;

    @Column(name = "latency_ms")
    private Integer latencyMs;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected DeliveryAttemptEntity() {
    }

    public Long getId() {
        return id;
    }

    public UUID getEventId() {
        return eventId;
    }

    public int getAttempt() {
        return attempt;
    }

    public Integer getStatusCode() {
        return statusCode;
    }

    public String getError() {
        return error;
    }

    public Integer getLatencyMs() {
        return latencyMs;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
