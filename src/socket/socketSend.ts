import type { Socket } from 'node:net'
import type { ActionServerToClient } from '../actions.js'
import {
	buildProtocolV2EnvelopeFromAction,
	isUtilityServerAction,
} from '../protocol/v2/index.js'
import type { ProtocolV2Envelope } from '../protocol/v2/index.js'
import {
	isFullServerPayloadLogEnabled,
	isVerboseServerLogEnabled,
	traceServerEventDeferred,
} from '../runtimeTrace.js'

type SocketLogContextProvider = () => Record<string, unknown>

// Per-socket backpressure state. Stored on the socket itself so it survives
// across multiple sender invocations and is cleaned up when the socket closes.
//
// `socket.pause()` / `socket.resume()` would also work for flow control, but
// they stop the kernel from delivering more *incoming* data too — which would
// also stop keep-alive acks and break the receive side. We only want to
// throttle the *write* side, so we do it explicitly.
type SocketBackpressureState = {
	/** True when the last write returned false (kernel buffer full). */
	paused: boolean
	/** Messages that arrived while paused, queued for the next drain. */
	queue: string[]
	/** True when the socket is being torn down and we should drop further writes. */
	closed: boolean
}

const SOCKET_BACKPRESSURE = Symbol.for('mp.socketBackpressure')

/**
 * Test fakes (and any other non-EventEmitter duck-type) cannot accept event
 * subscriptions. For those we just skip the backpressure wiring — the
 * in-memory queue + the synchronous write path are still safe, we just won't
 * catch the (theoretical) kernel-buffer-full case on a fake.
 */
const hasEventEmitterInterface = (
	socket: Socket,
): socket is Socket & { on: (...a: never[]) => unknown; once: (...a: never[]) => unknown } =>
	typeof (socket as { on?: unknown }).on === 'function' &&
	typeof (socket as { once?: unknown }).once === 'function'

const getSocketBackpressure = (socket: Socket): SocketBackpressureState => {
	const existing = (socket as Socket & { [SOCKET_BACKPRESSURE]?: SocketBackpressureState })[
		SOCKET_BACKPRESSURE
	]
	if (existing) return existing

	const state: SocketBackpressureState = { paused: false, queue: [], closed: false }
	;(socket as Socket & { [SOCKET_BACKPRESSURE]?: SocketBackpressureState })[
		SOCKET_BACKPRESSURE
	] = state

	if (!hasEventEmitterInterface(socket)) {
		// Nothing more to do; queue + sync write path still work.
		return state
	}

	// Once a drain is observed, flush everything we queued.
	const flush = () => {
		if (state.closed) return
		state.paused = false
		while (state.queue.length > 0) {
			const next = state.queue.shift() as string
			const ok = socket.write(next)
			if (!ok) {
				// Still backed up. Wait for the next drain.
				state.paused = true
				socket.once('drain', flush)
				return
			}
		}
	}
	socket.on('drain', flush)
	socket.on('close', () => {
		state.closed = true
		state.queue.length = 0
	})
	return state
}

const writeSocketMessage = (
	socket: Socket,
	message: Record<string, unknown>,
	logLabel: string,
	logPayload: Record<string, unknown>,
	getLogContext: SocketLogContextProvider,
	shouldLog = true,
) => {
	if (!socket || socket.destroyed) {
		return
	}

	const serializedMessage = JSON.stringify(message)
	const framed = `${serializedMessage}\n`
	const state = getSocketBackpressure(socket)

	const attemptWrite = (chunk: string): boolean => {
		if (state.closed) return true
		const ok = socket.write(chunk)
		if (!ok) {
			// Buffer is full. Register a one-shot drain listener that will
			// pick up the queue. Using once() so we don't pile up listeners.
			state.paused = true
			if (typeof (socket as { once?: unknown }).once === 'function') {
				socket.once('drain', onDrain)
			}
		}
		return ok
	}

	const onDrain = (): void => {
		if (state.closed) return
		state.paused = false
		while (state.queue.length > 0) {
			const next = state.queue.shift() as string
			const wrote = attemptWrite(next)
			if (!wrote) return
		}
	}

	if (state.paused) {
		// Don't keep queueing forever — a fully wedged socket shouldn't
		// be allowed to consume unbounded memory. Cap the queue at the
		// configured outgoing message limit. If the cap is hit, the
		// assumption is the peer is dead and we drop them.
		const MAX_QUEUED_BYTES = 8 * 1024 * 1024
		const projected = state.queue.reduce((n, m) => n + Buffer.byteLength(m, 'utf8'), 0) +
			Buffer.byteLength(framed, 'utf8')
		if (projected > MAX_QUEUED_BYTES) {
			// Force-close the dead consumer rather than blowing up the server.
			state.closed = true
			state.queue.length = 0
			socket.destroy(new Error('Outgoing write queue exceeded backpressure cap'))
			return
		}
		state.queue.push(framed)
	} else {
		attemptWrite(framed)
	}

	if (shouldLog && isVerboseServerLogEnabled()) {
		const traceFields: Record<string, unknown> = {
			bytes: Buffer.byteLength(serializedMessage, 'utf8'),
			label: logLabel,
			remoteAddress: socket.remoteAddress,
			remotePort: socket.remotePort,
			...getLogContext(),
		}

		if (isFullServerPayloadLogEnabled()) {
			traceFields.message = message
		} else {
			traceFields.payload = logPayload
		}

		traceServerEventDeferred('socket.outgoing', traceFields)
	}
}

export const createSocketActionSender =
	(socket: Socket, getLogContext: SocketLogContextProvider) =>
	(action: ActionServerToClient) => {
		const outgoingMessage = isUtilityServerAction(action.action)
			? action
			: buildProtocolV2EnvelopeFromAction(action)
		const { action: actionName, ...actionArgs } = action
		if (!outgoingMessage) {
			throw new Error(
				`No protocol_v2 descriptor registered for socket action "${actionName}"`,
			)
		}

		writeSocketMessage(
			socket,
			outgoingMessage as Record<string, unknown>,
			`action ${actionName}`,
			actionArgs,
			getLogContext,
			actionName !== 'keepAlive' && actionName !== 'keepAliveAck',
		)
	}

export const createSocketProtocolV2Sender =
	(socket: Socket, getLogContext: SocketLogContextProvider) =>
	(envelope: ProtocolV2Envelope) => {
		writeSocketMessage(
			socket,
			envelope as Record<string, unknown>,
			`protocol_v2 ${envelope.family}.${envelope.action}`,
			envelope.payload,
			getLogContext,
		)
	}
