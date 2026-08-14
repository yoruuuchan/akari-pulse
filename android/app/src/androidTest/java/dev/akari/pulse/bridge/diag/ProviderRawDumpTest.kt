package dev.akari.pulse.bridge.diag

import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Diagnostic dump of the raw vivo provider state, run with the main app's uid so the
 * signature-permission grants apply. Emits everything to logcat under AkariProviderDump.
 * Read-only: cursor queries and the same provider call() the production reader uses.
 */
@RunWith(AndroidJUnit4::class)
class ProviderRawDumpTest {

    private fun log(message: String) {
        var index = 0
        while (index < message.length) {
            val end = minOf(index + 3000, message.length)
            Log.i(TAG, message.substring(index, end))
            index = end
        }
    }

    @Test
    fun dumpAll() {
        val resolver = InstrumentationRegistry.getInstrumentation().targetContext.contentResolver
        log("DUMP_START epoch_ms=${System.currentTimeMillis()}")

        // care provider: every row, every column
        try {
            resolver.query(CARE_URI, null, null, null, null)?.use { cursor ->
                log("CARE rows=${cursor.count} cols=[${cursor.columnNames.joinToString(",")}]")
                var row = 0
                while (cursor.moveToNext() && row < 10) {
                    val line = StringBuilder("CARE_ROW[$row]")
                    for (i in 0 until cursor.columnCount) {
                        line.append(" ${cursor.getColumnName(i)}=${cursor.getString(i)}")
                    }
                    log(line.toString())
                    row++
                }
            } ?: log("CARE cursor=null")
        } catch (error: Exception) {
            log("CARE EXC=$error")
        }

        // sleep provider: row count, key columns of the first rows to expose sort order
        try {
            resolver.query(SLEEP_URI, null, null, null, null)?.use { cursor ->
                log("SLEEP rows=${cursor.count} cols=[${cursor.columnNames.joinToString(",")}]")
                var row = 0
                while (cursor.moveToNext() && row < 5) {
                    val keys = listOf("DATE", "TIMESTAMP", "ENTER_TIME", "EXIT_TIME", "TOTAL_DURATION", "WATCH_GENERATION")
                    val line = StringBuilder("SLEEP_ROW[$row]")
                    for (key in keys) {
                        val i = cursor.getColumnIndex(key)
                        line.append(" $key=${if (i >= 0) cursor.getString(i) else "<absent>"}")
                    }
                    log(line.toString())
                    row++
                }
            } ?: log("SLEEP cursor=null")
        } catch (error: Exception) {
            log("SLEEP EXC=$error")
        }

        // assistant step provider: same two calls the production reader makes
        try {
            val capability = resolver.call(STEP_URI, "canJoviStep", null, null)
            log("STEP_CAP ${describe(capability)}")
            val extras = Bundle().apply { putBoolean("ignore", true) }
            val activity = resolver.call(STEP_URI, "updateTodaySportAIDLBean", null, extras)
            log("STEP_ACT ${describe(activity)}")
        } catch (error: Exception) {
            log("STEP EXC=$error")
        }

        log("DUMP_END epoch_ms=${System.currentTimeMillis()}")
    }

    @Suppress("DEPRECATION")
    private fun describe(bundle: Bundle?): String {
        if (bundle == null) return "bundle=null"
        return bundle.keySet().sorted().joinToString(" ") { key -> "$key=${bundle.get(key)}" }
    }

    private companion object {
        const val TAG = "AkariProviderDump"
        val CARE_URI: Uri = Uri.parse("content://com.vivo.health.provider.care/healthCare")
        val SLEEP_URI: Uri = Uri.parse("content://com.vivo.health.provider/sleep")
        val STEP_URI: Uri = Uri.parse("content://com.vivo.assistant.step.provider")
    }
}
