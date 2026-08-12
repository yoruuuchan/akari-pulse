import config from '../config'

function appendOptional(target, key, value) {
  if (value !== undefined && value !== null && value !== '') {
    target[key] = value
  }
}

function eventId(timestamp, sequence) {
  const random = Math.floor(Math.random() * 0xffffff).toString(36)
  return `wa2456c-${timestamp}-${sequence}-${random}`
}

export function createEvent(input, sequence, sessionId) {
  const timestamp = typeof input.timestamp === 'number' ? Math.floor(input.timestamp) : Date.now()
  const event = {
    event_id: eventId(timestamp, sequence),
    timestamp: timestamp,
    metric: input.metric,
    source_device: config.sourceDevice,
    status: input.status,
  }

  if (Object.prototype.hasOwnProperty.call(input, 'value')) {
    event.value = input.value
  }

  appendOptional(event, 'sample_timestamp', input.sample_timestamp)
  appendOptional(event, 'unit', input.unit)
  appendOptional(event, 'source_module', input.source_module)
  appendOptional(event, 'source_api', input.source_api)
  appendOptional(event, 'quality', input.quality)
  appendOptional(event, 'session_id', input.session_id || sessionId)
  appendOptional(event, 'callback_delta_ms', input.callback_delta_ms)
  appendOptional(event, 'raw_error_code', input.raw_error_code)
  appendOptional(event, 'raw_error_message', input.raw_error_message)
  return event
}

export function statusForFailure(code) {
  const numericCode = Number(code)
  if (numericCode === 400) return 'DENIED'
  if (numericCode === 402) return 'API_MISSING'
  if (numericCode === 1000) return 'UNSUPPORTED'
  return 'ERROR'
}

// Contract decision (0.1.4): the vivo watch health API returns a raw callback
// with value === 0 and timeStamp === 0 when the internal heart-rate buffer
// holds no recent sample. That is not a real bpm reading of zero. Treat it as
// NO_DATA at parse time and preserve the raw zeros in raw_error_code/message.
// Applies to heart-rate-family recent-sample and live-subscription callbacks
// only; step_count/standing/intensity of 0 remain meaningful daily statistics.
export function isZeroHrSampleShape(sample) {
  if (!sample) return false
  return sample.value === 0 && sample.timeStamp === 0
}

export function errorText(data) {
  if (typeof data === 'string') return data
  if (data && typeof data.message === 'string') return data.message
  try {
    return JSON.stringify(data)
  } catch (error) {
    return String(data)
  }
}
