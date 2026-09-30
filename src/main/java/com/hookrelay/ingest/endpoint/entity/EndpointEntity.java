package com.hookrelay.ingest.endpoint.entity;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "endpoints")
public class EndpointEntity {

    @Id
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(name = "target_url", nullable = false)
    private String targetUrl;

    @Column(name = "rate_per_sec", nullable = false)
    private Integer ratePerSec = 50;

    @Column(nullable = false)
    private Boolean ordered = false;

    @Column(name = "disabled_at")
    private Instant disabledAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public EndpointEntity(UUID id,String name, String targetUrl,Integer ratePerSec, Boolean ordered) {
        this.id = id;
        this.name = name;
        this.targetUrl = targetUrl;
        this.createdAt = Instant.now();
        this.ratePerSec = ratePerSec;
        this.ordered = ordered;
    }

    public UUID getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getTargetUrl() {
        return targetUrl;
    }

    public Integer getRatePerSec() {
        return ratePerSec;
    }

    public Boolean getOrdered() {
        return ordered;
    }

    public Instant getDisabledAt() {
        return disabledAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
