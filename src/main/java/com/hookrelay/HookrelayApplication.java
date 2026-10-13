package com.hookrelay;

import java.util.TimeZone;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class HookrelayApplication {

    public static void main(String[] args) {
        // pgjdbc sends JVM tz on connect; Windows "Asia/Calcutta" alias missing from postgres:16 tzdata
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        SpringApplication.run(HookrelayApplication.class, args);
    }
}
