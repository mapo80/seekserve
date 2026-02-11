import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_seekserve/seekserve.dart';

/// Holds a torrent entry with its latest status and file list.
class SsTorrentEntry {
  final String torrentId;
  TorrentStatus? status;
  List<FileInfo>? files;
  bool metadataReceived;

  SsTorrentEntry({
    required this.torrentId,
    this.status,
    this.files,
    this.metadataReceived = false,
  });
}

/// Business logic controller for torrent management.
///
/// Wraps [SeekServeClient] and exposes reactive state via [ChangeNotifier].
/// Can be used directly with Flutter's `ListenableBuilder` or wrapped by
/// Provider, Riverpod, Bloc, etc.
class SsTorrentManager extends ChangeNotifier {
  SeekServeClient? _client;
  int? _serverPort;
  String? _errorMessage;
  StreamSubscription<SeekServeEvent>? _eventSub;
  Timer? _pollTimer;

  final Map<String, SsTorrentEntry> _torrents = {};
  DateTime? _startedAt;
  int? _streamPort;
  String? _authToken;

  /// All active torrent entries.
  List<SsTorrentEntry> get entries => _torrents.values.toList();

  /// All torrent statuses (non-null only).
  List<TorrentStatus> get statuses =>
      _torrents.values
          .where((e) => e.status != null)
          .map((e) => e.status!)
          .toList();

  /// Server port (null if not started).
  int? get serverPort => _serverPort;

  /// Last error message.
  String? get errorMessage => _errorMessage;

  /// Whether the engine is initialised and the server is started.
  bool get isReady => _client != null;

  /// Engine start time.
  DateTime? get startedAt => _startedAt;

  /// Stream server port (discovered from first getStreamUrl call).
  int? get streamPort => _streamPort;

  /// Auth token from config.
  String? get authToken => _authToken;

  /// Aggregate download rate across all torrents.
  double get totalDownloadRate =>
      statuses.fold(0.0, (sum, s) => sum + s.downloadRate);

  /// Aggregate upload rate across all torrents.
  double get totalUploadRate =>
      statuses.fold(0.0, (sum, s) => sum + s.uploadRate);

  /// Initialises the engine with default config based on [savePath].
  Future<void> init(String savePath, {SeekServeConfig? config}) async {
    if (_client != null) return;

    try {
      _client = SeekServeClient(
        config: config ??
            SeekServeConfig(
              savePath: savePath,
              streamPort: 0,
              controlPort: 0,
              logLevel: 'debug',
            ),
      );

      await _client!.initialize();

      final port = await _client!.startServer();
      _serverPort = port > 0 ? port : null;
      _startedAt = DateTime.now();
      _authToken = (config ?? SeekServeConfig(savePath: savePath)).authToken;

      // Restore previously persisted torrents
      try {
        final ids = _client!.listTorrents();
        for (final id in ids) {
          _torrents[id] = SsTorrentEntry(torrentId: id);
        }
      } catch (_) {}

      _eventSub = _client!.events.listen(_onEvent, onError: _onEventError);

      _pollTimer = Timer.periodic(
        const Duration(seconds: 2),
        (_) => _pollStatus(),
      );

      _errorMessage = null;
      notifyListeners();
    } catch (e) {
      _errorMessage = e.toString();
      notifyListeners();
    }
  }

  /// Adds a torrent by magnet URI or .torrent file path. Returns the torrent ID.
  String? addTorrent(String uri) {
    if (_client == null) return null;

    try {
      final id = _client!.addTorrent(uri);
      _torrents[id] = SsTorrentEntry(torrentId: id);
      _errorMessage = null;
      notifyListeners();
      return id;
    } catch (e) {
      _errorMessage = e.toString();
      notifyListeners();
      return null;
    }
  }

  /// Removes a torrent.
  void removeTorrent(String torrentId, {bool deleteFiles = false}) {
    if (_client == null) return;

    try {
      _client!.removeTorrent(torrentId, deleteFiles: deleteFiles);
      _torrents.remove(torrentId);
      _errorMessage = null;
      notifyListeners();
    } catch (e) {
      _errorMessage = e.toString();
      notifyListeners();
    }
  }

  /// Lists files for a torrent.
  List<FileInfo> listFiles(String torrentId) {
    if (_client == null) return [];

    final entry = _torrents[torrentId];
    if (entry != null && entry.files != null) return entry.files!;

    try {
      final files = _client!.listFiles(torrentId);
      if (entry != null) entry.files = files;
      return files;
    } catch (e) {
      _errorMessage = e.toString();
      notifyListeners();
      return [];
    }
  }

  /// Selects a file for streaming and returns its stream URL.
  ///
  /// Returns null (with [errorMessage] set) if metadata is not yet available.
  String? selectAndStream(String torrentId, int fileIndex) {
    if (_client == null) return null;

    final entry = _torrents[torrentId];
    if (entry?.status?.hasMetadata != true) {
      _errorMessage = 'Metadata not ready yet — please wait';
      notifyListeners();
      return null;
    }

    try {
      _client!.selectFile(torrentId, fileIndex);
      var url = _client!.getStreamUrl(torrentId, fileIndex);
      // Discover stream port from the URL.
      if (_streamPort == null) {
        final parsed = Uri.tryParse(url);
        if (parsed != null && parsed.port != 0) {
          _streamPort = parsed.port;
        }
      }
      // Append file name for MIME type detection by the Service Worker.
      final files = entry?.files ?? listFiles(torrentId);
      if (fileIndex < files.length) {
        final basename = files[fileIndex].path.split('/').last;
        final sep = url.contains('?') ? '&' : '?';
        url = '$url${sep}name=${Uri.encodeComponent(basename)}';
      }
      _errorMessage = null;
      notifyListeners();
      return url;
    } catch (e) {
      _errorMessage = e.toString();
      notifyListeners();
      return null;
    }
  }

  /// Gets current status for a torrent.
  TorrentStatus? getStatus(String torrentId) {
    return _torrents[torrentId]?.status;
  }

  /// Gets piece-level status for a torrent.
  PiecesInfo? getPieces(String torrentId) {
    if (_client == null) return null;
    try {
      return _client!.getPieces(torrentId);
    } catch (_) {
      return null;
    }
  }

  /// Gets the entry for a torrent.
  SsTorrentEntry? getEntry(String torrentId) => _torrents[torrentId];

  void _onEvent(SeekServeEvent event) {
    switch (event) {
      case MetadataReceived(:final torrentId):
        final entry = _torrents[torrentId];
        if (entry != null) {
          entry.metadataReceived = true;
          try {
            entry.files = _client!.listFiles(torrentId);
          } catch (_) {}
        }
        _safeNotify();
      case FileCompleted(:final torrentId, :final fileIndex):
        debugPrint('File completed: $torrentId file $fileIndex');
        _safeNotify();
      case PieceFinished():
        break;
      case TorrentError(:final torrentId, :final message):
        _errorMessage = 'Torrent $torrentId: $message';
        _safeNotify();
      case UnknownEvent():
        break;
    }
  }

  void _onEventError(Object error) {
    _errorMessage = error.toString();
    _safeNotify();
  }

  void _pollStatus() {
    if (_client == null) return;

    for (final entry in _torrents.values) {
      try {
        entry.status = _client!.getStatus(entry.torrentId);
        if (entry.status?.hasMetadata == true && !entry.metadataReceived) {
          entry.metadataReceived = true;
          entry.files ??= _tryListFiles(entry.torrentId);
        }
      } catch (_) {}
    }
    _safeNotify();
  }

  List<FileInfo>? _tryListFiles(String torrentId) {
    try {
      return _client!.listFiles(torrentId);
    } catch (_) {
      return null;
    }
  }

  /// Defer notifyListeners to a microtask so it never fires mid-build.
  void _safeNotify() {
    Future.microtask(() {
      if (!hasListeners) return;
      notifyListeners();
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _eventSub?.cancel();
    _client?.dispose();
    _client = null;
    super.dispose();
  }
}
