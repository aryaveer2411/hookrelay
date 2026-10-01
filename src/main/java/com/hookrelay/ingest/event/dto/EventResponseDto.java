package com.hookrelay.ingest.event.dto;

import com.hookrelay.ingest.event.entity.EventStatus;

import java.time.Instant;
import java.util.UUID;

public record EventResponseDto(UUID id,
                               UUID endpointId,
                               String externalId,
                               EventStatus status,
                               Instant receivedAt) {
}
