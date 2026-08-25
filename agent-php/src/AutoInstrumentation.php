<?php

declare(strict_types=1);

namespace RuntimeMentalMap;

use ReflectionClass;
use Throwable;

final class AutoInstrumentation
{
    /**
     * @param array<string, string> $layers directory => layer
     */
    public static function register(
        string $sourceDirectory,
        array $layers = [
            'Controllers' => 'controller',
            'Services' => 'application',
            'Repositories' => 'infrastructure',
        ],
        string $namespace = 'App\\',
    ): void {
        if (!function_exists('OpenTelemetry\\Instrumentation\\hook')) {
            error_log('RuntimeMap: OpenTelemetry extension is unavailable');

            return;
        }

        foreach ($layers as $directory => $layer) {
            foreach (glob(rtrim($sourceDirectory, '/').'/'.$directory.'/*.php') ?: [] as $file) {
                $class = $namespace.str_replace('/', '\\', $directory).'\\'.pathinfo($file, PATHINFO_FILENAME);

                if (class_exists($class)) {
                    self::registerClass($class, $layer);
                }
            }
        }
    }

    /** @param class-string $class */
    private static function registerClass(string $class, string $layer): void
    {
        $reflection = new ReflectionClass($class);

        foreach ($reflection->getMethods() as $method) {
            if (
                $method->getDeclaringClass()->getName() !== $class
                || $method->isAbstract()
                || $method->isConstructor()
                || $method->isDestructor()
            ) {
                continue;
            }

            self::registerMethod($class, $method->getName(), $layer);
        }
    }

    /** @param class-string $class */
    private static function registerMethod(string $class, string $method, string $layer): void
    {
        $hook = 'OpenTelemetry\\Instrumentation\\hook';
        $hook(
            $class,
            $method,
            pre: static function (
                mixed $object,
                array $params,
                string $calledClass,
                string $calledMethod,
                ?string $filename,
                ?int $line,
            ) use ($layer): void {
                RuntimeMap::enterAutoSpan($layer, $calledClass, $calledMethod);
            },
            // No return type: returning null here would replace the original result.
            post: static function (
                mixed $object,
                array $params,
                mixed $returnValue,
                ?Throwable $exception,
            ) {
                RuntimeMap::leaveAutoSpan($exception);
            },
        );
    }
}
