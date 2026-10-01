package com.hookrelay.common.logging;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingRequestWrapper;
import org.springframework.web.util.ContentCachingResponseWrapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * Logs one line per request and one per response, including bodies.
 *
 * Bodies are only available after the fact, so the request and response are wrapped in
 * caching wrappers: the wrapper keeps a copy of the bytes as they stream past, which is
 * the only way to read a body without consuming it before the controller sees it.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class RequestLoggingFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(RequestLoggingFilter.class);

    /** Matches "secret": "value" / "signature": "value" etc. so the value can be masked. */
    private static final Pattern SENSITIVE_JSON_FIELD = Pattern.compile(
            "(\"[^\"]*(?:secret|token|password|signature|apiKey)[^\"]*\"\\s*:\\s*\")([^\"]*)(\")",
            Pattern.CASE_INSENSITIVE);

    @Value("${hookrelay.logging.include-body:true}")
    private boolean includeBody;

    @Value("${hookrelay.logging.max-body-chars:2000}")
    private int maxBodyChars;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {

        ContentCachingRequestWrapper wrappedRequest = new ContentCachingRequestWrapper(request);
        ContentCachingResponseWrapper wrappedResponse = new ContentCachingResponseWrapper(response);

        long startedAt = System.nanoTime();
        String query = request.getQueryString() == null ? "" : "?" + request.getQueryString();

        try {
            filterChain.doFilter(wrappedRequest, wrappedResponse);
        } finally {
            long tookMs = (System.nanoTime() - startedAt) / 1_000_000;

            log.info("--> {} {}{}{}",
                    request.getMethod(),
                    request.getRequestURI(),
                    query,
                    bodySuffix("request", wrappedRequest.getContentAsByteArray()));

            log.info("<-- {} {}{} {} ({} ms){}",
                    request.getMethod(),
                    request.getRequestURI(),
                    query,
                    wrappedResponse.getStatus(),
                    tookMs,
                    bodySuffix("response", wrappedResponse.getContentAsByteArray()));

            // Mandatory: the wrapper held the bytes back, this writes them to the real response.
            wrappedResponse.copyBodyToResponse();
        }
    }

    private String bodySuffix(String label, byte[] content) {
        if (!includeBody || content.length == 0) {
            return "";
        }

        String body = new String(content, StandardCharsets.UTF_8);
        String masked = SENSITIVE_JSON_FIELD.matcher(body).replaceAll("$1***$3");
        String trimmed = masked.length() > maxBodyChars
                ? masked.substring(0, maxBodyChars) + "...(truncated)"
                : masked;

        return " " + label + "=" + trimmed.replaceAll("\\s*\\n\\s*", " ");
    }
}
