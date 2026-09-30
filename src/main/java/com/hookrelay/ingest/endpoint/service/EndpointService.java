package com.hookrelay.ingest.endpoint.service;

import com.hookrelay.ingest.endpoint.dto.CreateEndpointRequestDto;
import com.hookrelay.ingest.endpoint.dto.CreateEndpointResponseDto;
import com.hookrelay.ingest.endpoint.dto.GetEndpointResponseDto;
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


    public CreateEndpointResponseDto createEndpoint (CreateEndpointRequestDto request){
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
                endpointId,
                inboundSecret,
                outboundSecret
        );
    }

    public GetEndpointResponseDto getEndpoint(UUID id){
        EndpointEntity endpoint = endpointRepository.findById(id).orElseThrow(()-> new RuntimeException("Not Found"));

        return new GetEndpointResponseDto(
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
