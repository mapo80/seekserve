/// On web, there is no real HTTP server — the Service Worker is always online.
Future<(bool isHealthy, int latencyMs)> runHealthCheck(int controlPort) async {
  return (true, 0);
}
