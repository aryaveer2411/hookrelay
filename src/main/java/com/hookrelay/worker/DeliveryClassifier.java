package com.hookrelay.worker;

/**
 * Maps the result of one delivery attempt to an outcome.
 *
 * Pure on purpose: no I/O and no state, so every branch is covered by a plain unit test.
 */
public final class DeliveryClassifier {

    private DeliveryClassifier() {
    }

    /**
     * @param statusCode the target's HTTP status, or null when no response arrived (timeout, refused connection)
     */
    public static DeliveryOutcome classify(Integer statusCode) {
        // No answer at all is usually a target that is down or slow right now.
        if (statusCode == null) {
            return DeliveryOutcome.RETRY;
        }
        if (statusCode >= 200 && statusCode < 300) {
            return DeliveryOutcome.SUCCESS;
        }
        // Timed out on their side, rate limiting us, or broken on their side: all can clear up later.
        if (statusCode == 408 || statusCode == 429 || statusCode >= 500) {
            return DeliveryOutcome.RETRY;
        }
        // Every other 3xx/4xx is an answer about the request itself, which a retry sends unchanged.
        return DeliveryOutcome.DEAD;
    }
}
