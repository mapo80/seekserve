/// Base class for events received from the SeekServe native engine.
sealed class SeekServeEvent {
  const SeekServeEvent();

  factory SeekServeEvent.fromJson(Map<String, dynamic> json) {
    final type = json['type'] as String?;
    final data = json['data'] as Map<String, dynamic>? ?? {};

    switch (type) {
      case 'metadata_received':
        return MetadataReceived(torrentId: data['torrent_id'] as String? ?? '');
      case 'file_completed':
        return FileCompleted(
          torrentId: data['torrent_id'] as String? ?? '',
          fileIndex: data['file_index'] as int? ?? -1,
        );
      case 'piece_finished':
        return PieceFinished(
          torrentId: data['torrent_id'] as String? ?? '',
          pieceIndex: data['piece_index'] as int? ?? -1,
          pieceOffset: data['piece_offset'] as int? ?? 0,
          pieceLength: data['piece_length'] as int? ?? 0,
        );
      case 'error':
        return TorrentError(
          torrentId: data['torrent_id'] as String? ?? '',
          message: data['message'] as String? ?? 'Unknown error',
        );
      default:
        return UnknownEvent(type: type ?? 'null', data: data);
    }
  }
}

/// Fired when torrent metadata is received (file list available).
class MetadataReceived extends SeekServeEvent {
  final String torrentId;
  const MetadataReceived({required this.torrentId});
}

/// Fired when a piece finishes downloading.
class PieceFinished extends SeekServeEvent {
  final String torrentId;
  final int pieceIndex;
  final int pieceOffset;
  final int pieceLength;
  const PieceFinished({
    required this.torrentId,
    required this.pieceIndex,
    required this.pieceOffset,
    required this.pieceLength,
  });
}

/// Fired when a file finishes downloading completely.
class FileCompleted extends SeekServeEvent {
  final String torrentId;
  final int fileIndex;
  const FileCompleted({required this.torrentId, required this.fileIndex});
}

/// Fired when a torrent encounters an error.
class TorrentError extends SeekServeEvent {
  final String torrentId;
  final String message;
  const TorrentError({required this.torrentId, required this.message});
}

/// Fired for unrecognized event types (forward-compatibility).
class UnknownEvent extends SeekServeEvent {
  final String type;
  final Map<String, dynamic> data;
  const UnknownEvent({required this.type, required this.data});
}
