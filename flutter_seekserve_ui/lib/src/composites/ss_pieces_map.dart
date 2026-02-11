import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_seekserve/seekserve.dart';

import '../theme/ss_theme.dart';

/// Pieces map: grid visualisation of torrent pieces, divided by file.
///
/// Each cell = one piece, coloured by download state.
/// Files are shown in separate sections with headers.
/// The streaming file is visually highlighted.
class SsPiecesMap extends StatelessWidget {
  final PiecesInfo info;

  const SsPiecesMap({super.key, required this.info});

  @override
  Widget build(BuildContext context) {
    final theme = SsTheme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final file in info.files)
          _FileSection(
            file: file,
            pieces: info.pieces,
            isSelected: file.index == info.selectedFile,
            playheadPiece: info.playheadPiece,
            theme: theme,
          ),
      ],
    );
  }
}

class _FileSection extends StatelessWidget {
  final FilePieceRange file;
  final List<bool> pieces;
  final bool isSelected;
  final int? playheadPiece;
  final SsThemeData theme;

  const _FileSection({
    required this.file,
    required this.pieces,
    required this.isSelected,
    required this.playheadPiece,
    required this.theme,
  });

  @override
  Widget build(BuildContext context) {
    final fileName = file.name.split('/').last;
    final pct = (file.progress * 100).toStringAsFixed(1);
    final total = file.totalPieces;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            children: [
              if (isSelected)
                Container(
                  width: 4,
                  height: 14,
                  margin: const EdgeInsets.only(right: 6),
                  decoration: BoxDecoration(
                    color: theme.downloading,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              Expanded(
                child: Text(
                  fileName,
                  style: theme.captionStyle.copyWith(
                    fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
                    color: isSelected ? theme.onSurface : null,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Text(
                '${file.completed}/$total ($pct%)',
                style: theme.captionStyle,
              ),
            ],
          ),
          const SizedBox(height: 4),

          // Pieces grid
          LayoutBuilder(
            builder: (context, constraints) {
              return CustomPaint(
                size: _gridSize(constraints.maxWidth, total),
                painter: _PiecesGridPainter(
                  file: file,
                  pieces: pieces,
                  isSelected: isSelected,
                  playheadPiece: playheadPiece,
                  completedColor: theme.downloading,
                  missingColor: theme.surface,
                  playheadColor: theme.primary,
                  selectedBorderColor: theme.downloading,
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  Size _gridSize(double maxWidth, int total) {
    if (total == 0) return Size.zero;
    const cellSize = 5.0;
    const gap = 1.0;
    final cols = math.max(1, (maxWidth + gap) ~/ (cellSize + gap));
    final rows = (total + cols - 1) ~/ cols;
    return Size(maxWidth, rows * (cellSize + gap) - gap);
  }
}

class _PiecesGridPainter extends CustomPainter {
  final FilePieceRange file;
  final List<bool> pieces;
  final bool isSelected;
  final int? playheadPiece;
  final Color completedColor;
  final Color missingColor;
  final Color playheadColor;
  final Color selectedBorderColor;

  _PiecesGridPainter({
    required this.file,
    required this.pieces,
    required this.isSelected,
    required this.playheadPiece,
    required this.completedColor,
    required this.missingColor,
    required this.playheadColor,
    required this.selectedBorderColor,
  });

  static const double _cellSize = 5.0;
  static const double _gap = 1.0;

  @override
  void paint(Canvas canvas, Size size) {
    final total = file.endPiece - file.firstPiece;
    if (total <= 0) return;

    final cols = math.max(1, (size.width + _gap) ~/ (_cellSize + _gap));

    final completedPaint = Paint()..color = completedColor;
    final missingPaint = Paint()..color = missingColor;
    final playheadPaint = Paint()
      ..color = playheadColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;

    for (int i = 0; i < total; i++) {
      final pieceIdx = file.firstPiece + i;
      final col = i % cols;
      final row = i ~/ cols;

      final x = col * (_cellSize + _gap);
      final y = row * (_cellSize + _gap);
      final rect = Rect.fromLTWH(x, y, _cellSize, _cellSize);

      final isComplete = pieceIdx < pieces.length && pieces[pieceIdx];
      canvas.drawRect(rect, isComplete ? completedPaint : missingPaint);

      // Playhead indicator
      if (playheadPiece != null && pieceIdx == playheadPiece) {
        canvas.drawRect(rect.inflate(1.0), playheadPaint);
      }
    }
  }

  @override
  bool shouldRepaint(_PiecesGridPainter old) {
    return file.firstPiece != old.file.firstPiece ||
        file.endPiece != old.file.endPiece ||
        file.completed != old.file.completed ||
        isSelected != old.isSelected ||
        playheadPiece != old.playheadPiece;
  }
}
