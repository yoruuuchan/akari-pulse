import network from '@blueos.network.fetch'
import config from '../config'
import * as queue from './queue'
import * as transport from './transport'
import { errorText } from './events'

const SURVIVAL_WINDOW_MS = 60000

let observer = null
let survivalTimer = null
let activeTest = ''

function publish(message) {
  if (observer) observer(message)
}

function emitStage(test, label, stage, status, extra) {
  const message = {
    kind: 'diagnostic_stage',
    test: test,
    label: label,
    stage: stage,
    status: status,
  }
  if (extra) {
    const keys = Object.keys(extra)
    for (let index = 0; index < keys.length; index += 1) {
      message[keys[index]] = extra[keys[index]]
    }
  }
  console.info(`[akari pulse net] ${stage} ${label}`)
  publish(message)
}

function emitFailure(test, label, stage, data, code, status) {
  const rawCode = code === undefined || code === null ? 'UNKNOWN' : code
  const rawMessage = errorText(data)
  console.error(`[akari pulse net] ${stage} ${label} code=${rawCode} message=${rawMessage}`)
  emitStage(test, label, stage, status || 'ERROR', {
    raw_error_code: rawCode,
    raw_error_message: rawMessage,
  })
}

function emitResult(test, label, status, value, note) {
  publish({
    kind: 'diagnostic_result',
    test: test,
    label: label,
    status: status,
    value: value,
    note: note || '',
  })
}

function begin(test, label) {
  if (activeTest) {
    emitStage(test, label, 'TEST_LOCKED', 'ERROR', {
      raw_error_code: 'RELAUNCH_REQUIRED',
      raw_error_message: `${activeTest} already ran in this process; relaunch before another test`,
    })
    return false
  }
  activeTest = test
  if (survivalTimer) clearTimeout(survivalTimer)
  survivalTimer = null
  emitStage(test, label, 'BEGIN', 'RUNNING')
  return true
}

function armSurvivalWindow(test, label) {
  survivalTimer = setTimeout(function () {
    survivalTimer = null
    emitStage(test, label, 'SURVIVED_60S_AFTER_INVOKE', 'SURVIVED')
  }, SURVIVAL_WINDOW_MS)
}

function fetchAvailable(test, label) {
  if (!network || typeof network.fetch !== 'function') {
    emitFailure(
      test,
      label,
      'API_MISSING',
      '@blueos.network.fetch.fetch is unavailable',
      'API_MISSING',
      'API_MISSING'
    )
    return false
  }
  return true
}

export function setObserver(onMessage) {
  observer = onMessage || null
}

export function shutdown() {
  if (survivalTimer) clearTimeout(survivalTimer)
  survivalTimer = null
  activeTest = ''
  observer = null
}

// One cold-start test: three sequential GET probes that answer, in one pass,
// (1) does a sideloaded quick-app have any internet path on this watch,
// (2) is the relay reachable over HTTPS, and (3) what does plain HTTP do.
// Every probe records its raw outcome; a later probe never overwrites an earlier one.
export function runNetProbe() {
  const test = 'net_probe'
  const label = 'net probe'
  if (!begin(test, label)) return
  if (!fetchAvailable(test, label)) return

  const probes = [
    { key: 'CONTROL_HTTP_204', url: config.netProbe.controlUrl },
    { key: 'RELAY_HTTPS', url: config.netProbe.relayHealthzHttps },
    { key: 'RELAY_HTTP', url: config.netProbe.relayHealthzHttp },
  ]
  const outcomes = {}

  function runProbe(index) {
    if (index >= probes.length) {
      const relayHttps = outcomes.RELAY_HTTPS
      const control = outcomes.CONTROL_HTTP_204
      if (relayHttps && relayHttps.code === 200 && relayHttps.relay_body) {
        emitResult(test, label, 'PASS', 'relay https 200', 'relay reachable over https from this watch')
      } else if (control && control.code >= 200 && control.code < 400) {
        emitResult(
          test,
          label,
          'ERROR',
          `control ${control.code}, relay https failed`,
          'internet path exists but the relay https probe did not return 200'
        )
      } else {
        emitResult(
          test,
          label,
          'ERROR',
          'no probe succeeded',
          'no internet path was observed for this quick app'
        )
      }
      armSurvivalWindow(test, label)
      return
    }

    const probe = probes[index]
    emitStage(test, label, `BEGIN_${probe.key}`, 'RUNNING')
    try {
      network.fetch({
        url: probe.url,
        method: 'GET',
        timeout: config.netProbe.timeoutMs,
        success: function (response) {
          const code = response ? Number(response.code) : NaN
          const bodyText =
            response && response.data !== undefined && response.data !== null
              ? typeof response.data === 'string'
                ? response.data
                : JSON.stringify(response.data)
              : ''
          outcomes[probe.key] = {
            code: code,
            body_length: bodyText.length,
            relay_body: bodyText.indexOf('akari-pulse-relay') >= 0,
          }
          // The HTTP status code is embedded in the stage name so it is visible in the
          // on-watch last-stage display and log without any extra UI plumbing.
          emitStage(test, label, `${probe.key}_RESPONSE_${isFinite(code) ? code : 'NO_CODE'}`, 'PASS', {
            value: code,
            note: `body_length=${bodyText.length}`,
          })
          runProbe(index + 1)
        },
        fail: function (data, code) {
          outcomes[probe.key] = { failed: true }
          emitFailure(test, label, `${probe.key}_FAIL`, data, code)
          runProbe(index + 1)
        },
      })
    } catch (error) {
      outcomes[probe.key] = { failed: true }
      emitFailure(test, label, `${probe.key}_THROWN`, error, 'CALL_THROWN')
      runProbe(index + 1)
    }
  }

  runProbe(0)
}

// One cold-start test: load the saved diagnostic queue, add one non-health marker
// event, and run the production HTTP transport (batch, POST, strict acknowledgement,
// dequeue) against the relay. Failure keeps the queue intact by design.
export function runSendBatchHttps() {
  const test = 'send_batch_https'
  const label = 'send batch https'
  if (!begin(test, label)) return
  if (!fetchAvailable(test, label)) return

  emitStage(test, label, 'BEGIN_QUEUE_LOAD', 'RUNNING')
  let loadedSummary
  try {
    loadedSummary = queue.load()
  } catch (error) {
    emitFailure(test, label, 'QUEUE_LOAD_THROWN', error, 'CALL_THROWN')
    return
  }
  if (!loadedSummary || loadedSummary.storage_status !== 'PASS') {
    emitFailure(
      test,
      label,
      'QUEUE_LOAD_FAIL',
      loadedSummary ? loadedSummary.storage_error : 'queue.load returned no summary',
      loadedSummary ? loadedSummary.storage_status : 'NO_SUMMARY'
    )
    return
  }
  emitStage(test, label, 'QUEUE_LOAD_PASS', 'PASS')

  transport.initialize(function (message) {
    if (!message) return
    if (message.kind === 'sync_start') {
      emitStage(test, label, 'BEGIN_HTTPS_POST', 'RUNNING', { value: message.count })
      return
    }
    if (message.kind === 'sync_success') {
      emitStage(test, label, 'ACK_VALID', 'PASS', { value: message.count })
      emitResult(
        test,
        label,
        'PASS',
        `${message.count} event(s) acknowledged`,
        'relay stored the batch and returned a full matching acknowledgement'
      )
      return
    }
    if (message.kind === 'sync_error') {
      emitFailure(test, label, 'SEND_FAIL', message.message, message.code, message.status)
      emitResult(test, label, message.status || 'ERROR', undefined, errorText(message.message))
      return
    }
    if (message.kind === 'sync_empty') {
      emitFailure(test, label, 'QUEUE_EMPTY', 'no events were queued for sending', 'QUEUE_EMPTY')
    }
  })

  emitStage(test, label, 'BEGIN_ENQUEUE_MARKER', 'RUNNING')
  try {
    queue.enqueue(
      {
        metric: 'diagnostic_watch_pipeline',
        value: 'send_batch_https',
        status: 'PASS',
        source_module: '@blueos.network.fetch',
        source_api: 'fetch.fetch',
        quality: 'net_send_control',
      },
      function (result) {
        if (result.status !== 'PASS') {
          emitFailure(test, label, 'MARKER_PERSIST_FAIL', result.message, result.code || result.status)
          return
        }
        emitStage(test, label, 'MARKER_PERSISTED', 'PASS')
        transport.syncNow()
        armSurvivalWindow(test, label)
      }
    )
  } catch (error) {
    emitFailure(test, label, 'ENQUEUE_THROWN', error, 'CALL_THROWN')
  }
}
