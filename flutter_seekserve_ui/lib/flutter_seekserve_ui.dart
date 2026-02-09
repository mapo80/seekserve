/// Reusable UI widgets for SeekServe torrent streaming.
///
/// Provides a complete set of themed, Material-free widgets for
/// torrent management, file browsing, and video playback.
library;

// Theme
export 'src/theme/ss_theme.dart';
export 'src/theme/ss_theme_data.dart';

// Atoms
export 'src/atoms/ss_badge.dart';
export 'src/atoms/ss_button.dart';
export 'src/atoms/ss_card.dart';
export 'src/atoms/ss_chip.dart';
export 'src/atoms/ss_dialog.dart';
export 'src/atoms/ss_icon_button.dart';
export 'src/atoms/ss_progress_bar.dart';
export 'src/atoms/ss_slider.dart';
export 'src/atoms/ss_text_field.dart';

// Composites
export 'src/composites/ss_add_torrent_bar.dart';
export 'src/composites/ss_add_torrent_dialog.dart';
export 'src/composites/ss_delete_confirm.dart';
export 'src/composites/ss_file_tile.dart';
export 'src/composites/ss_server_status_panel.dart';
export 'src/composites/ss_file_tree.dart';
export 'src/composites/ss_stream_mode_badge.dart';
export 'src/composites/ss_torrent_detail.dart';
export 'src/composites/ss_torrent_list.dart';
export 'src/composites/ss_torrent_tile.dart';
export 'src/composites/ss_transfer_stats.dart';

// Player
export 'src/player/ss_buffering_overlay.dart';
export 'src/player/ss_player_status_bar.dart';
export 'src/player/ss_seek_controls_stub.dart'
    if (dart.library.io) 'src/player/ss_seek_controls.dart';
export 'src/player/ss_video_player.dart';

// Controllers
export 'src/controllers/ss_torrent_manager.dart';

// Utils
export 'src/utils/format.dart';
