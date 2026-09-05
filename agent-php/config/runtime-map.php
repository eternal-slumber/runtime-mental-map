<?php

declare(strict_types=1);

return [
    'enabled' => env(
        'RUNTIME_MAP_ENABLED',
        env('APP_ENV', 'production') === 'local',
    ),

    'collector_url' => env(
        'RUNTIME_MAP_COLLECTOR_URL',
        'http://127.0.0.1:9000',
    ),

    'service_name' => env(
        'RUNTIME_MAP_SERVICE_NAME',
        env('APP_NAME', 'laravel-app'),
    ),

    'namespace' => 'App\\',

    'layers' => [
        'Http/Controllers' => 'controller',
        'Services' => 'application',
        'Domain' => 'domain',
        'Repositories' => 'infrastructure',
    ],

    'exclude_paths' => [],

    'exclude' => [],
];
