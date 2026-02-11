import 'package:flutter/widgets.dart';

import 'screens/home_screen.dart';
import 'screens/player_screen.dart';
import 'screens/torrent_detail_screen.dart';

/// Route arguments for the torrent detail screen.
class TorrentDetailArgs {
  final String torrentId;
  const TorrentDetailArgs({required this.torrentId});
}

/// Route arguments for the player screen.
class PlayerArgs {
  final String streamUrl;
  final String torrentId;
  final String fileName;
  const PlayerArgs({
    required this.streamUrl,
    required this.torrentId,
    required this.fileName,
  });
}

class AppRouter {
  static Route<dynamic> _homeRoute(RouteSettings settings) {
    return PageRouteBuilder(
      settings: const RouteSettings(name: '/'),
      pageBuilder: (ctx, a1, a2) => const HomeScreen(),
      transitionsBuilder: _fade,
    );
  }

  static Route<dynamic> generateRoute(RouteSettings settings) {
    switch (settings.name) {
      case '/':
        return PageRouteBuilder(
          settings: settings,
          pageBuilder: (ctx, a1, a2) => const HomeScreen(),
          transitionsBuilder: _fade,
        );

      case '/detail':
        if (settings.arguments is! TorrentDetailArgs) {
          return _homeRoute(settings);
        }
        final detailArgs = settings.arguments as TorrentDetailArgs;
        return PageRouteBuilder(
          settings: settings,
          pageBuilder: (ctx, a1, a2) =>
              TorrentDetailScreen(torrentId: detailArgs.torrentId),
          transitionsBuilder: _fade,
        );

      case '/player':
        if (settings.arguments is! PlayerArgs) {
          return _homeRoute(settings);
        }
        final playerArgs = settings.arguments as PlayerArgs;
        return PageRouteBuilder(
          settings: settings,
          pageBuilder: (ctx, a1, a2) => AppPlayerScreen(
            streamUrl: playerArgs.streamUrl,
            torrentId: playerArgs.torrentId,
            fileName: playerArgs.fileName,
          ),
          transitionsBuilder: _fade,
        );

      default:
        return PageRouteBuilder(
          settings: settings,
          pageBuilder: (ctx, a1, a2) => const HomeScreen(),
          transitionsBuilder: _fade,
        );
    }
  }

  static Widget _fade(
    BuildContext ctx,
    Animation<double> animation,
    Animation<double> secondary,
    Widget child,
  ) {
    return FadeTransition(opacity: animation, child: child);
  }
}
