<?php

declare(strict_types=1);

namespace RuntimeMentalMap;

use PDO;
use PDOStatement;
use Throwable;

final class PdoInstrumentation
{
    private static bool $registered = false;

    public static function isRegistered(): bool
    {
        return self::$registered;
    }

    public static function register(): void
    {
        if (!function_exists('OpenTelemetry\\Instrumentation\\hook')) {
            return;
        }

        self::registerDirectQuery('query');
        self::registerDirectQuery('exec');
        self::registerStatementExecute();
        self::$registered = true;
    }

    private static function registerDirectQuery(string $method): void
    {
        $hook = 'OpenTelemetry\\Instrumentation\\hook';

        $hook(
            PDO::class,
            $method,
            pre: static function (
                mixed $object,
                array $params,
            ): void {
                try {
                    self::enterSql((string) ($params[0] ?? 'unknown'));
                } catch (Throwable $exception) {
                    // SQL execution must proceed without tracing.
                }
            },
            post: static function (
                mixed $object,
                array $params,
                mixed $returnValue,
                ?Throwable $exception,
            ) {
                try {
                    RuntimeMap::leaveSpan($exception);
                } catch (Throwable $tracingError) {
                    // Preserve the database result or exception.
                }
            },
        );
    }

    private static function registerStatementExecute(): void
    {
        $hook = 'OpenTelemetry\\Instrumentation\\hook';

        $hook(
            PDOStatement::class,
            'execute',
            pre: static function (
                mixed $object,
                array $params,
            ): void {
                $sql = $object instanceof PDOStatement
                    ? $object->queryString
                    : 'unknown';

                try {
                    self::enterSql($sql);
                } catch (Throwable $exception) {
                    // SQL execution must proceed without tracing.
                }
            },
            post: static function (
                mixed $object,
                array $params,
                mixed $returnValue,
                ?Throwable $exception,
            ) {
                try {
                    RuntimeMap::leaveSpan($exception);
                } catch (Throwable $tracingError) {
                    // Preserve the database result or exception.
                }
            },
        );
    }

    private static function enterSql(string $statement): void
    {
        $statement = preg_replace('/\s+/', ' ', trim($statement))
            ?: 'unknown';

        RuntimeMap::enterSpan(
            kind: 'sql',
            layer: 'infrastructure',
            name: 'SQL '.substr($statement, 0, 300),
        );
    }
}
