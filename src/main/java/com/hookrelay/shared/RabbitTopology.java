package com.hookrelay.shared;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RabbitTopology {

    public static final String DELIVER_EXCHANGE = "deliver.exchange";
    // Single partition until the hash ring lands; then this becomes ring.partitionFor(endpointId).
    public static final String PARTITION = "p0";
    public static final String DELIVER_QUEUE = "deliver." + PARTITION;
    public static final String RETRY_QUEUE = "retry.10s";
    public static final String DEAD_QUEUE = "dead.q";

    private static final int RETRY_DELAY_MS = 10_000;

    @Bean
    public DirectExchange deliverExchange() {
        return new DirectExchange(DELIVER_EXCHANGE);
    }

    @Bean
    public Queue deliverQueue() {
        return QueueBuilder.durable(DELIVER_QUEUE).build();
    }

    @Bean
    public Binding deliverBinding(Queue deliverQueue, DirectExchange deliverExchange) {
        return BindingBuilder.bind(deliverQueue).to(deliverExchange).with(PARTITION);
    }

    @Bean
    public Queue retryQueue() {
        return QueueBuilder.durable(RETRY_QUEUE)
                .ttl(RETRY_DELAY_MS)
                .deadLetterExchange(DELIVER_EXCHANGE)
                // Without this the expired message keeps routing key "retry.10s", which nothing binds.
                .deadLetterRoutingKey(PARTITION)
                .build();
    }

    @Bean
    public Queue deadQueue() {
        return QueueBuilder.durable(DEAD_QUEUE).build();
    }
}
