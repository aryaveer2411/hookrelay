package com.hookrelay.attempt.repository;

import com.hookrelay.attempt.entity.DeliveryAttemptEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface DeliveryAttemptRepository extends JpaRepository<DeliveryAttemptEntity, Long> {

    // Served by the attempts_by_event (event_id, attempt) index; id breaks ties between redelivered duplicates.
    List<DeliveryAttemptEntity> findByEventIdOrderByAttemptAscIdAsc(UUID eventId);
}
