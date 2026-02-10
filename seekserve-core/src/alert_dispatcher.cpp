#include "seekserve/alert_dispatcher.hpp"

#include <spdlog/spdlog.h>

namespace seekserve {

AlertDispatcher::~AlertDispatcher() {
    stop();
}

void AlertDispatcher::start(lt::session& ses) {
    if (running_.exchange(true)) return;

    ses.set_alert_notify([this]() {
        std::lock_guard lock(notify_mu_);
        notify_cv_.notify_one();
    });

    thread_ = std::thread([this, &ses]() { run(ses); });
}

void AlertDispatcher::stop() {
    if (!running_.exchange(false)) return;

    {
        std::lock_guard lock(notify_mu_);
        notify_cv_.notify_one();
    }

    if (thread_.joinable()) {
        thread_.join();
    }
}

void AlertDispatcher::run(lt::session& ses) {
    spdlog::debug("AlertDispatcher: started");

    while (running_.load()) {
        {
            std::unique_lock lock(notify_mu_);
            notify_cv_.wait_for(lock, std::chrono::milliseconds(500));
        }

        if (!running_.load()) break;

        std::vector<lt::alert*> alerts;
        ses.pop_alerts(&alerts);

        std::lock_guard lock(mu_);
        for (const auto* alert : alerts) {
            spdlog::debug("AlertDispatcher: [{}] {}", alert->type(), alert->message());
            auto it = handlers_.find(alert->type());
            if (it != handlers_.end()) {
                try {
                    it->second(alert);
                } catch (const std::exception& e) {
                    spdlog::error("AlertDispatcher: handler exception for alert type {}: {}",
                                  alert->type(), e.what());
                }
            }
        }
    }

    spdlog::debug("AlertDispatcher: stopped");
}

} // namespace seekserve
