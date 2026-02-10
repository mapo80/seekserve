/*

Copyright (c) 2024, SeekServe Contributors
All rights reserved.

Emscripten-specific WebSocket tracker connection using datachannel-wasm's
rtc::WebSocket (browser-native WebSocket) instead of Beast+SSL.
Implements the WebTorrent tracker JSON protocol for peer discovery.

You may use, distribute and modify this code under the terms of the BSD license,
see LICENSE file.
*/

#include "libtorrent/config.hpp" // for TORRENT_USE_RTC

#if TORRENT_USE_RTC && defined(__EMSCRIPTEN__)

#include "libtorrent/aux_/wasm_websocket_tracker_connection.hpp"
#include "libtorrent/aux_/utf8.hpp"
#include "libtorrent/aux_/session_settings.hpp"
#include "libtorrent/settings_pack.hpp"
#include "libtorrent/span.hpp"

#include "libtorrent/aux_/disable_warnings_push.hpp"
#include <boost/system/system_error.hpp>
#include <boost/json.hpp>
// Note: do NOT include <boost/json/src.hpp> here — websocket_tracker_connection.cpp
// already includes it when BOOST_JSON_HEADER_ONLY is defined.
#include "libtorrent/aux_/disable_warnings_pop.hpp"

#include <cstdio>
#include <functional>
#include <string>
#include <string_view>

namespace libtorrent::aux {

namespace errc = boost::system::errc;
namespace error = boost::asio::error;
namespace json = boost::json;

namespace {

std::string utf8_latin1(json::string const& sv)
{
	return aux::utf8_latin1(std::string_view{sv.data(), sv.size()});
}

} // anonymous namespace

wasm_websocket_tracker_connection::wasm_websocket_tracker_connection(
	io_context& ios
	, tracker_manager& man
	, tracker_request const& req
	, std::weak_ptr<request_callback> cb)
	: tracker_connection(man, req, ios, cb)
	, m_io_context(ios)
{
	queue_request(req, std::move(cb));
}

wasm_websocket_tracker_connection::~wasm_websocket_tracker_connection()
{
	close();
}

void wasm_websocket_tracker_connection::start()
{
	if (is_started()) return;

	m_websocket = std::make_shared<rtc::WebSocket>();

	auto self = shared_from_this();
	m_websocket->onOpen([self]() { self->on_open(); });
	m_websocket->onMessage([self](rtc::message_variant data) {
		self->on_message(std::move(data));
	});
	m_websocket->onError([self](rtc::string error) {
		self->on_error(std::move(error));
	});
	m_websocket->onClosed([self]() { self->on_closed(); });

#ifndef TORRENT_DISABLE_LOGGING
	if (auto cb = requester())
		cb->debug_log("*** WASM_WS_TRACKER_CONNECT [ url: %s ]"
			, tracker_req().url.c_str());
#endif

	m_websocket->open(tracker_req().url);
}

void wasm_websocket_tracker_connection::close()
{
	if (m_websocket)
	{
		// Clear callbacks first to break shared_ptr cycle
		m_websocket->onOpen(nullptr);
		m_websocket->onMessage(nullptr);
		m_websocket->onError(nullptr);
		m_websocket->onClosed(nullptr);
		m_websocket->close();
		m_websocket.reset();
	}

	error_code const ec = error::operation_aborted;
	while (!m_pending.empty())
	{
		auto [msg, callback] = std::move(m_pending.front());
		TORRENT_UNUSED(msg);
		m_pending.pop();
		if (auto cb = callback.lock())
			cb->tracker_request_error(
				tracker_req()
				, ec
				, operation_t::unknown
				, ec.message()
				, seconds32(120));
	}

	m_callbacks.clear();
	m_man.remove_request(this);
}

bool wasm_websocket_tracker_connection::is_started() const
{
	return m_websocket && (m_websocket->isOpen()
		|| m_websocket->readyState() == rtc::WebSocket::State::Connecting);
}

bool wasm_websocket_tracker_connection::is_open() const
{
	return m_websocket && m_websocket->isOpen();
}

void wasm_websocket_tracker_connection::queue_request(
	tracker_request req, std::weak_ptr<request_callback> cb)
{
	m_pending.emplace(tracker_message{std::move(req)}, cb);
	if (is_open()) send_pending();
}

void wasm_websocket_tracker_connection::queue_answer(tracker_answer ans)
{
	m_pending.emplace(tracker_message{std::move(ans)}, std::weak_ptr<request_callback>{});
	if (is_open()) send_pending();
}

void wasm_websocket_tracker_connection::send_pending()
{
	if (m_sending || m_pending.empty()) return;

	m_sending = true;

	auto [msg, callback] = std::move(m_pending.front());
	m_pending.pop();

	std::visit([this, cb = callback](auto const& m)
		{
			if (cb.lock())
			{
				m_requester = cb;
				m_callbacks[m.info_hash] = std::move(cb);
			}

			do_send(m);
		}
		, msg);
}

void wasm_websocket_tracker_connection::do_send(tracker_request const& req)
{
	m_req = req;

	json::object payload;
	payload["action"] = "announce";
	payload["info_hash"] = latin1_utf8(req.info_hash);
	payload["uploaded"] = req.uploaded;
	payload["downloaded"] = req.downloaded;
	payload["left"] = req.left;
	payload["corrupt"] = req.corrupt;
	payload["numwant"] = req.num_want;

	char str_key[9];
	std::snprintf(str_key, sizeof(str_key), "%08X", req.key);
	payload["key"] = str_key;

	if (req.event != event_t::none)
	{
		static const char* event_string[] = { "completed", "started", "stopped", "paused" };
		int event_index = static_cast<int>(req.event) - 1;
		TORRENT_ASSERT(event_index >= 0 && event_index < 4);
		payload["event"] = event_string[event_index];
	}

	payload["peer_id"] = latin1_utf8(req.pid);

	json::array& offers_array = payload["offers"].emplace_array();
	for (auto const& offer : req.offers)
	{
		json::object payload_offer;
		payload_offer["offer_id"] = latin1_utf8(offer.id);
		json::object& obj = payload_offer["offer"].emplace_object();
		obj["type"] = "offer";
		obj["sdp"] = offer.sdp;
		offers_array.emplace_back(std::move(payload_offer));
	}

	std::string const data = json::serialize(payload);

#ifndef TORRENT_DISABLE_LOGGING
	if (auto cb = requester())
		cb->debug_log("*** WASM_WS_TRACKER_WRITE [ size: %ld, data: %s ]"
			, long(data.size()), data.c_str());
#endif

	m_websocket->send(rtc::message_variant{rtc::string{data}});
	m_sending = false;
	send_pending();
}

void wasm_websocket_tracker_connection::do_send(tracker_answer const& ans)
{
	if (!is_open()) return;

	json::object payload;
	payload["action"] = "announce";
	payload["info_hash"] = latin1_utf8(ans.info_hash);
	payload["offer_id"] = latin1_utf8(ans.answer.offer_id);
	payload["to_peer_id"] = latin1_utf8(ans.answer.pid);
	payload["peer_id"] = latin1_utf8(ans.pid);
	json::object& obj = payload["answer"].emplace_object();
	obj["type"] = "answer";
	obj["sdp"] = ans.answer.sdp;

	std::string const data = json::serialize(payload);

#ifndef TORRENT_DISABLE_LOGGING
	if (auto cb = requester())
		cb->debug_log("*** WASM_WS_TRACKER_WRITE [ size: %ld, data: %s ]"
			, long(data.size()), data.c_str());
#endif

	m_websocket->send(rtc::message_variant{rtc::string{data}});
	m_sending = false;
	send_pending();
}

void wasm_websocket_tracker_connection::on_timeout(error_code const& ec)
{
	if (ec)
	{
		fail(operation_t::sock_read, ec);
		return;
	}

#ifndef TORRENT_DISABLE_LOGGING
	if (auto cb = requester())
		cb->debug_log("*** WASM_WS_TRACKER_TIMEOUT [ url: %s ]"
			, tracker_req().url.c_str());
#endif

	fail(operation_t::sock_read, error_code(error::timed_out));
	close();
}

void wasm_websocket_tracker_connection::on_open()
{
#ifndef TORRENT_DISABLE_LOGGING
	if (auto cb = requester())
		cb->debug_log("*** WASM_WS_TRACKER_CONNECTED [ url: %s ]"
			, tracker_req().url.c_str());
#endif

	send_pending();
}

void wasm_websocket_tracker_connection::on_message(rtc::message_variant data)
{
	std::visit(rtc::overloaded{
		[](rtc::binary const&) { /* ignore binary messages */ },
		[this](rtc::string const& str) { handle_message(str); }
	}, data);
}

void wasm_websocket_tracker_connection::on_error(rtc::string error)
{
#ifndef TORRENT_DISABLE_LOGGING
	if (auto cb = requester())
		cb->debug_log("*** WASM_WS_TRACKER_ERROR [ url: %s, error: %s ]"
			, tracker_req().url.c_str(), error.c_str());
#endif

	fail(operation_t::connect, error_code(error::connection_refused));
	close();
}

void wasm_websocket_tracker_connection::on_closed()
{
#ifndef TORRENT_DISABLE_LOGGING
	if (auto cb = requester())
		cb->debug_log("*** WASM_WS_TRACKER_CLOSED [ url: %s ]"
			, tracker_req().url.c_str());
#endif

	close();
}

void wasm_websocket_tracker_connection::handle_message(std::string const& json_str)
{
#ifndef TORRENT_DISABLE_LOGGING
	if (auto cb = requester())
		cb->debug_log("*** WASM_WS_TRACKER_READ [ size: %ld, data: %s ]"
			, long(json_str.size()), json_str.c_str());
#endif

	error_code ec;
	auto ret = parse_websocket_tracker_response(
		{json_str.data(), long(json_str.size())}, ec);

	if (ec)
	{
#ifndef TORRENT_DISABLE_LOGGING
		if (auto cb = requester())
		{
			TORRENT_ASSERT(std::holds_alternative<std::string>(ret));
			cb->debug_log("*** WASM_WS_TRACKER_READ [ ERROR: %s ]"
				, std::get<std::string>(ret).c_str());
		}
#endif
		fail(operation_t::handshake, ec);
		close();
		return;
	}

	TORRENT_ASSERT(std::holds_alternative<websocket_tracker_response>(ret));
	auto response = std::move(std::get<websocket_tracker_response>(ret));

	std::shared_ptr<request_callback> cb;
	if (auto cit = m_callbacks.find(response.info_hash); cit != m_callbacks.end())
		cb = cit->second.lock();

	if (cb)
	{
		if (response.offer)
		{
			response.offer->answer_callback =
				[info_hash = response.info_hash
					, self = shared_from_this()
					, id = response.offer->id
					, pid = response.offer->pid]
				(peer_id const& local_pid
					, aux::rtc_answer const& answer)
				{
					self->queue_answer({std::move(info_hash), std::move(local_pid), std::move(answer)});
					self->start();
				};

			cb->on_rtc_offer(*response.offer);
		}

		if (response.answer)
		{
			cb->on_rtc_answer(*response.answer);
		}

		if (response.resp)
		{
			response.resp->interval = std::max(response.resp->interval
				, seconds32{m_man.settings().get_int(
					settings_pack::min_websocket_announce_interval)});

			cb->tracker_response(tracker_req(), {}, {}, *response.resp);
		}
	}
	else
	{
#ifndef TORRENT_DISABLE_LOGGING
		if (auto cb_ = requester())
			cb_->debug_log("*** WASM_WS_TRACKER_READ [ warning: no callback for info_hash ]");
#endif
		m_callbacks.erase(response.info_hash);
	}
}

void wasm_websocket_tracker_connection::fail(operation_t op, error_code const& ec)
{
	tracker_connection::fail(ec, op, ec.message().c_str(), seconds32{120}, seconds32{120});
}

} // namespace libtorrent::aux

#endif // TORRENT_USE_RTC && __EMSCRIPTEN__
