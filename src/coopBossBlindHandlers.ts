import type Client from './Client.js'
import type {
	ActionCoopBossBlindRequest,
	ActionHandlerArgs,
} from './actions.js'
import { isCoopLobbyType } from './lobbyTypes.js'
import { broadcastLobbyMatchPlayerStates } from './lobbyPlayerState/broadcasts.js'
import { getLobbyActivePlayers } from './lobbyPlayerState/queries.js'
import {
	clearPendingBlindReadyState,
	clearPlayerBlindPreviewState,
} from './playerState.js'
import { sendMatchServerAction, sendSystemError } from './protocol/v2/index.js'
import { GLOBAL_COOP_SYNC_GROUP_ID } from './sharedSyncGroups.js'

const BOSS_REROLL_LOCK_TIMEOUT_MS = 4000

const isValidBossKey = (bossKey: unknown): bossKey is string =>
	typeof bossKey === 'string' &&
	bossKey.length > 0 &&
	bossKey.length <= 128

const normalizeAnte = (ante: unknown) => {
	const numericAnte = Number(ante)
	if (!Number.isFinite(numericAnte)) {
		return null
	}

	return Math.max(0, Math.trunc(numericAnte))
}

const getCoopBossBlindGroup = (client: Client) => {
	const lobby = client.lobby
	if (
		!lobby ||
		!lobby.isInGame ||
		!client.isInMatch ||
		!isCoopLobbyType(lobby.lobbyType)
	) {
		return null
	}

	if (lobby.options.different_seeds) {
		return null
	}

	const players = getLobbyActivePlayers(lobby)
	if (players.length === 0) {
		return null
	}

	return { lobby, players, groupId: GLOBAL_COOP_SYNC_GROUP_ID }
}

const isBossBlindActive = (players: readonly Client[]) =>
	players.some(
		(player) => player.activeBlindStarted && player.activeBlindRow === 'Boss',
	)

const clearBossReadyState = (players: readonly Client[]) => {
	for (const player of players) {
		if (player.readyBlindRow === 'Boss') {
			clearPendingBlindReadyState(player)
		}
		clearPlayerBlindPreviewState(player)
	}
}

const broadcastCoopBossBlind = (
	players: readonly Client[],
	action: Parameters<typeof sendMatchServerAction>[1],
) => {
	for (const player of players) {
		sendMatchServerAction(player, action)
	}
}

const sendExistingBossBlind = (
	client: Client,
	existing: {
		ante: number
		revision: number
		sourcePlayerId: string
		bossKey: string
		isReroll: boolean
	},
) => {
	sendMatchServerAction(client, {
		action: 'coopBossBlind',
		phase: 'result',
		ante: existing.ante,
		revision: existing.revision,
		sourcePlayerId: existing.sourcePlayerId,
		bossKey: existing.bossKey,
		isReroll: existing.isReroll,
	})
}

const handleBossRerollStart = (
	client: Client,
	ante: number,
): void => {
	const group = getCoopBossBlindGroup(client)
	if (!group) {
		return
	}

	const { lobby, players, groupId } = group
	if (isBossBlindActive(players)) {
		sendSystemError(client, 'Boss blind is already active.')
		return
	}

	const now = Date.now()
	const pending = lobby.teamState.getPendingBossReroll(groupId)
	if (
		pending &&
		pending.sourcePlayerId !== client.id &&
		now - pending.startedAt <= BOSS_REROLL_LOCK_TIMEOUT_MS
	) {
		return
	}

	const revision = lobby.teamState.nextBossBlindRevision(groupId)
	lobby.teamState.setPendingBossReroll(groupId, {
		ante,
		sourcePlayerId: client.id,
		revision,
		startedAt: now,
	})

	clearBossReadyState(players)
	broadcastCoopBossBlind(players, {
		action: 'coopBossBlind',
		phase: 'start',
		ante,
		revision,
		sourcePlayerId: client.id,
		isReroll: true,
	})
	broadcastLobbyMatchPlayerStates(lobby, players)
}

const handleBossResult = (
	client: Client,
	ante: number,
	bossKey: string,
): void => {
	const group = getCoopBossBlindGroup(client)
	if (!group) {
		return
	}

	const { lobby, players, groupId } = group
	const pending = lobby.teamState.getPendingBossReroll(groupId)
	const existing = lobby.teamState.getBossBlind(groupId, ante)
	const isPendingResult =
		pending?.ante === ante && pending.sourcePlayerId === client.id
	if (pending?.ante === ante && !isPendingResult) {
		return
	}

	if (!isPendingResult && existing) {
		if (existing.bossKey !== bossKey) {
			sendExistingBossBlind(client, existing)
		}
		return
	}

	const revision = isPendingResult
		? pending.revision
		: lobby.teamState.nextBossBlindRevision(groupId)

	lobby.teamState.setBossBlind(
		groupId,
		ante,
		bossKey,
		revision,
		client.id,
		isPendingResult,
	)
	if (isPendingResult) {
		lobby.teamState.clearPendingBossReroll(groupId)
	}

	broadcastCoopBossBlind(players, {
		action: 'coopBossBlind',
		phase: 'result',
		ante,
		revision,
		sourcePlayerId: client.id,
		bossKey,
		isReroll: isPendingResult,
	})
}

export const coopBossBlindAction = (
	{ phase, ante, bossKey }: ActionHandlerArgs<ActionCoopBossBlindRequest>,
	client: Client,
) => {
	const normalizedAnte = normalizeAnte(ante)
	if (normalizedAnte === null) {
		sendSystemError(client, 'Invalid co-op boss blind ante.', { display: 'log' })
		return
	}

	if (phase === 'start') {
		handleBossRerollStart(client, normalizedAnte)
		return
	}

	if (phase === 'result' && isValidBossKey(bossKey)) {
		handleBossResult(client, normalizedAnte, bossKey)
		return
	}

	sendSystemError(client, 'Invalid co-op boss blind update.', { display: 'log' })
}
