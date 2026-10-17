package com.hookrelay.ingest.event.dto;

import com.hookrelay.ingest.event.entity.EventStatus;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** One event plus every delivery attempt, oldest first. */
public record EventDetailResponseDto(UUID id,
                                     UUID endpointId,
                                     String externalId,
                                     EventStatus status,
                                     Instant receivedAt,
                                     List<DeliveryAttemptDto> attempts) {
}
