import 'models/seekserve_config.dart';
import 'seekserve_client.dart';

/// Stub factory — throws on unsupported platforms.
SeekServeClient createClient({SeekServeConfig? config}) =>
    throw UnsupportedError(
        'No SeekServeClient implementation for this platform.');
