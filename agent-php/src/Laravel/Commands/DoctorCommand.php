<?php

declare(strict_types=1);

namespace RuntimeMentalMap\Laravel\Commands;

use Illuminate\Console\Command;
use Illuminate\Contracts\Http\Kernel as KernelContract;
use RuntimeMentalMap\Diagnostics;
use RuntimeMentalMap\AutoInstrumentation;
use RuntimeMentalMap\PdoInstrumentation;
use RuntimeMentalMap\Laravel\RuntimeMapMiddleware;

final class DoctorCommand extends Command
{
    protected $signature = 'mental-map:doctor';
    protected $description = 'Check Runtime Mental Map integration';

    public function handle(KernelContract $kernel): int
    {
        $middleware = method_exists($kernel, 'getGlobalMiddleware')
            && in_array(RuntimeMapMiddleware::class, $kernel->getGlobalMiddleware(), true);
        $checks = Diagnostics::run(
            (array) config('runtime-map', []),
            app_path(),
            $middleware,
            AutoInstrumentation::isRegistered() && PdoInstrumentation::isRegistered(),
        );
        $this->line('Runtime Mental Map Doctor');
        $passed = true;
        foreach ($checks as $check) {
            $this->line(($check['ok'] ? '✓ ' : '✗ ').$check['label']);
            if (!$check['ok']) {
                $passed = false;
                if ($check['detail'] !== '') {
                    $this->line('  '.$check['detail']);
                }
            }
        }
        $this->line($passed ? 'Runtime Mental Map is ready.' : 'Fix the failed checks and run doctor again.');
        return $passed ? self::SUCCESS : self::FAILURE;
    }
}
