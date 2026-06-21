import type Client from '../Client.js'
import type {
	ActionGetEndGameSummaryResponse,
	ActionHandlerArgs,
	ActionReceiveEndGameSummaryRequest,
} from '../actions.js'
import { sendEndgameServerAction } from '../protocol/v2/index.js'
import {
	requestEndGameSnapshot,
	storeAndForwardEndGameSnapshot,
} from './requestRouting.js'

export const getEndGameSummaryAction = (
	{ targetPlayerId, fresh }: ActionHandlerArgs<ActionGetEndGameSummaryResponse>,
	client: Client,
) => {
	requestEndGameSnapshot({
		client,
		traceKind: 'summary',
		targetPlayerId,
		fresh: fresh === true,
		getCachedSnapshot: (lobby, playerId) =>
			lobby.getEndGameSnapshot(playerId)?.summary,
		sendCachedSnapshot: (requester, sourcePlayerId, summary) => {
			sendEndgameServerAction(requester, {
				action: 'receiveEndGameSummary',
				summary,
				sourcePlayerId,
			})
		},
		sendTargetRequest: (target, requester) => {
			sendEndgameServerAction(target, {
				action: 'getEndGameSummary',
				requesterPlayerId: requester.id,
			})
		},
	})
}

export const receiveEndGameSummaryAction = (
	{
		summary,
		sourcePlayerId,
		requesterPlayerId,
	}: ActionHandlerArgs<ActionReceiveEndGameSummaryRequest>,
	client: Client,
) => {
	storeAndForwardEndGameSnapshot({
		client,
		traceKind: 'summary',
		sourcePlayerId,
		requesterPlayerId,
		snapshot: summary,
		storeSnapshot: (lobby, playerId, resolvedSummary) =>
			lobby.storeEndGameSnapshot(playerId, { summary: resolvedSummary }),
		sendSnapshotToRequester: (
			requester,
			resolvedSourcePlayerId,
			resolvedSummary,
		) => {
			sendEndgameServerAction(requester, {
				action: 'receiveEndGameSummary',
				summary: resolvedSummary,
				sourcePlayerId: resolvedSourcePlayerId,
			})
		},
		broadcastSnapshotOnNoRequester: (
			recipient,
			resolvedSourcePlayerId,
			resolvedSummary,
		) => {
			sendEndgameServerAction(recipient, {
				action: 'receiveEndGameSummary',
				summary: resolvedSummary,
				sourcePlayerId: resolvedSourcePlayerId,
			})
		},
	})
}
