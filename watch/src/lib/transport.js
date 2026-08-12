import config from '../config'
import * as queue from './queue'
import * as httpAdapter from './http-adapter'
import * as rpcAdapter from './rpc-adapter'
import { stopSubscriptions } from './collector'

let observer = null
let syncing = false
let pendingRpcBatch = null
let rpcAckTimer = null

function publish(message) {
  if (observer) observer(message)
}

function transportFailure(status, code, message, sourceModule, sourceApi) {
  syncing = false
  queue.recordTransportDiagnostic(status, code, message, sourceModule, sourceApi)
  publish({ kind: 'sync_error', status: status, code: code, message: message })
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= 0
}

function acknowledgementError(result, expectedCount, prefix) {
  if (!nonNegativeInteger(result.accepted) || !nonNegativeInteger(result.duplicates)) {
    return {
      code: `${prefix}_ACK_INVALID`,
      message: 'acknowledgement accepted/duplicates must be non-negative integers',
    }
  }
  if (result.accepted + result.duplicates !== expectedCount) {
    return {
      code: `${prefix}_ACK_COUNT_MISMATCH`,
      message: `acknowledgement covers ${result.accepted + result.duplicates} of ${expectedCount} events`,
    }
  }
  return null
}

function handleSessionControl(message) {
  if (!message || (message.type !== 'akari.session.start' && message.type !== 'akari.session.stop')) {
    return false
  }
  const data = message.data
  if (!data || typeof data.session_id !== 'string' || !data.session_id) {
    queue.enqueue({
      metric: 'diagnostic_watch_transport',
      status: 'ERROR',
      source_module: '@blueos.bluexlink.connectionManager',
      source_api: 'connect.onMessage',
      quality: 'session_control',
      raw_error_code: 'INVALID_SESSION_CONTROL',
      raw_error_message: `${message.type} requires a non-empty data.session_id`,
    })
    publish({ kind: 'session_control', status: 'ERROR', action: message.type })
    return true
  }

  const controlTimestamp = message.type === 'akari.session.start' ? data.started_at : data.ended_at
  if (typeof controlTimestamp !== 'number' || !isFinite(controlTimestamp) || controlTimestamp < 0) {
    queue.enqueue({
      metric: 'diagnostic_watch_transport',
      status: 'ERROR',
      source_module: '@blueos.bluexlink.connectionManager',
      source_api: 'connect.onMessage',
      quality: 'session_control',
      raw_error_code: 'INVALID_SESSION_TIMESTAMP',
      raw_error_message: `${message.type} requires an epoch-ms ${
        message.type === 'akari.session.start' ? 'data.started_at' : 'data.ended_at'
      }`,
    })
    publish({ kind: 'session_control', status: 'ERROR', action: message.type })
    return true
  }

  if (message.type === 'akari.session.start') {
    const currentSession = queue.summary().session_id
    if (currentSession && currentSession !== data.session_id) {
      queue.enqueue({
        metric: 'diagnostic_watch_transport',
        status: 'ERROR',
        source_module: '@blueos.bluexlink.connectionManager',
        source_api: 'connect.onMessage',
        quality: 'session_control',
        raw_error_code: 'SESSION_ALREADY_ACTIVE',
        raw_error_message: `cannot replace active session ${currentSession} with ${data.session_id}`,
      })
      publish({ kind: 'session_control', status: 'ERROR', action: 'start' })
      return true
    }
    queue.startSession(data.session_id, controlTimestamp)
    publish({ kind: 'session_control', status: 'PASS', action: 'start', session_id: data.session_id })
    return true
  }

  const currentSession = queue.summary().session_id
  if (!currentSession) {
    queue.enqueue({
      metric: 'diagnostic_watch_transport',
      status: 'ERROR',
      source_module: '@blueos.bluexlink.connectionManager',
      source_api: 'connect.onMessage',
      quality: 'session_control',
      raw_error_code: 'NO_ACTIVE_SESSION',
      raw_error_message: `stop requested for ${data.session_id}, but no session is active`,
    })
    publish({ kind: 'session_control', status: 'ERROR', action: 'stop' })
    return true
  }
  if (currentSession && currentSession !== data.session_id) {
    queue.enqueue({
      metric: 'diagnostic_watch_transport',
      status: 'ERROR',
      source_module: '@blueos.bluexlink.connectionManager',
      source_api: 'connect.onMessage',
      quality: 'session_control',
      raw_error_code: 'SESSION_ID_MISMATCH',
      raw_error_message: `stop requested for ${data.session_id}, active session is ${currentSession}`,
    })
    publish({ kind: 'session_control', status: 'ERROR', action: 'stop' })
    return true
  }
  stopSubscriptions()
  queue.stopSession(data.session_id, controlTimestamp)
  publish({ kind: 'session_control', status: 'REQUESTED', action: 'stop', session_id: data.session_id })
  return true
}

function handleRpcMessage(message) {
  if (handleSessionControl(message)) return
  if (!pendingRpcBatch) {
    publish({ kind: 'rpc_message', status: 'IGNORED' })
    return
  }

  const result = message && message.result
  if (message.code === 0 && result && result.batch_id === pendingRpcBatch.batch_id) {
    if (rpcAckTimer) clearTimeout(rpcAckTimer)
    rpcAckTimer = null
    const acknowledged = pendingRpcBatch
    pendingRpcBatch = null
    const ackError = acknowledgementError(result, acknowledged.events.length, 'RPC')
    if (ackError) {
      transportFailure(
        'ERROR',
        ackError.code,
        ackError.message,
        '@blueos.bluexlink.connectionManager',
        'connect.onMessage'
      )
      return
    }
    syncing = false
    queue.acknowledge(acknowledged.events, acknowledged.batch_id)
    publish({ kind: 'sync_success', adapter: 'rpc', count: acknowledged.events.length, code: 0 })
    return
  }

  if (result && result.batch_id === pendingRpcBatch.batch_id && message.code !== 0) {
    if (rpcAckTimer) clearTimeout(rpcAckTimer)
    rpcAckTimer = null
    pendingRpcBatch = null
    transportFailure(
      'ERROR',
      message.code,
      message.message || 'phone bridge rejected the RPC batch',
      '@blueos.bluexlink.connectionManager',
      'connect.onMessage'
    )
  }
}

export function initialize(onMessage) {
  observer = onMessage || null
  // The HTTP adapter needs no connection setup; only the RPC adapter opens a
  // BlueXlink instance, and only when it is the selected transport.
  if (config.transport.adapter !== 'rpc') return true
  return initializeRpc(onMessage)
}

// Explicit BlueXlink initialization for the `transport init` diagnostic, independent
// of the configured adapter, so the interconnect evidence path stays testable.
export function initializeRpc(onMessage) {
  observer = onMessage || null
  if (!rpcAdapter.isConfigured()) {
    publish({
      kind: 'rpc_connection',
      status: 'API_MISSING',
      code: 'RPC_CONFIG_MISSING',
      message: 'RPC phonePackage and phoneSha256 are not configured',
    })
    return false
  }
  return rpcAdapter.initialize({
    onOpen: function () {
      publish({ kind: 'rpc_connection', status: 'PASS' })
    },
    onClose: function () {
      publish({ kind: 'rpc_connection', status: 'NO_DATA' })
    },
    onError: function (data, code) {
      publish({ kind: 'rpc_connection', status: 'ERROR', code: code, message: data })
    },
    onApiMissing: function (message) {
      publish({ kind: 'rpc_connection', status: 'API_MISSING', message: message })
    },
    onMessage: handleRpcMessage,
  })
}

export function syncNow() {
  if (syncing) {
    publish({ kind: 'sync_busy' })
    return
  }

  const adapter = config.transport.adapter
  const limit = adapter === 'http' ? config.transport.http.batchSize : 100
  const batch = queue.makeBatch(limit)
  if (!batch) {
    publish({ kind: 'sync_empty' })
    return
  }

  syncing = true
  publish({ kind: 'sync_start', adapter: adapter, count: batch.events.length })

  if (adapter === 'http') {
    httpAdapter.send(
      batch,
      function (code, body) {
        syncing = false
        queue.acknowledge(batch.events, batch.batch_id)
        const ack = body && body.data
        const accepted = ack && typeof ack.accepted === 'number' ? ack.accepted : batch.events.length
        const duplicates = ack && typeof ack.duplicates === 'number' ? ack.duplicates : 0
        // Enqueue a PASS watch_transport diagnostic describing the batch that
        // just ACK'd. It rides the next sync — so on a fresh queue the store
        // shows watch_transport PASS only after the second successful sync.
        queue.recordTransportSuccess(batch.batch_id, accepted, duplicates)
        publish({ kind: 'sync_success', adapter: 'http', count: batch.events.length, code: code })
      },
      function (status, code, message) {
        transportFailure(status, code, message, '@blueos.network.fetch', 'fetch.fetch')
      }
    )
    return
  }

  if (adapter === 'rpc') {
    if (!rpcAdapter.isConfigured()) {
      transportFailure(
        'API_MISSING',
        'RPC_CONFIG_MISSING',
        'RPC phonePackage and phoneSha256 are not configured',
        '@blueos.bluexlink.connectionManager',
        'interconnect.instance'
      )
      return
    }
    pendingRpcBatch = batch
    rpcAdapter.send(
      batch,
      function () {
        if (!pendingRpcBatch || pendingRpcBatch.batch_id !== batch.batch_id) return
        publish({ kind: 'sync_sent', adapter: 'rpc', count: batch.events.length })
        rpcAckTimer = setTimeout(function () {
          pendingRpcBatch = null
          rpcAckTimer = null
          transportFailure(
            'ERROR',
            'RPC_ACK_TIMEOUT',
            'RPC send succeeded but no batch-correlated business acknowledgement arrived',
            '@blueos.bluexlink.connectionManager',
            'connect.onMessage'
          )
        }, config.transport.rpc.ackTimeoutMs)
      },
      function (status, code, message) {
        pendingRpcBatch = null
        transportFailure(status, code, message, '@blueos.bluexlink.connectionManager', 'connect.send')
      }
    )
    return
  }

  transportFailure(
    'API_MISSING',
    'TRANSPORT_ADAPTER_MISSING',
    `transport adapter is not implemented: ${adapter}`,
    'akari-pulse',
    'transport.syncNow'
  )
}

export function shutdown() {
  if (rpcAckTimer) clearTimeout(rpcAckTimer)
  rpcAckTimer = null
  pendingRpcBatch = null
  syncing = false
  rpcAdapter.close()
}
