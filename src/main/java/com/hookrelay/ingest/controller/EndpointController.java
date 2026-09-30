package com.hookrelay.ingest.controller;

import com.hookrelay.ingest.dto.CreateEndpointRequestDto;
import com.hookrelay.ingest.dto.CreateEndpointResponseDto;
import com.hookrelay.ingest.dto.GetEndpointResponseDto;
import com.hookrelay.ingest.service.EndpointService;
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
    public CreateEndpointResponseDto createEndpoint(@Valid @RequestBody CreateEndpointRequestDto request){
        return endpointService.createEndpoint(request);
    }

    @GetMapping("/{id}")
    @ResponseStatus(HttpStatus.OK)
    public GetEndpointResponseDto getEndpoint(@PathVariable UUID id){
       return  endpointService.getEndpoint(id);
    }

}
