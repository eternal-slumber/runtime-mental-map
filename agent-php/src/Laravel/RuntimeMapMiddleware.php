<?php

declare(strict_types=1);

namespace RuntimeMentalMap\Laravel;

use Closure;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use RuntimeMentalMap\RuntimeMap;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

final class RuntimeMapMiddleware
{
    public function handle(
        Request $request,
        Closure $next,
    ): Response {
        $path = $request->getPathInfo();

        if (
            !config('runtime-map.enabled', false)
            || in_array(
                $path,
                (array) config('runtime-map.exclude_paths', []),
                true,
            )
        ) {
            return $next($request);
        }

        RuntimeMap::startRequest(
            method: $request->getMethod(),
            path: $path,
            framework: 'laravel',
            collectorUrl: (string) config(
                'runtime-map.collector_url',
                'http://127.0.0.1:9000',
            ),
            serviceName: (string) config(
                'runtime-map.service_name',
                'laravel-app',
            ),
        );

        $status = 500;

        try {
            /** @var Response $response */
            $response = $next($request);

            $status = $response->getStatusCode();
            $traceId = RuntimeMap::traceId();

            if ($traceId !== null) {
                $response->headers->set(
                    'X-Runtime-Trace-Id',
                    $traceId,
                );
            }

            return $response;
        } catch (Throwable $exception) {
            $status = $this->exceptionStatus($exception);

            RuntimeMap::recordException($exception);

            throw $exception;
        } finally {
            RuntimeMap::finishRequest($status);
        }
    }

    private function exceptionStatus(
        Throwable $exception,
    ): int {
        return match (true) {
            $exception instanceof HttpResponseException
                => $exception->getResponse()->getStatusCode(),

            $exception instanceof ValidationException
                => $exception->status,

            $exception instanceof HttpExceptionInterface
                => $exception->getStatusCode(),

            default => 500,
        };
    }
}
