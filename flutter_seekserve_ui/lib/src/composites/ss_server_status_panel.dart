import 'dart:async';

import 'package:flutter/widgets.dart';

import '../atoms/ss_badge.dart';
import '../theme/ss_theme.dart';
import '../utils/format.dart';
import 'health_check_stub.dart'
    if (dart.library.io) 'health_check_native.dart'
    if (dart.library.js_interop) 'health_check_web.dart';

/// A detailed diagnostic panel showing the state of the SeekServe web server.
///
/// Performs periodic health checks against the control API and displays
/// server addresses, auth info, torrent stats, and available endpoints.
class SsServerStatusPanel extends StatefulWidget {
  final int? controlPort;
  final int? streamPort;
  final String? authToken;
  final int activeTorrents;
  final double totalDownloadRate;
  final double totalUploadRate;
  final DateTime? startedAt;

  const SsServerStatusPanel({
    super.key,
    this.controlPort,
    this.streamPort,
    this.authToken,
    this.activeTorrents = 0,
    this.totalDownloadRate = 0,
    this.totalUploadRate = 0,
    this.startedAt,
  });

  /// Shows the panel as a modal overlay route.
  static Future<void> show(BuildContext context, {
    int? controlPort,
    int? streamPort,
    String? authToken,
    int activeTorrents = 0,
    double totalDownloadRate = 0,
    double totalUploadRate = 0,
    DateTime? startedAt,
  }) {
    return Navigator.of(context).push(
      PageRouteBuilder(
        opaque: false,
        barrierDismissible: true,
        barrierColor: const Color(0x80000000),
        pageBuilder: (ctx, anim, secAnim) => Center(
          child: Padding(
            padding: EdgeInsets.only(
              left: 16,
              right: 16,
              top: MediaQuery.of(ctx).padding.top + 16,
              bottom: MediaQuery.of(ctx).padding.bottom + 16,
            ),
            child: SsServerStatusPanel(
              controlPort: controlPort,
              streamPort: streamPort,
              authToken: authToken,
              activeTorrents: activeTorrents,
              totalDownloadRate: totalDownloadRate,
              totalUploadRate: totalUploadRate,
              startedAt: startedAt,
            ),
          ),
        ),
      ),
    );
  }

  @override
  State<SsServerStatusPanel> createState() => _SsServerStatusPanelState();
}

class _SsServerStatusPanelState extends State<SsServerStatusPanel> {
  Timer? _healthTimer;
  bool _isHealthy = false;
  int _latencyMs = 0;
  DateTime? _lastCheck;
  String _uptimeText = '';
  Timer? _uptimeTimer;

  @override
  void initState() {
    super.initState();
    _runHealthCheck();
    _healthTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _runHealthCheck(),
    );
    _updateUptime();
    _uptimeTimer = Timer.periodic(
      const Duration(seconds: 1),
      (_) => _updateUptime(),
    );
  }

  @override
  void dispose() {
    _healthTimer?.cancel();
    _uptimeTimer?.cancel();
    super.dispose();
  }

  void _updateUptime() {
    if (widget.startedAt == null) {
      if (_uptimeText != '--') {
        setState(() => _uptimeText = '--');
      }
      return;
    }
    final d = DateTime.now().difference(widget.startedAt!);
    final h = d.inHours;
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    final text = h > 0 ? '${h}h ${m}m ${s}s' : '${m}m ${s}s';
    if (text != _uptimeText) {
      setState(() => _uptimeText = text);
    }
  }

  Future<void> _runHealthCheck() async {
    if (widget.controlPort == null) {
      if (_isHealthy) setState(() => _isHealthy = false);
      return;
    }
    final (healthy, latency) = await runHealthCheck(widget.controlPort!);
    if (!mounted) return;
    setState(() {
      _isHealthy = healthy;
      _latencyMs = latency;
      _lastCheck = DateTime.now();
    });
  }

  String _maskToken(String? token) {
    if (token == null || token.isEmpty) return '(none)';
    if (token.length <= 8) return '****';
    return '${token.substring(0, 4)}****${token.substring(token.length - 4)}';
  }

  String _lastCheckText() {
    if (_lastCheck == null) return 'checking...';
    final ago = DateTime.now().difference(_lastCheck!).inSeconds;
    if (ago < 2) return 'just now';
    return '${ago}s ago';
  }

  @override
  Widget build(BuildContext context) {
    final theme = SsTheme.of(context);

    return Container(
      constraints: const BoxConstraints(maxWidth: 420, maxHeight: 600),
      decoration: BoxDecoration(
        color: theme.surface,
        borderRadius: BorderRadius.circular(theme.borderRadius),
        boxShadow: const [
          BoxShadow(
            color: Color(0x60000000),
            blurRadius: 16,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(theme.borderRadius),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header
              _Header(
                isHealthy: _isHealthy,
                onClose: () => Navigator.of(context).pop(),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Status + Health
                    const SizedBox(height: 12),
                    _SectionLabel('Server'),
                    const SizedBox(height: 8),
                    _InfoRow(
                      label: 'Status',
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: _isHealthy
                                  ? theme.seeding
                                  : theme.error,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            _isHealthy ? 'Running' : 'Offline',
                            style: theme.bodyStyle.copyWith(
                              color: _isHealthy
                                  ? theme.seeding
                                  : theme.error,
                            ),
                          ),
                        ],
                      ),
                    ),
                    _InfoRow(
                      label: 'Control API',
                      value: widget.controlPort != null
                          ? 'http://127.0.0.1:${widget.controlPort}'
                          : '--',
                      mono: true,
                    ),
                    _InfoRow(
                      label: 'Stream Server',
                      value: widget.streamPort != null
                          ? 'http://127.0.0.1:${widget.streamPort}'
                          : 'Discovering...',
                      mono: widget.streamPort != null,
                    ),
                    _InfoRow(
                      label: 'Auth Token',
                      value: _maskToken(widget.authToken),
                      mono: true,
                    ),
                    _InfoRow(
                      label: 'Health Check',
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            _lastCheck != null
                                ? '${_latencyMs}ms'
                                : '--',
                            style: theme.monoStyle.copyWith(
                              fontSize: 12,
                              color: _isHealthy
                                  ? theme.seeding
                                  : theme.error,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            '(${_lastCheckText()})',
                            style: theme.captionStyle,
                          ),
                        ],
                      ),
                    ),
                    _InfoRow(label: 'Uptime', value: _uptimeText),

                    // Torrent stats
                    const SizedBox(height: 16),
                    _SectionLabel('Torrents'),
                    const SizedBox(height: 8),
                    _InfoRow(
                      label: 'Active',
                      value: '${widget.activeTorrents}',
                    ),
                    _InfoRow(
                      label: 'Total Download',
                      child: Text(
                        formatRate(widget.totalDownloadRate),
                        style: theme.monoStyle.copyWith(
                          fontSize: 12,
                          color: theme.downloading,
                        ),
                      ),
                    ),
                    _InfoRow(
                      label: 'Total Upload',
                      child: Text(
                        formatRate(widget.totalUploadRate),
                        style: theme.monoStyle.copyWith(
                          fontSize: 12,
                          color: theme.seeding,
                        ),
                      ),
                    ),

                    // Endpoints
                    const SizedBox(height: 16),
                    _SectionLabel('Endpoints'),
                    const SizedBox(height: 8),
                    const _EndpointRow(
                      method: 'GET',
                      path: '/api/torrents',
                      desc: 'List all torrents',
                    ),
                    const _EndpointRow(
                      method: 'POST',
                      path: '/api/torrents',
                      desc: 'Add torrent',
                    ),
                    const _EndpointRow(
                      method: 'GET',
                      path: '/api/torrents/{id}/status',
                      desc: 'Torrent status',
                    ),
                    const _EndpointRow(
                      method: 'GET',
                      path: '/api/torrents/{id}/files',
                      desc: 'List files',
                    ),
                    const _EndpointRow(
                      method: 'DELETE',
                      path: '/api/torrents/{id}',
                      desc: 'Remove torrent',
                    ),
                    const _EndpointRow(
                      method: 'GET',
                      path: '/api/cache',
                      desc: 'Cache entries',
                    ),
                    const _EndpointRow(
                      method: 'GET',
                      path: '/stream/{id}/{fi}',
                      desc: 'Video stream',
                    ),
                    const SizedBox(height: 16),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ─── Subwidgets ──────────────────────────────────────────────────────────────

class _Header extends StatelessWidget {
  final bool isHealthy;
  final VoidCallback onClose;

  const _Header({required this.isHealthy, required this.onClose});

  @override
  Widget build(BuildContext context) {
    final theme = SsTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: theme.onSurface.withValues(alpha: 0.05),
        border: Border(
          bottom: BorderSide(color: theme.onSurface.withValues(alpha: 0.08)),
        ),
      ),
      child: Row(
        children: [
          Icon(
            const IconData(0xe1e5, fontFamily: 'MaterialIcons'), // dns
            size: 20,
            color: isHealthy ? theme.seeding : theme.error,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              'Server Diagnostics',
              style: theme.headingStyle.copyWith(fontSize: 16),
            ),
          ),
          SsBadge(
            label: isHealthy ? 'ONLINE' : 'OFFLINE',
            color: isHealthy ? theme.seeding : theme.error,
          ),
          const SizedBox(width: 12),
          GestureDetector(
            onTap: onClose,
            child: Icon(
              const IconData(0xe16a, fontFamily: 'MaterialIcons'), // close
              size: 20,
              color: theme.onSurface.withValues(alpha: 0.6),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) {
    final theme = SsTheme.of(context);
    return Text(
      text.toUpperCase(),
      style: theme.captionStyle.copyWith(
        fontWeight: FontWeight.w600,
        letterSpacing: 1.2,
        color: theme.onSurface.withValues(alpha: 0.5),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String? value;
  final Widget? child;
  final bool mono;

  const _InfoRow({
    required this.label,
    this.value,
    this.child,
    this.mono = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = SsTheme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(
            width: 110,
            child: Text(label, style: theme.captionStyle),
          ),
          Expanded(
            child: child ??
                Text(
                  value ?? '--',
                  style: mono
                      ? theme.monoStyle.copyWith(fontSize: 12)
                      : theme.bodyStyle.copyWith(fontSize: 13),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
          ),
        ],
      ),
    );
  }
}

class _EndpointRow extends StatelessWidget {
  final String method;
  final String path;
  final String desc;

  const _EndpointRow({
    required this.method,
    required this.path,
    required this.desc,
  });

  Color _methodColor(SsThemeData theme) {
    switch (method) {
      case 'GET':
        return theme.seeding;
      case 'POST':
        return theme.downloading;
      case 'DELETE':
        return theme.error;
      default:
        return theme.onSurface;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = SsTheme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          SizedBox(
            width: 52,
            child: Text(
              method,
              style: theme.monoStyle.copyWith(
                fontSize: 10,
                color: _methodColor(theme),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: Text(
              path,
              style: theme.monoStyle.copyWith(fontSize: 11),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 8),
          Text(desc, style: theme.captionStyle.copyWith(fontSize: 10)),
        ],
      ),
    );
  }
}
