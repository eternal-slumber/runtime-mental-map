<?php

declare(strict_types=1);

namespace RuntimeMentalMap\Slim;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use RuntimeMentalMap\RuntimeMap;
use Throwable;

final readonly class RuntimeMapMiddleware implements MiddlewareInterface
{
    public function __construct(private string $collectorUrl) {}

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        RuntimeMap::startRequest(
            method: $request->getMethod(),
            path: $request->getUri()->getPath(),
            framework: 'slim',
            collectorUrl: $this->collectorUrl,
        );

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
            RuntimeMap::finishRequest($status);
        }
    }
}
