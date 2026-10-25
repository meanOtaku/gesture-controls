package com.gesturecontrols.wearwatch.feature.power

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the watch spends its battery on while it streams, counted so a change (sensor batching, fewer trackers) can be
 * measured rather than guessed: sensor events and how often they were delivered, pulse samples, messages and bytes
 * sent. Every counter only grows; the desktop works out rates from the difference between two reports, so a report
 * that goes missing loses nothing.
 *
 * Changes nothing about what the watch does. Pure apart from `org.json`, so it is tested on the JVM.
 */
class WatchStats {
    /** One motion sensor as it is set up: whether it runs, the period asked for, and its hardware batching buffer. */
    class SensorInfo(
        val id: String,
        val name: String,
        val registered: Boolean,
        /** The period asked of `registerListener`, in microseconds (a `SENSOR_DELAY_*` constant is turned into its nominal period). */
        val requestedPeriodUs: Int?,
        /** `Sensor.fifoMaxEventCount`: how many events the sensor hub can hold for batching; 0 means it cannot batch. */
        val fifoMaxEvents: Int,
        val fifoReservedEvents: Int,
    )

    class Battery(
        val percent: Int?,
        val charging: Boolean?,
        /** `BATTERY_PROPERTY_CHARGE_COUNTER`, in µAh: finer than the percentage, so drain shows within minutes. */
        val chargeUah: Long?,
        /** `BATTERY_PROPERTY_CURRENT_NOW`, in µA. Its sign differs between devices. */
        val currentUa: Long?,
        val temperatureC: Double?,
    )

    private val events = LinkedHashMap<String, Long>()
    private var deliveries = 0L
    private var lastCallbackNs: Long? = null
    private var ppgSamples = 0L
    private var ppgDeliveries = 0L
    private var messages = 0L
    private var bytes = 0L
    private var refusedSends = 0L

    /**
     * One sensor event, as it reaches the app at `nowNs` (elapsed realtime). Events that arrive within
     * [DELIVERY_GAP_NS] of the one before came in the same delivery; each delivery is a time the app's processor had
     * to wake for the sensors, which is what hardware batching reduces.
     */
    @Synchronized
    fun onSensorEvent(sensorId: String, nowNs: Long) {
        events[sensorId] = (events[sensorId] ?: 0L) + 1
        val last = lastCallbackNs
        if (last == null || nowNs - last > DELIVERY_GAP_NS) deliveries++
        lastCallbackNs = nowNs
    }

    /** One delivery of pulse samples from the health SDK. */
    @Synchronized
    fun onPpgDelivery(samples: Int) {
        ppgDeliveries++
        ppgSamples += samples
    }

    /** One message handed to the link: its size, and whether the link took it. */
    @Synchronized
    fun onSend(messageBytes: Int, accepted: Boolean) {
        messages++
        bytes += messageBytes
        if (!accepted) refusedSends++
    }

    /** The report sent with a heartbeat. */
    @Synchronized
    fun toJson(elapsedMs: Long, cpuMs: Long?, battery: Battery?, sensors: List<SensorInfo>, droppedMessages: Long): JSONObject {
        val out = JSONObject()
        out.put("elapsedMs", elapsedMs)
        out.put("cpuMs", cpuMs ?: JSONObject.NULL)
        if (battery != null) {
            out.put(
                "battery",
                JSONObject()
                    .put("percent", battery.percent ?: JSONObject.NULL)
                    .put("charging", battery.charging ?: JSONObject.NULL)
                    .put("chargeUah", battery.chargeUah ?: JSONObject.NULL)
                    .put("currentUa", battery.currentUa ?: JSONObject.NULL)
                    .put("temperatureC", battery.temperatureC ?: JSONObject.NULL),
            )
        }
        out.put("sensorDeliveries", deliveries)
        val list = JSONArray()
        for (sensor in sensors) {
            list.put(
                JSONObject()
                    .put("id", sensor.id)
                    .put("name", sensor.name)
                    .put("registered", sensor.registered)
                    .put("requestedPeriodUs", sensor.requestedPeriodUs ?: JSONObject.NULL)
                    .put("fifoMaxEvents", sensor.fifoMaxEvents)
                    .put("fifoReservedEvents", sensor.fifoReservedEvents)
                    .put("events", events[sensor.id] ?: 0L),
            )
        }
        out.put("sensors", list)
        out.put("ppgSamples", ppgSamples)
        out.put("ppgDeliveries", ppgDeliveries)
        out.put("messages", messages)
        out.put("bytes", bytes)
        out.put("refusedSends", refusedSends)
        out.put("droppedMessages", droppedMessages)
        return out
    }

    companion object {
        /** Events closer together than this came in one delivery (a burst from the sensor hub, or one wake). */
        const val DELIVERY_GAP_NS = 2_000_000L

        /** The nominal period of a `SensorManager.SENSOR_DELAY_*` constant (0 to 3), or `rate` itself when it is already µs. */
        fun nominalPeriodUs(rate: Int): Int = when (rate) {
            0 -> 0 // SENSOR_DELAY_FASTEST: as fast as the sensor goes
            1 -> 20_000 // SENSOR_DELAY_GAME
            2 -> 66_667 // SENSOR_DELAY_UI
            3 -> 200_000 // SENSOR_DELAY_NORMAL
            else -> rate
        }
    }
}
