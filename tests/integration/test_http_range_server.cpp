#include <gtest/gtest.h>

#include <cstdio>
#include <fstream>
#include <thread>
#include <chrono>
#include <filesystem>
#include <string>
#include <sstream>

#include <boost/asio/io_context.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>

#include <libtorrent/file_storage.hpp>
#include <libtorrent/torrent_handle.hpp>

#include "seekserve/http_range_server.hpp"
#include "seekserve/byte_source.hpp"
#include "seekserve/byte_range_mapper.hpp"
#include "seekserve/piece_availability.hpp"
#include "seekserve/config.hpp"
#include "seekserve/types.hpp"

namespace seekserve {
namespace {

namespace net = boost::asio;
namespace beast = boost::beast;
namespace http = beast::http;
using tcp = net::ip::tcp;

static constexpr int kFileSize = 5000;
static constexpr int kPieceLength = 1000;
static constexpr int kNumPieces = 5;
static constexpr int kLastPieceSize = 1000;

static std::uint8_t test_byte(std::int64_t pos) {
    return static_cast<std::uint8_t>((pos * 7 + 13) % 256);
}

class HttpRangeServerTest : public ::testing::Test {
protected:
    void SetUp() override {
        // Create temp file
        tmp_dir_ = std::filesystem::temp_directory_path() /
            ("seekserve_test_http_" + std::to_string(
                std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(tmp_dir_);
        file_path_ = (tmp_dir_ / "test.bin").string();

        std::ofstream out(file_path_, std::ios::binary);
        ASSERT_TRUE(out.is_open());
        for (int i = 0; i < kFileSize; ++i) {
            auto b = test_byte(i);
            out.write(reinterpret_cast<const char*>(&b), 1);
        }
        out.close();

        // Build file_storage
        fs_.set_piece_length(kPieceLength);
        fs_.add_file("test.bin", kFileSize);
        fs_.set_num_pieces(kNumPieces);

        mapper_ = std::make_unique<ByteRangeMapper>(fs_, 0);
        avail_ = std::make_unique<PieceAvailabilityIndex>(kNumPieces, kPieceLength, kLastPieceSize);

        // Mark all pieces complete (we want HTTP tests, not download blocking tests)
        for (int i = 0; i < kNumPieces; ++i) avail_->mark_complete(i);

        source_ = std::make_shared<ByteSource>(
            lt::torrent_handle{}, 0, file_path_, *mapper_, *avail_, std::chrono::seconds(5));

        // Set up server
        server_ = std::make_unique<HttpRangeServer>(ioc_, ServerConfig{});
        server_->set_byte_source(source_, "abc123", 0);
        server_->set_auth_token("testtoken");

        auto result = server_->start(0);
        ASSERT_TRUE(result.ok()) << result.error().message();
        port_ = result.value();

        // Run io_context in background
        io_thread_ = std::thread([this] { ioc_.run(); });
    }

    void TearDown() override {
        server_->stop();
        ioc_.stop();
        if (io_thread_.joinable()) io_thread_.join();
        std::filesystem::remove_all(tmp_dir_);
    }

    // HTTP client helper for GET requests
    http::response<http::string_body> do_get(const std::string& target,
                                              const std::string& range_header = "") {
        net::io_context client_ioc;
        tcp::resolver resolver(client_ioc);
        beast::tcp_stream stream(client_ioc);

        auto results = resolver.resolve("127.0.0.1", std::to_string(port_));
        stream.connect(results);

        http::request<http::empty_body> req{http::verb::get, target, 11};
        req.set(http::field::host, "127.0.0.1");
        if (!range_header.empty()) {
            req.set(http::field::range, range_header);
        }

        http::write(stream, req);

        beast::flat_buffer buffer;
        http::response<http::string_body> res;
        http::read(stream, buffer, res);

        boost::system::error_code ec;
        stream.socket().shutdown(tcp::socket::shutdown_both, ec);
        return res;
    }

    // HTTP client helper for HEAD requests (parser skips body)
    http::response<http::empty_body> do_head(const std::string& target,
                                              const std::string& range_header = "") {
        net::io_context client_ioc;
        tcp::resolver resolver(client_ioc);
        beast::tcp_stream stream(client_ioc);

        auto results = resolver.resolve("127.0.0.1", std::to_string(port_));
        stream.connect(results);

        http::request<http::empty_body> req{http::verb::head, target, 11};
        req.set(http::field::host, "127.0.0.1");
        if (!range_header.empty()) {
            req.set(http::field::range, range_header);
        }

        http::write(stream, req);

        beast::flat_buffer buffer;
        http::response_parser<http::empty_body> parser;
        parser.skip(true);
        http::read(stream, buffer, parser);

        boost::system::error_code ec;
        stream.socket().shutdown(tcp::socket::shutdown_both, ec);
        return parser.release();
    }

    std::filesystem::path tmp_dir_;
    std::string file_path_;
    lt::file_storage fs_;
    std::unique_ptr<ByteRangeMapper> mapper_;
    std::unique_ptr<PieceAvailabilityIndex> avail_;
    std::shared_ptr<ByteSource> source_;

    net::io_context ioc_;
    std::unique_ptr<HttpRangeServer> server_;
    std::uint16_t port_ = 0;
    std::thread io_thread_;
};

// --- HEAD request ---

TEST_F(HttpRangeServerTest, HeadReturnsAcceptRanges) {
    auto res = do_head("/stream/abc123/0?token=testtoken");

    EXPECT_EQ(res.result(), http::status::ok);
    EXPECT_EQ(res[http::field::accept_ranges], "bytes");
    EXPECT_EQ(std::stoll(std::string(res[http::field::content_length])), kFileSize);
}

// --- GET without Range → 200 OK ---

TEST_F(HttpRangeServerTest, GetWithoutRangeReturnsFullBody) {
    auto res = do_get("/stream/abc123/0?token=testtoken");

    EXPECT_EQ(res.result(), http::status::ok);
    EXPECT_EQ(res[http::field::accept_ranges], "bytes");
    ASSERT_EQ(static_cast<int>(res.body().size()), kFileSize);

    for (int i = 0; i < kFileSize; ++i) {
        EXPECT_EQ(static_cast<std::uint8_t>(res.body()[i]), test_byte(i))
            << "Mismatch at byte " << i;
    }
}

// --- GET with Range → 206 Partial Content ---

TEST_F(HttpRangeServerTest, GetRangeReturns206) {
    auto res = do_get("/stream/abc123/0?token=testtoken", "bytes=0-499");

    EXPECT_EQ(res.result(), http::status::partial_content);
    EXPECT_EQ(res[http::field::accept_ranges], "bytes");
    EXPECT_EQ(std::string(res[http::field::content_range]),
              "bytes 0-499/" + std::to_string(kFileSize));

    ASSERT_EQ(static_cast<int>(res.body().size()), 500);
    for (int i = 0; i < 500; ++i) {
        EXPECT_EQ(static_cast<std::uint8_t>(res.body()[i]), test_byte(i));
    }
}

TEST_F(HttpRangeServerTest, GetRangeMiddle) {
    auto res = do_get("/stream/abc123/0?token=testtoken", "bytes=1000-1999");

    EXPECT_EQ(res.result(), http::status::partial_content);
    EXPECT_EQ(std::string(res[http::field::content_range]),
              "bytes 1000-1999/" + std::to_string(kFileSize));

    ASSERT_EQ(static_cast<int>(res.body().size()), 1000);
    for (int i = 0; i < 1000; ++i) {
        EXPECT_EQ(static_cast<std::uint8_t>(res.body()[i]), test_byte(1000 + i));
    }
}

TEST_F(HttpRangeServerTest, GetOpenEndedRange) {
    auto res = do_get("/stream/abc123/0?token=testtoken", "bytes=4500-");

    EXPECT_EQ(res.result(), http::status::partial_content);
    EXPECT_EQ(std::string(res[http::field::content_range]),
              "bytes 4500-4999/" + std::to_string(kFileSize));

    ASSERT_EQ(static_cast<int>(res.body().size()), 500);
    for (int i = 0; i < 500; ++i) {
        EXPECT_EQ(static_cast<std::uint8_t>(res.body()[i]), test_byte(4500 + i));
    }
}

TEST_F(HttpRangeServerTest, GetSuffixRange) {
    auto res = do_get("/stream/abc123/0?token=testtoken", "bytes=-100");

    EXPECT_EQ(res.result(), http::status::partial_content);
    EXPECT_EQ(std::string(res[http::field::content_range]),
              "bytes 4900-4999/" + std::to_string(kFileSize));

    ASSERT_EQ(static_cast<int>(res.body().size()), 100);
    for (int i = 0; i < 100; ++i) {
        EXPECT_EQ(static_cast<std::uint8_t>(res.body()[i]), test_byte(4900 + i));
    }
}

// --- 416 Range Not Satisfiable ---

TEST_F(HttpRangeServerTest, InvalidRangeReturns416) {
    auto res = do_get("/stream/abc123/0?token=testtoken", "bytes=10000-20000");

    EXPECT_EQ(res.result(), http::status::range_not_satisfiable);
    EXPECT_EQ(std::string(res[http::field::content_range]),
              "bytes */" + std::to_string(kFileSize));
}

// --- 404 for unknown stream ---

TEST_F(HttpRangeServerTest, UnknownStreamReturns404) {
    auto res = do_get("/stream/deadbeef/99?token=testtoken");

    EXPECT_EQ(res.result(), http::status::not_found);
}

TEST_F(HttpRangeServerTest, InvalidPathReturns404) {
    auto res = do_get("/invalid/path?token=testtoken");

    EXPECT_EQ(res.result(), http::status::not_found);
}

// --- Auth ---

TEST_F(HttpRangeServerTest, WrongTokenReturns403) {
    auto res = do_get("/stream/abc123/0?token=wrongtoken");

    EXPECT_EQ(res.result(), http::status::forbidden);
}

TEST_F(HttpRangeServerTest, MissingTokenReturns403) {
    auto res = do_get("/stream/abc123/0");

    EXPECT_EQ(res.result(), http::status::forbidden);
}

// --- HEAD with Range ---

TEST_F(HttpRangeServerTest, HeadWithRangeReturns206) {
    auto res = do_head("/stream/abc123/0?token=testtoken", "bytes=0-499");

    EXPECT_EQ(res.result(), http::status::partial_content);
    EXPECT_EQ(std::string(res[http::field::content_range]),
              "bytes 0-499/" + std::to_string(kFileSize));
    EXPECT_EQ(std::stoll(std::string(res[http::field::content_length])), 500);
}

// --- stream_url() ---

TEST_F(HttpRangeServerTest, StreamUrlFormat) {
    auto url = server_->stream_url("abc123", 0);
    EXPECT_NE(url.find("127.0.0.1"), std::string::npos);
    EXPECT_NE(url.find(std::to_string(port_)), std::string::npos);
    EXPECT_NE(url.find("/stream/abc123/0"), std::string::npos);
    EXPECT_NE(url.find("token=testtoken"), std::string::npos);
}

}  // namespace
}  // namespace seekserve
