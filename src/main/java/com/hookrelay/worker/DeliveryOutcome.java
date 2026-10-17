package com.hookrelay.worker;

/** What a single delivery attempt means for the event. */
public enum DeliveryOutcome {
    /** The target took it; the event is delivered. */
    SUCCESS,
    /** A temporary failure; a later attempt may succeed. */
    RETRY,
    /** A permanent failure; retrying would only repeat it. */
    DEAD
}
