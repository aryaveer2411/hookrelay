package com.hookrelay.ingest.event.dto;

import java.time.Instant;

public record DeliveryAttemptDto(int attempt,
                                 Integer statusCode,
                                 String error,
                                 Integer latencyMs,
                                 Instant createdAt) {
}
