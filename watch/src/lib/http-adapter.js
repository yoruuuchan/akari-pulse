import network from '@blueos.network.fetch'
import config from '../config'
import { errorText } from './events'

export function send(batch, onSuccess, onFailure) {
  const http = config.transport.http
  if (!http || !http.endpoint) {
    onFailure('API_MISSING', 'HTTP_ENDPOINT_MISSING', 'HTTP endpoint is not configured')
    return
  }
  if (!network || typeof network.fetch !== 'function') {
    onFailure('API_MISSING', 'API_MISSING', '@blueos.network.fetch.fetch is unavailable')
    return
  }

  const headers = { 'Content-Type': 'application/json' }
  if (http.bridgeToken) headers['X-Akari-Bridge-Token'] = http.bridgeToken

  try {
    network.fetch({
      url: http.endpoint,
      method: 'POST',
      header: headers,
      data: JSON.stringify(batch),
      responseType: 'json',
      timeout: http.timeoutMs,
      success: function (response) {
        const code = response && Number(response.code)
        if (code >= 200 && code < 300) {
          const body = response.data
          const acknowledgement = body && body.data
          const accepted = acknowledgement && acknowledgement.accepted
          const duplicates = acknowledgement && acknowledgement.duplicates
          const countsAreIntegers =
            typeof accepted === 'number' &&
            isFinite(accepted) &&
            Math.floor(accepted) === accepted &&
            accepted >= 0 &&
            typeof duplicates === 'number' &&
            isFinite(duplicates) &&
            Math.floor(duplicates) === duplicates &&
            duplicates >= 0
          if (
            body &&
            body.ok === true &&
            acknowledgement &&
            acknowledgement.batch_id === batch.batch_id &&
            countsAreIntegers &&
            accepted + duplicates === batch.events.length
          ) {
            onSuccess(code, body)
            return
          }
          const ackCode =
            countsAreIntegers && accepted + duplicates !== batch.events.length
              ? 'HTTP_ACK_COUNT_MISMATCH'
              : 'HTTP_ACK_INVALID'
          onFailure(
            'ERROR',
            ackCode,
            'HTTP response did not acknowledge the full submitted batch'
          )
          return
        }
        onFailure(
          'ERROR',
          code || 'INVALID_HTTP_RESPONSE',
          response ? errorText(response.data) : 'fetch success callback returned no response'
        )
      },
      fail: function (data, code) {
        onFailure('ERROR', code, errorText(data))
      },
    })
  } catch (error) {
    onFailure('ERROR', 'CALL_THROWN', errorText(error))
  }
}
