import 'package:flutter/widgets.dart';
import 'package:flutter_seekserve/seekserve.dart';
import 'package:flutter_seekserve_ui/flutter_seekserve_ui.dart';

import '../main.dart';
import '../router.dart';

/// Detail screen for a single torrent: metadata + file tree.
class TorrentDetailScreen extends StatefulWidget {
  final String torrentId;

  const TorrentDetailScreen({super.key, required this.torrentId});

  @override
  State<TorrentDetailScreen> createState() => _TorrentDetailScreenState();
}

class _TorrentDetailScreenState extends State<TorrentDetailScreen> {
  SsTorrentManager? _manager;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final m = context.manager;
    if (m != _manager) {
      _manager?.removeListener(_onChange);
      _manager = m;
      m.addListener(_onChange);
    }
  }

  @override
  void dispose() {
    _manager?.removeListener(_onChange);
    super.dispose();
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  void _onFileTap(FileInfo file) {
    final url = context.manager.selectAndStream(widget.torrentId, file.index);
    if (url == null) return;

    Navigator.of(context).pushNamed(
      '/player',
      arguments: PlayerArgs(
        streamUrl: url,
        torrentId: widget.torrentId,
        fileName: file.name,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = SsTheme.of(context);
    final manager = context.manager;
    final status = manager.getStatus(widget.torrentId);
    final files = manager.listFiles(widget.torrentId);
    final piecesInfo = manager.getPieces(widget.torrentId);
    final error = manager.errorMessage;
    final metadataReady = status?.hasMetadata == true;

    return ColoredBox(
      color: theme.background,
      child: Column(
        children: [
          // Top bar with back button
          Container(
            padding: EdgeInsets.only(
              top: MediaQuery.of(context).padding.top + 4,
              left: 4,
              right: 16,
              bottom: 4,
            ),
            color: theme.surface,
            child: Row(
              children: [
                SsIconButton(
                  icon: const IconData(0xe092, fontFamily: 'MaterialIcons'),
                  color: theme.onSurface,
                  onPressed: () => Navigator.of(context).pop(),
                ),
                Expanded(
                  child: Text(
                    status?.name ?? 'Torrent',
                    style: theme.headingStyle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
          // Error banner
          if (error != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: const Color(0xFF4A1111),
              child: Text(
                error,
                style: const TextStyle(color: Color(0xFFFF8A80), fontSize: 13),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          // Content
          Expanded(
            child: status == null
                ? Center(
                    child: Text('Loading...', style: theme.captionStyle),
                  )
                : ListView(
                    children: [
                      SsTorrentDetail(status: status, files: files),
                      if (piecesInfo != null && piecesInfo.files.isNotEmpty) ...[
                        Padding(
                          padding: const EdgeInsets.only(left: 16, top: 8),
                          child: Text('Pieces', style: theme.headingStyle),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          child: SsPiecesMap(info: piecesInfo),
                        ),
                      ],
                      if (files.isNotEmpty) ...[
                        Padding(
                          padding: const EdgeInsets.only(left: 16, top: 8),
                          child: Text('Files', style: theme.headingStyle),
                        ),
                        if (!metadataReady)
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                            child: Text(
                              'Waiting for metadata before streaming...',
                              style: theme.captionStyle,
                            ),
                          ),
                        SizedBox(
                          height: files.length * 52.0 + 16,
                          child: SsFileTree(
                            files: files,
                            onFileTap: metadataReady ? _onFileTap : null,
                          ),
                        ),
                      ],
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
