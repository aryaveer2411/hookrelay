package com.hookrelay.ingest.endpoint.dto;

public record CreateEndpointResponseDto(EndpointResponseDto endpointResponseDto,
                                        String inboundSecret,
                                        String outboundSecret) {
}
