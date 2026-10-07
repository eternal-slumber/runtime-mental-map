<?php

declare(strict_types=1);

namespace RuntimeMentalMap;

final class Diagnostics
{
    /**
     * @param array<string, mixed> $config
     * @return list<array{ok: bool, label: string, detail: string}>
     */
    public static function run(array $config, string $sourceDirectory, ?bool $middlewareRegistered = null, ?bool $instrumentationReady = null): array
    {
        $checks = [];
        $add = static function (bool $ok, string $label, string $detail = '') use (&$checks): void {
            $checks[] = compact('ok', 'label', 'detail');
        };

        $add(version_compare(PHP_VERSION, '8.2.0', '>='), 'PHP '.PHP_VERSION, 'PHP 8.2+ required');
        $add(class_exists(RuntimeMap::class), 'Agent package loaded');
        $add(function_exists('OpenTelemetry\\Instrumentation\\hook'), 'OpenTelemetry extension loaded', 'Install ext-opentelemetry in the PHP runtime');
        $add(($config['enabled'] ?? false) === true, 'Tracing enabled', 'Set MENTAL_MAP_ENABLED=true');

        $url = $config['collector_url'] ?? null;
        $validURL = is_string($url)
            && filter_var($url, FILTER_VALIDATE_URL) !== false
            && in_array(parse_url($url, PHP_URL_SCHEME), ['http', 'https'], true);
        $add($validURL, 'Collector URL valid', 'Set MENTAL_MAP_COLLECTOR to an HTTP URL');

        $service = $config['service_name'] ?? null;
        $add(is_string($service) && trim($service) !== '', 'Service name', 'Set MENTAL_MAP_SERVICE_NAME');
        $namespace = $config['namespace'] ?? null;
        $add(is_string($namespace) && str_ends_with($namespace, '\\'), 'App namespace', 'Set namespace to a PHP namespace ending in \\');
        $add(is_dir($sourceDirectory), 'Source directory '.$sourceDirectory);

        $layers = $config['layers'] ?? null;
        $validLayers = is_array($layers);
        if ($validLayers) {
            foreach ($layers as $directory => $layer) {
                if (!is_string($directory) || !is_string($layer) || $layer === '') {
                    $validLayers = false;
                    break;
                }
            }
        }
        $add($validLayers, 'Layer mappings valid', 'Expected directory => layer strings');
        if ($validLayers) {
            $active = 0;
            foreach (array_keys($layers) as $directory) {
                $active += is_dir($sourceDirectory.'/'.trim($directory, '/')) ? 1 : 0;
            }
            $add($active > 0, $active.' layer directories found', 'Add a mapped source directory or adjust the layers config');
        }

        if ($middlewareRegistered !== null) {
            $add($middlewareRegistered, 'RuntimeMap middleware registered', 'Run php artisan mental-map:install and clear config cache');
        }
        if ($instrumentationReady !== null) {
            $add($instrumentationReady, 'Instrumentation initialized', 'Check layer config and ext-opentelemetry');
        }

        $add(function_exists('curl_init') || (bool) ini_get('allow_url_fopen'), 'HTTP transport available');
        if ($validURL) {
            $health = self::health(rtrim($url, '/').'/health');
            $add($health !== null, 'Collector reachable', 'Start Runtime Mental Map with docker compose up -d');
            if ($health !== null) {
                $version = $health['protocol_version'] ?? null;
                $add($version === RuntimeMap::PROTOCOL_VERSION,
                    'Protocol version '.RuntimeMap::PROTOCOL_VERSION,
                    'Collector reports '.var_export($version, true).' (agent expects '.RuntimeMap::PROTOCOL_VERSION.')');
            }
        }
        return $checks;
    }

    /** @return array<string, mixed>|null */
    private static function health(string $url): ?array
    {
        if (function_exists('curl_init')) {
            $curl = curl_init($url);
            if ($curl === false) {
                return null;
            }
            try {
                curl_setopt_array($curl, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_CONNECTTIMEOUT_MS => 100,
                    CURLOPT_TIMEOUT_MS => 400,
                ]);
                $body = curl_exec($curl);
                if ($body === false || curl_getinfo($curl, CURLINFO_RESPONSE_CODE) !== 200) {
                    return null;
                }
            } finally {
                curl_close($curl);
            }
        } else {
            $context = stream_context_create(['http' => ['timeout' => 0.4, 'ignore_errors' => true]]);
            $body = @file_get_contents($url, false, $context);
            if ($body === false || !str_contains($http_response_header[0] ?? '', ' 200 ')) {
                return null;
            }
        }
        $result = json_decode($body, true);
        return is_array($result) && ($result['status'] ?? null) === 'ok' ? $result : null;
    }
}
