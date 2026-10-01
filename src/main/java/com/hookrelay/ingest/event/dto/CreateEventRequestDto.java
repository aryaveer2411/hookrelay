package com.hookrelay.ingest.event.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.util.UUID;

public record CreateEventRequestDto(
        @NotNull UUID endpointId,
        @NotBlank String externalId,
        @NotNull JsonNode payload
) {
}
