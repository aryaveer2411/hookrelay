package com.hookrelay.ingest.outbox.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * A queued hand-off of an event to the delivery pipeline.
 *
 * Written in the same transaction as the event it points at, so an event can never be
 * accepted without also being scheduled for delivery. The relay fills in sentAt and
 * partition once the message is safely published to the broker.
 */
@Entity
@Table(name = "outbox")
public class OutboxEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_id", nullable = false, updatable = false)
    private UUID eventId;

    @Column(name = "sent_at")
    private Instant sentAt;

    @Column(name = "partition")
    private String partition;

    protected OutboxEntity() {
    }

    public OutboxEntity(UUID eventId) {
        this.eventId = eventId;
    }

    public Long getId() {
        return id;
    }

    public UUID getEventId() {
        return eventId;
    }

    public Instant getSentAt() {
        return sentAt;
    }

    public String getPartition() {
        return partition;
    }
}
