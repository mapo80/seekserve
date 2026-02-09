/// Stub health check — throws on unsupported platforms.
Future<(bool isHealthy, int latencyMs)> runHealthCheck(int controlPort) async {
  throw UnsupportedError('Health check not supported on this platform.');
}
