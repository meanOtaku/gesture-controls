#ifndef SONY_HEAD_TRACKER_C_H
#define SONY_HEAD_TRACKER_C_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct sht_engine sht_engine;

enum sht_result {
    SHT_OK = 0,
    SHT_ERROR_NULL = 1,
    SHT_ERROR_ALREADY_STARTED = 2,
    SHT_ERROR_THREAD = 3,
    SHT_ERROR_UNSUPPORTED = 4,
    SHT_ERROR_INTERNAL = 5,
};

enum sht_status {
    SHT_STATUS_SEARCHING = 0,
    SHT_STATUS_CONNECTED = 1,
    SHT_STATUS_DISCONNECTED = 2,
    SHT_STATUS_PERMISSION = 3,
    SHT_STATUS_UNSUPPORTED = 4,
    SHT_STATUS_ERROR = 5,
};

typedef struct sht_sample {
    double quaternion[4]; /* w, x, y, z */
    double ypr_degrees[3]; /* yaw, pitch, roll */
    double gyro[3];
    double acceleration[3];
    uint8_t has_gyro;
    uint8_t has_acceleration;
    uint8_t reset_counter;
    uint8_t reserved;
    double packets_per_second;
    double receive_latency_ms;
    /* UTF-8; valid only for the duration of the callback. */
    const char *device_label;
} sht_sample;

typedef void (*sht_sample_callback)(void *context, const sht_sample *sample);
typedef void (*sht_status_callback)(void *context, uint32_t status,
                                    const char *message);
typedef void (*sht_context_release_callback)(void *context);

/* On success, the engine owns context and invokes release_callback exactly once
 * during final teardown, after no further sample/status callback can begin. On
 * creation failure, ownership remains with the caller. */
sht_engine *sht_create(void *context, sht_sample_callback sample_callback,
                       sht_status_callback status_callback,
                       sht_context_release_callback release_callback);
void sht_destroy(sht_engine *engine);
int32_t sht_start(sht_engine *engine);
int32_t sht_stop(sht_engine *engine);
int32_t sht_recenter(sht_engine *engine);

#ifdef __cplusplus
}
#endif

#endif
