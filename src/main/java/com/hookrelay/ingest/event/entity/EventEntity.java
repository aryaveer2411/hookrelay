package com.hookrelay.ingest.event.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "events")
public class EventEntity {

    @Id
    private UUID id;

    @Column(name = "endpoint_id", nullable = false)
    private UUID endpointId;

    @Column(name = "external_id", nullable = false)
    private String externalId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "payload", nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Convert(converter = EventStatusConverter.class)
    @Column(name = "status", nullable = false)
    private EventStatus status;

    @Column(name = "received_at", nullable = false, updatable = false)
    private Instant receivedAt;

    protected EventEntity() {
    }

    public EventEntity(UUID id, UUID endpointId, String externalId, String payload) {
        this.id = id;
        this.endpointId = endpointId;
        this.externalId = externalId;
        this.payload = payload;
        this.status = EventStatus.PENDING;
        this.receivedAt = Instant.now();
    }

    public void markDelivered() {
        this.status = EventStatus.DELIVERED;
    }

    public void markDead() {
        this.status = EventStatus.DEAD;
    }

    public UUID getId() {
        return id;
    }

    public UUID getEndpointId() {
        return endpointId;
    }

    public String getExternalId() {
        return externalId;
    }

    public String getPayload() {
        return payload;
    }

    public EventStatus getStatus() {
        return status;
    }

    public Instant getReceivedAt() {
        return receivedAt;
    }
}
