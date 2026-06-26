import { InsaneInt, parseFiniteInsaneInt } from './InsaneInt.js'
import type Client from './Client.js'
import type {
	ActionBlindPreview,
	ActionHandlerArgs,
	ActionPlayHand,
	BlindKind,
	BlindRow,
} from './actions.js'
import { sumScores, sumScoreValues } from './blindScoring.js'
import {
	loseLobbyTeamLife,
	resetLobbyTeamLifeBlocker,
} from './lobbyPlayerState/lives.js'
import { broadcastLobbyMatchPlayerStates } from './lobbyPlayerState/broadcasts.js'
import { finalizeMatchResults, resolveTeamsGameOver } from './matchGameOver.js'
import {
	clearPlayerActiveBlindState,
	clearPlayerCoopBlindState,
	clearPlayerStartedBlindRuntimeState,
	preparePlayerForStartedBlind,
} from './playerState.js'
import { sendMatchServerAction } from './protocol/v2/index.js'
import { isCoopLobbyType } from './lobbyTypes.js'
import {
	getClientSharedSyncGroupId,
	getLobbyActiveSharedSyncGroupPlayers,
	lobbyUsesSharedSyncGroup,
} from './sharedSyncGroups.js'

const endTeamCoopBlind = (players: Client[], lost: boolean) =>
	players.forEach((player) => {
		clearPlayerStartedBlindRuntimeState(player)
		sendMatchServerAction(player, { action: 'endCoopBlind', lost })
	})

const getCoopBlindGroup = (client: Client) => {
	const lobby = client.lobby
	if (!lobby) {
		return null
	}

	if (!lobbyUsesSharedSyncGroup(lobby)) {
		return null
	}

	const groupId = getClientSharedSyncGroupId(client)
	const players = getLobbyActiveSharedSyncGroupPlayers(lobby, groupId)

	if (players.length === 0) {
		return null
	}

	return { lobby, groupId, players, isGlobalCoop: isCoopLobbyType(lobby.lobbyType) }
}

const parseReportedBlindTarget = (
	blindTarget: unknown,
) => {
	if (typeof blindTarget !== 'string' || blindTarget.length === 0) {
		return null
	}

	return parseFiniteInsaneInt(blindTarget)
}

const PREVIEW_BLIND_ROWS: readonly BlindRow[] = ['Small', 'Big', 'Boss']

const normalizeAggregateBlindTarget = (blindTarget: InsaneInt) => {
	const normalized = InsaneInt.fromString(blindTarget)
	normalized.balance()

	if (normalized.startingECount === 0 && normalized.exponent === 0) {
		return new InsaneInt(0, Math.round(normalized.coefficient), 0)
	}

	return normalized
}

const aggregateBlindTargets = (targets: InsaneInt[]) => {
	if (targets.length === 0) {
		return null
	}

	const summedTargets = sumScoreValues(targets)
	const aggregateTarget = summedTargets.div(new InsaneInt(0, targets.length, 0))
	return normalizeAggregateBlindTarget(aggregateTarget)
}

const aggregateReadyBlindTargets = (
	players: Client[],
	fallbackBlindTarget: unknown,
) => {
	const targets = players
		.map((player) => parseReportedBlindTarget(player.readyBlindTarget))
		.filter((target): target is InsaneInt => target != null)

	if (targets.length === players.length && targets.length > 0) {
		return aggregateBlindTargets(targets)
	}

	const fallbackTarget = parseReportedBlindTarget(fallbackBlindTarget)
	return fallbackTarget ? normalizeAggregateBlindTarget(fallbackTarget) : null
}

const aggregatePreviewBlindTarget = (
	players: Client[],
	previewKey: string,
	row: BlindRow,
) => {
	const targets = players
		.map((player) =>
			player.blindPreviewKey === previewKey
				? parseReportedBlindTarget(player.blindPreviewTargets[row])
				: null,
		)
		.filter((target): target is InsaneInt => target != null)

	if (targets.length !== players.length) {
		return null
	}

	return aggregateBlindTargets(targets)
}

export const blindPreviewAction = (
	{ previewKey, targets }: ActionHandlerArgs<ActionBlindPreview>,
	client: Client,
) => {
	if (!client.isInMatch) {
		return
	}

	const group = getCoopBlindGroup(client)
	if (!group) {
		return
	}

	client.blindPreviewKey = previewKey
	client.blindPreviewTargets = { ...targets }

	const { players } = group
	const aggregateTargets: Partial<Record<BlindRow, string>> = {}
	for (const row of PREVIEW_BLIND_ROWS) {
		const aggregateTarget = aggregatePreviewBlindTarget(
			players,
			previewKey,
			row,
		)
		if (aggregateTarget) {
			aggregateTargets[row] = aggregateTarget.toString()
		}
	}

	for (const player of players) {
		sendMatchServerAction(player, {
			action: 'coopBlindPreview',
			previewKey,
			targets: aggregateTargets,
		})
	}
}

export const startTeamCoopBlindIfReady = (
	client: Client,
	blindKind: BlindKind,
	blindTarget: string | null = client.readyBlindTarget,
) => {
	if (blindKind === 'pvp') {
		return false
	}

	const group = getCoopBlindGroup(client)
	if (!group) {
		return false
	}

	const { lobby, groupId, players, isGlobalCoop } = group
	lobby.teamState.deleteBlindTarget(groupId)
	const aggregateBlindTarget = aggregateReadyBlindTargets(
		players,
		blindTarget,
	)
	if (aggregateBlindTarget) {
		lobby.teamState.setBlindTarget(groupId, aggregateBlindTarget)
	}
	if (isGlobalCoop) {
		lobby.teamState.clearLifeBlockers()
	} else {
		resetLobbyTeamLifeBlocker(lobby, groupId)
	}
	lobby.teamState.deleteResolvedCoopTeam(groupId)

	for (const player of players) {
		preparePlayerForStartedBlind(player, true)
	}

	for (const player of players) {
		sendMatchServerAction(player, {
			action: 'startBlind',
			blindTarget: aggregateBlindTarget?.toString(),
		})
	}
	broadcastLobbyMatchPlayerStates(lobby, players)

	return true
}

export const resolveTeamCoopBlindFailure = (client: Client) => {
	if (!client.coopBlindActive) {
		return false
	}

	const group = getCoopBlindGroup(client)
	if (!group) {
		return false
	}

	const { lobby, groupId, players, isGlobalCoop } = group
	if (lobby.teamState.hasResolvedCoopTeam(groupId)) {
		return true
	}

	lobby.teamState.addResolvedCoopTeam(groupId)
	lobby.teamState.deleteBlindTarget(groupId)

	if (isGlobalCoop) {
		for (const player of players) {
			clearPlayerCoopBlindState(player)
			clearPlayerActiveBlindState(player)
		}
		finalizeMatchResults(lobby, players, { losers: players })
		return true
	}

	const remainingLives = loseLobbyTeamLife(
		lobby,
		groupId,
		'team_coop_blind_failed',
	)
	if (remainingLives <= 0) {
		for (const player of players) {
			clearPlayerCoopBlindState(player)
			clearPlayerActiveBlindState(player)
		}
		resolveTeamsGameOver(lobby, groupId)
		return true
	}

	endTeamCoopBlind(players, true)
	return true
}

export const handleTeamCoopBlindRoundFailure = (client: Client) => {
	if (!client.coopBlindActive) {
		return false
	}

	const group = getCoopBlindGroup(client)
	if (!group) {
		return false
	}

	const { lobby, groupId, players } = group
	if (lobby.teamState.hasResolvedCoopTeam(groupId)) {
		return true
	}

	client.handsLeft = 0
	broadcastLobbyMatchPlayerStates(lobby, players)
	return handleTeamCoopBlindPlayHand(undefined, client)
}

export const handleTeamCoopBlindPlayHand = (
	blindTarget: ActionHandlerArgs<ActionPlayHand>['blindTarget'],
	client: Client,
) => {
	if (!client.coopBlindActive) {
		return false
	}

	const group = getCoopBlindGroup(client)
	if (!group) {
		return false
	}

	const { lobby, groupId, players } = group
	const parsedBlindTarget = parseReportedBlindTarget(blindTarget)
	if (!lobby.teamState.getBlindTarget(groupId) && parsedBlindTarget) {
		lobby.teamState.setBlindTarget(groupId, parsedBlindTarget)
	}

	if (lobby.teamState.hasResolvedCoopTeam(groupId)) {
		return true
	}

	const teamScore = sumScores(players)
	const teamBlindTarget =
		lobby.teamState.getBlindTarget(groupId) ?? parsedBlindTarget
	const allTeammatesFinished = players.every(
		(player) => player.handsLeft === 0,
	)
	if (!teamBlindTarget && !allTeammatesFinished) {
		return true
	}
	if (!teamBlindTarget) {
		return resolveTeamCoopBlindFailure(client)
	}

	const beatBlind = !teamScore.lessThan(teamBlindTarget)

	if (beatBlind) {
		lobby.teamState.addResolvedCoopTeam(groupId)
		lobby.teamState.deleteBlindTarget(groupId)
		endTeamCoopBlind(players, false)
		return true
	}

	if (!allTeammatesFinished) {
		return true
	}

	return resolveTeamCoopBlindFailure(client)
}
