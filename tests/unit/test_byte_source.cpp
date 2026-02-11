#include <gtest/gtest.h>

#include <cstdio>
#include <fstream>
#include <thread>
#include <chrono>
#include <filesystem>

#include <libtorrent/file_storage.hpp>
#include <libtorrent/torrent_handle.hpp>

#include "seekserve/byte_source.hpp"
#include "seekserve/byte_range_mapper.hpp"
#include "seekserve/piece_availability.hpp"
#include "seekserve/types.hpp"
#include "seekserve/error.hpp"

namespace seekserve {
namespace {

// Single-file torrent layout for testing:
//   file: "test.bin", 2500 bytes, piece_length=1000
//   piece 0: [0, 999], piece 1: [1000, 1999], piece 2: [2000, 2499] (500 bytes)

static constexpr int kFileSize = 2500;
static constexpr int kPieceLength = 1000;
static constexpr int kNumPieces = 3;
static constexpr int kLastPieceSize = 500;

static std::uint8_t test_byte(std::int64_t pos) {
    return static_cast<std::uint8_t>((pos * 7 + 13) % 256);
}

class ByteSourceTest : public ::testing::Test {
protected:
    void SetUp() override {
        // Create temp directory and file
        tmp_dir_ = std::filesystem::temp_directory_path() /
            ("seekserve_test_m3_" + std::to_string(
                std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(tmp_dir_);
        file_path_ = (tmp_dir_ / "test.bin").string();

        // Write known content
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
    }

    void TearDown() override {
        std::filesystem::remove_all(tmp_dir_);
    }

    void mark_all_complete() {
        for (int i = 0; i < kNumPieces; ++i) avail_->mark_complete(i);
    }

    std::unique_ptr<ByteSource> make_source(
        std::chrono::milliseconds timeout = std::chrono::seconds(5))
    {
        return std::make_unique<ByteSource>(
            lt::torrent_handle{}, 0, file_path_, *mapper_, *avail_, timeout);
    }

    std::filesystem::path tmp_dir_;
    std::string file_path_;
    lt::file_storage fs_;
    std::unique_ptr<ByteRangeMapper> mapper_;
    std::unique_ptr<PieceAvailabilityIndex> avail_;
};

// --- read() on available ranges ---

TEST_F(ByteSourceTest, ReadFirstBytes) {
    mark_all_complete();
    auto src = make_source();

    auto result = src->read(0, 100);
    ASSERT_TRUE(result.ok()) << result.error().message();

    auto& buf = result.value();
    ASSERT_EQ(static_cast<int>(buf.size()), 100);
    for (int i = 0; i < 100; ++i) {
        EXPECT_EQ(buf[i], test_byte(i)) << "Mismatch at byte " << i;
    }
}

TEST_F(ByteSourceTest, ReadMiddleOfFile) {
    mark_all_complete();
    auto src = make_source();

    auto result = src->read(1500, 200);
    ASSERT_TRUE(result.ok());

    auto& buf = result.value();
    ASSERT_EQ(static_cast<int>(buf.size()), 200);
    for (int i = 0; i < 200; ++i) {
        EXPECT_EQ(buf[i], test_byte(1500 + i)) << "Mismatch at byte " << i;
    }
}

TEST_F(ByteSourceTest, ReadCrossPieceBoundary) {
    avail_->mark_complete(0);
    avail_->mark_complete(1);
    auto src = make_source();

    // Read 20 bytes across piece 0→1 boundary
    auto result = src->read(990, 20);
    ASSERT_TRUE(result.ok());

    auto& buf = result.value();
    ASSERT_EQ(static_cast<int>(buf.size()), 20);
    for (int i = 0; i < 20; ++i) {
        EXPECT_EQ(buf[i], test_byte(990 + i));
    }
}

TEST_F(ByteSourceTest, ReadLastPiece) {
    avail_->mark_complete(2);
    auto src = make_source();

    auto result = src->read(2000, 500);
    ASSERT_TRUE(result.ok());

    auto& buf = result.value();
    ASSERT_EQ(static_cast<int>(buf.size()), 500);
    for (int i = 0; i < 500; ++i) {
        EXPECT_EQ(buf[i], test_byte(2000 + i));
    }
}

TEST_F(ByteSourceTest, ReadSingleByte) {
    avail_->mark_complete(0);
    auto src = make_source();

    auto result = src->read(42, 1);
    ASSERT_TRUE(result.ok());

    auto& buf = result.value();
    ASSERT_EQ(buf.size(), 1u);
    EXPECT_EQ(buf[0], test_byte(42));
}

// --- read() blocking + timeout ---

TEST_F(ByteSourceTest, ReadTimesOutWhenNotAvailable) {
    // No pieces marked complete, short timeout
    auto src = make_source(std::chrono::milliseconds(100));

    auto result = src->read(0, 100);
    ASSERT_FALSE(result.ok());
    EXPECT_EQ(result.error(), make_error_code(errc::timeout_waiting_for_piece));
}

// --- read() blocking + notify ---

TEST_F(ByteSourceTest, ReadUnblocksOnPieceComplete) {
    auto src = make_source(std::chrono::seconds(5));

    Result<std::vector<std::uint8_t>> result = make_error_code(errc::cancelled);

    std::thread reader([&] {
        result = src->read(0, 100);  // needs piece 0
    });

    // Wait for the reader thread to start waiting
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    // Mark piece 0 complete and notify
    avail_->mark_complete(0);
    src->notify_piece_complete();

    reader.join();

    ASSERT_TRUE(result.ok()) << result.error().message();
    ASSERT_EQ(static_cast<int>(result.value().size()), 100);
    for (int i = 0; i < 100; ++i) {
        EXPECT_EQ(result.value()[i], test_byte(i));
    }
}

TEST_F(ByteSourceTest, ReadUnblocksMultiplePieces) {
    auto src = make_source(std::chrono::seconds(5));

    Result<std::vector<std::uint8_t>> result = make_error_code(errc::cancelled);

    std::thread reader([&] {
        result = src->read(990, 20);  // needs pieces 0 and 1
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    // Mark piece 0 — not enough yet
    avail_->mark_complete(0);
    src->notify_piece_complete();

    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    // Mark piece 1 — now both available
    avail_->mark_complete(1);
    src->notify_piece_complete();

    reader.join();

    ASSERT_TRUE(result.ok()) << result.error().message();
    ASSERT_EQ(static_cast<int>(result.value().size()), 20);
}

// --- cancel() ---

TEST_F(ByteSourceTest, CancelUnblocksRead) {
    auto src = make_source(std::chrono::seconds(30));

    Result<std::vector<std::uint8_t>> result = make_error_code(errc::io_error);

    std::thread reader([&] {
        result = src->read(0, 100);
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    src->cancel();

    reader.join();

    ASSERT_FALSE(result.ok());
    EXPECT_EQ(result.error(), make_error_code(errc::cancelled));
}

TEST_F(ByteSourceTest, ReadAfterCancelFailsImmediately) {
    auto src = make_source();
    src->cancel();

    auto result = src->read(0, 100);
    ASSERT_FALSE(result.ok());
    EXPECT_EQ(result.error(), make_error_code(errc::cancelled));
}

// --- is_available() ---

TEST_F(ByteSourceTest, IsAvailableComplete) {
    avail_->mark_complete(0);
    avail_->mark_complete(1);
    auto src = make_source();

    EXPECT_TRUE(src->is_available(0, 100));       // piece 0
    EXPECT_TRUE(src->is_available(500, 500));      // piece 0
    EXPECT_TRUE(src->is_available(1000, 100));     // piece 1
    EXPECT_TRUE(src->is_available(990, 20));       // pieces 0+1
}

TEST_F(ByteSourceTest, IsAvailableIncomplete) {
    avail_->mark_complete(0);
    // piece 1 and 2 NOT complete
    auto src = make_source();

    EXPECT_TRUE(src->is_available(0, 100));        // piece 0 only — OK
    EXPECT_FALSE(src->is_available(990, 20));      // needs piece 0+1
    EXPECT_FALSE(src->is_available(1000, 100));    // needs piece 1
    EXPECT_FALSE(src->is_available(2000, 100));    // needs piece 2
}

// --- file_size() ---

TEST_F(ByteSourceTest, FileSize) {
    auto src = make_source();
    EXPECT_EQ(src->file_size(), kFileSize);
}

// --- read_from_disk edge cases ---

TEST_F(ByteSourceTest, ReadFromNonExistentFile) {
    mark_all_complete();
    auto src = std::make_unique<ByteSource>(
        lt::torrent_handle{}, 0, "/tmp/seekserve_nonexistent_file.bin",
        *mapper_, *avail_, std::chrono::seconds(1));

    auto result = src->read(0, 100);
    ASSERT_FALSE(result.ok());
    EXPECT_EQ(result.error(), make_error_code(errc::io_error));
}

TEST_F(ByteSourceTest, ReadEntireFile) {
    mark_all_complete();
    auto src = make_source();

    auto result = src->read(0, kFileSize);
    ASSERT_TRUE(result.ok());
    ASSERT_EQ(static_cast<int>(result.value().size()), kFileSize);

    for (int i = 0; i < kFileSize; ++i) {
        EXPECT_EQ(result.value()[i], test_byte(i)) << "Mismatch at " << i;
    }
}

}  // namespace
}  // namespace seekserve
