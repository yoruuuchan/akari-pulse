import storage from '@blueos.storage.storage'
import config from '../config'
import { createEvent, errorText } from './events'

const STORAGE_KEY = 'akari.pulse.unsent.diagnostic.v1'
const MAX_EVENTS = 200

let state = freshState()
let observer = null
let persistInProgress = false
let persistDirty = false
let activePersistCallbacks = []
let dirtyPersistCallbacks = []
let storageStatus = 'NOT_RUN'
let storageError = ''
let loaded = false

function freshState() {
  return {
    version: 1,
    sequence: 0,
    events: [],
    overflow_event: null,
    transport_event: null,
    pending_batch: null,
    dropped_count: 0,
    session_id: '',
    session_started_at: null,
    last_session: null,
  }
}

function nextSequence() {
  state.sequence += 1
  return state.sequence
}

function validStoredState(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === 1 &&
    typeof value.sequence === 'number' &&
    Array.isArray(value.events)
  )
}

function normalizeStoredState(value) {
  let parsed = value
  if (typeof value === 'string' && value) {
    parsed = JSON.parse(value)
  }
  if (!validStoredState(parsed)) return null
  return {
    version: 1,
    sequence: Math.max(0, Math.floor(parsed.sequence)),
    events: parsed.events,
    overflow_event: parsed.overflow_event || null,
    transport_event: parsed.transport_event || null,
    pending_batch: parsed.pending_batch || null,
    dropped_count: Math.max(0, Math.floor(parsed.dropped_count || 0)),
    session_id: typeof parsed.session_id === 'string' ? parsed.session_id : '',
    session_started_at:
      typeof parsed.session_started_at === 'number' ? Math.floor(parsed.session_started_at) : null,
    last_session: parsed.last_session || null,
  }
}

function notify(event) {
  if (observer) observer(summary(), event || null)
}

function persist(onComplete, onStage) {
  if (!storage || typeof storage.set !== 'function') {
    storageStatus = 'API_MISSING'
    storageError = '@blueos.storage.storage.set is unavailable'
    notify()
    if (onComplete) {
      onComplete({ status: 'API_MISSING', code: 'API_MISSING', message: storageError })
    }
    return
  }
  if (persistInProgress) {
    persistDirty = true
    if (onComplete) dirtyPersistCallbacks.push(onComplete)
    return
  }

  persistInProgress = true
  activePersistCallbacks = onComplete ? [onComplete] : []
  try {
    if (onStage) onStage('BEGIN_SNAPSHOT')
    const snapshot = JSON.parse(JSON.stringify(state))
    if (onStage) onStage('SNAPSHOT_READY')
    if (onStage) onStage('BEGIN_STORAGE_SET')
    storage.set({
      key: STORAGE_KEY,
      value: snapshot,
      success: function () {
        storageStatus = 'PASS'
        storageError = ''
        finishPersist({ status: 'PASS', code: '', message: '' })
      },
      fail: function (data, code) {
        storageStatus = 'ERROR'
        storageError = `${code}: ${errorText(data)}`
        finishPersist({ status: 'ERROR', code: code, message: errorText(data) })
      },
    })
  } catch (error) {
    storageStatus = 'ERROR'
    storageError = `CALL_THROWN: ${errorText(error)}`
    finishPersist({ status: 'ERROR', code: 'CALL_THROWN', message: errorText(error) })
  }
}

function finishPersist(result) {
  const callbacks = activePersistCallbacks
  activePersistCallbacks = []
  persistInProgress = false
  notify()
  for (let index = 0; index < callbacks.length; index += 1) {
    callbacks[index](result)
  }
  if (persistDirty) {
    persistDirty = false
    const nextCallbacks = dirtyPersistCallbacks
    dirtyPersistCallbacks = []
    persist(function (nextResult) {
      for (let index = 0; index < nextCallbacks.length; index += 1) {
        nextCallbacks[index](nextResult)
      }
    })
  }
}

function overflowDiagnostic() {
  return createEvent(
    {
      metric: 'diagnostic_watch_transport',
      status: 'ERROR',
      source_module: '@blueos.storage.storage',
      source_api: 'storage.set',
      quality: 'queue_overflow',
      raw_error_code: 'QUEUE_OVERFLOW',
      raw_error_message: `unsent queue limit ${MAX_EVENTS}; ${state.dropped_count} oldest event(s) replaced`,
    },
    nextSequence(),
    state.session_id
  )
}

export function setObserver(onChange) {
  observer = onChange || null
}

export function load() {
  if (!storage || typeof storage.getSync !== 'function') {
    storageStatus = 'API_MISSING'
    storageError = '@blueos.storage.storage.getSync is unavailable'
    notify()
    return summary()
  }

  try {
    const stored = storage.getSync({ key: STORAGE_KEY })
    if (stored !== undefined && stored !== null && stored !== '') {
      const normalized = normalizeStoredState(stored)
      if (normalized) {
        state = normalized
        storageStatus = 'PASS'
        storageError = ''
      } else {
        storageStatus = 'ERROR'
        storageError = 'stored queue has an unsupported shape'
      }
    } else {
      storageStatus = 'PASS'
      storageError = ''
    }
    loaded = true
  } catch (error) {
    storageStatus = 'ERROR'
    storageError = errorText(error)
  }
  notify()
  return summary()
}

export function initialize(onChange) {
  setObserver(onChange)
  return load()
}

export function enqueue(input, onPersist, onStage) {
  const event = createEvent(input, nextSequence(), state.session_id)
  if (state.events.length >= MAX_EVENTS) {
    state.events.shift()
    state.dropped_count += 1
    state.overflow_event = overflowDiagnostic()
  }
  state.events.push(event)
  if (onStage) onStage('QUEUE_MEMORY')
  persist(
    onPersist
      ? function (result) {
          onPersist(result, event)
        }
      : null,
    onStage
  )
  notify(event)
  return event
}

export function recordTransportDiagnostic(status, code, message, sourceModule, sourceApi) {
  state.transport_event = createEvent(
    {
      metric: 'diagnostic_watch_transport',
      status: status,
      source_module: sourceModule || '@blueos.network.fetch',
      source_api: sourceApi || 'fetch.fetch',
      quality: config.transport.adapter,
      raw_error_code: code,
      raw_error_message: message,
    },
    nextSequence(),
    state.session_id
  )
  persist()
  notify(state.transport_event)
  return state.transport_event
}

// Record a PASS diagnostic for the watch_transport layer after an ACK actually
// arrived. This event describes the batch that just succeeded and rides the
// NEXT sync: the layer summary in the store therefore reflects past verified
// transport success, never a claim in advance of the ACK.
export function recordTransportSuccess(batchId, accepted, duplicates, sourceModule, sourceApi) {
  state.transport_event = createEvent(
    {
      metric: 'diagnostic_watch_transport',
      status: 'PASS',
      source_module: sourceModule || '@blueos.network.fetch',
      source_api: sourceApi || 'fetch.fetch',
      quality: config.transport.adapter + '_ack_valid',
      value: {
        batch_id: batchId,
        accepted: accepted,
        duplicates: duplicates,
      },
    },
    nextSequence(),
    state.session_id
  )
  persist()
  notify(state.transport_event)
  return state.transport_event
}

export function makeBatch(limit) {
  if (state.pending_batch && Array.isArray(state.pending_batch.events)) {
    return state.pending_batch
  }
  const events = state.events.slice(0, limit)
  if (state.overflow_event) events.push(state.overflow_event)
  if (state.transport_event) events.push(state.transport_event)
  if (events.length === 0) return null
  state.pending_batch = {
    batch_id: `wa2456c-batch-${Date.now()}-${nextSequence()}`,
    producer: config.producer,
    sent_at: Date.now(),
    events: events,
  }
  persist()
  notify()
  return state.pending_batch
}

export function acknowledge(events, batchId) {
  const ids = {}
  for (let index = 0; index < events.length; index += 1) {
    ids[events[index].event_id] = true
  }
  state.events = state.events.filter(function (event) {
    return !ids[event.event_id]
  })
  if (state.overflow_event && ids[state.overflow_event.event_id]) state.overflow_event = null
  if (state.transport_event && ids[state.transport_event.event_id]) state.transport_event = null
  if (!batchId || (state.pending_batch && state.pending_batch.batch_id === batchId)) {
    state.pending_batch = null
  }
  persist()
  notify()
}

export function startSession(sessionId, startedAt) {
  state.session_id = sessionId
  state.session_started_at = Math.floor(startedAt)
  persist()
  notify()
}

export function stopSession(sessionId, endedAt) {
  state.last_session = {
    session_id: sessionId,
    started_at: state.session_started_at,
    ended_at: Math.floor(endedAt),
  }
  state.session_id = ''
  state.session_started_at = null
  persist()
  notify()
}

export function summary() {
  const lastEvent = state.events.length > 0 ? state.events[state.events.length - 1] : null
  return {
    depth: state.events.length + (state.overflow_event ? 1 : 0) + (state.transport_event ? 1 : 0),
    health_event_count: state.events.length,
    dropped_count: state.dropped_count,
    session_id: state.session_id,
    session_started_at: state.session_started_at,
    last_session: state.last_session,
    pending_batch_id: state.pending_batch ? state.pending_batch.batch_id : '',
    storage_status: storageStatus,
    storage_error: storageError,
    storage_key: STORAGE_KEY,
    loaded: loaded,
    last_event: lastEvent
      ? {
          metric: lastEvent.metric,
          status: lastEvent.status,
          value: lastEvent.value,
          source_api: lastEvent.source_api,
        }
      : null,
    max_events: MAX_EVENTS,
  }
}
