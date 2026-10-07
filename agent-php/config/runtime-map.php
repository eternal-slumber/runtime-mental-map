<?php

declare(strict_types=1);

return [
    'enabled' => env(
        'MENTAL_MAP_ENABLED',
        env('RUNTIME_MAP_ENABLED', env('APP_ENV', 'production') === 'local'),
    ),

    'collector_url' => env(
        'MENTAL_MAP_COLLECTOR',
        env('RUNTIME_MAP_COLLECTOR_URL', 'http://127.0.0.1:9000'),
    ),

    'service_name' => env(
        'MENTAL_MAP_SERVICE_NAME',
        env('RUNTIME_MAP_SERVICE_NAME', env('APP_NAME', 'laravel-app')),
    ),

    'namespace' => 'App\\',

    'layers' => [
        'Http/Controllers' => 'controller',
        'Services' => 'application',
        'Actions' => 'application',
        'Application' => 'application',
        'Domain' => 'domain',
        'Repositories' => 'repository',
        'Infrastructure' => 'repository',
    ],

    'exclude_paths' => [],

    'exclude' => [],

    'debug' => env('MENTAL_MAP_DEBUG', false),
];
