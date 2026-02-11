/// Per-file piece range with completion count.
class FilePieceRange {
  final int index;
  final String name;
  final int firstPiece;
  final int endPiece; // exclusive
  final int completed;

  const FilePieceRange({
    required this.index,
    required this.name,
    required this.firstPiece,
    required this.endPiece,
    required this.completed,
  });

  int get totalPieces => endPiece - firstPiece;

  double get progress =>
      totalPieces > 0 ? completed / totalPieces : 0.0;

  factory FilePieceRange.fromJson(Map<String, dynamic> json) {
    return FilePieceRange(
      index: json['index'] as int,
      name: json['name'] as String,
      firstPiece: json['first_piece'] as int,
      endPiece: json['end_piece'] as int,
      completed: json['completed'] as int,
    );
  }
}

/// Piece-level status for a torrent: bitfield + per-file ranges.
class PiecesInfo {
  final int numPieces;
  final int pieceLength;
  final List<bool> pieces;
  final List<FilePieceRange> files;
  final int? selectedFile;
  final int? playheadPiece;

  const PiecesInfo({
    required this.numPieces,
    required this.pieceLength,
    required this.pieces,
    required this.files,
    this.selectedFile,
    this.playheadPiece,
  });

  factory PiecesInfo.fromJson(Map<String, dynamic> json) {
    final bitfield = json['bitfield'] as String? ?? '';
    final numPieces = json['num_pieces'] as int;
    final pieces = _decodeBitfield(bitfield, numPieces);

    final filesJson = json['files'] as List<dynamic>? ?? [];
    final files = filesJson
        .map((e) => FilePieceRange.fromJson(e as Map<String, dynamic>))
        .toList();

    return PiecesInfo(
      numPieces: numPieces,
      pieceLength: json['piece_length'] as int,
      pieces: pieces,
      files: files,
      selectedFile: json['selected_file'] as int?,
      playheadPiece: json['playhead_piece'] as int?,
    );
  }

  /// Decode hex-encoded bitfield (MSB first) into a List<bool>.
  static List<bool> _decodeBitfield(String hex, int numPieces) {
    if (hex.isEmpty) return List.filled(numPieces, false);

    final result = List.filled(numPieces, false);
    for (int i = 0; i < hex.length; i += 2) {
      final end = (i + 2 <= hex.length) ? i + 2 : hex.length;
      final byte = int.parse(hex.substring(i, end), radix: 16);
      for (int bit = 0; bit < 8; bit++) {
        final pieceIdx = (i ~/ 2) * 8 + bit;
        if (pieceIdx >= numPieces) break;
        result[pieceIdx] = (byte & (0x80 >> bit)) != 0;
      }
    }
    return result;
  }
}
