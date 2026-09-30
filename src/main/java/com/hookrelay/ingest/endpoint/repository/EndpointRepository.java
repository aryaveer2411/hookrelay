package com.hookrelay.ingest.endpoint.repository;

import com.hookrelay.ingest.endpoint.entity.EndpointEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface EndpointRepository extends JpaRepository<EndpointEntity, UUID> {
}