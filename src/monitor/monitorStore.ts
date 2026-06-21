import type Client from '../Client.js'
import type Lobby from '../Lobby.js'
import { getLobbyMaxPlayers } from '../lobbyRules.js'

const MAX_LOBBY_EVENTS = 250
const MAX_ARCHIVED_LOBBIES = 100

export type MonitorEventLevel = 'info' | 'warn' | 'error'

export type MonitorEvent = {
	id: number
	at: string
	level: MonitorEventLevel
	event: string
	message: string
	playerId?: string
	playerName?: string
	details?: Record<string, unknown>
}

export type MonitorPlayerSnapshot = {
	id: string
	username: string
	isOwner: boolean
	isReadyLobby: boolean
	isReady: boolean
	isInMatch: boolean
	isDisconnected: boolean
	team: number | null
	isTeamLocked: boolean
	location: string
	modHash: string
	mods: string[]
	lives: number
	score: string
	handsLeft: number
	ante: number
	skips: number
	furthestBlind: number
	money: number
	nemesisPlayerId: string | null
	readyBlindRow: string | null
	readyBlindKind: string | null
	activeBlindRow: string | null
	activeBlindKind: string | null
}

export type MonitorLobbySnapshot = {
	code: string
	status: 'waiting' | 'in_game'
	gameMode: string
	lobbyType: string
	createdAt: string
	updatedAt: string
	matchStartedAt: string | null
	endedAt: string | null
	durationSeconds: number | null
	ownerId: string
	ownerName: string | null
	playerCount: number
	maxPlayers: number
	coopSaveId: string | null
	options: Record<string, unknown>
	players: MonitorPlayerSnapshot[]
	disconnectedPlayers: MonitorPlayerSnapshot[]
	timer: {
		time: number
		started: boolean
		lockedForAnte: boolean
		controllerId: string | null
		controllerAnte: number | null
		generation: number
	}
	events: MonitorEvent[]
}

type LobbyMonitorState = {
	code: string
	createdAt: string
	updatedAt: string
	matchStartedAt: string | null
	matchStartedEventIndex: number | null
	lastArchivedMatchStartedAt: string | null
	events: MonitorEvent[]
}

type ArchiveOptions = {
	reason: string
	message?: string
	endedAt?: string
	winners?: Client[]
	losers?: Client[]
}

let nextEventId = 1
const lobbyStates = new Map<string, LobbyMonitorState>()
const archivedLobbies: MonitorLobbySnapshot[] = []

const nowIso = () => new Date().toISOString()

const cloneRecord = (value: Record<string, unknown>) => ({ ...value })

const toScoreString = (value: unknown) =>
	value && typeof (value as { toString?: unknown }).toString === 'function'
		? String(value)
		: String(value ?? 0)

const parseModHash = (modHash: string) =>
	modHash
		.split(';')
		.map((entry) => entry.trim())
		.filter(Boolean)

const getLobbyState = (lobby: Lobby): LobbyMonitorState => {
	let state = lobbyStates.get(lobby.code)
	if (!state) {
		const createdAt = nowIso()
		state = {
			code: lobby.code,
			createdAt,
			updatedAt: createdAt,
			matchStartedAt: null,
			matchStartedEventIndex: null,
			lastArchivedMatchStartedAt: null,
			events: [],
		}
		lobbyStates.set(lobby.code, state)
	}
	return state
}

const pushArchive = (snapshot: MonitorLobbySnapshot) => {
	archivedLobbies.unshift(snapshot)
	if (archivedLobbies.length > MAX_ARCHIVED_LOBBIES) {
		archivedLobbies.length = MAX_ARCHIVED_LOBBIES
	}
}

const appendEvent = (
	state: LobbyMonitorState,
	event: string,
	message: string,
	options: {
		level?: MonitorEventLevel
		player?: Client
		details?: Record<string, unknown>
		at?: string
	} = {},
) => {
	const at = options.at ?? nowIso()
	state.updatedAt = at
	state.events.push({
		id: nextEventId++,
		at,
		level: options.level ?? 'info',
		event,
		message,
		playerId: options.player?.id,
		playerName: options.player?.username,
		details: options.details ? cloneRecord(options.details) : undefined,
	})
	if (state.events.length > MAX_LOBBY_EVENTS) {
		state.events.splice(0, state.events.length - MAX_LOBBY_EVENTS)
	}
}

export const recordLobbyEvent = (
	lobby: Lobby | null | undefined,
	event: string,
	message: string,
	options: {
		level?: MonitorEventLevel
		player?: Client
		details?: Record<string, unknown>
	} = {},
) => {
	if (!lobby) return
	appendEvent(getLobbyState(lobby), event, message, options)
}

export const recordLobbyCreated = (lobby: Lobby, host: Client) => {
	const state = getLobbyState(lobby)
	appendEvent(state, 'lobby.created', `${host.username} created the lobby`, {
		player: host,
		details: {
			gameMode: lobby.gameMode,
			lobbyType: lobby.lobbyType,
		},
	})
}

export const recordMatchStarted = (lobby: Lobby, host: Client) => {
	const state = getLobbyState(lobby)
	const at = nowIso()
	state.matchStartedAt = at
	state.matchStartedEventIndex = state.events.length
	appendEvent(state, 'match.started', `${host.username} started the match`, {
		player: host,
		at,
		details: {
			playerCount: lobby.getPlayerCount(),
			gameMode: lobby.gameMode,
			lobbyType: lobby.lobbyType,
		},
	})
}

const buildPlayerSnapshot = (
	player: Client,
	options: { isDisconnected?: boolean } = {},
): MonitorPlayerSnapshot => ({
	id: player.id,
	username: player.username,
	isOwner: player.isOwner,
	isReadyLobby: player.isReadyLobby,
	isReady: player.isReady,
	isInMatch: player.isInMatch,
	isDisconnected: options.isDisconnected === true,
	team: player.team ?? null,
	isTeamLocked: player.isTeamLocked,
	location: player.location,
	modHash: player.modHash,
	mods: parseModHash(player.modHash),
	lives: player.lives,
	score: toScoreString(player.score),
	handsLeft: player.handsLeft,
	ante: player.ante,
	skips: player.skips,
	furthestBlind: player.furthestBlind,
	money: player.reportedMoney,
	nemesisPlayerId: player.nemesisPlayerId,
	readyBlindRow: player.readyBlindRow,
	readyBlindKind: player.readyBlindKind,
	activeBlindRow: player.activeBlindRow,
	activeBlindKind: player.activeBlindKind,
})

const buildDisconnectedPlayerSnapshot = (
	slot: ReturnType<Lobby['getDisconnectedSlots']>[number],
): MonitorPlayerSnapshot => {
	const saved = slot.savedState
	return {
		id: saved.id,
		username: saved.username,
		isOwner: saved.isOwner,
		isReadyLobby: saved.isReadyLobby,
		isReady: saved.isReady,
		isInMatch: saved.isInMatch,
		isDisconnected: true,
		team: saved.team ?? null,
		isTeamLocked: saved.isTeamLocked,
		location: 'loc_disconnected',
		modHash: saved.modHash,
		mods: parseModHash(saved.modHash),
		lives: saved.lives,
		score: toScoreString(saved.score),
		handsLeft: saved.handsLeft,
		ante: saved.ante,
		skips: saved.skips,
		furthestBlind: saved.furthestBlind,
		money: saved.money,
		nemesisPlayerId: saved.nemesisPlayerId,
		readyBlindRow: saved.readyBlindRow,
		readyBlindKind: saved.readyBlindKind,
		activeBlindRow: saved.activeBlindRow,
		activeBlindKind: saved.activeBlindKind,
	}
}

export const buildMonitorLobbySnapshot = (
	lobby: Lobby,
	options: { endedAt?: string; eventStartIndex?: number } = {},
): MonitorLobbySnapshot => {
	const state = getLobbyState(lobby)
	const players = lobby.getPlayers().map((player) => buildPlayerSnapshot(player))
	const disconnectedPlayers = lobby
		.getDisconnectedSlots()
		.map(buildDisconnectedPlayerSnapshot)
	const owner = players.find((player) => player.id === lobby.ownerId)
	const endedAt = options.endedAt ?? null
	const startedAt = state.matchStartedAt
	const durationSeconds =
		startedAt && endedAt
			? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
			: null

	return {
		code: lobby.code,
		status: lobby.isInGame ? 'in_game' : 'waiting',
		gameMode: lobby.gameMode,
		lobbyType: lobby.lobbyType,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		matchStartedAt: startedAt,
		endedAt,
		durationSeconds,
		ownerId: lobby.ownerId,
		ownerName: owner?.username ?? null,
		playerCount: players.length + disconnectedPlayers.length,
		maxPlayers: getLobbyMaxPlayers(lobby),
		coopSaveId: lobby.coopSaveId,
		options: { ...lobby.options, gamemode: lobby.getClientGamemodeKey() },
		players,
		disconnectedPlayers,
		timer: {
			time: lobby.anteTimer.getEffectiveState().time,
			started: lobby.anteTimer.started,
			lockedForAnte: lobby.anteTimer.lockedForAnte,
			controllerId: lobby.anteTimer.controllerId,
			controllerAnte: lobby.anteTimer.controllerAnte,
			generation: lobby.anteTimer.generation,
		},
		events: [...state.events.slice(options.eventStartIndex ?? 0)],
	}
}

export const archiveLobbySnapshot = (
	lobby: Lobby,
	options: ArchiveOptions,
): MonitorLobbySnapshot => {
	const state = getLobbyState(lobby)
	const endedAt = options.endedAt ?? nowIso()
	const archiveKey = state.matchStartedAt ?? state.createdAt
	if (state.lastArchivedMatchStartedAt === archiveKey) {
		return archivedLobbies.find((entry) => entry.code === lobby.code) ??
			buildMonitorLobbySnapshot(lobby, { endedAt })
	}

	const eventName =
		options.reason === 'match_finished'
			? 'match.finished'
			: options.reason === 'lobby_removed'
			  ? 'lobby.removed'
			  : 'lobby.archived'
	appendEvent(state, eventName, options.message ?? options.reason, {
		at: endedAt,
		details: {
			reason: options.reason,
			winners: options.winners?.map((player) => player.username),
			losers: options.losers?.map((player) => player.username),
		},
	})
	const snapshot = buildMonitorLobbySnapshot(lobby, {
		endedAt,
		eventStartIndex:
			options.reason === 'match_finished'
				? state.matchStartedEventIndex ?? 0
				: 0,
	})
	pushArchive(snapshot)
	state.lastArchivedMatchStartedAt = archiveKey
	return snapshot
}

export const recordMatchFinished = (
	lobby: Lobby,
	options: {
		winners?: Client[]
		losers?: Client[]
	} = {},
) => {
	const winners = options.winners ?? []
	const losers = options.losers ?? []
	const winnerNames = winners.map((player) => player.username)
	const loserNames = losers.map((player) => player.username)
	const result =
		winnerNames.length > 0
			? `Winners: ${winnerNames.join(', ')}`
			: 'Match finished with no winner'
	return archiveLobbySnapshot(lobby, {
		reason: 'match_finished',
		message: loserNames.length > 0 ? `${result}; losers: ${loserNames.join(', ')}` : result,
		winners,
		losers,
	})
}

export const recordLobbyRemoved = (lobby: Lobby) => {
	archiveLobbySnapshot(lobby, {
		reason: 'lobby_removed',
		message: 'Lobby closed',
	})
	lobbyStates.delete(lobby.code)
}

export const getMonitorSnapshot = (lobbies: Iterable<Lobby>) => {
	const live = Array.from(lobbies).map((lobby) =>
		buildMonitorLobbySnapshot(lobby),
	)
	return {
		generatedAt: nowIso(),
		live,
		archived: archivedLobbies,
		counts: {
			live: live.length,
			archived: archivedLobbies.length,
			players: live.reduce((total, lobby) => total + lobby.playerCount, 0),
			inGame: live.filter((lobby) => lobby.status === 'in_game').length,
		},
	}
}

export const resetMonitorStoreForTests = () => {
	nextEventId = 1
	lobbyStates.clear()
	archivedLobbies.length = 0
}
