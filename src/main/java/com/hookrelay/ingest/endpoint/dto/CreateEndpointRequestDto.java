package com.hookrelay.ingest.endpoint.dto;

import jakarta.validation.constraints.NotBlank;

public record CreateEndpointRequestDto(
        @NotBlank
        String name,

        @NotBlank
        String target_url,


        Integer ratePerSec,

        Boolean ordered
) {
}
