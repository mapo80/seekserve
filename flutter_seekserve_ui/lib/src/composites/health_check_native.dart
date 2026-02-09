import 'dart:io';

/// Performs an HTTP health check against the local control API.
Future<(bool isHealthy, int latencyMs)> runHealthCheck(int controlPort) async {
  final sw = Stopwatch()..start();
  try {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 3);
    final uri = Uri.parse('http://127.0.0.1:$controlPort/api/torrents');
    final request = await client.openUrl('GET', uri);
    final response = await request.close();
    await response.drain<void>();
    client.close();
    sw.stop();
    return (
      response.statusCode >= 200 && response.statusCode < 400,
      sw.elapsedMilliseconds
    );
  } catch (_) {
    sw.stop();
    return (false, sw.elapsedMilliseconds);
  }
}
