package com.hookrelay.worker;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DeliveryClassifierTest {

    @ParameterizedTest
    @ValueSource(ints = {200, 201, 202, 204, 299})
    void twoHundredsSucceed(int statusCode) {
        assertEquals(DeliveryOutcome.SUCCESS, DeliveryClassifier.classify(statusCode));
    }

    @ParameterizedTest
    @ValueSource(ints = {408, 429, 500, 502, 503, 504, 599})
    void temporaryFailuresRetry(int statusCode) {
        assertEquals(DeliveryOutcome.RETRY, DeliveryClassifier.classify(statusCode));
    }

    @Test
    void noResponseRetries() {
        assertEquals(DeliveryOutcome.RETRY, DeliveryClassifier.classify(null));
    }

    @ParameterizedTest
    @ValueSource(ints = {400, 401, 403, 404, 405, 409, 410, 422})
    void otherClientErrorsAreDead(int statusCode) {
        assertEquals(DeliveryOutcome.DEAD, DeliveryClassifier.classify(statusCode));
    }

    @ParameterizedTest
    @ValueSource(ints = {300, 301, 302, 307, 308})
    void redirectsAreDead(int statusCode) {
        assertEquals(DeliveryOutcome.DEAD, DeliveryClassifier.classify(statusCode));
    }
}
