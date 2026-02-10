import 'package:flutter/widgets.dart';
import 'package:flutter_seekserve_ui/flutter_seekserve_ui.dart';

import 'init_stub.dart'
    if (dart.library.io) 'init_native.dart'
    if (dart.library.js_interop) 'init_web.dart';
import 'router.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  platformInit();
  runApp(const SeekServeApp());
}

class SeekServeApp extends StatefulWidget {
  const SeekServeApp({super.key});

  @override
  State<SeekServeApp> createState() => _SeekServeAppState();
}

class _SeekServeAppState extends State<SeekServeApp> {
  final SsTorrentManager _manager = SsTorrentManager();
  bool _initialised = false;

  @override
  void initState() {
    super.initState();
    _initEngine();
  }

  Future<void> _initEngine() async {
    final config = await getPlatformConfig();
    await _manager.init(config.savePath ?? '/seekserve', config: config);
    setState(() => _initialised = true);
  }

  @override
  void dispose() {
    _manager.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SsTheme(
      data: SsThemeData.dark(),
      child: ManagerScope(
        manager: _manager,
        child: WidgetsApp(
          title: 'SeekServe',
          color: const Color(0xFF7C4DFF),
          onGenerateRoute: AppRouter.generateRoute,
          initialRoute: '/',
          builder: (ctx, child) {
            if (!_initialised) {
              return const ColoredBox(
                color: Color(0xFF121212),
                child: Center(
                  child: Text(
                    'Starting engine...',
                    style: TextStyle(color: Color(0xFF9E9E9E), fontSize: 14),
                  ),
                ),
              );
            }
            return child ?? const SizedBox.shrink();
          },
        ),
      ),
    );
  }
}

/// Provides the [SsTorrentManager] to the widget tree via InheritedWidget.
class ManagerScope extends InheritedWidget {
  final SsTorrentManager manager;

  const ManagerScope({super.key, required this.manager, required super.child});

  static SsTorrentManager of(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<ManagerScope>()!
        .manager;
  }

  @override
  bool updateShouldNotify(ManagerScope old) => manager != old.manager;
}

/// Extension for easy access to the manager from any widget.
extension ManagerContext on BuildContext {
  SsTorrentManager get manager => ManagerScope.of(this);
}
