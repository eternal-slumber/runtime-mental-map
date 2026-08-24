<?php

declare(strict_types=1);

namespace RuntimeMentalMap;

use Throwable;

final class RuntimeMap
{
    private static ?string $collectorUrl = null;
    private static ?string $traceId = null;
    private static string $framework = 'php';

    /** @var list<string> */
    private static array $stack = [];

    /** @var array<string, mixed>|null */
    private static ?array $requestSpan = null;

    /** @var list<array<string, mixed>|null> */
    private static array $autoFrames = [];

    public static function startRequest(
        string $method,
        string $path,
        string $framework,
        string $collectorUrl,
    ): void {
        self::reset();

        $spanId = self::id();
        self::$collectorUrl = rtrim($collectorUrl, '/');
        self::$traceId = self::id();
        self::$framework = $framework;
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

    public static function finishRequest(): void
    {
        if (self::$requestSpan === null) {
            return;
        }

        try {
            self::finishAndSend(self::$requestSpan);
        } finally {
            self::reset();
        }
    }

    public static function traceId(): ?string
    {
        return self::$traceId;
    }

    public static function enterAutoSpan(string $layer, string $class, string $method): void
    {
        if (self::$traceId === null) {
            self::$autoFrames[] = null;

            return;
        }

        $span = self::event(
            spanId: self::id(),
            parentId: self::currentSpanId(),
            kind: 'method',
            layer: $layer,
            name: $class.'::'.$method,
            class: $class,
            method: $method,
        );

        self::$stack[] = $span['span_id'];
        self::$autoFrames[] = $span;
    }

    public static function leaveAutoSpan(): void
    {
        $span = array_pop(self::$autoFrames);

        if (!is_array($span)) {
            return;
        }

        array_pop(self::$stack);
        self::finishAndSend($span);
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

    /** @param array<string, mixed> $span */
    private static function finishAndSend(array $span): void
    {
        $span['duration_ns'] = hrtime(true) - $span['_started_ns'];
        unset($span['_started_ns']);
        self::send($span);
    }

    /** @param array<string, mixed> $event */
    private static function send(array $event): void
    {
        if (self::$collectorUrl === null) {
            return;
        }

        try {
            $context = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => "Content-Type: application/json\r\nConnection: close",
                    'content' => json_encode($event, JSON_THROW_ON_ERROR),
                    'timeout' => 0.5,
                    'ignore_errors' => true,
                ],
            ]);
            $result = @file_get_contents(self::$collectorUrl.'/events', false, $context);
            $status = $http_response_header[0] ?? '';

            if ($result === false || !str_contains($status, ' 202 ')) {
                error_log(sprintf(
                    'RuntimeMap failed to send span %s: %s',
                    $event['span_id'],
                    $status ?: 'collector unavailable',
                ));
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

    private static function id(): string
    {
        return bin2hex(random_bytes(16));
    }

    private static function reset(): void
    {
        self::$collectorUrl = null;
        self::$traceId = null;
        self::$framework = 'php';
        self::$stack = [];
        self::$requestSpan = null;
        self::$autoFrames = [];
    }
}
