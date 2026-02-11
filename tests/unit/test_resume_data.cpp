#include <gtest/gtest.h>
#include <filesystem>
#include <chrono>
#include <sqlite3.h>

#include "seekserve/offline_cache.hpp"
#include "seekserve/types.hpp"
#include "seekserve/config.hpp"

namespace fs = std::filesystem;

class ResumeDataTest : public ::testing::Test {
protected:
    void SetUp() override {
        db_path_ = "/tmp/seekserve_test_resume_" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()) + ".db";
    }

    void TearDown() override {
        fs::remove(db_path_);
        fs::remove(db_path_ + "-wal");
        fs::remove(db_path_ + "-shm");
    }

    seekserve::CacheConfig make_config() {
        seekserve::CacheConfig cfg;
        cfg.db_path = db_path_;
        return cfg;
    }

    std::string db_path_;
};

TEST_F(ResumeDataTest, SaveAndLoadResumeData) {
    auto cfg = make_config();
    seekserve::OfflineCacheManager cache(cfg);

    cache.save_torrent_uri("abc123", "magnet:?xt=urn:btih:abc123");

    std::vector<char> data = {0x01, 0x02, 0x03, 0x04, 0x05};
    cache.save_resume_data("abc123", data);

    auto loaded = cache.load_resume_data("abc123");
    ASSERT_EQ(loaded.size(), 5u);
    EXPECT_EQ(loaded, data);
}

TEST_F(ResumeDataTest, ResumeDataPersistsAcrossInstances) {
    auto cfg = make_config();

    std::vector<char> data = {0x10, 0x20, 0x30};

    {
        seekserve::OfflineCacheManager cache(cfg);
        cache.save_torrent_uri("tid1", "magnet:?xt=urn:btih:tid1");
        cache.save_resume_data("tid1", data);
    }

    // Reopen
    {
        seekserve::OfflineCacheManager cache(cfg);
        auto loaded = cache.load_resume_data("tid1");
        ASSERT_EQ(loaded.size(), 3u);
        EXPECT_EQ(loaded, data);
    }
}

TEST_F(ResumeDataTest, ResumeDataOverwrite) {
    auto cfg = make_config();
    seekserve::OfflineCacheManager cache(cfg);

    cache.save_torrent_uri("abc", "magnet:?xt=urn:btih:abc");

    std::vector<char> data1 = {0x01, 0x02};
    cache.save_resume_data("abc", data1);

    std::vector<char> data2 = {
        static_cast<char>(0xAA), static_cast<char>(0xBB),
        static_cast<char>(0xCC), static_cast<char>(0xDD)
    };
    cache.save_resume_data("abc", data2);

    auto loaded = cache.load_resume_data("abc");
    ASSERT_EQ(loaded.size(), 4u);
    EXPECT_EQ(loaded, data2);
}

TEST_F(ResumeDataTest, ResumeDataEmpty) {
    auto cfg = make_config();
    seekserve::OfflineCacheManager cache(cfg);

    auto loaded = cache.load_resume_data("nonexistent");
    EXPECT_TRUE(loaded.empty());
}

TEST_F(ResumeDataTest, SaveSelectedFile) {
    auto cfg = make_config();
    seekserve::OfflineCacheManager cache(cfg);

    cache.save_torrent_uri("abc", "magnet:?xt=urn:btih:abc");
    cache.save_selected_file("abc", 3);

    auto saved = cache.list_saved_torrents();
    ASSERT_EQ(saved.size(), 1u);
    EXPECT_EQ(saved[0].id, "abc");
    EXPECT_EQ(saved[0].selected_file, 3);
}

TEST_F(ResumeDataTest, ListSavedTorrentsWithResumeData) {
    auto cfg = make_config();
    seekserve::OfflineCacheManager cache(cfg);

    cache.save_torrent_uri("t1", "magnet:?xt=urn:btih:t1");
    cache.save_torrent_uri("t2", "magnet:?xt=urn:btih:t2");

    std::vector<char> rd1 = {0x01, 0x02, 0x03};
    cache.save_resume_data("t1", rd1);
    cache.save_selected_file("t1", 8);

    auto saved = cache.list_saved_torrents();
    ASSERT_EQ(saved.size(), 2u);

    // t1 has resume data and selected file
    EXPECT_EQ(saved[0].id, "t1");
    EXPECT_EQ(saved[0].uri, "magnet:?xt=urn:btih:t1");
    EXPECT_EQ(saved[0].resume_data, rd1);
    EXPECT_EQ(saved[0].selected_file, 8);

    // t2 has no resume data, default selected_file
    EXPECT_EQ(saved[1].id, "t2");
    EXPECT_EQ(saved[1].uri, "magnet:?xt=urn:btih:t2");
    EXPECT_TRUE(saved[1].resume_data.empty());
    EXPECT_EQ(saved[1].selected_file, -1);
}

TEST_F(ResumeDataTest, AlterTableMigration) {
    auto cfg = make_config();

    // Create old-schema DB (without resume_data and selected_file)
    {
        sqlite3* db = nullptr;
        sqlite3_open(cfg.db_path.c_str(), &db);
        sqlite3_exec(db, R"(
            CREATE TABLE torrents (
                torrent_id TEXT PRIMARY KEY,
                uri TEXT NOT NULL,
                added_at INTEGER NOT NULL
            );
            INSERT INTO torrents (torrent_id, uri, added_at)
            VALUES ('old_torrent', 'magnet:?xt=urn:btih:old', 1000);
        )", nullptr, nullptr, nullptr);
        sqlite3_close(db);
    }

    // Opening with OfflineCacheManager should auto-migrate
    {
        seekserve::OfflineCacheManager cache(cfg);

        auto saved = cache.list_saved_torrents();
        ASSERT_EQ(saved.size(), 1u);
        EXPECT_EQ(saved[0].id, "old_torrent");
        EXPECT_EQ(saved[0].uri, "magnet:?xt=urn:btih:old");
        EXPECT_TRUE(saved[0].resume_data.empty());
        EXPECT_EQ(saved[0].selected_file, -1);

        // Can save resume data on migrated row
        std::vector<char> rd = {static_cast<char>(0xFF)};
        cache.save_resume_data("old_torrent", rd);
        auto loaded = cache.load_resume_data("old_torrent");
        EXPECT_EQ(loaded, rd);
    }
}

TEST_F(ResumeDataTest, LargeResumeDataBlob) {
    auto cfg = make_config();
    seekserve::OfflineCacheManager cache(cfg);

    cache.save_torrent_uri("big", "magnet:?xt=urn:btih:big");

    // Simulate a realistic resume data blob (~64KB)
    std::vector<char> data(65536);
    for (size_t i = 0; i < data.size(); ++i) {
        data[i] = static_cast<char>(i & 0xFF);
    }

    cache.save_resume_data("big", data);
    auto loaded = cache.load_resume_data("big");
    ASSERT_EQ(loaded.size(), data.size());
    EXPECT_EQ(loaded, data);
}
