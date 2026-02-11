import 'package:flutter_seekserve/seekserve.dart';
import 'package:web/web.dart' as web;

void platformInit() {
  // No-op: no MediaKit on web.
}

Future<SeekServeConfig> getPlatformConfig() async {
  // Allow overriding STUN server via URL param (e.g. ?stun_server= for local testing).
  final uri = Uri.parse(web.window.location.href);
  final stunOverride = uri.queryParameters['stun_server'];

  return SeekServeConfig(
    savePath: '/seekserve',
    cacheDbPath: '/seekserve/seekserve_cache.db',
    logLevel: 'debug',
    enableWebtorrent: true,
    stunServer: stunOverride,
  );
}
