package com.hookrelay.security;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

@Service
public class SecretService {

    private static final String HMAC_ALGORITHM = "HmacSHA256";

    /**
     * How far a webhook timestamp may drift from now before it is treated as a replay.
     */
    private static final Duration REPLAY_TOLERANCE = Duration.ofMinutes(5);

    private final String masterKey;

    public SecretService(
            @Value("${hookrelay.secret-key}") String masterKey
    ) {
        this.masterKey = masterKey;
    }

    /**
     * Generates the inbound secret for an endpoint.
     *
     * The secret is derived from:
     * master key + endpoint ID + "inbound"
     */
    public String generateInboundSecret(UUID endpointId) {
        return generateSecret(endpointId, "inbound");
    }

    /**
     * Generates the outbound secret for an endpoint.
     *
     * The secret is derived from:
     * master key + endpoint ID + "outbound"
     */
    public String generateOutboundSecret(UUID endpointId) {
        return generateSecret(endpointId, "outbound");
    }

    /**
     * Signs a webhook over "<epochSeconds>:<endpointId>:<body>".
     * <p>
     * The timestamp is part of the signed data so a captured request cannot be
     * replayed later; the caller must send it alongside the signature so the
     * receiver can recompute the same string.
     */
    public String signWebhook(UUID endpointId, String type, String requestBody, Instant timestamp) {
        String secret = generateSecret(endpointId, type);

        return hmac(secret, timestamp.getEpochSecond() + ":" + endpointId + ":" + requestBody);
    }

    /**
     * Verifies a signature and rejects anything outside the replay tolerance window.
     */
    public boolean verifyWebhook(
            UUID endpointId,
            String type,
            String requestBody,
            Instant timestamp,
            String signature
    ) {
        if (signature == null || timestamp == null) {
            return false;
        }

        if (Duration.between(timestamp, Instant.now()).abs().compareTo(REPLAY_TOLERANCE) > 0) {
            return false;
        }

        String expected = signWebhook(endpointId, type, requestBody, timestamp);

        byte[] expectedBytes = decode(expected);
        byte[] providedBytes = decode(signature);

        if (providedBytes == null) {
            return false;
        }

        return MessageDigest.isEqual(expectedBytes, providedBytes);
    }

    /**
     * Decodes a url-safe Base64 signature, returning null when the caller sent
     * something that is not valid Base64 at all.
     */
    private byte[] decode(String signature) {
        try {
            return Base64.getUrlDecoder().decode(signature);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private String generateSecret(UUID endpointId, String type) {
        String data = endpointId + ":" + type;

        return hmac(masterKey, data);
    }

    private String hmac(String key, String data) {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);

            SecretKeySpec secretKey = new SecretKeySpec(
                    key.getBytes(StandardCharsets.UTF_8),
                    HMAC_ALGORITHM
            );

            mac.init(secretKey);

            byte[] hash = mac.doFinal(
                    data.getBytes(StandardCharsets.UTF_8)
            );

            return Base64.getUrlEncoder()
                    .withoutPadding()
                    .encodeToString(hash);

        } catch (Exception e) {
            throw new IllegalStateException("Failed to generate HMAC", e);
        }
    }
}
