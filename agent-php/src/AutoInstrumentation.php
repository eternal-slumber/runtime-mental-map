<?php

declare(strict_types=1);

namespace RuntimeMentalMap;

use FilesystemIterator;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use ReflectionClass;
use SplFileInfo;
use Throwable;

final class AutoInstrumentation
{
    /**
     * @param array<string, string> $layers directory => layer
     * @param list<string> $exclude classes or namespace prefixes
     */
    public static function register(
        string $sourceDirectory,
        array $layers = [
            'Controllers' => 'controller',
            'Services' => 'application',
            'Repositories' => 'infrastructure',
        ],
        string $namespace = 'App\\',
        array $exclude = [],
    ): void {
        if (!function_exists('OpenTelemetry\\Instrumentation\\hook')) {
            error_log('RuntimeMap: OpenTelemetry extension is unavailable');

            return;
        }

        $sourceDirectory = realpath($sourceDirectory);

        if ($sourceDirectory === false) {
            error_log('RuntimeMap: source directory does not exist');

            return;
        }

        $sourceDirectory = str_replace(
            '\\',
            '/',
            $sourceDirectory,
        );

        foreach ($layers as $directory => $layer) {
            $layerDirectory = $sourceDirectory
                . '/'
                . trim($directory, '/');

            foreach (self::phpFiles($layerDirectory) as $file) {
                $relativePath = substr(
                    $file,
                    strlen($sourceDirectory) + 1,
                    -4,
                );

                $class = $namespace . str_replace(
                    '/',
                    '\\',
                    $relativePath,
                );

                if (
                    !self::isExcluded($class, $exclude)
                    && class_exists($class)
                ) {
                    self::registerClass($class, $layer);
                }
            }
        }
    }

    /**
     * @return iterable<string>
     */
    private static function phpFiles(
        string $directory,
    ): iterable {
        if (!is_dir($directory)) {
            return;
        }

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator(
                $directory,
                FilesystemIterator::SKIP_DOTS,
            )
        );

        foreach ($iterator as $file) {
            if (
                !$file instanceof SplFileInfo
                || !$file->isFile()
                || $file->getExtension() !== 'php'
            ) {
                continue;
            }

            yield str_replace(
                '\\',
                '/',
                $file->getPathname(),
            );
        }
    }

    /**
     * @param list<string> $exclude
     */
    private static function isExcluded(
        string $class,
        array $exclude,
    ): bool {
        foreach ($exclude as $excluded) {
            $excluded = rtrim($excluded, '\\');

            if (
                $class === $excluded
                || str_starts_with($class, $excluded . '\\')
            ) {
                return true;
            }
        }

        return false;
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
