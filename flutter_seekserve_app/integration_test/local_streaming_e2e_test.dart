// Local Torrent Streaming E2E Test
//
// Tests the complete pipeline: engine init -> add torrent -> metadata ->
// select file -> HTTP Range streaming.
//
// Two modes:
//   Magnet mode (iOS/physical device):  --dart-define INFOHASH, TRACKER_URL
//   File mode   (Android emulator):     --dart-define TORRENT_PATH, SAVE_PATH
//
// Common: --dart-define VIDEO_NAME
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_seekserve/seekserve.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // Magnet mode params
  const infohash = String.fromEnvironment('INFOHASH');
  const trackerUrl = String.fromEnvironment('TRACKER_URL');

  // File mode params (Android emulator)
  const torrentPath = String.fromEnvironment('TORRENT_PATH');
  const customSavePath = String.fromEnvironment('SAVE_PATH');

  const videoName = String.fromEnvironment('VIDEO_NAME',
      defaultValue: 'bbb_sunflower_1080p_30fps_normal.mp4');

  final useFileMode = torrentPath.isNotEmpty;

  testWidgets('Local torrent streaming E2E', (tester) async {
    // Pump a minimal widget so the test framework is happy
    await tester.pumpWidget(const SizedBox.shrink());

    // Validate params based on mode
    final String torrentUri;
    if (useFileMode) {
      expect(torrentPath, isNotEmpty,
          reason: 'TORRENT_PATH not set via --dart-define');
      torrentUri = torrentPath;
      debugPrint('=== E2E (file mode): Starting ===');
      debugPrint('  Torrent:    $torrentPath');
      debugPrint('  Save path:  $customSavePath');
    } else {
      expect(infohash, isNotEmpty,
          reason: 'INFOHASH not set via --dart-define');
      expect(trackerUrl, isNotEmpty,
          reason: 'TRACKER_URL not set via --dart-define');
      torrentUri =
          'magnet:?xt=urn:btih:$infohash&dn=$videoName&tr=$trackerUrl';
      debugPrint('=== E2E (magnet mode): Starting ===');
      debugPrint('  Infohash:   $infohash');
      debugPrint('  Tracker:    $trackerUrl');
      debugPrint('  Magnet URI: $torrentUri');
    }
    debugPrint('  Video:      $videoName');

    // --- Step 1: Init engine ---
    debugPrint('\n--- Step 1: Init engine ---');
    final String savePath;
    if (customSavePath.isNotEmpty) {
      savePath = customSavePath;
      await Directory(savePath).create(recursive: true);
    } else {
      final docsDir = await getApplicationDocumentsDirectory();
      savePath = '${docsDir.path}/seekserve_e2e';
      await Directory(savePath).create(recursive: true);
    }

    final client = SeekServeClient(
      config: SeekServeConfig(
        savePath: savePath,
        logLevel: 'debug',
        enableWebtorrent: !useFileMode,
        extraTrackers: trackerUrl.isNotEmpty ? [trackerUrl] : [],
      ),
    );
    await client.initialize();
    debugPrint('  Engine created (savePath: $savePath)');

    try {
      // --- Step 2: Start HTTP server ---
      debugPrint('\n--- Step 2: Start HTTP server ---');
      final port = await client.startServer();
      expect(port, greaterThan(0), reason: 'Server port must be > 0');
      debugPrint('  Server listening on port $port');

      // --- Step 3: Add torrent ---
      debugPrint('\n--- Step 3: Add torrent ---');
      final torrentId = client.addTorrent(torrentUri);
      expect(torrentId, isNotEmpty, reason: 'Torrent ID must not be empty');
      debugPrint('  Torrent added: $torrentId');

      // --- Step 4: Wait for metadata ---
      debugPrint('\n--- Step 4: Wait for metadata ---');
      final metadataTimeout = useFileMode ? 30 : 60;
      bool gotMetadata = false;
      for (int i = 0; i < metadataTimeout && !gotMetadata; i++) {
        final status = client.getStatus(torrentId);
        if (status.hasMetadata) {
          gotMetadata = true;
          debugPrint(
              '  Metadata received after ${i + 1}s (peers: ${status.numPeers})');
          break;
        }
        if (i % 5 == 0) {
          debugPrint(
              '  Waiting... (${i}s, state: ${status.state}, peers: ${status.numPeers})');
        }
        await Future.delayed(const Duration(seconds: 1));
      }
      expect(gotMetadata, isTrue,
          reason: 'Metadata not received within ${metadataTimeout}s');

      // --- Step 5: List files, find video ---
      debugPrint('\n--- Step 5: List files ---');
      final files = client.listFiles(torrentId);
      expect(files, isNotEmpty, reason: 'File list must not be empty');
      debugPrint('  Found ${files.length} files:');
      for (final f in files) {
        debugPrint('    [${f.index}] ${f.name} (${f.size} bytes)');
      }

      final videoFile = files.firstWhere(
        (f) => f.path.endsWith('.mp4'),
        orElse: () => files.first,
      );
      debugPrint('  Selected: [${videoFile.index}] ${videoFile.name}');

      // --- Step 6: Select file + get stream URL ---
      debugPrint('\n--- Step 6: Select file + stream URL ---');
      client.selectFile(torrentId, videoFile.index);
      final streamUrl = client.getStreamUrl(torrentId, videoFile.index);
      expect(streamUrl, contains('http://127.0.0.1'),
          reason: 'Stream URL must be localhost HTTP');
      debugPrint('  Stream URL: $streamUrl');

      // In file mode, wait for piece checking to complete
      if (useFileMode) {
        debugPrint('\n--- Step 6b: Wait for piece checking ---');
        for (int i = 0; i < 60; i++) {
          final status = client.getStatus(torrentId);
          if (status.progress > 0) {
            debugPrint(
                '  Pieces verified after ${i + 1}s (progress: ${(status.progress * 100).toStringAsFixed(1)}%)');
            break;
          }
          if (i % 5 == 0) {
            debugPrint(
                '  Checking... (${i}s, state: ${status.state}, progress: ${(status.progress * 100).toStringAsFixed(1)}%)');
          }
          await Future.delayed(const Duration(seconds: 1));
        }
      }

      // --- Step 7: HTTP HEAD ---
      debugPrint('\n--- Step 7: HTTP HEAD ---');
      final headResp = await http.head(Uri.parse(streamUrl));
      debugPrint('  HEAD status: ${headResp.statusCode}');
      debugPrint('  Content-Length: ${headResp.headers['content-length']}');
      debugPrint('  Accept-Ranges: ${headResp.headers['accept-ranges']}');
      debugPrint('  Content-Type: ${headResp.headers['content-type']}');
      expect(headResp.statusCode, 200);
      expect(headResp.headers['content-length'], isNotNull);
      expect(int.parse(headResp.headers['content-length']!), greaterThan(0));
      expect(headResp.headers['accept-ranges'], 'bytes');

      // --- Step 8: HTTP Range GET ---
      debugPrint('\n--- Step 8: HTTP Range GET bytes=0-65535 ---');
      final getResp = await http.get(
        Uri.parse(streamUrl),
        headers: {'Range': 'bytes=0-65535'},
      );
      debugPrint('  GET status: ${getResp.statusCode}');
      debugPrint('  Body length: ${getResp.bodyBytes.length}');
      debugPrint(
          '  Content-Range: ${getResp.headers['content-range'] ?? 'none'}');
      expect(getResp.statusCode, anyOf(200, 206));
      expect(getResp.bodyBytes.length, greaterThan(0));
      expect(getResp.bodyBytes.length, lessThanOrEqualTo(65536));

      // --- Step 9: Check download progress ---
      debugPrint('\n--- Step 9: Check download progress ---');
      for (int i = 0; i < 10; i++) {
        final status = client.getStatus(torrentId);
        debugPrint(
            '  Progress: ${(status.progress * 100).toStringAsFixed(1)}%'
            ' (peers: ${status.numPeers}, rate: ${(status.downloadRate / 1024).toStringAsFixed(1)} KB/s)');
        if (status.progress > 0) break;
        await Future.delayed(const Duration(seconds: 1));
      }
      final finalStatus = client.getStatus(torrentId);
      expect(finalStatus.progress, greaterThan(0),
          reason: 'Download progress should be > 0 after streaming');

      // --- Step 10: Cleanup ---
      debugPrint('\n--- Step 10: Cleanup ---');
      client.removeTorrent(torrentId, deleteFiles: !useFileMode);
      debugPrint('  Torrent removed');

      debugPrint('\n=== E2E: ALL STEPS PASSED ===');
    } finally {
      client.dispose();
      if (!useFileMode) {
        try {
          await Directory(savePath).delete(recursive: true);
        } catch (_) {}
      }
    }
  });
}
