import 'dart:convert';

/// Configuration for the SeekServe engine.
class SeekServeConfig {
  final String? savePath;
  final String? authToken;
  final int? streamPort;
  final int? controlPort;
  final int? maxStorageBytes;
  final String? cacheDbPath;
  final String? logLevel;
  final bool? enableWebtorrent;
  final String? stunServer;
  final List<String>? extraTrackers;

  const SeekServeConfig({
    this.savePath,
    this.authToken,
    this.streamPort,
    this.controlPort,
    this.maxStorageBytes,
    this.cacheDbPath,
    this.logLevel,
    this.enableWebtorrent,
    this.stunServer,
    this.extraTrackers,
  });

  /// Serializes to JSON string for `ss_engine_create()`.
  String toJsonString() {
    final map = <String, dynamic>{};
    if (savePath != null) map['save_path'] = savePath;
    if (authToken != null) map['auth_token'] = authToken;
    if (streamPort != null) map['stream_port'] = streamPort;
    if (controlPort != null) map['control_port'] = controlPort;
    if (maxStorageBytes != null) map['max_storage_bytes'] = maxStorageBytes;
    if (cacheDbPath != null) map['cache_db_path'] = cacheDbPath;
    if (logLevel != null) map['log_level'] = logLevel;
    if (enableWebtorrent != null) map['enable_webtorrent'] = enableWebtorrent;
    if (stunServer != null) map['stun_server'] = stunServer;
    if (extraTrackers != null) map['extra_trackers'] = extraTrackers;
    return jsonEncode(map);
  }
}
