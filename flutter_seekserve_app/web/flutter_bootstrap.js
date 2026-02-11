{{flutter_js}}
{{flutter_build_config}}

// Load WITHOUT serviceWorkerSettings — SeekServe registers its own SW
// from Dart code (client_wasm.dart) to avoid conflicts with Flutter's
// flutter_service_worker.js.
_flutter.loader.load();
