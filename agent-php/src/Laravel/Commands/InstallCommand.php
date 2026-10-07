<?php

declare(strict_types=1);

namespace RuntimeMentalMap\Laravel\Commands;

use Illuminate\Console\Command;

final class InstallCommand extends Command
{
    protected $signature = 'mental-map:install';
    protected $description = 'Prepare Runtime Mental Map for this Laravel application';

    public function handle(): int
    {
        $this->line('Runtime Mental Map');
        $this->line('✓ Laravel detected');
        $namespace = app()->getNamespace();
        $this->line('✓ App namespace: '.$namespace);

        $target = config_path('runtime-map.php');
        if (is_file($target)) {
            $this->line('✓ Existing configuration preserved: '.$target);
        } else {
            $source = dirname(__DIR__, 3).'/config/runtime-map.php';
            $contents = file_get_contents($source);
            if ($contents === false) {
                $this->error('Cannot read the package configuration');
                return self::FAILURE;
            }
            $contents = str_replace(
                "'namespace' => 'App\\\\',",
                "'namespace' => ".var_export($namespace, true).",",
                $contents,
            );
            if (file_put_contents($target, $contents, LOCK_EX) === false) {
                $this->error('Cannot write '.$target);
                return self::FAILURE;
            }
            $this->line('✓ Configuration created: '.$target);
        }

        $this->line('✓ Collector endpoint: '.config('runtime-map.collector_url'));
        $this->line('✓ Service name: '.config('runtime-map.service_name'));
        $this->line('Detected layers:');
        foreach ((array) config('runtime-map.layers', []) as $directory => $layer) {
            if (is_string($directory) && is_dir(app_path($directory))) {
                $this->line('  '.$layer.'  '.$namespace.str_replace('/', '\\', $directory).'\\');
            }
        }
        $this->line('Run: php artisan mental-map:doctor');
        return self::SUCCESS;
    }
}
