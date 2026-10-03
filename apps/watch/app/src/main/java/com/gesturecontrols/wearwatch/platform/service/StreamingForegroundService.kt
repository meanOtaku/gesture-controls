package com.gesturecontrols.wearwatch.platform.service

import com.gesturecontrols.wearwatch.R

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the watch-to-desktop session alive after the display sleeps. Sensor
 * and socket ownership stays in [MainActivity]; this foreground service keeps
 * the process from being frozen, and holds a partial wake lock only while data
 * is actually streaming ([setStreaming]). Between desktop connections (waiting
 * to reconnect) the service stays but the CPU wake lock is released, because
 * nothing is being produced and a held lock is pure battery drain.
 */
class StreamingForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopStreaming()
                return START_NOT_STICKY
            }
            ACTION_WAKE_OFF -> {
                releaseWakeLock()
                return START_NOT_STICKY
            }
        }

        running = true
        startForeground(NOTIFICATION_ID, createNotification())
        acquireWakeLock()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun stopStreaming() {
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        releaseWakeLock()
        val powerManager = getSystemService(PowerManager::class.java)
        // The timeout is a leak guard, not a session length: a start intent
        // re-acquires it, and a session longer than this simply re-arms on the
        // next connect.
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "$packageName:watch-streaming",
        ).apply { acquire(WAKE_LOCK_MAX_MS) }
    }

    private fun releaseWakeLock() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    private fun createNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.streaming_notification_channel),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(getString(R.string.streaming_notification_title))
            .setContentText(getString(R.string.streaming_notification_text))
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        private const val ACTION_START = "com.gesturecontrols.wearwatch.action.START_STREAMING"
        private const val ACTION_STOP = "com.gesturecontrols.wearwatch.action.STOP_STREAMING"
        private const val ACTION_WAKE_OFF = "com.gesturecontrols.wearwatch.action.WAKE_OFF"
        private const val WAKE_LOCK_MAX_MS = 12L * 60 * 60 * 1000

        @Volatile private var running = false
        private const val TAG = "StreamingService"
        private const val CHANNEL_ID = "watch_streaming"
        private const val NOTIFICATION_ID = 1001

        fun start(context: Context) {
            // A reconnect can land while the app is in the background; newer Wear OS
            // versions may refuse a foreground-service start from there. Streaming still
            // works without it, only without the wake lock, so log and carry on.
            runCatching {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, StreamingForegroundService::class.java).setAction(ACTION_START),
                )
            }.onFailure { Log.w(TAG, "could not start the streaming service", it) }
        }

        /**
         * Streaming data again: start (or re-arm) the service and its wake lock.
         * Not streaming but still waiting for the desktop: [releaseWakeLock] keeps
         * the service and drops only the CPU lock.
         */
        fun releaseWakeLock(context: Context) {
            if (!running) return
            runCatching {
                context.startService(
                    Intent(context, StreamingForegroundService::class.java).setAction(ACTION_WAKE_OFF),
                )
            }.onFailure { Log.w(TAG, "could not release the streaming wake lock", it) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, StreamingForegroundService::class.java))
        }
    }
}
