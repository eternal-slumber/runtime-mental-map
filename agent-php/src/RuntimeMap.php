<?php

declare(strict_types=1);

namespace RuntimeMentalMap;

use Throwable;

final class RuntimeMap
{
    private const PROTOCOL_VERSION = 1;

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
        if ($collectorUrl === null || $events === []) {
            return;
        }

        try {
            $context = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => "Content-Type: application/json\r\nConnection: close",
                    'content' => json_encode($events, JSON_THROW_ON_ERROR),
                    'timeout' => 1.0,
                    'ignore_errors' => true,
                ],
            ]);
            $result = @file_get_contents(
                $collectorUrl.'/events/batch',
                false,
                $context,
            );
            $status = $http_response_header[0] ?? '';

            if ($result === false || !str_contains($status, ' 202 ')) {
                error_log('RuntimeMap failed to send batch: '.($status ?: 'collector unavailable'));
            }
        } catch (Throwable $exception) {
            error_log('RuntimeMap error: '.$exception->getMessage());
        }
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
