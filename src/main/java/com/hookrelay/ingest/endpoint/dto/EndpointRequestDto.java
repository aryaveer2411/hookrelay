package com.hookrelay.ingest.endpoint.dto;

public record EndpointRequestDto(
        String name,
        String target_url,
        Integer ratePerSec,
        Boolean ordered
) {
}
