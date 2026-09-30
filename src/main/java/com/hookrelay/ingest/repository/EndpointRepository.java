package com.hookrelay.ingest.repository;

import com.hookrelay.ingest.entity.EndpointEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface EndpointRepository extends JpaRepository<EndpointEntity, UUID> {
}