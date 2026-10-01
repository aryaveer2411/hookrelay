package com.hookrelay.ingest.event.entity;

/** Delivery lifecycle state of an event; values match the events.status CHECK constraint. */
public enum EventStatus {
    PENDING("pending"),
    DELIVERED("delivered"),
    DEAD("dead");

    private final String value;

    EventStatus(String value) {
        this.value = value;
    }

    public String getValue() {
        return value;
    }

    public static EventStatus fromValue(String value) {
        for (EventStatus status : values()) {
            if (status.value.equals(value)) {
                return status;
            }
        }
        throw new IllegalArgumentException("Unknown event status: " + value);
    }
}
