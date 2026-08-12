import health from '@blueos.health.health'
import * as queue from './queue'
import * as transport from './transport'
import { errorText, statusForFailure, isZeroHrSampleShape } from './events'

const HEALTH_MODULE = '@blueos.health.health'
const LIVE_WINDOW_MS = 60000
const MAX_LIVE_PASS_EVENTS = 5

let observer = null
let activeTest = ''
let liveTimer = null

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
  console.info(`[akari pulse collect] ${stage} ${label}`)
  publish(message)
}

function emitFailure(test, label, stage, data, code, status) {
  const rawCode = code === undefined || code === null ? 'UNKNOWN' : code
  const rawMessage = errorText(data)
  console.error(`[akari pulse collect] ${stage} ${label} code=${rawCode} message=${rawMessage}`)
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
  emitStage(test, label, 'BEGIN', 'RUNNING')
  return true
}

function finishRun(test) {
  if (activeTest === test) activeTest = ''
}

function ensureQueueLoaded(test, label) {
  let loadedSummary
  try {
    loadedSummary = queue.load()
  } catch (error) {
    emitFailure(test, label, 'QUEUE_LOAD_THROWN', error, 'CALL_THROWN')
    return false
  }
  if (!loadedSummary || loadedSummary.storage_status !== 'PASS') {
    emitFailure(
      test,
      label,
      'QUEUE_LOAD_FAIL',
      loadedSummary ? loadedSummary.storage_error : 'queue.load returned no summary',
      loadedSummary ? loadedSummary.storage_status : 'NO_SUMMARY'
    )
    return false
  }
  emitStage(test, label, 'QUEUE_LOAD_PASS', 'PASS')
  return true
}

function initTransportForRun(test, label, onDone) {
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
        'relay stored the collect batch and returned a matching acknowledgement'
      )
      if (onDone) onDone(true)
      return
    }
    if (message.kind === 'sync_error') {
      emitFailure(test, label, 'SEND_FAIL', message.message, message.code, message.status)
      emitResult(test, label, message.status || 'ERROR', undefined, errorText(message.message))
      if (onDone) onDone(false)
      return
    }
    if (message.kind === 'sync_empty') {
      emitFailure(test, label, 'QUEUE_EMPTY', 'no events were queued for sending', 'QUEUE_EMPTY')
      if (onDone) onDone(false)
    }
  })
}

function enqueueLayerDiag(test, layer, status, sourceApi, code, message, sourceModule) {
  const input = {
    metric: `diagnostic_${layer}`,
    status: status,
    source_module: sourceModule || HEALTH_MODULE,
    source_api: sourceApi,
    quality: test,
  }
  if (status === 'PASS') input.value = 'observed'
  if (code !== undefined && code !== null && code !== '') input.raw_error_code = code
  if (message !== undefined && message !== null && message !== '') input.raw_error_message = message
  queue.enqueue(input)
}

function healthReady(fnName) {
  if (!health || typeof health[fnName] !== 'function') return false
  if (!health.DATA_TYPES) return false
  return true
}

function dataType(name) {
  if (!health || !health.DATA_TYPES) return undefined
  return health.DATA_TYPES[name]
}

function statisticType(name) {
  if (!health || !health.STATISTIC_TYPES) return undefined
  return health.STATISTIC_TYPES[name]
}

function validTimestamp(value) {
  return typeof value === 'number' && isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

export function setObserver(onMessage) {
  observer = onMessage || null
}

export function shutdown() {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = null
  activeTest = ''
  observer = null
}

// ---- Button 1: collect hr live -----------------------------------------------
// Real 60 s heart-rate live subscription. Enqueues up to MAX_LIVE_PASS_EVENTS
// nonzero PASS events (bpm + real callback ts + callback_delta_ms). If the
// window ends with zero nonzero callbacks, enqueues exactly one heart_rate
// NO_DATA event. Also emits watch_module_api, permission, and sample_acquisition
// layer diagnostics reflecting real observations, then syncs.
export function runCollectHrLive() {
  const test = 'collect_hr_live'
  const label = 'collect hr live'
  if (!begin(test, label)) return
  if (!ensureQueueLoaded(test, label)) {
    finishRun(test)
    return
  }

  const moduleOk = healthReady('subscribeSample') && dataType('HEART_RATE') !== undefined
  if (!moduleOk) {
    enqueueLayerDiag(
      test,
      'watch_module_api',
      'API_MISSING',
      'health.subscribeSample',
      'API_MISSING',
      'health.subscribeSample or DATA_TYPES.HEART_RATE unavailable'
    )
    emitFailure(
      test,
      label,
      'API_MISSING',
      'health.subscribeSample or DATA_TYPES.HEART_RATE unavailable',
      'API_MISSING',
      'API_MISSING'
    )
    initTransportForRun(test, label, function () {
      finishRun(test)
    })
    transport.syncNow()
    return
  }
  enqueueLayerDiag(test, 'watch_module_api', 'PASS', 'health.subscribeSample')

  const type = dataType('HEART_RATE')
  const liveState = {
    passCount: 0,
    zeroCount: 0,
    failCode: null,
    failMessage: null,
    lastCallbackAt: null,
  }

  emitStage(test, label, 'BEGIN_LIVE_SUBSCRIBE', 'RUNNING')
  try {
    health.subscribeSample({
      dataType: type,
      callback: function (sample) {
        const now = Date.now()
        const delta =
          liveState.lastCallbackAt === null
            ? undefined
            : Math.max(0, now - liveState.lastCallbackAt)
        liveState.lastCallbackAt = now

        if (!sample || sample.value === undefined || sample.value === null) {
          liveState.zeroCount += 1
          emitStage(test, label, 'HR_CALLBACK_EMPTY', 'NO_DATA', { value: liveState.zeroCount })
          return
        }
        if (isZeroHrSampleShape(sample)) {
          liveState.zeroCount += 1
          emitStage(test, label, 'HR_CALLBACK_ZERO_SHAPE', 'NO_DATA', {
            value: liveState.zeroCount,
          })
          return
        }
        if (liveState.passCount >= MAX_LIVE_PASS_EVENTS) {
          emitStage(test, label, 'HR_CALLBACK_CAPPED', 'RUNNING', { value: liveState.passCount })
          return
        }
        liveState.passCount += 1
        emitStage(test, label, `HR_CALLBACK_PASS_${liveState.passCount}`, 'PASS', {
          value: sample.value,
        })
        const input = {
          timestamp: now,
          metric: 'heart_rate',
          value: sample.value,
          unit: 'bpm',
          sample_timestamp: validTimestamp(sample.timeStamp),
          status: 'PASS',
          source_module: HEALTH_MODULE,
          source_api: 'health.subscribeSample',
          quality: 'live_sample_collect',
        }
        if (delta !== undefined) input.callback_delta_ms = delta
        queue.enqueue(input)
      },
      fail: function (data, code) {
        liveState.failCode = code === undefined || code === null ? 'UNKNOWN' : code
        liveState.failMessage = errorText(data)
        const status = statusForFailure(liveState.failCode)
        emitFailure(test, label, 'HR_SUBSCRIPTION_FAIL', data, liveState.failCode, status)
      },
    })
    emitStage(test, label, 'SUBSCRIBE_RETURNED', 'RETURNED')
  } catch (error) {
    liveState.failCode = 'CALL_THROWN'
    liveState.failMessage = errorText(error)
    emitFailure(test, label, 'SUBSCRIBE_THROWN', error, 'CALL_THROWN')
  }

  liveTimer = setTimeout(function () {
    liveTimer = null
    // Best-effort unsubscribe.
    try {
      if (health && typeof health.unsubscribeSample === 'function') {
        health.unsubscribeSample({ dataType: type })
        emitStage(test, label, 'UNSUBSCRIBED', 'PASS')
      }
    } catch (error) {
      emitFailure(test, label, 'UNSUBSCRIBE_THROWN', error, 'CALL_THROWN')
    }

    if (liveState.failCode !== null) {
      enqueueLayerDiag(
        test,
        'permission',
        statusForFailure(liveState.failCode),
        'health.subscribeSample',
        liveState.failCode,
        liveState.failMessage
      )
    } else {
      enqueueLayerDiag(test, 'permission', 'PASS', 'health.subscribeSample')
    }

    if (liveState.passCount > 0) {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        'PASS',
        'health.subscribeSample',
        'LIVE_CALLBACKS',
        `${liveState.passCount} nonzero, ${liveState.zeroCount} zero-shape`
      )
    } else if (liveState.failCode !== null) {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        statusForFailure(liveState.failCode),
        'health.subscribeSample',
        liveState.failCode,
        liveState.failMessage
      )
    } else {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        'NO_DATA',
        'health.subscribeSample',
        'LIVE_WINDOW_ZERO',
        `${liveState.zeroCount} zero-shape callback(s) and 0 real bpm in ${LIVE_WINDOW_MS}ms`
      )
    }

    if (liveState.passCount === 0) {
      const status = liveState.failCode !== null ? statusForFailure(liveState.failCode) : 'NO_DATA'
      const input = {
        metric: 'heart_rate',
        unit: 'bpm',
        status: status,
        source_module: HEALTH_MODULE,
        source_api: 'health.subscribeSample',
        quality: 'live_sample_collect_empty_window',
      }
      if (liveState.failCode !== null) {
        input.raw_error_code = liveState.failCode
        input.raw_error_message = liveState.failMessage
      } else {
        input.raw_error_code = 'LIVE_WINDOW_ZERO'
        input.raw_error_message = `${liveState.zeroCount} zero-shape callback(s) in ${LIVE_WINDOW_MS}ms window`
      }
      queue.enqueue(input)
    }

    initTransportForRun(test, label, function () {
      finishRun(test)
    })
    transport.syncNow()
  }, LIVE_WINDOW_MS)
}

// ---- Button 2: collect recents ----------------------------------------------
// One event per metric via health.getRecentSamples: heart_rate, resting HR,
// SpO2, stress. PASS carries the real value+timestamp; the zero-shape maps to
// NO_DATA for heart-rate-family; empty payload maps to NO_DATA; fail codes map
// via statusForFailure. Layer diags reflect real observations. Then sync.
const RECENT_METRICS = [
  { type: 'HEART_RATE', metric: 'heart_rate', unit: 'bpm', hr: true },
  { type: 'HEART_RATE_RESTING', metric: 'heart_rate_resting', unit: 'bpm', hr: true },
  { type: 'SPO2', metric: 'spo2', unit: '%', hr: false },
  { type: 'STRESS', metric: 'stress', unit: '', hr: false },
]

export function runCollectRecents() {
  const test = 'collect_recents'
  const label = 'collect recents'
  if (!begin(test, label)) return
  if (!ensureQueueLoaded(test, label)) {
    finishRun(test)
    return
  }

  if (!healthReady('getRecentSamples')) {
    enqueueLayerDiag(
      test,
      'watch_module_api',
      'API_MISSING',
      'health.getRecentSamples',
      'API_MISSING',
      'health.getRecentSamples or DATA_TYPES unavailable'
    )
    emitFailure(
      test,
      label,
      'API_MISSING',
      'health.getRecentSamples unavailable',
      'API_MISSING',
      'API_MISSING'
    )
    initTransportForRun(test, label, function () {
      finishRun(test)
    })
    transport.syncNow()
    return
  }
  enqueueLayerDiag(test, 'watch_module_api', 'PASS', 'health.getRecentSamples')

  const results = []

  function finalize() {
    let anyPass = false
    let anyNoData = false
    let firstDenied = null
    let firstError = null
    for (let index = 0; index < results.length; index += 1) {
      const r = results[index]
      if (r.status === 'PASS') anyPass = true
      else if (r.status === 'NO_DATA') anyNoData = true
      else if (r.status === 'DENIED' && !firstDenied) firstDenied = r
      else if (!firstError && (r.status === 'ERROR' || r.status === 'UNSUPPORTED' || r.status === 'API_MISSING'))
        firstError = r
    }

    if (firstDenied) {
      enqueueLayerDiag(
        test,
        'permission',
        'DENIED',
        'health.getRecentSamples',
        firstDenied.code,
        firstDenied.message
      )
    } else {
      enqueueLayerDiag(test, 'permission', 'PASS', 'health.getRecentSamples')
    }

    if (anyPass) {
      let passCount = 0
      for (let index = 0; index < results.length; index += 1) if (results[index].status === 'PASS') passCount += 1
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        'PASS',
        'health.getRecentSamples',
        'RECENT_SAMPLES',
        `${passCount} PASS of ${results.length}`
      )
    } else if (anyNoData && !firstError) {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        'NO_DATA',
        'health.getRecentSamples',
        'RECENT_ALL_NO_DATA',
        'all recents returned empty or zero-shape'
      )
    } else if (firstError) {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        firstError.status,
        'health.getRecentSamples',
        firstError.code,
        firstError.message
      )
    } else {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        'NO_DATA',
        'health.getRecentSamples',
        'RECENT_NO_RESULTS',
        'no results were produced'
      )
    }

    initTransportForRun(test, label, function () {
      finishRun(test)
    })
    transport.syncNow()
  }

  function runOne(index) {
    if (index >= RECENT_METRICS.length) {
      finalize()
      return
    }
    const descriptor = RECENT_METRICS[index]
    const type = dataType(descriptor.type)
    if (type === undefined || type === null) {
      const input = {
        metric: descriptor.metric,
        unit: descriptor.unit,
        status: 'API_MISSING',
        source_module: HEALTH_MODULE,
        source_api: 'health.DATA_TYPES',
        quality: 'recent_sample_collect',
        raw_error_code: 'API_MISSING',
        raw_error_message: `DATA_TYPES.${descriptor.type} unavailable`,
      }
      queue.enqueue(input)
      results.push({ metric: descriptor.metric, status: 'API_MISSING', code: 'API_MISSING' })
      runOne(index + 1)
      return
    }

    emitStage(test, label, `BEGIN_${descriptor.type}`, 'RUNNING')
    try {
      health.getRecentSamples({
        dataTypes: [type],
        success: function (samples) {
          let sample = null
          if (Array.isArray(samples)) {
            for (let i = 0; i < samples.length; i += 1) {
              if (samples[i] && samples[i].dataType === type) {
                sample = samples[i].data
                break
              }
            }
            if (!sample && samples.length === 1 && samples[0]) sample = samples[0].data
          }

          if (!sample || sample.value === undefined || sample.value === null) {
            const input = {
              metric: descriptor.metric,
              unit: descriptor.unit,
              status: 'NO_DATA',
              source_module: HEALTH_MODULE,
              source_api: 'health.getRecentSamples',
              quality: 'recent_sample_collect_empty',
            }
            queue.enqueue(input)
            emitStage(test, label, `${descriptor.type}_NO_DATA`, 'NO_DATA')
            results.push({ metric: descriptor.metric, status: 'NO_DATA' })
            runOne(index + 1)
            return
          }
          if (descriptor.hr && isZeroHrSampleShape(sample)) {
            const input = {
              metric: descriptor.metric,
              unit: descriptor.unit,
              status: 'NO_DATA',
              source_module: HEALTH_MODULE,
              source_api: 'health.getRecentSamples',
              quality: 'recent_sample_collect_zero_shape',
              raw_error_code: 'ZERO_SHAPE',
              raw_error_message: 'value=0 sample_timestamp=0 (no valid sample)',
            }
            queue.enqueue(input)
            emitStage(test, label, `${descriptor.type}_ZERO_SHAPE`, 'NO_DATA')
            results.push({ metric: descriptor.metric, status: 'NO_DATA' })
            runOne(index + 1)
            return
          }

          const input = {
            metric: descriptor.metric,
            value: sample.value,
            unit: descriptor.unit,
            sample_timestamp: validTimestamp(sample.timeStamp),
            status: 'PASS',
            source_module: HEALTH_MODULE,
            source_api: 'health.getRecentSamples',
            quality: 'recent_sample_collect',
          }
          queue.enqueue(input)
          emitStage(test, label, `${descriptor.type}_PASS`, 'PASS', { value: sample.value })
          results.push({ metric: descriptor.metric, status: 'PASS', value: sample.value })
          runOne(index + 1)
        },
        fail: function (data, code) {
          const rawCode = code === undefined || code === null ? 'UNKNOWN' : code
          const rawMessage = errorText(data)
          const status = statusForFailure(rawCode)
          const input = {
            metric: descriptor.metric,
            unit: descriptor.unit,
            status: status,
            source_module: HEALTH_MODULE,
            source_api: 'health.getRecentSamples',
            quality: 'recent_sample_collect',
            raw_error_code: rawCode,
            raw_error_message: rawMessage,
          }
          queue.enqueue(input)
          emitFailure(test, label, `${descriptor.type}_FAIL`, data, rawCode, status)
          results.push({ metric: descriptor.metric, status: status, code: rawCode, message: rawMessage })
          runOne(index + 1)
        },
      })
    } catch (error) {
      const rawMessage = errorText(error)
      const input = {
        metric: descriptor.metric,
        unit: descriptor.unit,
        status: 'ERROR',
        source_module: HEALTH_MODULE,
        source_api: 'health.getRecentSamples',
        quality: 'recent_sample_collect',
        raw_error_code: 'CALL_THROWN',
        raw_error_message: rawMessage,
      }
      queue.enqueue(input)
      emitFailure(test, label, `${descriptor.type}_THROWN`, error, 'CALL_THROWN')
      results.push({ metric: descriptor.metric, status: 'ERROR', code: 'CALL_THROWN', message: rawMessage })
      runOne(index + 1)
    }
  }

  runOne(0)
}

// ---- Button 3: collect stats -------------------------------------------------
// Daily statistics via health.getTodayStatistic. Uses only the published support
// matrix (see watch/README.md): SUM for standing/intensity/step/distance/calories
// and MAX/MIN for heart-rate. Real values only; empty result → NO_DATA. Then sync.
const STAT_METRICS = [
  { type: 'STEP_COUNT', statistic: 'SUM', metric: 'step_count', unit: 'step' },
  { type: 'DISTANCE', statistic: 'SUM', metric: 'distance', unit: 'm' },
  { type: 'CALORIES', statistic: 'SUM', metric: 'calories', unit: 'kcal' },
  { type: 'STANDING', statistic: 'SUM', metric: 'standing', unit: 'hour' },
  { type: 'INTENSITY_SPORT', statistic: 'SUM', metric: 'intensity_sport', unit: 'minute' },
  { type: 'HEART_RATE', statistic: 'MAX', metric: 'heart_rate_today_max', unit: 'bpm' },
  { type: 'HEART_RATE', statistic: 'MIN', metric: 'heart_rate_today_min', unit: 'bpm' },
]

export function runCollectStats() {
  const test = 'collect_stats'
  const label = 'collect stats'
  if (!begin(test, label)) return
  if (!ensureQueueLoaded(test, label)) {
    finishRun(test)
    return
  }

  if (!healthReady('getTodayStatistic')) {
    enqueueLayerDiag(
      test,
      'watch_module_api',
      'API_MISSING',
      'health.getTodayStatistic',
      'API_MISSING',
      'health.getTodayStatistic or DATA_TYPES unavailable'
    )
    emitFailure(
      test,
      label,
      'API_MISSING',
      'health.getTodayStatistic unavailable',
      'API_MISSING',
      'API_MISSING'
    )
    initTransportForRun(test, label, function () {
      finishRun(test)
    })
    transport.syncNow()
    return
  }
  enqueueLayerDiag(test, 'watch_module_api', 'PASS', 'health.getTodayStatistic')

  const results = []

  function finalize() {
    let anyPass = false
    let anyNoData = false
    let firstDenied = null
    let firstError = null
    for (let index = 0; index < results.length; index += 1) {
      const r = results[index]
      if (r.status === 'PASS') anyPass = true
      else if (r.status === 'NO_DATA') anyNoData = true
      else if (r.status === 'DENIED' && !firstDenied) firstDenied = r
      else if (!firstError && (r.status === 'ERROR' || r.status === 'UNSUPPORTED' || r.status === 'API_MISSING'))
        firstError = r
    }

    if (firstDenied) {
      enqueueLayerDiag(
        test,
        'permission',
        'DENIED',
        'health.getTodayStatistic',
        firstDenied.code,
        firstDenied.message
      )
    } else {
      enqueueLayerDiag(test, 'permission', 'PASS', 'health.getTodayStatistic')
    }

    if (anyPass) {
      let passCount = 0
      for (let index = 0; index < results.length; index += 1) if (results[index].status === 'PASS') passCount += 1
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        'PASS',
        'health.getTodayStatistic',
        'TODAY_STATS',
        `${passCount} PASS of ${results.length}`
      )
    } else if (anyNoData && !firstError) {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        'NO_DATA',
        'health.getTodayStatistic',
        'STATS_ALL_NO_DATA',
        'all daily statistics returned empty'
      )
    } else if (firstError) {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        firstError.status,
        'health.getTodayStatistic',
        firstError.code,
        firstError.message
      )
    } else {
      enqueueLayerDiag(
        test,
        'sample_acquisition',
        'NO_DATA',
        'health.getTodayStatistic',
        'STATS_NO_RESULTS',
        'no results were produced'
      )
    }

    initTransportForRun(test, label, function () {
      finishRun(test)
    })
    transport.syncNow()
  }

  function runOne(index) {
    if (index >= STAT_METRICS.length) {
      finalize()
      return
    }
    const descriptor = STAT_METRICS[index]
    const type = dataType(descriptor.type)
    const statistic = statisticType(descriptor.statistic)
    if (type === undefined || type === null || statistic === undefined || statistic === null) {
      const input = {
        metric: descriptor.metric,
        unit: descriptor.unit,
        status: 'API_MISSING',
        source_module: HEALTH_MODULE,
        source_api: 'health.DATA_TYPES/STATISTIC_TYPES',
        quality: `today_${descriptor.statistic.toLowerCase()}_collect`,
        raw_error_code: 'API_MISSING',
        raw_error_message: `DATA_TYPES.${descriptor.type} or STATISTIC_TYPES.${descriptor.statistic} unavailable`,
      }
      queue.enqueue(input)
      results.push({ metric: descriptor.metric, status: 'API_MISSING', code: 'API_MISSING' })
      runOne(index + 1)
      return
    }

    emitStage(test, label, `BEGIN_${descriptor.type}_${descriptor.statistic}`, 'RUNNING')
    try {
      health.getTodayStatistic({
        dataType: type,
        statisticType: statistic,
        success: function (result) {
          if (!result || result.value === undefined || result.value === null) {
            const input = {
              metric: descriptor.metric,
              unit: descriptor.unit,
              status: 'NO_DATA',
              source_module: HEALTH_MODULE,
              source_api: 'health.getTodayStatistic',
              quality: `today_${descriptor.statistic.toLowerCase()}_collect_empty`,
            }
            queue.enqueue(input)
            emitStage(test, label, `${descriptor.type}_${descriptor.statistic}_NO_DATA`, 'NO_DATA')
            results.push({ metric: descriptor.metric, status: 'NO_DATA' })
            runOne(index + 1)
            return
          }

          const input = {
            metric: descriptor.metric,
            value: result.value,
            unit: descriptor.unit,
            sample_timestamp: validTimestamp(result.endTime),
            status: 'PASS',
            source_module: HEALTH_MODULE,
            source_api: 'health.getTodayStatistic',
            quality: `today_${descriptor.statistic.toLowerCase()}_collect`,
          }
          queue.enqueue(input)
          emitStage(test, label, `${descriptor.type}_${descriptor.statistic}_PASS`, 'PASS', {
            value: result.value,
          })
          results.push({ metric: descriptor.metric, status: 'PASS', value: result.value })
          runOne(index + 1)
        },
        fail: function (data, code) {
          const rawCode = code === undefined || code === null ? 'UNKNOWN' : code
          const rawMessage = errorText(data)
          const status = statusForFailure(rawCode)
          const input = {
            metric: descriptor.metric,
            unit: descriptor.unit,
            status: status,
            source_module: HEALTH_MODULE,
            source_api: 'health.getTodayStatistic',
            quality: `today_${descriptor.statistic.toLowerCase()}_collect`,
            raw_error_code: rawCode,
            raw_error_message: rawMessage,
          }
          queue.enqueue(input)
          emitFailure(test, label, `${descriptor.type}_${descriptor.statistic}_FAIL`, data, rawCode, status)
          results.push({ metric: descriptor.metric, status: status, code: rawCode, message: rawMessage })
          runOne(index + 1)
        },
      })
    } catch (error) {
      const rawMessage = errorText(error)
      const input = {
        metric: descriptor.metric,
        unit: descriptor.unit,
        status: 'ERROR',
        source_module: HEALTH_MODULE,
        source_api: 'health.getTodayStatistic',
        quality: `today_${descriptor.statistic.toLowerCase()}_collect`,
        raw_error_code: 'CALL_THROWN',
        raw_error_message: rawMessage,
      }
      queue.enqueue(input)
      emitFailure(test, label, `${descriptor.type}_${descriptor.statistic}_THROWN`, error, 'CALL_THROWN')
      results.push({ metric: descriptor.metric, status: 'ERROR', code: 'CALL_THROWN', message: rawMessage })
      runOne(index + 1)
    }
  }

  runOne(0)
}
