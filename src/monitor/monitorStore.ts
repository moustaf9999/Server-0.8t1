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

export type MonitorMatchOutcome = {
	type: 'waiting' | 'in_progress' | 'win' | 'no_winner' | 'abandoned' | 'closed'
	label: string
	reason: string | null
	winners: string[]
	losers: string[]
	remaining: string[]
}

export type MonitorLobbySnapshot = {
	id: string
	viewKind: 'live' | 'archived'
	code: string
	status: 'waiting' | 'in_game'
	gameMode: string
	lobbyType: string
	createdAt: string
	updatedAt: string
	matchId: string | null
	matchNumber: number
	matchStartedAt: string | null
	endedAt: string | null
	durationSeconds: number | null
	archiveReason: string | null
	outcome: MonitorMatchOutcome
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
	lobbyInstanceId: number
	code: string
	createdAt: string
	updatedAt: string
	matchId: string | null
	matchNumber: number
	matchStartedAt: string | null
	matchStartedEventIndex: number | null
	lastArchivedArchiveKey: string | null
	lastArchivedSnapshotId: string | null
	events: MonitorEvent[]
}

type ArchiveOptions = {
	reason: string
	message?: string
	endedAt?: string
	winners?: Client[]
	losers?: Client[]
	remaining?: Client[]
}

let nextEventId = 1
let nextLobbyInstanceId = 1
let nextArchiveId = 1
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

const buildLiveOutcome = (lobby: Lobby): MonitorMatchOutcome =>
	lobby.isInGame
		? {
				type: 'in_progress',
				label: 'In progress',
				reason: null,
				winners: [],
				losers: [],
				remaining: [],
		  }
		: {
				type: 'waiting',
				label: 'Waiting in lobby',
				reason: null,
				winners: [],
				losers: [],
				remaining: [],
		  }

const buildArchiveOutcome = (
	lobby: Lobby,
	options: ArchiveOptions,
): MonitorMatchOutcome => {
	const winners = options.winners?.map((player) => player.username) ?? []
	const losers = options.losers?.map((player) => player.username) ?? []
	const remaining = options.remaining?.map((player) => player.username) ?? []

	if (options.reason === 'match_finished') {
		return winners.length > 0
			? {
					type: 'win',
					label: `${winners.length === 1 ? 'Winner' : 'Winners'}: ${winners.join(', ')}`,
					reason: options.reason,
					winners,
					losers,
					remaining,
			  }
			: {
					type: 'no_winner',
					label: 'Finished with no winner',
					reason: options.reason,
					winners,
					losers,
					remaining,
			  }
	}

	if (options.reason === 'match_abandoned') {
		return {
			type: 'abandoned',
			label: 'Match abandoned',
			reason: options.reason,
			winners,
			losers,
			remaining,
		}
	}

	if (options.reason === 'lobby_removed' && getLobbyState(lobby).matchStartedAt) {
		return {
			type: 'abandoned',
			label: 'Abandoned before a result',
			reason: options.reason,
			winners,
			losers,
			remaining,
		}
	}

	return {
		type: 'closed',
		label: 'Lobby closed',
		reason: options.reason,
		winners,
		losers,
		remaining,
	}
}

const getLobbyState = (lobby: Lobby): LobbyMonitorState => {
	let state = lobbyStates.get(lobby.code)
	if (!state) {
		const createdAt = nowIso()
		state = {
			lobbyInstanceId: nextLobbyInstanceId++,
			code: lobby.code,
			createdAt,
			updatedAt: createdAt,
			matchId: null,
			matchNumber: 0,
			matchStartedAt: null,
			matchStartedEventIndex: null,
			lastArchivedArchiveKey: null,
			lastArchivedSnapshotId: null,
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
	state.matchNumber += 1
	state.matchId = `${state.lobbyInstanceId}:match:${state.matchNumber}`
	state.matchStartedAt = at
	state.matchStartedEventIndex = state.events.length
	appendEvent(state, 'match.started', `${host.username} started match ${state.matchNumber}`, {
		player: host,
		at,
		details: {
			matchId: state.matchId,
			matchNumber: state.matchNumber,
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
	options: {
		archiveReason?: string | null
		endedAt?: string
		eventStartIndex?: number
		id?: string
		outcome?: MonitorMatchOutcome
		viewKind?: 'live' | 'archived'
	} = {},
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
		id:
			options.id ??
			`${options.viewKind ?? 'live'}:${state.lobbyInstanceId}:${lobby.code}`,
		viewKind: options.viewKind ?? 'live',
		code: lobby.code,
		status: lobby.isInGame ? 'in_game' : 'waiting',
		gameMode: lobby.gameMode,
		lobbyType: lobby.lobbyType,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		matchId: state.matchId,
		matchNumber: state.matchNumber,
		matchStartedAt: startedAt,
		endedAt,
		durationSeconds,
		archiveReason: options.archiveReason ?? null,
		outcome: options.outcome ?? buildLiveOutcome(lobby),
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
	const archiveKey = state.matchId ?? `${state.lobbyInstanceId}:lobby:${state.createdAt}`
	if (state.lastArchivedArchiveKey === archiveKey) {
		return archivedLobbies.find(
			(entry) => entry.id === state.lastArchivedSnapshotId,
		) ??
			buildMonitorLobbySnapshot(lobby, {
				endedAt,
				outcome: buildArchiveOutcome(lobby, options),
			})
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
		archiveReason: options.reason,
		endedAt,
		eventStartIndex:
			options.reason === 'match_finished'
				? state.matchStartedEventIndex ?? 0
				: 0,
		id: `archive:${nextArchiveId++}:${archiveKey}`,
		outcome: buildArchiveOutcome(lobby, options),
		viewKind: 'archived',
	})
	pushArchive(snapshot)
	state.lastArchivedArchiveKey = archiveKey
	state.lastArchivedSnapshotId = snapshot.id
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

export const recordMatchAbandoned = (
	lobby: Lobby,
	options: {
		remaining?: Client[]
	} = {},
) => {
	const remaining = options.remaining ?? []
	const remainingNames = remaining.map((player) => player.username)
	return archiveLobbySnapshot(lobby, {
		reason: 'match_abandoned',
		message:
			remainingNames.length > 0
				? `Match abandoned; remaining: ${remainingNames.join(', ')}`
				: 'Match abandoned with no players remaining',
		remaining,
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
	nextLobbyInstanceId = 1
	nextArchiveId = 1
	lobbyStates.clear()
	archivedLobbies.length = 0
}
