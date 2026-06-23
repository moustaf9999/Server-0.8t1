import type { InsaneInt } from './InsaneInt.js'

type SharedBossBlindState = {
	ante: number
	bossKey: string
	revision: number
	sourcePlayerId: string
	isReroll: boolean
}

type PendingBossRerollState = {
	ante: number
	sourcePlayerId: string
	revision: number
	startedAt: number
}

export class LobbyTeamState {
	decks = new Map<number, Map<string, string | null>>()
	handLevels = new Map<number, Map<string, string>>()
	lives = new Map<number, number>()
	blindTargets = new Map<number, InsaneInt>()
	lifeBlockers = new Set<number>()
	resolvedCoopTeams = new Set<number>()
	bossBlindRevisions = new Map<number, number>()
	bossBlinds = new Map<number, Map<number, SharedBossBlindState>>()
	pendingBossRerolls = new Map<number, PendingBossRerollState>()

	clearSyncCaches = () => {
		this.decks.clear()
		this.handLevels.clear()
	}

	clearMatchState = () => {
		this.lives.clear()
		this.blindTargets.clear()
		this.lifeBlockers.clear()
		this.resolvedCoopTeams.clear()
		this.bossBlindRevisions.clear()
		this.bossBlinds.clear()
		this.pendingBossRerolls.clear()
	}

	clearAll = () => {
		this.clearSyncCaches()
		this.clearMatchState()
	}

	getDeck = (teamId: number) => this.decks.get(teamId)

	ensureDeck = (teamId: number) => {
		let teamDeck = this.decks.get(teamId)
		if (!teamDeck) {
			teamDeck = new Map<string, string | null>()
			this.decks.set(teamId, teamDeck)
		}
		return teamDeck
	}

	getHandLevels = (teamId: number) => this.handLevels.get(teamId)

	ensureHandLevels = (teamId: number) => {
		let teamHandLevels = this.handLevels.get(teamId)
		if (!teamHandLevels) {
			teamHandLevels = new Map<string, string>()
			this.handLevels.set(teamId, teamHandLevels)
		}
		return teamHandLevels
	}

	getLives = (teamId: number) => this.lives.get(teamId) ?? 0

	setLives = (teamId: number, lives: number) => {
		this.lives.set(teamId, lives)
		return lives
	}

	getBlindTarget = (teamId: number) => this.blindTargets.get(teamId)

	setBlindTarget = (teamId: number, blindTarget: InsaneInt) => {
		this.blindTargets.set(teamId, blindTarget)
		return blindTarget
	}

	deleteBlindTarget = (teamId: number) => this.blindTargets.delete(teamId)

	clearBlindTargets = () => {
		this.blindTargets.clear()
	}

	hasLifeBlocker = (teamId: number) => this.lifeBlockers.has(teamId)

	addLifeBlocker = (teamId: number) => {
		this.lifeBlockers.add(teamId)
	}

	deleteLifeBlocker = (teamId: number) => this.lifeBlockers.delete(teamId)

	clearLifeBlockers = () => {
		this.lifeBlockers.clear()
	}

	hasResolvedCoopTeam = (teamId: number) => this.resolvedCoopTeams.has(teamId)

	addResolvedCoopTeam = (teamId: number) => {
		this.resolvedCoopTeams.add(teamId)
	}

	deleteResolvedCoopTeam = (teamId: number) =>
		this.resolvedCoopTeams.delete(teamId)

	clearResolvedCoopTeams = () => {
		this.resolvedCoopTeams.clear()
	}

	nextBossBlindRevision = (groupId: number) => {
		const revision = (this.bossBlindRevisions.get(groupId) ?? 0) + 1
		this.bossBlindRevisions.set(groupId, revision)
		return revision
	}

	getBossBlind = (groupId: number, ante: number) =>
		this.bossBlinds.get(groupId)?.get(ante) ?? null

	setBossBlind = (
		groupId: number,
		ante: number,
		bossKey: string,
		revision: number,
		sourcePlayerId: string,
		isReroll: boolean,
	) => {
		let groupBossBlinds = this.bossBlinds.get(groupId)
		if (!groupBossBlinds) {
			groupBossBlinds = new Map<number, SharedBossBlindState>()
			this.bossBlinds.set(groupId, groupBossBlinds)
		}

		const state = { ante, bossKey, revision, sourcePlayerId, isReroll }
		groupBossBlinds.set(ante, state)
		this.bossBlindRevisions.set(
			groupId,
			Math.max(this.bossBlindRevisions.get(groupId) ?? 0, revision),
		)
		return state
	}

	getPendingBossReroll = (groupId: number) =>
		this.pendingBossRerolls.get(groupId) ?? null

	setPendingBossReroll = (
		groupId: number,
		pending: PendingBossRerollState,
	) => {
		this.pendingBossRerolls.set(groupId, pending)
		return pending
	}

	clearPendingBossReroll = (groupId: number) =>
		this.pendingBossRerolls.delete(groupId)
}
