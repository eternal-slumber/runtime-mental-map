<?php

declare(strict_types=1);

namespace RuntimeMentalMap\Laravel;

use Illuminate\Contracts\Http\Kernel as KernelContract;
use Illuminate\Foundation\Http\Kernel;
use Illuminate\Support\ServiceProvider;
use RuntimeMentalMap\AutoInstrumentation;
use RuntimeMentalMap\PdoInstrumentation;

final class RuntimeMapServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(
            $this->configPath(),
            'runtime-map',
        );
    }

    public function boot(
        KernelContract $kernel,
    ): void
    {
        if ($this->app->runningInConsole()) {
            $this->publishes([
                $this->configPath()
                    => config_path('runtime-map.php'),
            ], 'runtime-map-config');
        }

        if (!config('runtime-map.enabled', false)) {
            return;
        }

        if ($kernel instanceof Kernel) {
            $kernel->prependMiddleware(
                RuntimeMapMiddleware::class,
            );
        }

        AutoInstrumentation::register(
            sourceDirectory: app_path(),
            layers: (array) config(
                'runtime-map.layers',
                [],
            ),
            namespace: (string) config(
                'runtime-map.namespace',
                'App\\',
            ),
            exclude: (array) config(
                'runtime-map.exclude',
                [],
            ),
        );

        PdoInstrumentation::register();
    }

    private function configPath(): string
    {
        return dirname(__DIR__, 2)
            .'/config/runtime-map.php';
    }
}