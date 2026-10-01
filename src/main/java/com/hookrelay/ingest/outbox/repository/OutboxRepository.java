package com.hookrelay.ingest.outbox.repository;

import com.hookrelay.ingest.outbox.entity.OutboxEntity;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OutboxRepository extends JpaRepository<OutboxEntity, Long> {
}
