package com.hookrelay.ingest.endpoint.dto;

import java.util.UUID;

public record CreateEndpointResponseDto(UUID id,
                                        String inboundSecret,
                                        String outboundSecret) {
}
