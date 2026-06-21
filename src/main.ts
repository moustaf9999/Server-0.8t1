import { createServer, type Socket } from 'node:net'
import { startAdminServer } from './admin/adminServer.js'
import { disconnectFromLobbyAction } from './lobbyModerationHandlers.js'
import {
	createMonitorDashboardServer,
	isMonitorDashboardHttpRequest,
	type MonitorDashboardServer,
} from './monitor/monitorDashboard.js'
import {
	sendSystemConnected,
	sendSystemRequestVersion,
} from './protocol/v2/index.js'
import {
	getServerLogPath,
	isServerLogEnabled,
	traceServerEvent,
} from './runtimeTrace.js'
import { isLoopbackHost, resolveServerConfig } from './serverConfig.js'
import { createSocketConnectionHandler } from './socket/socketConnection.js'
import { handleIncomingSocketMessage } from './socket/socketDispatch.js'

const {
	adminPort,
	explicitGameplayPort,
	gameplayPort,
	genericPort,
	host,
	isRailwayDeployment,
	railwayApplicationPort,
	railwayTcpProxyDomain,
	railwayTcpProxyPort,
} = resolveServerConfig(process.env)

interface BigIntWithToJSON {
	prototype: {
		toJSON: () => string
	}
}
;(BigInt as unknown as BigIntWithToJSON).prototype.toJSON = function () {
	return this.toString()
}

const handleGameplaySocketConnection = createSocketConnectionHandler({
	onConnected: (client) => {
		sendSystemConnected(client)
		sendSystemRequestVersion(client)
	},
	onDisconnected: (client) => {
		disconnectFromLobbyAction(client)
	},
	onMessage: handleIncomingSocketMessage,
})

const monitorDashboard = createMonitorDashboardServer()
const monitorSharesGameplayPort =
	!!monitorDashboard && monitorDashboard.port === gameplayPort

const createMultiplexedConnectionHandler =
	(
		dashboard: MonitorDashboardServer,
		gameplayHandler: (socket: Socket) => void,
	) =>
	(socket: Socket) => {
		let handled = false
		let fallbackTimer: ReturnType<typeof setTimeout> | null = null

		const cleanup = () => {
			if (fallbackTimer) {
				clearTimeout(fallbackTimer)
				fallbackTimer = null
			}
			socket.off('data', handleInitialData)
			socket.off('error', handleInitialError)
		}

		const useGameplay = (initialData?: Buffer) => {
			if (handled) return
			handled = true
			cleanup()
			if (initialData) {
				socket.unshift(initialData)
			}
			gameplayHandler(socket)
			socket.resume()
		}

		const useDashboard = (initialData: Buffer) => {
			if (handled) return
			handled = true
			cleanup()
			dashboard.handleConnection(socket, initialData)
			socket.resume()
		}

		function handleInitialData(data: Buffer) {
			socket.pause()
			if (isMonitorDashboardHttpRequest(data)) {
				useDashboard(data)
				return
			}
			useGameplay(data)
		}

		function handleInitialError() {
			if (!handled) {
				handled = true
				cleanup()
				socket.destroy()
			}
		}

		socket.pause()
		socket.once('data', handleInitialData)
		socket.once('error', handleInitialError)
		fallbackTimer = setTimeout(() => useGameplay(), 75)
		fallbackTimer.unref?.()
		socket.resume()
	}

const server = createServer(
	monitorSharesGameplayPort && monitorDashboard
		? createMultiplexedConnectionHandler(
				monitorDashboard,
				handleGameplaySocketConnection,
		  )
		: handleGameplaySocketConnection,
)

server.listen(gameplayPort, host, () => {
	console.log(`Gameplay server internal bind listening on ${host}:${gameplayPort}`)
	if (isServerLogEnabled()) {
		console.log(`Server trace log writing to ${getServerLogPath()}`)
	}
	traceServerEvent('server.started', {
		gameplayPort,
		genericPort,
		host,
		isRailwayDeployment,
		railwayApplicationPort,
		railwayTcpProxyDomain,
		railwayTcpProxyPort,
	})
	if (
		(explicitGameplayPort || railwayApplicationPort) &&
		genericPort &&
		gameplayPort !== genericPort
	) {
		console.log(
			`Gameplay TCP bind port detected; using internal port ${gameplayPort} instead of generic PORT ${genericPort}.`,
		)
	} else if (
		isRailwayDeployment &&
		!explicitGameplayPort &&
		!railwayApplicationPort &&
		genericPort &&
		gameplayPort !== genericPort
	) {
		console.log(
			`Railway TCP deployment detected; using internal fallback port ${gameplayPort} instead of generic PORT ${genericPort}. The public TCP proxy port is separate.`,
		)
	}
	if (railwayTcpProxyDomain && railwayTcpProxyPort) {
		console.log(
			`Railway TCP proxy available at ${railwayTcpProxyDomain}:${railwayTcpProxyPort} -> internal ${host}:${gameplayPort}`,
		)
	} else if (isRailwayDeployment) {
		console.log(
			'Railway deployment detected with no public TCP proxy configured yet. Create one in Public Networking -> TCP Proxy.',
		)
	}
	if (!isLoopbackHost(host)) {
		console.warn(
			'WARNING: Gameplay server is exposed beyond localhost. Use only on a trusted network unless you add your own transport security.',
		)
	}
})
startAdminServer(adminPort)
if (monitorDashboard) {
	if (monitorSharesGameplayPort) {
		console.log(
			`Monitor dashboard sharing gameplay port ${host}:${gameplayPort}/admin`,
		)
	} else {
		monitorDashboard.listen()
	}
}
