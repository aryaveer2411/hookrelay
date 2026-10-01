package com.hookrelay.ingest.event.repository;

import com.hookrelay.ingest.event.entity.EventEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public interface EventRepository extends JpaRepository<EventEntity, UUID> {

    Optional<EventEntity> findByEndpointIdAndExternalId(UUID endpointId, String externalId);

    /**
     * Inserts the event unless (endpoint_id, external_id) is already taken.
     *
     * Lets the unique index do the dedup without raising a constraint violation, which would
     * abort the surrounding transaction and leave no way to read the winning row back.
     *
     * @return 1 if this call stored the row, 0 if an event with the same ids already existed
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = """
                    insert into events (id, endpoint_id, external_id, payload, status, received_at)
                    values (:id, :endpointId, :externalId, cast(:payload as jsonb), :status, :receivedAt)
                    on conflict (endpoint_id, external_id) do nothing
                    """,
            nativeQuery = true
    )
    int insertIfAbsent(@Param("id") UUID id,
                       @Param("endpointId") UUID endpointId,
                       @Param("externalId") String externalId,
                       @Param("payload") String payload,
                       @Param("status") String status,
                       @Param("receivedAt") Instant receivedAt);
}
