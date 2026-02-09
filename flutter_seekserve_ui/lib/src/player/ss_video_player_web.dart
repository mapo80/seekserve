import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/widgets.dart';
import 'package:flutter_seekserve/seekserve.dart';
import 'package:web/web.dart' as web;

import '../atoms/ss_icon_button.dart';
import '../atoms/ss_slider.dart';
import '../theme/ss_theme.dart';
import '../utils/format.dart';
import 'ss_buffering_overlay.dart';
import 'ss_player_status_bar.dart';

/// Web implementation of the video player using an HTML5 `<video>` element.
///
/// The [streamUrl] is intercepted by the SeekServe Service Worker which
/// serves bytes from the WASM engine, enabling HTTP Range streaming in
/// the browser without a real server.
class SsVideoPlayer extends StatefulWidget {
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
  State<SsVideoPlayer> createState() => _SsVideoPlayerState();
}

class _SsVideoPlayerState extends State<SsVideoPlayer> {
  web.HTMLVideoElement? _video;

  bool _playing = false;
  double _positionMs = 0;
  double _durationMs = 0;
  bool _buffering = true;
  String _error = '';
  bool _controlsVisible = true;
  Timer? _hideTimer;
  Timer? _pollTimer;

  static const _fullscreen = IconData(0xe2cb, fontFamily: 'MaterialIcons');
  static const _fullscreenExit = IconData(0xe2cc, fontFamily: 'MaterialIcons');
  static const _playArrow = IconData(0xe4cb, fontFamily: 'MaterialIcons');
  static const _pause = IconData(0xe47c, fontFamily: 'MaterialIcons');
  static const _replay10 = IconData(0xe524, fontFamily: 'MaterialIcons');
  static const _forward10 = IconData(0xe2c5, fontFamily: 'MaterialIcons');

  @override
  void initState() {
    super.initState();
    _scheduleHide();
  }

  @override
  void didUpdateWidget(SsVideoPlayer old) {
    super.didUpdateWidget(old);
    if (old.streamUrl != widget.streamUrl && _video != null) {
      _video!.src = widget.streamUrl;
      _video!.load();
      setState(() {
        _error = '';
        _buffering = true;
      });
    }
  }

  void _attachListeners(web.HTMLVideoElement video) {
    _video = video;

    video.addEventListener(
      'play',
      ((web.Event e) {
        if (mounted) setState(() => _playing = true);
      }).toJS,
    );
    video.addEventListener(
      'pause',
      ((web.Event e) {
        if (mounted) setState(() => _playing = false);
      }).toJS,
    );
    video.addEventListener(
      'waiting',
      ((web.Event e) {
        if (mounted) setState(() => _buffering = true);
      }).toJS,
    );
    video.addEventListener(
      'playing',
      ((web.Event e) {
        if (mounted) setState(() => _buffering = false);
      }).toJS,
    );
    video.addEventListener(
      'canplay',
      ((web.Event e) {
        if (mounted) setState(() => _buffering = false);
      }).toJS,
    );
    video.addEventListener(
      'error',
      ((web.Event e) {
        if (mounted) setState(() => _error = 'Video playback error');
      }).toJS,
    );

    // Poll position and duration since there's no stream-based API.
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (_video == null || !mounted) return;
      final pos = _video!.currentTime * 1000;
      final dur = _video!.duration;
      final durMs = dur.isFinite ? dur * 1000 : 0.0;
      if (pos != _positionMs || durMs != _durationMs) {
        setState(() {
          _positionMs = pos;
          _durationMs = durMs;
        });
      }
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _hideTimer?.cancel();
    _video?.pause();
    _video = null;
    super.dispose();
  }

  void _scheduleHide() {
    _hideTimer?.cancel();
    _hideTimer = Timer(const Duration(seconds: 4), () {
      if (mounted) setState(() => _controlsVisible = false);
    });
  }

  void _toggle() {
    setState(() {
      _controlsVisible = !_controlsVisible;
      if (_controlsVisible) _scheduleHide();
    });
  }

  void _onInteraction() => _scheduleHide();

  void _playPause() {
    final v = _video;
    if (v == null) return;
    if (_playing) {
      v.pause();
    } else {
      v.play();
    }
    _onInteraction();
  }

  void _seekTo(double ms) {
    final v = _video;
    if (v == null) return;
    v.currentTime = ms / 1000.0;
    _onInteraction();
  }

  @override
  Widget build(BuildContext context) {
    final theme = SsTheme.of(context);

    if (_error.isNotEmpty) {
      return ColoredBox(
        color: theme.background,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _error,
                  style: theme.bodyStyle.copyWith(color: theme.error),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  widget.streamUrl,
                  style: theme.monoStyle.copyWith(fontSize: 10),
                  textAlign: TextAlign.center,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Stack(
      fit: StackFit.expand,
      children: [
        // HTML5 <video> element via platform view
        HtmlElementView.fromTagName(
          tagName: 'video',
          onElementCreated: (Object element) {
            final video = element as web.HTMLVideoElement;
            video.src = widget.streamUrl;
            video.autoplay = true;
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.objectFit = 'contain';
            video.style.backgroundColor = '#000';
            _attachListeners(video);
          },
        ),
        // Tap area for toggling controls
        GestureDetector(
          behavior: HitTestBehavior.translucent,
          onTap: _toggle,
        ),
        // Buffering indicator
        if (_buffering)
          const Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SsSpinner(),
                SizedBox(height: 8),
                Text(
                  'Buffering...',
                  style: TextStyle(fontSize: 13, color: Color(0xCCFFFFFF)),
                ),
              ],
            ),
          ),
        // Controls overlay
        IgnorePointer(
          ignoring: !_controlsVisible,
          child: AnimatedOpacity(
            opacity: _controlsVisible ? 1.0 : 0.0,
            duration: const Duration(milliseconds: 250),
            child: _buildControlsPanel(theme),
          ),
        ),
      ],
    );
  }

  Widget _buildControlsPanel(SsThemeData theme) {
    return Column(
      children: [
        // Top gradient: fullscreen button
        Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color(0xCC000000), Color(0x00000000)],
            ),
          ),
          padding: EdgeInsets.only(
            top: widget.isFullscreen ? 16.0 : 4.0,
            right: 4,
          ),
          alignment: Alignment.topRight,
          child: SsIconButton(
            icon: widget.isFullscreen ? _fullscreenExit : _fullscreen,
            color: const Color(0xFFFFFFFF),
            onPressed: () {
              widget.onFullscreenToggle?.call();
              _onInteraction();
            },
          ),
        ),

        // Center: play/pause
        const Spacer(),
        SsIconButton(
          icon: _playing ? _pause : _playArrow,
          size: 52,
          color: const Color(0xFFFFFFFF),
          onPressed: _playPause,
        ),
        const Spacer(),

        // Bottom gradient: seek + transport + status
        Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.bottomCenter,
              end: Alignment.topCenter,
              colors: [Color(0xCC000000), Color(0x00000000)],
            ),
          ),
          padding: EdgeInsets.only(
            bottom: widget.isFullscreen ? 16.0 : 0.0,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _buildSeekBar(theme),
              _buildTransportRow(),
              if (widget.torrentStatus != null)
                SsPlayerStatusBar(status: widget.torrentStatus!),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildSeekBar(SsThemeData theme) {
    final maxMs = _durationMs;
    final posMs = _positionMs.clamp(0.0, maxMs > 0 ? maxMs : 1.0);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(
        children: [
          Text(
            formatDuration(Duration(milliseconds: posMs.toInt())),
            style: const TextStyle(color: Color(0xCCFFFFFF), fontSize: 12),
          ),
          Expanded(
            child: SsSlider(
              value: posMs,
              max: maxMs > 0 ? maxMs : 1.0,
              activeColor: theme.primary,
              trackColor: const Color(0x40FFFFFF),
              onChanged: _seekTo,
            ),
          ),
          Text(
            formatDuration(Duration(milliseconds: maxMs.toInt())),
            style: const TextStyle(color: Color(0xCCFFFFFF), fontSize: 12),
          ),
        ],
      ),
    );
  }

  Widget _buildTransportRow() {
    final position = Duration(milliseconds: _positionMs.toInt());
    final duration = Duration(milliseconds: _durationMs.toInt());

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        SsIconButton(
          icon: _replay10,
          color: const Color(0xFFFFFFFF),
          onPressed: () {
            final t = position - const Duration(seconds: 10);
            _seekTo(
              (t < Duration.zero ? Duration.zero : t)
                  .inMilliseconds
                  .toDouble(),
            );
          },
        ),
        SsIconButton(
          icon: _playing ? _pause : _playArrow,
          size: 32,
          color: const Color(0xFFFFFFFF),
          onPressed: _playPause,
        ),
        SsIconButton(
          icon: _forward10,
          color: const Color(0xFFFFFFFF),
          onPressed: () {
            final t = position + const Duration(seconds: 10);
            _seekTo(
              (t > duration ? duration : t).inMilliseconds.toDouble(),
            );
          },
        ),
      ],
    );
  }
}
