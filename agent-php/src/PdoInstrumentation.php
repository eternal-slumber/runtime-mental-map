<?php

declare(strict_types=1);

namespace RuntimeMentalMap;

use PDO;
use PDOStatement;
use Throwable;

final class PdoInstrumentation
{
    public static function register(): void
    {
        if (!function_exists('OpenTelemetry\\Instrumentation\\hook')) {
            return;
        }

        self::registerDirectQuery('query');
        self::registerDirectQuery('exec');
        self::registerStatementExecute();
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
                self::enterSql((string) ($params[0] ?? 'unknown'));
            },
            post: static function (
                mixed $object,
                array $params,
                mixed $returnValue,
                ?Throwable $exception,
            ) {
                RuntimeMap::leaveSpan($exception);
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

                self::enterSql($sql);
            },
            post: static function (
                mixed $object,
                array $params,
                mixed $returnValue,
                ?Throwable $exception,
            ) {
                RuntimeMap::leaveSpan($exception);
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
