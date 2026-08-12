package dev.akari.pulse.bridge.network

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ServerUrlPolicyTest {
    @Test
    fun httpsIsAcceptedAndTrailingSlashIsRemoved() {
        assertEquals(
            "https://akari-health.example.ts.net",
            ServerUrlPolicy.validate("https://akari-health.example.ts.net/", false),
        )
    }

    @Test
    fun explicitTailnetHttpIsAcceptedInDebugBuild() {
        assertEquals(
            "http://100.100.20.30:8787",
            ServerUrlPolicy.validate("http://100.100.20.30:8787", true),
        )
    }

    @Test
    fun tailnetHttpRequiresExplicitConsent() {
        assertFailsWith<IllegalArgumentException> {
            ServerUrlPolicy.validate("http://100.100.20.30:8787", false)
        }
    }

    @Test
    fun publicHttpIsRejected() {
        assertFailsWith<IllegalArgumentException> {
            ServerUrlPolicy.validate("http://example.com", true)
        }
    }

    @Test
    fun endpointPathAndEmbeddedCredentialsAreRejected() {
        assertFailsWith<IllegalArgumentException> {
            ServerUrlPolicy.validate("https://user:password@example.com/v1", false)
        }
    }
}
