package com.hookrelay.ingest.endpoint.controller;

import com.hookrelay.ingest.endpoint.dto.CreateEndpointResponseDto;
import com.hookrelay.ingest.endpoint.dto.EndpointRequestDto;
import com.hookrelay.ingest.endpoint.dto.EndpointResponseDto;
import com.hookrelay.ingest.endpoint.service.EndpointService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/api/endpoint")
public class EndpointController {

    private final EndpointService endpointService;

   public EndpointController(EndpointService endpointService){
       this.endpointService = endpointService;
   }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public CreateEndpointResponseDto createEndpoint(@Valid @RequestBody EndpointRequestDto request) {
        return endpointService.createEndpoint(request);
    }

    @GetMapping("/{id}")
    @ResponseStatus(HttpStatus.OK)
    public EndpointResponseDto getEndpoint(@PathVariable UUID id) {
       return  endpointService.getEndpoint(id);
    }

    @PatchMapping("/{id}")
    @ResponseStatus(HttpStatus.OK)
    public EndpointResponseDto updateEndpoint(@PathVariable UUID id, @Valid @RequestBody EndpointRequestDto request) {
        return endpointService.updateEndpoint(id, request);
    }

}
