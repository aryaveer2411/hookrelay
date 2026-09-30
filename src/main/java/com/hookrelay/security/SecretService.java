package com.hookrelay.security;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

@Service
public class SecretService {

    private static final String HMAC_ALGORITHM = "HmacSHA256";

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

    public String signWebhook(UUID endpointId, String type, String requestBody) {
        String secret = generateSecret(endpointId, type);

        if ("inbound".equals(type)) {
            return hmac(secret, endpointId.toString());
        }

        if ("outbound".equals(type)) {
            return hmac(secret, endpointId + ":" + requestBody);
        }

        throw new IllegalArgumentException("Invalid webhook type");
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