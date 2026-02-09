import 'dart:io';

import 'package:flutter_seekserve/seekserve.dart';
import 'package:media_kit/media_kit.dart';
import 'package:path_provider/path_provider.dart';

void platformInit() {
  MediaKit.ensureInitialized();
}

Future<SeekServeConfig> getPlatformConfig() async {
  final dir = await getApplicationDocumentsDirectory();
  final savePath = '${dir.path}${Platform.pathSeparator}seekserve';
  await Directory(savePath).create(recursive: true);
  final dbPath = '$savePath${Platform.pathSeparator}seekserve_cache.db';
  return SeekServeConfig(
    savePath: savePath,
    cacheDbPath: dbPath,
    streamPort: 0,
    controlPort: 0,
    logLevel: 'debug',
  );
}
