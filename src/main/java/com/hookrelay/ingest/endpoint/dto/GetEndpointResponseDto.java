package com.hookrelay.ingest.endpoint.dto;

import java.time.Instant;
import java.util.UUID;

public record GetEndpointResponseDto(UUID id,
                                     String name,
                                     String target_url,
                                     int rate_per_sec,
                                     boolean ordered,
                                     Instant disabledAt,
                                     Instant createdAt) {
}
