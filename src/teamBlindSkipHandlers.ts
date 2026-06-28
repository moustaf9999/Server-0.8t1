import type Client from './Client.js'
import type Lobby from './Lobby.js'
import type {
	ActionHandlerArgs,
	ActionReadySkipBlind,
} from './actions.js'
import {
	hasDisconnectedSharedBlindBlocker,
	isSkipBlindRow,
} from './blindRules.js'
import {
	clearPendingBlindReadyState,
	clearPlayerReadyToSkipBlind,
	markPlayerReadyToSkipBlind,
} from './playerState.js'
import {
	getLobbyActivePlayers,
	isPlayerExcludedFromActiveMatch,
} from './lobbyPlayerState/queries.js'
import { sendTeamServerAction } from './protocol/v2/index.js'
import {
	getClientSharedSyncGroupId,
	getLobbyActiveSharedSyncGroupPlayers,
	lobbyUsesSharedSyncGroup,
} from './sharedSyncGroups.js'

const normalizeSkipAnte = (ante: unknown, fallbackAnte: number) => {
	const numericAnte = Number(ante)
	if (!Number.isFinite(numericAnte)) {
		return Math.max(0, Math.trunc(fallbackAnte))
	}
	return Math.max(0, Math.trunc(numericAnte))
}

const tryResolveReadySkipGroup = (
	lobby: Lobby,
	client: Client,
	blindRow: ActionReadySkipBlind['blindRow'],
	skipAnte: number,
) => {
	if (hasDisconnectedSharedBlindBlocker(lobby, client)) return false

	const players = getLobbyActiveSharedSyncGroupPlayers(
		lobby,
		getClientSharedSyncGroupId(client),
	)
	if (players.length === 0) return false

	const allReadyToSkip = players.every(
		(player) =>
			player.skipReadyBlindRow === blindRow &&
			player.skipReadyBlindAnte === skipAnte,
	)
	if (!allReadyToSkip) return false

	for (const player of players) {
		clearPendingBlindReadyState(player)
	}

	for (const player of players) {
		sendTeamServerAction(player, {
			action: 'teamSkipBlind',
			blindRow,
			ante: skipAnte,
		})
	}

	return true
}

export const tryResolvePendingSkipBlindIfReady = (
	lobby: Lobby | null | undefined,
) => {
	if (!lobbyUsesSharedSyncGroup(lobby)) return false

	const checkedGroupIds = new Set<number>()
	let resolvedAny = false
	for (const player of getLobbyActivePlayers(lobby)) {
		const blindRow = player.skipReadyBlindRow
		const skipAnte = player.skipReadyBlindAnte
		if (!isSkipBlindRow(blindRow) || skipAnte == null) continue

		const groupId = getClientSharedSyncGroupId(player)
		if (checkedGroupIds.has(groupId)) continue
		checkedGroupIds.add(groupId)

		resolvedAny =
			tryResolveReadySkipGroup(lobby, player, blindRow, skipAnte) ||
			resolvedAny
	}

	return resolvedAny
}

export const readySkipBlindAction = (
	{ blindRow, ante }: ActionHandlerArgs<ActionReadySkipBlind>,
	client: Client,
) => {
	const lobby = client.lobby
	if (!lobbyUsesSharedSyncGroup(lobby)) return
	if (!client.isInMatch) return
	if (!isSkipBlindRow(blindRow)) return

	const skipAnte = normalizeSkipAnte(ante, client.ante)
	markPlayerReadyToSkipBlind(client, blindRow, skipAnte)

	tryResolveReadySkipGroup(lobby, client, blindRow, skipAnte)
}

export const unreadySkipBlindAction = (client: Client) => {
	const lobby = client.lobby
	if (lobby && isPlayerExcludedFromActiveMatch(lobby, client)) {
		return
	}
	clearPlayerReadyToSkipBlind(client)
}
