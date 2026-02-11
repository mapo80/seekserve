import 'package:flutter_seekserve/seekserve.dart';

void platformInit() {
  // No-op: no MediaKit on web.
}

Future<SeekServeConfig> getPlatformConfig() async {
  return const SeekServeConfig(
    savePath: '/seekserve',
    cacheDbPath: '/seekserve/seekserve_cache.db',
    logLevel: 'debug',
  );
}
