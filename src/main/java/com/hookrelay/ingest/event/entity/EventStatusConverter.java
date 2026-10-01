package com.hookrelay.ingest.event.entity;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

/** Persists EventStatus as its lowercase DB value rather than the enum name. */
@Converter(autoApply = true)
public class EventStatusConverter implements AttributeConverter<EventStatus, String> {

    @Override
    public String convertToDatabaseColumn(EventStatus attribute) {
        return attribute == null ? null : attribute.getValue();
    }

    @Override
    public EventStatus convertToEntityAttribute(String dbData) {
        return dbData == null ? null : EventStatus.fromValue(dbData);
    }
}
