<?php

declare(strict_types=1);

namespace RuntimeMentalMap\Slim;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use RuntimeMentalMap\RuntimeMap;
use RuntimeMentalMap\AutoInstrumentation;
use RuntimeMentalMap\PdoInstrumentation;
use Throwable;

final readonly class RuntimeMapMiddleware implements MiddlewareInterface
{
    public function __construct(
        private string $collectorUrl,
        private string $serviceName = 'php-app',
        private bool $enabled = true,
    ) {}

    /** @param array<string, mixed> $config */
    public static function fromConfig(array $config): self
    {
        if (($config['enabled'] ?? true) === true) {
            try {
                AutoInstrumentation::register(
                    (string) ($config['source_directory'] ?? getcwd().'/src'),
                    (array) ($config['layers'] ?? []),
                    (string) ($config['namespace'] ?? 'App\\'),
                    (array) ($config['exclude'] ?? []),
                );
                PdoInstrumentation::register();
            } catch (Throwable $exception) {
                // The application can still run without instrumentation.
            }
        }
        return new self(
            (string) ($config['collector_url'] ?? 'http://127.0.0.1:9000'),
            (string) ($config['service_name'] ?? 'php-app'),
            ($config['enabled'] ?? true) === true,
        );
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        if (!$this->enabled) {
            return $handler->handle($request);
        }
        $flowId = trim(
            $request->getHeaderLine('X-Runtime-Flow-Id'),
        );
        $parentTraceId = trim(
            $request->getHeaderLine('X-Runtime-Parent-Trace-Id'),
        );

        try {
            RuntimeMap::startRequest(
                method: $request->getMethod(),
                path: $request->getUri()->getPath(),
                framework: 'slim',
                collectorUrl: $this->collectorUrl,
                serviceName: $this->serviceName,
                flowId: $flowId !== '' ? $flowId : null,
                parentTraceId: $parentTraceId !== ''
                    ? $parentTraceId
                    : null,
            );
        } catch (Throwable $exception) {
            return $handler->handle($request);
        }

        $status = 500;

        try {
            $response = $handler->handle($request);
            $status = $response->getStatusCode();
            $traceId = RuntimeMap::traceId();

            return $traceId === null
                ? $response
                : $response->withHeader(
                    'X-Runtime-Trace-Id',
                    $traceId,
                );
        } catch (Throwable $exception) {
            RuntimeMap::recordException($exception);
            throw $exception;
        } finally {
            try {
                RuntimeMap::finishRequest($status);
            } catch (Throwable $exception) {
                // Tracing must not replace the application's response or exception.
            }
        }
    }
}
