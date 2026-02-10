/*

Copyright (c) 2024, SeekServe Contributors
All rights reserved.

Emscripten-specific WebSocket tracker connection using datachannel-wasm's
rtc::WebSocket (browser-native WebSocket) instead of Beast+SSL.

You may use, distribute and modify this code under the terms of the BSD license,
see LICENSE file.
*/

#ifndef TORRENT_WASM_WEBSOCKET_TRACKER_CONNECTION_HPP_INCLUDED
#define TORRENT_WASM_WEBSOCKET_TRACKER_CONNECTION_HPP_INCLUDED

#include "libtorrent/config.hpp"

#if TORRENT_USE_RTC && defined(__EMSCRIPTEN__)

#include "libtorrent/aux_/websocket_tracker_connection.hpp" // tracker_answer, websocket_tracker_response, parse fn
#include "libtorrent/aux_/tracker_manager.hpp"
#include "libtorrent/error_code.hpp"
#include "libtorrent/io_context.hpp"
#include "libtorrent/peer_id.hpp"

#include <rtc/websocket.hpp>

#include <map>
#include <memory>
#include <queue>
#include <string>
#include <tuple>
#include <variant>

namespace libtorrent::aux {

struct TORRENT_EXTRA_EXPORT wasm_websocket_tracker_connection
	: tracker_connection
{
	friend class tracker_manager;

	wasm_websocket_tracker_connection(
		io_context& ios
		, tracker_manager& man
		, tracker_request const& req
		, std::weak_ptr<request_callback> cb);

	~wasm_websocket_tracker_connection() override;

	void start() override;
	void close() override;

	bool is_started() const;
	bool is_open() const;

	void queue_request(tracker_request req, std::weak_ptr<request_callback> cb);
	void queue_answer(tracker_answer ans);

private:
	std::shared_ptr<wasm_websocket_tracker_connection> shared_from_this()
	{
		return std::static_pointer_cast<wasm_websocket_tracker_connection>(
			tracker_connection::shared_from_this());
	}

	void send_pending();
	void do_send(tracker_request const& req);
	void do_send(tracker_answer const& ans);
	void on_timeout(error_code const& ec) override;
	void on_open();
	void on_message(rtc::message_variant data);
	void on_error(rtc::string error);
	void on_closed();
	void handle_message(std::string const& json_str);
	void fail(operation_t op, error_code const& ec);

	io_context& m_io_context;
	std::shared_ptr<rtc::WebSocket> m_websocket;

	using tracker_message = std::variant<tracker_request, tracker_answer>;
	std::queue<std::tuple<tracker_message, std::weak_ptr<request_callback>>> m_pending;
	std::map<sha1_hash, std::weak_ptr<request_callback>> m_callbacks;

	bool m_sending = false;
};

} // namespace libtorrent::aux

#endif // TORRENT_USE_RTC && __EMSCRIPTEN__
#endif // TORRENT_WASM_WEBSOCKET_TRACKER_CONNECTION_HPP_INCLUDED
