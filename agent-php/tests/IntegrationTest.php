<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use RuntimeMentalMap\Diagnostics;
use RuntimeMentalMap\RuntimeMap;

final class IntegrationTest extends TestCase
{
    private static string $directory;
    private static string $url;
    /** @var resource */
    private static $server;

    public static function setUpBeforeClass(): void
    {
        self::$directory = sys_get_temp_dir().'/mental-map-agent-test-'.bin2hex(random_bytes(4));
        mkdir(self::$directory);
        mkdir(self::$directory.'/Services');
        file_put_contents(self::$directory.'/version', '1');
        file_put_contents(self::$directory.'/router.php', <<<'PHP'
<?php
if ($_SERVER['REQUEST_URI'] === '/health') {
    header('Content-Type: application/json');
    echo json_encode(['status' => 'ok', 'protocol_version' => (int) file_get_contents(__DIR__.'/version')]);
} elseif ($_SERVER['REQUEST_URI'] === '/events/batch') {
    file_put_contents(__DIR__.'/batch', file_get_contents('php://input'));
    http_response_code(202);
} else {
    http_response_code(404);
}
PHP);
        $socket = stream_socket_server('tcp://127.0.0.1:0', $errorCode, $errorMessage);
        self::assertNotFalse($socket, $errorMessage);
        $address = stream_socket_get_name($socket, false);
        fclose($socket);
        self::$url = 'http://'.$address;
        self::$server = proc_open(
            [PHP_BINARY, '-S', $address, self::$directory.'/router.php'],
            [['file', '/dev/null', 'r'], ['file', self::$directory.'/server.log', 'w'], ['file', self::$directory.'/server.log', 'a']],
            $pipes,
        );
        self::assertIsResource(self::$server);
        for ($attempt = 0; $attempt < 50; $attempt++) {
            if (@file_get_contents(self::$url.'/health') !== false) {
                return;
            }
            usleep(20_000);
        }
        self::fail('Test collector did not start');
    }

    public static function tearDownAfterClass(): void
    {
        proc_terminate(self::$server);
        proc_close(self::$server);
        foreach (glob(self::$directory.'/*') ?: [] as $file) {
            is_dir($file) ? rmdir($file) : unlink($file);
        }
        rmdir(self::$directory);
    }

    public function testBatchKeepsRequestAndMethodSpans(): void
    {
        RuntimeMap::startRequest('GET', '/test', 'laravel', self::$url, 'test-app');
        RuntimeMap::enterAutoSpan('application', 'App\\Services\\Example', 'run');
        RuntimeMap::leaveAutoSpan();
        RuntimeMap::finishRequest(200);
        $batch = json_decode((string) file_get_contents(self::$directory.'/batch'), true);
        self::assertCount(2, $batch);
        self::assertSame(['method', 'request'], array_column($batch, 'kind'));
        self::assertSame($batch[1]['span_id'], $batch[0]['parent_id']);
    }

    public function testDoctorDetectsProtocolMismatchAndDisabledMode(): void
    {
        $config = [
            'enabled' => true,
            'collector_url' => self::$url,
            'service_name' => 'test-app',
            'namespace' => 'App\\',
            'layers' => ['Services' => 'application'],
        ];
        file_put_contents(self::$directory.'/version', '2');
        $checks = Diagnostics::run($config, self::$directory);
        self::assertFalse(self::check($checks, 'Protocol version 1'));
        file_put_contents(self::$directory.'/version', '1');
        $checks = Diagnostics::run($config, self::$directory);
        self::assertTrue(self::check($checks, 'Protocol version 1'));
        $config['enabled'] = false;
        self::assertFalse(self::check(Diagnostics::run($config, self::$directory), 'Tracing enabled'));
    }

    public function testCollectorFailureDoesNotBreakRequest(): void
    {
        $started = microtime(true);
        RuntimeMap::startRequest('GET', '/offline', 'slim', 'http://127.0.0.1:1', 'test-app');
        RuntimeMap::finishRequest(200);
        RuntimeMap::startRequest('GET', '/retry', 'slim', 'http://127.0.0.1:1', 'test-app');
        RuntimeMap::finishRequest(200);
        self::assertLessThan(0.8, microtime(true) - $started);
    }

    /** @param list<array{ok: bool, label: string, detail: string}> $checks */
    private static function check(array $checks, string $label): bool
    {
        foreach ($checks as $check) {
            if ($check['label'] === $label) {
                return $check['ok'];
            }
        }
        self::fail('Missing diagnostic: '.$label);
    }
}
