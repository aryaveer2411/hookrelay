package com.hookrelay.ingest.endpoint.service;

import com.hookrelay.ingest.endpoint.dto.CreateEndpointResponseDto;
import com.hookrelay.ingest.endpoint.dto.EndpointRequestDto;
import com.hookrelay.ingest.endpoint.dto.EndpointResponseDto;
import com.hookrelay.ingest.endpoint.entity.EndpointEntity;
import com.hookrelay.ingest.endpoint.repository.EndpointRepository;
import com.hookrelay.security.SecretService;
import org.springframework.stereotype.Service;

import java.util.Objects;
import java.util.UUID;

@Service
public class EndpointService {

    private final EndpointRepository endpointRepository;
    private final SecretService secretService;

    public  EndpointService( EndpointRepository endpointRepository,
                             SecretService secretService       ){
        this.endpointRepository = endpointRepository;
        this.secretService = secretService;

    }


    public CreateEndpointResponseDto createEndpoint(EndpointRequestDto request) {
        if (request.name() == null || request.target_url() == null) {
            throw new RuntimeException("Name or TargetUrl is missing");
        }

        UUID endpointId = UUID.randomUUID();
        EndpointEntity endpoint = new EndpointEntity(
                endpointId,
                request.name(),
                request.target_url(),
                Objects.requireNonNullElse(request.ratePerSec(), 50),
                Objects.requireNonNullElse(request.ordered(), false)
        );

        endpointRepository.save(endpoint);

        String inboundSecret =
                secretService.generateInboundSecret(endpointId);

        String outboundSecret =
                secretService.generateOutboundSecret(endpointId);

        return new CreateEndpointResponseDto(
                new EndpointResponseDto(
                        endpoint.getId(),
                        endpoint.getName(),
                        endpoint.getTargetUrl(),
                        endpoint.getRatePerSec(),
                        endpoint.getOrdered(),
                        endpoint.getDisabledAt(),
                        endpoint.getCreatedAt()
                ),
                inboundSecret,
                outboundSecret
        );
    }

    public EndpointResponseDto getEndpoint(UUID id) {
        EndpointEntity endpoint = endpointRepository.findById(id).orElseThrow(()-> new RuntimeException("Not Found"));

        return new EndpointResponseDto(
                endpoint.getId(),
                endpoint.getName(),
                endpoint.getTargetUrl(),
                endpoint.getRatePerSec(),
                endpoint.getOrdered(),
                endpoint.getDisabledAt(),
                endpoint.getCreatedAt()
        );
    }

    public EndpointResponseDto updateEndpoint(UUID id, EndpointRequestDto request) {
        EndpointEntity endpoint = endpointRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("Endpoint not found"));
        endpoint.update(request.name(), request.target_url(), request.ratePerSec(), request.ordered());

        endpointRepository.save(endpoint);

        return new EndpointResponseDto(
                endpoint.getId(),
                endpoint.getName(),
                endpoint.getTargetUrl(),
                endpoint.getRatePerSec(),
                endpoint.getOrdered(),
                endpoint.getDisabledAt(),
                endpoint.getCreatedAt()
        );

    }
}
