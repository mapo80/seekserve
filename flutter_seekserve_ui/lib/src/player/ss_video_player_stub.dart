import 'package:flutter/widgets.dart';
import 'package:flutter_seekserve/seekserve.dart';

/// Stub video player — throws on unsupported platforms.
class SsVideoPlayer extends StatelessWidget {
  final String streamUrl;
  final TorrentStatus? torrentStatus;
  final bool isFullscreen;
  final VoidCallback? onFullscreenToggle;

  const SsVideoPlayer({
    super.key,
    required this.streamUrl,
    this.torrentStatus,
    this.isFullscreen = false,
    this.onFullscreenToggle,
  });

  @override
  Widget build(BuildContext context) {
    throw UnsupportedError('SsVideoPlayer is not supported on this platform.');
  }
}
