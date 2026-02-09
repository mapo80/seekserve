// Error codes matching seekserve_c.h defines.
const int SS_OK = 0;
const int SS_ERR_INVALID_ARG = -1;
const int SS_ERR_NOT_FOUND = -2;
const int SS_ERR_METADATA_PENDING = -3;
const int SS_ERR_TIMEOUT = -4;
const int SS_ERR_IO = -5;
const int SS_ERR_ALREADY_RUNNING = -6;
const int SS_ERR_CANCELLED = -7;

/// Exception thrown when a SeekServe C API call returns an error.
class SeekServeException implements Exception {
  final int errorCode;
  final String message;

  const SeekServeException(this.errorCode, this.message);

  factory SeekServeException.fromCode(int code) {
    return SeekServeException(code, _messageForCode(code));
  }

  static String _messageForCode(int code) {
    switch (code) {
      case SS_ERR_INVALID_ARG:
        return 'Invalid argument';
      case SS_ERR_NOT_FOUND:
        return 'Torrent or file not found';
      case SS_ERR_METADATA_PENDING:
        return 'Metadata not yet received';
      case SS_ERR_TIMEOUT:
        return 'Operation timed out';
      case SS_ERR_IO:
        return 'I/O error';
      case SS_ERR_ALREADY_RUNNING:
        return 'Server already running';
      case SS_ERR_CANCELLED:
        return 'Operation cancelled';
      default:
        return 'Unknown error ($code)';
    }
  }

  @override
  String toString() => 'SeekServeException($errorCode): $message';
}

/// Checks the error code and throws [SeekServeException] if non-zero.
void checkError(int code) {
  if (code != SS_OK) {
    throw SeekServeException.fromCode(code);
  }
}
