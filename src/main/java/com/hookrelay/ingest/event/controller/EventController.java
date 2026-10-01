package com.hookrelay.ingest.event.controller;

import com.hookrelay.ingest.event.dto.EventResponseDto;
import com.hookrelay.ingest.event.service.EventService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;

@RestController
@RequestMapping("/api/event")
public class EventController {

    public static final String TIMESTAMP_HEADER = "X-Hookrelay-Timestamp";
    public static final String SIGNATURE_HEADER = "X-Hookrelay-Signature";

    private final EventService eventService;

    public EventController(EventService eventService) {
        this.eventService = eventService;
    }

    /**
     * Takes the body as a raw String so the signature can be checked against the exact
     * bytes the caller signed; the service parses it after verification.
     */
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public EventResponseDto ingestEvent(
            @RequestHeader(TIMESTAMP_HEADER) long timestamp,
            @RequestHeader(SIGNATURE_HEADER) String signature,
            @RequestBody String rawBody
    ) {
        return eventService.ingestEvent(rawBody, Instant.ofEpochSecond(timestamp), signature);
    }
}
