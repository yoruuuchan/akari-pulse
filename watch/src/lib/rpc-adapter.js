import interconnect from '@blueos.bluexlink.connectionManager'
import config from '../config'
import { errorText } from './events'

let connection = null
let handlers = null

function configured() {
  const rpc = config.transport.rpc
  return Boolean(rpc && rpc.phonePackage && rpc.phoneSha256)
}

function reportError(data, code) {
  if (!handlers || !handlers.onError) return
  if (data && typeof data === 'object') {
    handlers.onError(data.data || errorText(data), data.code === undefined ? code : data.code)
    return
  }
  handlers.onError(errorText(data), code)
}

function decodeMessage(message) {
  let value = message
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (error) {
      return null
    }
  }
  return value && typeof value === 'object' ? value : null
}

export function initialize(callbacks) {
  handlers = callbacks || null
  if (!configured()) return false
  if (!interconnect || typeof interconnect.instance !== 'function') {
    if (handlers && handlers.onApiMissing) {
      handlers.onApiMissing('@blueos.bluexlink.connectionManager.instance is unavailable')
    }
    return false
  }

  try {
    connection = interconnect.instance({
      package: config.transport.rpc.phonePackage,
      fingerprint: config.transport.rpc.phoneSha256,
    })
    if (!connection) {
      if (handlers && handlers.onApiMissing) handlers.onApiMissing('interconnect.instance returned no connection')
      return false
    }

    connection.onOpen = function () {
      if (handlers && handlers.onOpen) handlers.onOpen()
    }
    connection.onClose = function () {
      if (handlers && handlers.onClose) handlers.onClose()
    }
    // The current online page shows an error object, while the distributed d.ts
    // declares (data, code). Normalize both documented shapes at this API boundary.
    connection.onError = function (data, code) {
      reportError(data, code)
    }
    connection.onMessage = function (message) {
      if (!message || message.isFileType || !handlers || !handlers.onMessage) return
      const decoded = decodeMessage(message.data)
      if (decoded) handlers.onMessage(decoded)
    }
    return true
  } catch (error) {
    reportError(error, 'CALL_THROWN')
    return false
  }
}

export function isConfigured() {
  return configured()
}

export function send(batch, onSent, onFailure) {
  if (!configured()) {
    onFailure(
      'API_MISSING',
      'RPC_CONFIG_MISSING',
      'RPC phonePackage and phoneSha256 must match the installed Android app and its signing certificate'
    )
    return
  }
  if (!connection || typeof connection.send !== 'function') {
    onFailure('API_MISSING', 'API_MISSING', 'BlueXlink connection.send is unavailable')
    return
  }

  try {
    connection.send({
      data: {
        type: config.transport.rpc.messageType,
        data: batch,
      },
      // Official send.success has no business response. The caller must wait for
      // a separately received, batch-correlated acknowledgement before dequeueing.
      success: function () {
        onSent()
      },
      fail: function (data, code) {
        onFailure('ERROR', code, errorText(data))
      },
    })
  } catch (error) {
    onFailure('ERROR', 'CALL_THROWN', errorText(error))
  }
}

export function close() {
  if (!connection || typeof connection.close !== 'function') return
  try {
    connection.close({
      complete: function () {
        connection = null
      },
    })
  } catch (error) {
    connection = null
  }
}
