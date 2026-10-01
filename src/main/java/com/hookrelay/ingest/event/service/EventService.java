package com.hookrelay.ingest.event.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hookrelay.ingest.endpoint.entity.EndpointEntity;
import com.hookrelay.ingest.endpoint.repository.EndpointRepository;
import com.hookrelay.ingest.event.dto.CreateEventRequestDto;
import com.hookrelay.ingest.event.dto.EventResponseDto;
import com.hookrelay.ingest.event.entity.EventEntity;
import com.hookrelay.ingest.event.repository.EventRepository;
import com.hookrelay.ingest.outbox.entity.OutboxEntity;
import com.hookrelay.ingest.outbox.repository.OutboxRepository;
import com.hookrelay.security.SecretService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.UUID;

@Service
public class EventService {

    private static final String INBOUND = "inbound";

    private final EventRepository eventRepository;
    private final OutboxRepository outboxRepository;
    private final EndpointRepository endpointRepository;
    private final SecretService secretService;
    private final ObjectMapper objectMapper;

    public EventService(EventRepository eventRepository,
                        OutboxRepository outboxRepository,
                        EndpointRepository endpointRepository,
                        SecretService secretService,
                        ObjectMapper objectMapper) {
        this.eventRepository = eventRepository;
        this.outboxRepository = outboxRepository;
        this.endpointRepository = endpointRepository;
        this.secretService = secretService;
        this.objectMapper = objectMapper;
    }

    /**
     * Accepts a signed inbound webhook and stores it as a pending event.
     *
     * The raw body is required verbatim: the signature was computed over those exact
     * bytes, so re-serialising a parsed object would change the text and never match.
     *
     * The event and its outbox row are written in one transaction, so an accepted event is
     * always scheduled for delivery; publishing to the broker is the relay's job, not ours.
     */
    @Transactional
    public EventResponseDto ingestEvent(String rawBody, Instant timestamp, String signature) {
        CreateEventRequestDto request = parse(rawBody);

        if (request.endpointId() == null || request.externalId() == null || request.payload() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "endpointId, externalId and payload are required");
        }

        // Verified before any lookup so an unsigned caller cannot probe which endpoints exist.
        boolean verified = secretService.verifyWebhook(
                request.endpointId(),
                INBOUND,
                rawBody,
                timestamp,
                signature
        );

        if (!verified) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid signature");
        }

        EndpointEntity endpoint = endpointRepository.findById(request.endpointId())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Endpoint not found"));

        if (endpoint.getDisabledAt() != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Endpoint is disabled");
        }

        // Insert-first: the unique index is the dedup, so a retry costs one round trip, not two.
        return save(request);
    }

    private EventResponseDto save(CreateEventRequestDto request) {
        EventEntity event = new EventEntity(
                UUID.randomUUID(),
                request.endpointId(),
                request.externalId(),
                request.payload().toString()
        );

        int inserted = eventRepository.insertIfAbsent(
                event.getId(),
                event.getEndpointId(),
                event.getExternalId(),
                event.getPayload(),
                event.getStatus().getValue(),
                event.getReceivedAt()
        );

        if (inserted == 0) {
            // This event was already stored, by an earlier retry or a concurrent delivery.
            // Return the stored row so the sender sees the same answer every time.
            return eventRepository
                    .findByEndpointIdAndExternalId(request.endpointId(), request.externalId())
                    .map(this::toResponse)
                    .orElseThrow(() -> new IllegalStateException(
                            "Insert conflicted but no stored event found for endpoint "
                                    + request.endpointId() + " and externalId " + request.externalId()));
        }

        // Only a genuinely new event is queued. Enqueuing on a duplicate would deliver the
        // same webhook to the customer twice, undoing the dedup we just did.
        outboxRepository.save(new OutboxEntity(event.getId()));

        return toResponse(event);
    }

    private CreateEventRequestDto parse(String rawBody) {
        try {
            return objectMapper.readValue(rawBody, CreateEventRequestDto.class);
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Malformed request body");
        }
    }

    private EventResponseDto toResponse(EventEntity event) {
        return new EventResponseDto(
                event.getId(),
                event.getEndpointId(),
                event.getExternalId(),
                event.getStatus(),
                event.getReceivedAt()
        );
    }
}
