import health from '@blueos.health.health'
import storage from '@blueos.storage.storage'
import * as queue from './queue'
import { errorText, statusForFailure, isZeroHrSampleShape } from './events'

const HEALTH_MODULE = '@blueos.health.health'
const STORAGE_MODULE = '@blueos.storage.storage'
const STORAGE_CONTROL_KEY = 'akari.pulse.diag.storage.control.v1'
const SURVIVAL_WINDOW_MS = 60000

let observer = null
let survivalTimer = null
let activeTest = ''
let callbackSeen = false

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
  console.info(`[akari pulse diag] ${stage} ${label}`)
  publish(message)
}

function emitFailure(test, label, stage, data, code) {
  const rawCode = code === undefined || code === null ? 'UNKNOWN' : code
  const rawMessage = errorText(data)
  let failureStatus = statusForFailure(rawCode)
  if (rawCode === 'API_MISSING') failureStatus = 'API_MISSING'
  console.error(
    `[akari pulse diag] ${stage} ${label} code=${rawCode} message=${rawMessage}`
  )
  emitStage(test, label, stage, failureStatus, {
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
  callbackSeen = false
  if (survivalTimer) clearTimeout(survivalTimer)
  survivalTimer = null
  emitStage(test, label, 'BEGIN', 'RUNNING')
  return true
}

function armSurvivalWindow(test, label, callbackObservable) {
  survivalTimer = setTimeout(function () {
    survivalTimer = null
    if (callbackObservable && !callbackSeen) {
      emitStage(test, label, 'NO_CALLBACK_WITHIN_60S', 'NO_CALLBACK', {
        note: 'Akari harness observation; not a BlueOS error code',
      })
      return
    }
    emitStage(
      test,
      label,
      callbackObservable ? 'SURVIVED_60S_AFTER_CALLBACK' : 'SURVIVED_60S_AFTER_INVOKE',
      'SURVIVED'
    )
  }, SURVIVAL_WINDOW_MS)
}

function heartRateType(test, label) {
  if (!health || typeof health.getRecentSamples !== 'function') {
    emitFailure(
      test,
      label,
      'API_MISSING',
      'health.getRecentSamples is unavailable',
      'API_MISSING'
    )
    return undefined
  }
  if (!health.DATA_TYPES || health.DATA_TYPES.HEART_RATE === undefined) {
    emitFailure(
      test,
      label,
      'ENUM_MISSING',
      'health.DATA_TYPES.HEART_RATE is unavailable',
      'API_MISSING'
    )
    return undefined
  }
  return health.DATA_TYPES.HEART_RATE
}

function callbackEntry(test, label, callbackKind) {
  callbackSeen = true
  emitStage(test, label, `CALLBACK_ENTERED_${callbackKind.toUpperCase()}`, 'CALLBACK')
}

function validTimestamp(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function parseRecentHeartRate(samples, type) {
  if (!Array.isArray(samples)) {
    return { status: 'NO_DATA', note: 'success callback payload was not an array' }
  }

  let sample = null
  for (let index = 0; index < samples.length; index += 1) {
    if (samples[index] && samples[index].dataType === type) {
      sample = samples[index].data
      break
    }
  }
  if (!sample && samples.length === 1 && samples[0]) sample = samples[0].data

  if (!sample || sample.value === undefined || sample.value === null) {
    return { status: 'NO_DATA', note: 'success callback contained no heart-rate value' }
  }
  if (isZeroHrSampleShape(sample)) {
    return {
      status: 'NO_DATA',
      note: 'device zero shape value=0 sample_timestamp=0 mapped to NO_DATA (0.1.4 contract)',
      zeroShape: true,
    }
  }
  return {
    status: 'PASS',
    value: sample.value,
    sampleTimestamp: validTimestamp(sample.timeStamp),
    note: 'real getRecentSamples callback',
  }
}

function emitParsedResult(test, label, parsed) {
  if (parsed.status === 'PASS') {
    emitStage(test, label, 'PARSE_PASS', 'PASS', { value: parsed.value })
  } else {
    emitStage(test, label, 'PARSE_NO_DATA', 'NO_DATA', { note: parsed.note })
  }
  emitResult(test, label, parsed.status, parsed.value, parsed.note)
}

function queueStage(test, label, stage) {
  const status = stage === 'QUEUE_MEMORY' || stage === 'SNAPSHOT_READY' ? 'PASS' : 'RUNNING'
  emitStage(test, label, stage, status)
}

function persistFullObservation(test, label, input, finalResult) {
  emitStage(test, label, 'BEGIN_QUEUE', 'RUNNING')
  try {
    const event = queue.enqueue(
      input,
      function (result, persistedEvent) {
        if (result.status !== 'PASS') {
          emitFailure(
            test,
            label,
            'STORAGE_FAIL',
            result.message,
            result.code || result.status
          )
          return
        }
        emitStage(test, label, 'STORAGE_SUCCESS', 'PASS')
        emitResult(
          test,
          label,
          finalResult.status,
          persistedEvent ? persistedEvent.value : finalResult.value,
          finalResult.note
        )
      },
      function (stage) {
        queueStage(test, label, stage)
      }
    )
    emitStage(test, label, 'QUEUE_ENQUEUE_RETURNED', 'PASS', {
      event_id: event.event_id,
    })
  } catch (error) {
    emitFailure(test, label, 'QUEUE_THROWN', error, 'CALL_THROWN')
  }
}

export function setObserver(onMessage) {
  observer = onMessage || null
}

export function shutdown() {
  if (survivalTimer) clearTimeout(survivalTimer)
  survivalTimer = null
  activeTest = ''
  callbackSeen = false
  observer = null
}

export function runUiControl() {
  const test = 'ui_control'
  const label = 'ui control'
  if (!begin(test, label)) return
  emitStage(test, label, 'UI_REACTIVE_PASS', 'PASS')
  emitResult(test, label, 'PASS', 'ui', 'no native, storage, queue, or transport call')
  armSurvivalWindow(test, label, false)
}

export function runStorageControl() {
  const test = 'storage_control'
  const label = 'storage set + read'
  if (!begin(test, label)) return

  if (!storage || typeof storage.set !== 'function' || typeof storage.getSync !== 'function') {
    emitFailure(
      test,
      label,
      'API_MISSING',
      'storage.set or storage.getSync is unavailable',
      'API_MISSING'
    )
    return
  }

  const expected = `akari-storage-control-${Date.now()}`
  emitStage(test, label, 'BEGIN_STORAGE_SET', 'RUNNING')
  try {
    storage.set({
      key: STORAGE_CONTROL_KEY,
      value: expected,
      success: function () {
        emitStage(test, label, 'STORAGE_SUCCESS', 'PASS')
        emitStage(test, label, 'BEGIN_STORAGE_GET', 'RUNNING')
        try {
          const actual = storage.getSync({ key: STORAGE_CONTROL_KEY })
          if (actual === expected) {
            emitStage(test, label, 'STORAGE_READ_MATCH', 'PASS')
            emitResult(test, label, 'PASS', 'storage', 'exact string round trip matched')
          } else {
            emitFailure(
              test,
              label,
              'STORAGE_READ_MISMATCH',
              'getSync did not return the exact value written by set.success',
              'VALUE_MISMATCH'
            )
          }
        } catch (error) {
          emitFailure(test, label, 'STORAGE_GET_THROWN', error, 'CALL_THROWN')
        }
      },
      fail: function (data, code) {
        emitFailure(test, label, 'STORAGE_FAIL', data, code)
      },
    })
    emitStage(test, label, 'STORAGE_SET_RETURNED', 'RETURNED')
    armSurvivalWindow(test, label, false)
  } catch (error) {
    emitFailure(test, label, 'STORAGE_SET_THROWN', error, 'CALL_THROWN')
  }
}

export function runQueueControl() {
  const test = 'queue_control'
  const label = 'queue + persist'
  if (!begin(test, label)) return

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
  emitStage(test, label, 'BEGIN_QUEUE_ENQUEUE', 'RUNNING')
  try {
    const event = queue.enqueue(
      {
        metric: 'diagnostic_watch_pipeline',
        value: 'queue_control',
        status: 'PASS',
        source_module: STORAGE_MODULE,
        source_api: 'queue.enqueue/storage.set',
        quality: 'non_health_control',
      },
      function (result, persistedEvent) {
        if (result.status !== 'PASS') {
          emitFailure(
            test,
            label,
            'QUEUE_STORAGE_FAIL',
            result.message,
            result.code || result.status
          )
          return
        }
        emitStage(test, label, 'QUEUE_PERSIST_PASS', 'PASS')
        emitResult(
          test,
          'queue + persist',
          'PASS',
          persistedEvent ? persistedEvent.value : 'queue_control',
          'non-health event persisted to the isolated diagnostic queue'
        )
      },
      function (stage) {
        queueStage(test, label, stage)
      }
    )
    emitStage(test, label, 'QUEUE_ENQUEUE_RETURNED', 'PASS', { event_id: event.event_id })
    armSurvivalWindow(test, label, false)
  } catch (error) {
    emitFailure(test, label, 'QUEUE_THROWN', error, 'CALL_THROWN')
  }
}

export function runHrInvokeOnly() {
  const test = 'hr_invoke_only'
  const label = 'hr invoke only'
  if (!begin(test, label)) return
  const type = heartRateType(test, label)
  if (type === undefined) return

  emitStage(test, label, 'BEGIN_HEALTH_CALL', 'RUNNING')
  try {
    health.getRecentSamples({
      dataTypes: [type],
      success: function () {},
      fail: function () {},
    })
    emitStage(test, label, 'HEALTH_CALL_RETURNED', 'RETURNED')
    armSurvivalWindow(test, label, false)
  } catch (error) {
    emitFailure(test, label, 'HEALTH_CALL_THROWN', error, 'CALL_THROWN')
  }
}

export function runHrCallbackOnly() {
  const test = 'hr_callback_only'
  const label = 'hr callback only'
  if (!begin(test, label)) return
  const type = heartRateType(test, label)
  if (type === undefined) return

  emitStage(test, label, 'BEGIN_HEALTH_CALL', 'RUNNING')
  try {
    health.getRecentSamples({
      dataTypes: [type],
      success: function () {
        callbackEntry(test, label, 'success')
      },
      fail: function (data, code) {
        callbackEntry(test, label, 'fail')
        emitFailure(test, label, 'HEALTH_FAIL', data, code)
      },
    })
    emitStage(test, label, 'HEALTH_CALL_RETURNED', 'RETURNED')
    armSurvivalWindow(test, label, true)
  } catch (error) {
    emitFailure(test, label, 'HEALTH_CALL_THROWN', error, 'CALL_THROWN')
  }
}

export function runHrDirect() {
  const test = 'hr_direct'
  const label = 'hr direct ui'
  if (!begin(test, label)) return
  const type = heartRateType(test, label)
  if (type === undefined) return

  emitStage(test, label, 'BEGIN_HEALTH_CALL', 'RUNNING')
  try {
    health.getRecentSamples({
      dataTypes: [type],
      success: function (samples) {
        callbackEntry(test, label, 'success')
        const parsed = parseRecentHeartRate(samples, type)
        emitParsedResult(test, label, parsed)
      },
      fail: function (data, code) {
        callbackEntry(test, label, 'fail')
        emitFailure(test, label, 'HEALTH_FAIL', data, code)
      },
    })
    emitStage(test, label, 'HEALTH_CALL_RETURNED', 'RETURNED')
    armSurvivalWindow(test, label, true)
  } catch (error) {
    emitFailure(test, label, 'HEALTH_CALL_THROWN', error, 'CALL_THROWN')
  }
}

export function runHrFull() {
  const test = 'hr_full_pipeline'
  const label = 'hr full pipeline'
  if (!begin(test, label)) return
  const type = heartRateType(test, label)
  if (type === undefined) return

  emitStage(test, label, 'BEGIN_HEALTH_CALL', 'RUNNING')
  try {
    health.getRecentSamples({
      dataTypes: [type],
      success: function (samples) {
        callbackEntry(test, label, 'success')
        const parsed = parseRecentHeartRate(samples, type)
        if (parsed.status === 'PASS') {
          emitStage(test, label, 'PARSE_PASS', 'PASS', { value: parsed.value })
        } else {
          emitStage(test, label, 'PARSE_NO_DATA', 'NO_DATA', { note: parsed.note })
        }
        const input = {
          metric: 'heart_rate',
          unit: 'bpm',
          sample_timestamp: parsed.sampleTimestamp,
          status: parsed.status,
          source_module: HEALTH_MODULE,
          source_api: 'health.getRecentSamples',
          quality: parsed.zeroShape
            ? 'recent_sample_diagnostic_full_zero_shape'
            : 'recent_sample_diagnostic_full',
        }
        if (parsed.status === 'PASS') input.value = parsed.value
        if (parsed.zeroShape) {
          input.raw_error_code = 'ZERO_SHAPE'
          input.raw_error_message = 'device recent-sample returned value=0 sample_timestamp=0 (no valid sample)'
        }
        persistFullObservation(test, label, input, parsed)
      },
      fail: function (data, code) {
        callbackEntry(test, label, 'fail')
        const failureStatus = statusForFailure(code)
        const failureMessage = errorText(data)
        emitStage(test, label, 'HEALTH_FAIL_RECEIVED', failureStatus, {
          raw_error_code: code,
          raw_error_message: failureMessage,
        })
        persistFullObservation(
          test,
          label,
          {
            metric: 'heart_rate',
            unit: 'bpm',
            status: failureStatus,
            source_module: HEALTH_MODULE,
            source_api: 'health.getRecentSamples',
            quality: 'recent_sample_diagnostic_full',
            raw_error_code: code,
            raw_error_message: failureMessage,
          },
          { status: failureStatus, note: failureMessage }
        )
      },
    })
    emitStage(test, label, 'HEALTH_CALL_RETURNED', 'RETURNED')
    armSurvivalWindow(test, label, true)
  } catch (error) {
    emitFailure(test, label, 'HEALTH_CALL_THROWN', error, 'CALL_THROWN')
  }
}
