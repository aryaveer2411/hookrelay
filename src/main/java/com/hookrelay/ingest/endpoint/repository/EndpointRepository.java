package com.hookrelay.ingest.endpoint.repository;

import com.hookrelay.ingest.endpoint.entity.EndpointEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.UUID;

public interface EndpointRepository extends JpaRepository<EndpointEntity, UUID> {

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = """
                    update endpoints
                    set disabled_at = :now
                    where id = :id
                      and disabled_at is null
                    """,
            nativeQuery = true
    )
    int disableIfEnabled(@Param("id") UUID id, @Param("now") Instant now);
}
