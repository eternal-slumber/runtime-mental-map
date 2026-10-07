<?php

declare(strict_types=1);

namespace RuntimeMentalMap;

use Throwable;

final class RuntimeMap
{
    public const PROTOCOL_VERSION = 1;
    private const CONNECT_TIMEOUT_MS = 100;
    private const TOTAL_TIMEOUT_MS = 350;
    private const RETRY_AFTER_SECONDS = 10;

    private static float $retryAfter = 0;
    private static bool $transportWarningLogged = false;

    private static string $serviceName = 'php-app';

    private static ?string $collectorUrl = null;
    private static ?string $traceId = null;
    private static string $framework = 'php';

    /** @var list<array<string, mixed>> */
    private static array $events = [];

    /** @var list<string> */
    private static array $stack = [];

    /** @var array<string, mixed>|null */
    private static ?array $requestSpan = null;

    /** @var list<array<string, mixed>|null> */
    private static array $autoFrames = [];

    private static ?Throwable $requestException = null;

    public static function startRequest(
        string $method,
        string $path,
        string $framework,
        string $collectorUrl,
        string $serviceName = 'php-app',
        ?string $flowId = null,
        ?string $parentTraceId = null,
    ): void {
        self::reset();

        $spanId = self::id();
        self::$collectorUrl = rtrim($collectorUrl, '/');
        self::$traceId = self::id();
        self::$framework = $framework;
        self::$serviceName = $serviceName;
        self::$stack[] = $spanId;
        self::$requestSpan = self::event(
            spanId: $spanId,
            parentId: null,
            kind: 'request',
            layer: null,
            name: sprintf('%s %s', $method, $path ?: '/'),
            class: null,
            method: null,
        );
        self::$requestSpan['flow_id'] = $flowId;
        self::$requestSpan['parent_trace_id'] = $parentTraceId;
    }

    public static function finishRequest(int $httpStatus): void
    {
        if (self::$requestSpan === null) {
            return;
        }

        self::finishSpan(
            self::$requestSpan,
            self::$requestException,
            $httpStatus,
        );

        $collectorUrl = self::$collectorUrl;
        $events = self::$events;

        self::reset();
        self::sendBatch($collectorUrl, $events);
    }

    public static function recordException(Throwable $exception): void
    {
        if (
            self::$traceId !== null
            && self::$requestException === null
        ) {
            self::$requestException = $exception;
        }
    }

    public static function traceId(): ?string
    {
        return self::$traceId;
    }

    public static function enterSpan(
        string $kind,
        ?string $layer,
        string $name,
        ?string $class = null,
        ?string $method = null,
    ): void
    {
        if (self::$traceId === null) {
            self::$autoFrames[] = null;

            return;
        }

        $span = self::event(
            spanId: self::id(),
            parentId: self::currentSpanId(),
            kind: $kind,
            layer: $layer,
            name: $name,
            class: $class,
            method: $method,
        );

        self::$stack[] = $span['span_id'];
        self::$autoFrames[] = $span;
    }

    public static function leaveSpan(
        ?Throwable $exception = null,
    ): void
    {
        $span = array_pop(self::$autoFrames);

        if (!is_array($span)) {
            return;
        }

        array_pop(self::$stack);
        self::finishSpan($span, $exception);
    }

    public static function enterAutoSpan(
        string $layer,
        string $class,
        string $method,
    ): void {
        self::enterSpan(
            kind: 'method',
            layer: $layer,
            name: $class.'::'.$method,
            class: $class,
            method: $method,
        );
    }

    public static function leaveAutoSpan(
        ?Throwable $exception = null,
    ): void
    {
        self::leaveSpan($exception);
    }

    /**
     * @return array<string, mixed>
     */
    private static function event(
        string $spanId,
        ?string $parentId,
        string $kind,
        ?string $layer,
        string $name,
        ?string $class,
        ?string $method,
    ): array {
        return [
            'protocol_version' => self::PROTOCOL_VERSION,
            'service_name' => self::$serviceName,
            'trace_id' => self::$traceId,
            'span_id' => $spanId,
            'parent_id' => $parentId,
            'kind' => $kind,
            'runtime' => 'php',
            'framework' => self::$framework,
            'layer' => $layer,
            'name' => $name,
            'class' => $class,
            'method' => $method,
            'started_at_unix_us' => (int) (microtime(true) * 1_000_000),
            'duration_ns' => 0,
            '_started_ns' => hrtime(true),
        ];
    }

    /**
     * @param array<string, mixed> $span
     */
    private static function finishSpan(
        array $span,
        ?Throwable $exception = null,
        ?int $httpStatus = null,
    ): void {
        $span['duration_ns'] = hrtime(true) - $span['_started_ns'];
        unset($span['_started_ns']);

        $span['http_status'] = $httpStatus;
        $span['outcome'] = $httpStatus === null
            ? ($exception === null ? 'success' : 'exception')
            : self::httpOutcome($httpStatus, $exception);

        $span['error_type'] = $exception === null
            ? null
            : $exception::class;

        $span['error_message'] = $exception?->getMessage();
        $span['error_file'] = $exception?->getFile();
        $span['error_line'] = $exception?->getLine();

        self::$events[] = $span;
    }

    /**
     * @param list<array<string, mixed>> $events
     */
    private static function sendBatch(
        ?string $collectorUrl,
        array $events,
    ): void {
        if ($collectorUrl === null || $events === [] || microtime(true) < self::$retryAfter) {
            return;
        }

        try {
            $body = json_encode($events, JSON_THROW_ON_ERROR);
            if (self::postBatch($collectorUrl.'/events/batch', $body)) {
                self::$retryAfter = 0;
                self::$transportWarningLogged = false;
                return;
            }
        } catch (Throwable $exception) {
            // Tracing must never replace an application response or exception.
        }
        self::$retryAfter = microtime(true) + self::RETRY_AFTER_SECONDS;
        if (!self::$transportWarningLogged && getenv('MENTAL_MAP_DEBUG') === '1') {
            error_log('Runtime Mental Map: collector unavailable; retrying later');
            self::$transportWarningLogged = true;
        }
    }

    private static function postBatch(string $url, string $body): bool
    {
        if (function_exists('curl_init')) {
            $curl = curl_init($url);
            if ($curl === false) {
                return false;
            }
            try {
                curl_setopt_array($curl, [
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => $body,
                    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
                    CURLOPT_CONNECTTIMEOUT_MS => self::CONNECT_TIMEOUT_MS,
                    CURLOPT_TIMEOUT_MS => self::TOTAL_TIMEOUT_MS,
                    CURLOPT_RETURNTRANSFER => true,
                ]);
                return curl_exec($curl) !== false && curl_getinfo($curl, CURLINFO_RESPONSE_CODE) === 202;
            } finally {
                curl_close($curl);
            }
        }

        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nConnection: close",
            'content' => $body,
            'timeout' => self::TOTAL_TIMEOUT_MS / 1000,
            'ignore_errors' => true,
        ]]);
        $result = @file_get_contents($url, false, $context);
        return $result !== false && str_contains($http_response_header[0] ?? '', ' 202 ');
    }

    private static function currentSpanId(): ?string
    {
        $index = array_key_last(self::$stack);

        return $index === null ? null : self::$stack[$index];
    }

    private static function httpOutcome(
        int $status,
        ?Throwable $exception,
    ): string {
        if ($status < 400) {
            return 'success';
        }

        if ($status < 500) {
            return 'client_error';
        }

        return $exception === null
            ? 'server_error'
            : 'exception';
    }

    private static function id(): string
    {
        return bin2hex(random_bytes(16));
    }

    private static function reset(): void
    {
        self::$collectorUrl = null;
        self::$traceId = null;
        self::$framework = 'php';
        self::$events = [];
        self::$stack = [];
        self::$requestSpan = null;
        self::$autoFrames = [];
        self::$requestException = null;
        self::$serviceName = 'php-app';
    }
}
