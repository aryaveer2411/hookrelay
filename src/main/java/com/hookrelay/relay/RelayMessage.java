package com.hookrelay.relay;

import java.util.UUID;

/**
 * What travels through RabbitMQ: a pointer to the event, not the payload itself.
 */
public record RelayMessage(UUID eventId, UUID endpointId, int attempt, boolean ordered) {
}
