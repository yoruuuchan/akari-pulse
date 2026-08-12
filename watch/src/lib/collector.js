import health from '@blueos.health.health'
import sensor from '@blueos.hardware.sensor.sensor'
import { enqueue } from './queue'
import { errorText, statusForFailure } from './events'

const HEALTH_MODULE = '@blueos.health.health'
const SENSOR_MODULE = '@blueos.hardware.sensor.sensor'

const PROBES = {
  recent_hr: {
    id: 'recent_hr',
    label: 'Recent HR',
    kind: 'recent',
    type: 'HEART_RATE',
    metric: 'heart_rate',
    unit: 'bpm',
  },
  resting_hr: {
    id: 'resting_hr',
    label: 'Resting HR',
    kind: 'recent',
    type: 'HEART_RATE_RESTING',
    metric: 'heart_rate_resting',
    unit: 'bpm',
  },
  step_count: {
    id: 'step_count',
    label: 'Step Count',
    kind: 'today',
    type: 'STEP_COUNT',
    statistic: 'SUM',
    metric: 'step_count',
    unit: 'step',
  },
  spo2: {
    id: 'spo2',
    label: 'SpO2',
    kind: 'recent',
    type: 'SPO2',
    metric: 'spo2',
    unit: '%',
  },
  stress: {
    id: 'stress',
    label: 'Stress',
    kind: 'recent',
    type: 'STRESS',
    metric: 'stress',
    unit: '',
  },
  sleep_status: {
    id: 'sleep_status',
    label: 'Sleep Status',
    kind: 'recent',
    type: 'SLEEP_STATUS',
    metric: 'sleep_status',
    unit: 'state',
  },
  sleep_unit: {
    id: 'sleep_unit',
    label: 'Sleep Unit',
    kind: 'recent',
    type: 'SLEEP_UNIT',
    metric: 'sleep_unit',
    unit: '',
  },
  sleep_stages: {
    id: 'sleep_stages',
    label: 'Sleep Stages',
    kind: 'recent',
    type: 'SLEEP_STAGES',
    metric: 'sleep_stages',
    unit: '',
  },
  today_statistic: {
    id: 'today_statistic',
    label: 'Today Statistic',
    kind: 'today',
    type: 'HEART_RATE',
    statistic: 'MAX',
    metric: 'heart_rate_today_max',
    unit: 'bpm',
  },
}

const START_HR_SUBSCRIPTION = {
  id: 'start_hr_subscription',
  label: 'Start HR Subscription',
  metric: 'heart_rate',
  unit: 'bpm',
  sourceApi: 'health.subscribeSample',
}

const STOP_HR_SUBSCRIPTION = {
  id: 'stop_hr_subscription',
  label: 'Stop HR Subscription',
  metric: 'heart_rate_subscription',
  unit: '',
  sourceApi: 'health.unsubscribeSample',
}

const STEP_SENSOR = {
  id: 'step_sensor',
  label: 'Step Sensor',
  metric: 'step_count_sensor',
  unit: 'step',
  sourceApi: 'sensor.subscribeStepCounter',
}

let observer = null
let activeOneShot = ''
let hrSubscriptionActive = false
let hrSubscriptionPassed = false
let stepSensorActive = false
let stepSensorPassed = false
const lastCallbackAt = {}

function publish(message) {
  if (observer) observer(message)
}

function observe(input) {
  const event = enqueue(input)
  publish({ kind: 'observation', event: event })
  return event
}

function validTimestamp(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function callbackDelta(metric, now) {
  const previous = lastCallbackAt[metric]
  lastCallbackAt[metric] = now
  return typeof previous === 'number' ? Math.max(0, now - previous) : undefined
}

function dataType(name) {
  if (!health || !health.DATA_TYPES) return undefined
  return health.DATA_TYPES[name]
}

function statisticType(name) {
  if (!health || !health.STATISTIC_TYPES) return undefined
  return health.STATISTIC_TYPES[name]
}

function recordFailure(descriptor, sourceApi, data, code, quality, sourceModule) {
  return observe({
    metric: descriptor.metric,
    unit: descriptor.unit,
    status: statusForFailure(code),
    source_module: sourceModule || HEALTH_MODULE,
    source_api: sourceApi,
    quality: quality,
    raw_error_code: code,
    raw_error_message: errorText(data),
  })
}

function recordApiMissing(descriptor, sourceApi, message, sourceModule) {
  return observe({
    metric: descriptor.metric,
    unit: descriptor.unit,
    status: 'API_MISSING',
    source_module: sourceModule || HEALTH_MODULE,
    source_api: sourceApi,
    raw_error_code: 'API_MISSING',
    raw_error_message: message,
  })
}

function beginMarker(descriptor, sourceApi) {
  console.info(`[akari pulse] BEGIN ${descriptor.label}`)
  publish({
    kind: 'probe_begin',
    probe: descriptor.id,
    label: descriptor.label,
    source_api: sourceApi,
  })
}

function passMarker(descriptor, event) {
  const status = event ? event.status : 'PASS'
  const suffix = status === 'PASS' ? '' : ` status=${status}`
  console.info(`[akari pulse] PASS ${descriptor.label}${suffix}`)
  publish({
    kind: 'probe_pass',
    probe: descriptor.id,
    label: descriptor.label,
    status: status,
    event: event || null,
  })
}

function failMarker(descriptor, event) {
  const code = event && event.raw_error_code !== undefined ? event.raw_error_code : 'UNKNOWN'
  const message = event && event.raw_error_message ? event.raw_error_message : 'unknown failure'
  console.error(`[akari pulse] FAIL ${descriptor.label} code=${code} message=${message}`)
  publish({
    kind: 'probe_fail',
    probe: descriptor.id,
    label: descriptor.label,
    status: event ? event.status : 'ERROR',
    raw_error_code: code,
    raw_error_message: message,
  })
}

function busyMarker(descriptor) {
  const message = `${activeOneShot} is still awaiting a callback`
  console.error(`[akari pulse] FAIL ${descriptor.label} code=PROBE_BUSY message=${message}`)
  publish({
    kind: 'probe_fail',
    probe: descriptor.id,
    label: descriptor.label,
    status: 'ERROR',
    raw_error_code: 'PROBE_BUSY',
    raw_error_message: message,
  })
}

function finishOneShotPass(descriptor, event) {
  activeOneShot = ''
  passMarker(descriptor, event)
}

function finishOneShotFailure(descriptor, event) {
  activeOneShot = ''
  failMarker(descriptor, event)
}

function runRecentProbe(descriptor) {
  if (activeOneShot) {
    busyMarker(descriptor)
    return
  }
  activeOneShot = descriptor.id
  beginMarker(descriptor, 'health.getRecentSamples')

  if (!health || typeof health.getRecentSamples !== 'function') {
    finishOneShotFailure(
      descriptor,
      recordApiMissing(descriptor, 'health.getRecentSamples', 'health.getRecentSamples is unavailable')
    )
    return
  }

  const type = dataType(descriptor.type)
  if (type === undefined || type === null) {
    finishOneShotFailure(
      descriptor,
      recordApiMissing(
        descriptor,
        'health.DATA_TYPES',
        `health.DATA_TYPES.${descriptor.type} is unavailable`
      )
    )
    return
  }

  try {
    health.getRecentSamples({
      dataTypes: [type],
      success: function (samples) {
        let sample = null
        if (Array.isArray(samples)) {
          for (let index = 0; index < samples.length; index += 1) {
            if (samples[index] && samples[index].dataType === type) {
              sample = samples[index].data
              break
            }
          }
          if (!sample && samples.length === 1 && samples[0]) sample = samples[0].data
        }

        if (!sample || sample.value === undefined || sample.value === null) {
          const event = observe({
            metric: descriptor.metric,
            unit: descriptor.unit,
            status: 'NO_DATA',
            source_module: HEALTH_MODULE,
            source_api: 'health.getRecentSamples',
            quality: 'recent_sample',
          })
          finishOneShotPass(descriptor, event)
          return
        }

        const event = observe({
          metric: descriptor.metric,
          value: sample.value,
          unit: descriptor.unit,
          sample_timestamp: validTimestamp(sample.timeStamp),
          status: 'PASS',
          source_module: HEALTH_MODULE,
          source_api: 'health.getRecentSamples',
          quality: 'recent_sample',
        })
        finishOneShotPass(descriptor, event)
      },
      fail: function (data, code) {
        finishOneShotFailure(
          descriptor,
          recordFailure(descriptor, 'health.getRecentSamples', data, code, 'recent_sample')
        )
      },
    })
  } catch (error) {
    finishOneShotFailure(
      descriptor,
      recordFailure(descriptor, 'health.getRecentSamples', error, 'CALL_THROWN', 'recent_sample')
    )
  }
}

function runTodayStatisticProbe(descriptor) {
  if (activeOneShot) {
    busyMarker(descriptor)
    return
  }
  activeOneShot = descriptor.id
  beginMarker(descriptor, 'health.getTodayStatistic')

  if (!health || typeof health.getTodayStatistic !== 'function') {
    finishOneShotFailure(
      descriptor,
      recordApiMissing(descriptor, 'health.getTodayStatistic', 'health.getTodayStatistic is unavailable')
    )
    return
  }

  const type = dataType(descriptor.type)
  const statistic = statisticType(descriptor.statistic)
  if (type === undefined || type === null || statistic === undefined || statistic === null) {
    finishOneShotFailure(
      descriptor,
      recordApiMissing(
        descriptor,
        'health.DATA_TYPES/STATISTIC_TYPES',
        `required enum is unavailable: ${descriptor.type}/${descriptor.statistic}`
      )
    )
    return
  }

  try {
    health.getTodayStatistic({
      dataType: type,
      statisticType: statistic,
      success: function (result) {
        if (!result || result.value === undefined || result.value === null) {
          const event = observe({
            metric: descriptor.metric,
            unit: descriptor.unit,
            status: 'NO_DATA',
            source_module: HEALTH_MODULE,
            source_api: 'health.getTodayStatistic',
            quality: `today_${descriptor.statistic.toLowerCase()}`,
          })
          finishOneShotPass(descriptor, event)
          return
        }

        const event = observe({
          metric: descriptor.metric,
          value: result.value,
          unit: descriptor.unit,
          sample_timestamp: validTimestamp(result.endTime),
          status: 'PASS',
          source_module: HEALTH_MODULE,
          source_api: 'health.getTodayStatistic',
          quality: `today_${descriptor.statistic.toLowerCase()}`,
        })
        finishOneShotPass(descriptor, event)
      },
      fail: function (data, code) {
        finishOneShotFailure(
          descriptor,
          recordFailure(
            descriptor,
            'health.getTodayStatistic',
            data,
            code,
            `today_${descriptor.statistic.toLowerCase()}`
          )
        )
      },
    })
  } catch (error) {
    finishOneShotFailure(
      descriptor,
      recordFailure(
        descriptor,
        'health.getTodayStatistic',
        error,
        'CALL_THROWN',
        `today_${descriptor.statistic.toLowerCase()}`
      )
    )
  }
}

export function setObserver(onMessage) {
  observer = onMessage || null
}

export function runProbe(probeId) {
  const descriptor = PROBES[probeId]
  if (!descriptor) return
  if (descriptor.kind === 'recent') {
    runRecentProbe(descriptor)
  } else {
    runTodayStatisticProbe(descriptor)
  }
}

export function startHeartRateSubscription() {
  if (hrSubscriptionActive) {
    const message = 'heart-rate subscription is already active'
    console.error(
      `[akari pulse] FAIL ${START_HR_SUBSCRIPTION.label} code=ALREADY_ACTIVE message=${message}`
    )
    publish({
      kind: 'probe_fail',
      probe: START_HR_SUBSCRIPTION.id,
      label: START_HR_SUBSCRIPTION.label,
      status: 'ERROR',
      raw_error_code: 'ALREADY_ACTIVE',
      raw_error_message: message,
    })
    return
  }

  beginMarker(START_HR_SUBSCRIPTION, START_HR_SUBSCRIPTION.sourceApi)
  if (!health || typeof health.subscribeSample !== 'function') {
    failMarker(
      START_HR_SUBSCRIPTION,
      recordApiMissing(
        START_HR_SUBSCRIPTION,
        START_HR_SUBSCRIPTION.sourceApi,
        'health.subscribeSample is unavailable'
      )
    )
    return
  }

  const type = dataType('HEART_RATE')
  if (type === undefined || type === null) {
    failMarker(
      START_HR_SUBSCRIPTION,
      recordApiMissing(
        START_HR_SUBSCRIPTION,
        'health.DATA_TYPES',
        'health.DATA_TYPES.HEART_RATE is unavailable'
      )
    )
    return
  }

  hrSubscriptionActive = true
  hrSubscriptionPassed = false
  try {
    health.subscribeSample({
      dataType: type,
      callback: function (sample) {
        const now = Date.now()
        let event
        if (!sample || sample.value === undefined || sample.value === null) {
          event = observe({
            metric: START_HR_SUBSCRIPTION.metric,
            unit: START_HR_SUBSCRIPTION.unit,
            status: 'NO_DATA',
            source_module: HEALTH_MODULE,
            source_api: START_HR_SUBSCRIPTION.sourceApi,
            quality: 'live_sample',
            callback_delta_ms: callbackDelta(START_HR_SUBSCRIPTION.metric, now),
          })
        } else {
          event = observe({
            timestamp: now,
            metric: START_HR_SUBSCRIPTION.metric,
            value: sample.value,
            unit: START_HR_SUBSCRIPTION.unit,
            sample_timestamp: validTimestamp(sample.timeStamp),
            status: 'PASS',
            source_module: HEALTH_MODULE,
            source_api: START_HR_SUBSCRIPTION.sourceApi,
            quality: 'live_sample',
            callback_delta_ms: callbackDelta(START_HR_SUBSCRIPTION.metric, now),
          })
        }
        if (!hrSubscriptionPassed) {
          hrSubscriptionPassed = true
          passMarker(START_HR_SUBSCRIPTION, event)
        }
        publish({ kind: 'subscription_state', subscription: 'hr', status: event.status })
      },
      fail: function (data, code) {
        hrSubscriptionActive = false
        const event = recordFailure(
          START_HR_SUBSCRIPTION,
          START_HR_SUBSCRIPTION.sourceApi,
          data,
          code,
          'live_sample'
        )
        failMarker(START_HR_SUBSCRIPTION, event)
        publish({ kind: 'subscription_state', subscription: 'hr', status: event.status })
      },
    })
    publish({ kind: 'subscription_state', subscription: 'hr', status: 'WAITING' })
  } catch (error) {
    hrSubscriptionActive = false
    const event = recordFailure(
      START_HR_SUBSCRIPTION,
      START_HR_SUBSCRIPTION.sourceApi,
      error,
      'CALL_THROWN',
      'live_sample'
    )
    failMarker(START_HR_SUBSCRIPTION, event)
    publish({ kind: 'subscription_state', subscription: 'hr', status: event.status })
  }
}

export function stopHeartRateSubscription() {
  beginMarker(STOP_HR_SUBSCRIPTION, STOP_HR_SUBSCRIPTION.sourceApi)
  if (!health || typeof health.unsubscribeSample !== 'function') {
    failMarker(
      STOP_HR_SUBSCRIPTION,
      recordApiMissing(
        STOP_HR_SUBSCRIPTION,
        STOP_HR_SUBSCRIPTION.sourceApi,
        'health.unsubscribeSample is unavailable'
      )
    )
    return
  }

  const type = dataType('HEART_RATE')
  if (type === undefined || type === null) {
    failMarker(
      STOP_HR_SUBSCRIPTION,
      recordApiMissing(
        STOP_HR_SUBSCRIPTION,
        'health.DATA_TYPES',
        'health.DATA_TYPES.HEART_RATE is unavailable'
      )
    )
    return
  }

  try {
    health.unsubscribeSample({ dataType: type })
    hrSubscriptionActive = false
    hrSubscriptionPassed = false
    passMarker(STOP_HR_SUBSCRIPTION)
    publish({ kind: 'subscription_state', subscription: 'hr', status: 'STOPPED' })
  } catch (error) {
    const event = recordFailure(
      STOP_HR_SUBSCRIPTION,
      STOP_HR_SUBSCRIPTION.sourceApi,
      error,
      'CALL_THROWN',
      'control'
    )
    failMarker(STOP_HR_SUBSCRIPTION, event)
    publish({ kind: 'subscription_state', subscription: 'hr', status: event.status })
  }
}

export function startStepSensorProbe() {
  if (stepSensorActive) {
    const message = 'step sensor subscription is already active'
    console.error(`[akari pulse] FAIL ${STEP_SENSOR.label} code=ALREADY_ACTIVE message=${message}`)
    publish({
      kind: 'probe_fail',
      probe: STEP_SENSOR.id,
      label: STEP_SENSOR.label,
      status: 'ERROR',
      raw_error_code: 'ALREADY_ACTIVE',
      raw_error_message: message,
    })
    return
  }

  beginMarker(STEP_SENSOR, STEP_SENSOR.sourceApi)
  if (!sensor || typeof sensor.subscribeStepCounter !== 'function') {
    failMarker(
      STEP_SENSOR,
      recordApiMissing(
        STEP_SENSOR,
        STEP_SENSOR.sourceApi,
        'sensor.subscribeStepCounter is unavailable',
        SENSOR_MODULE
      )
    )
    return
  }

  stepSensorActive = true
  stepSensorPassed = false
  try {
    sensor.subscribeStepCounter({
      callback: function (result) {
        const now = Date.now()
        let event
        if (!result || result.steps === undefined || result.steps === null) {
          event = observe({
            metric: STEP_SENSOR.metric,
            unit: STEP_SENSOR.unit,
            status: 'NO_DATA',
            source_module: SENSOR_MODULE,
            source_api: STEP_SENSOR.sourceApi,
            quality: 'cumulative_since_boot',
            callback_delta_ms: callbackDelta(STEP_SENSOR.metric, now),
          })
        } else {
          event = observe({
            timestamp: now,
            metric: STEP_SENSOR.metric,
            value: result.steps,
            unit: STEP_SENSOR.unit,
            status: 'PASS',
            source_module: SENSOR_MODULE,
            source_api: STEP_SENSOR.sourceApi,
            quality: 'cumulative_since_boot',
            callback_delta_ms: callbackDelta(STEP_SENSOR.metric, now),
          })
        }
        if (!stepSensorPassed) {
          stepSensorPassed = true
          passMarker(STEP_SENSOR, event)
        }
        publish({ kind: 'subscription_state', subscription: 'step', status: event.status })
      },
      fail: function (data, code) {
        stepSensorActive = false
        const event = recordFailure(
          STEP_SENSOR,
          STEP_SENSOR.sourceApi,
          data,
          code,
          'cumulative_since_boot',
          SENSOR_MODULE
        )
        failMarker(STEP_SENSOR, event)
        publish({ kind: 'subscription_state', subscription: 'step', status: event.status })
      },
    })
    publish({ kind: 'subscription_state', subscription: 'step', status: 'WAITING' })
  } catch (error) {
    stepSensorActive = false
    const event = recordFailure(
      STEP_SENSOR,
      STEP_SENSOR.sourceApi,
      error,
      'CALL_THROWN',
      'cumulative_since_boot',
      SENSOR_MODULE
    )
    failMarker(STEP_SENSOR, event)
    publish({ kind: 'subscription_state', subscription: 'step', status: event.status })
  }
}

export function stopSubscriptions() {
  const heartRateType = dataType('HEART_RATE')
  if (
    hrSubscriptionActive &&
    health &&
    typeof health.unsubscribeSample === 'function' &&
    heartRateType !== undefined &&
    heartRateType !== null
  ) {
    try {
      health.unsubscribeSample({ dataType: heartRateType })
    } catch (error) {
      console.error(`[akari pulse] cleanup health.unsubscribeSample failed: ${errorText(error)}`)
    }
  }
  if (stepSensorActive && sensor && typeof sensor.unsubscribeStepCounter === 'function') {
    try {
      sensor.unsubscribeStepCounter()
    } catch (error) {
      console.error(`[akari pulse] cleanup sensor.unsubscribeStepCounter failed: ${errorText(error)}`)
    }
  }
  hrSubscriptionActive = false
  hrSubscriptionPassed = false
  stepSensorActive = false
  stepSensorPassed = false
  activeOneShot = ''
}
