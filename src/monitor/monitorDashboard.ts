import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import { Lobbies } from '../lobbyRegistry.js'
import { getMonitorSnapshot } from './monitorStore.js'

const DEFAULT_MONITOR_PORT = 8790

const isTruthyEnvValue = (value: string | undefined) =>
	['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')

const getMonitorToken = () =>
	process.env.ADMIN_DASHBOARD_TOKEN?.trim() ||
	process.env.MONITOR_DASHBOARD_TOKEN?.trim() ||
	''

const isRailwayEnvironment = () =>
	Boolean(
		process.env.RAILWAY_ENVIRONMENT_ID ||
			process.env.RAILWAY_SERVICE_ID ||
			process.env.RAILWAY_PROJECT_ID,
	)

const getMonitorPort = () => {
	const parsed = Number(
		process.env.MONITOR_DASHBOARD_PORT ??
			(isRailwayEnvironment() ? process.env.PORT : undefined),
	)
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
		? parsed
		: DEFAULT_MONITOR_PORT
}

const getMonitorHost = () =>
	process.env.MONITOR_DASHBOARD_HOST?.trim() || '0.0.0.0'

export const isMonitorDashboardHttpRequest = (data: Buffer) =>
	/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s/i.test(
		data.toString('ascii', 0, Math.min(data.length, 16)),
	)

const hashSecret = (value: string) =>
	createHash('sha256').update(value).digest()

const secretsEqual = (left: string, right: string) => {
	const leftHash = hashSecret(left)
	const rightHash = hashSecret(right)
	return timingSafeEqual(leftHash, rightHash)
}

const parseCookies = (header: string | undefined) => {
	const cookies = new Map<string, string>()
	for (const part of (header ?? '').split(';')) {
		const [name, ...valueParts] = part.trim().split('=')
		if (!name) continue
		cookies.set(name, decodeURIComponent(valueParts.join('=')))
	}
	return cookies
}

const extractBearerToken = (request: IncomingMessage) => {
	const header = request.headers.authorization
	if (!header) return ''
	const match = /^Bearer\s+(.+)$/i.exec(header)
	return match?.[1]?.trim() ?? ''
}

const getRequestToken = (request: IncomingMessage, url: URL) =>
	extractBearerToken(request) ||
	url.searchParams.get('token')?.trim() ||
	parseCookies(request.headers.cookie).get('mp_monitor_token') ||
	''

const isAuthorized = (request: IncomingMessage, url: URL) => {
	const configuredToken = getMonitorToken()
	if (!configuredToken) return false
	const requestToken = getRequestToken(request, url)
	return !!requestToken && secretsEqual(requestToken, configuredToken)
}

const sendText = (
	response: ServerResponse,
	statusCode: number,
	body: string,
	contentType = 'text/plain; charset=utf-8',
) => {
	response.writeHead(statusCode, {
		'content-type': contentType,
		'cache-control': 'no-store',
	})
	response.end(body)
}

const sendJson = (
	response: ServerResponse,
	statusCode: number,
	body: unknown,
) => {
	sendText(
		response,
		statusCode,
		JSON.stringify(body),
		'application/json; charset=utf-8',
	)
}

const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Balatro Multiplayer Monitor</title>
<style>
:root {
	color-scheme: dark;
	--bg: #11191b;
	--panel: #26393c;
	--panel-2: #30484c;
	--line: #9db8c8;
	--muted: #a7b8ba;
	--text: #f3fbff;
	--blue: #0c94e8;
	--red: #ff4a42;
	--orange: #ff9b00;
	--green: #37d68a;
	--purple: #9a62d0;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, input {
	font: inherit;
}
.shell {
	max-width: 1480px;
	margin: 0 auto;
	padding: 18px;
}
.topbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 14px;
}
h1 {
	margin: 0;
	font-size: 22px;
	letter-spacing: 0;
}
.muted { color: var(--muted); }
.tabs, .toolbar, .stats {
	display: flex;
	gap: 8px;
	align-items: center;
	flex-wrap: wrap;
}
.tab, .btn {
	border: 0;
	border-radius: 6px;
	background: var(--panel-2);
	color: var(--text);
	padding: 8px 12px;
	cursor: pointer;
	box-shadow: 0 3px 0 rgba(0,0,0,.35);
}
.tab.active, .btn.primary { background: var(--blue); }
.stat {
	background: var(--panel);
	border: 1px solid rgba(157,184,200,.25);
	border-radius: 6px;
	padding: 8px 10px;
	min-width: 110px;
}
.stat b { display: block; font-size: 18px; }
.grid {
	display: grid;
	grid-template-columns: minmax(320px, 420px) 1fr;
	gap: 12px;
	align-items: start;
}
.list, .detail {
	background: var(--panel);
	border: 2px solid var(--line);
	border-radius: 8px;
	padding: 12px;
	min-height: 240px;
}
.lobby {
	width: 100%;
	text-align: left;
	border: 0;
	border-radius: 6px;
	margin: 0 0 8px;
	padding: 10px;
	background: rgba(0,0,0,.22);
	color: var(--text);
	cursor: pointer;
	border-left: 6px solid var(--muted);
}
.lobby.active { outline: 2px solid var(--blue); }
.lobby.in_game { border-left-color: var(--green); }
.lobby.waiting { border-left-color: var(--orange); }
.lobby .row, .section-title, .player-head {
	display: flex;
	justify-content: space-between;
	gap: 8px;
	align-items: center;
}
.code { font-weight: 800; font-size: 18px; }
.pill {
	display: inline-flex;
	align-items: center;
	border-radius: 999px;
	padding: 2px 8px;
	background: rgba(255,255,255,.1);
	color: var(--text);
	white-space: nowrap;
}
.pill.green { background: rgba(55,214,138,.22); color: #a9ffd2; }
.pill.orange { background: rgba(255,155,0,.22); color: #ffd79a; }
.pill.red { background: rgba(255,74,66,.24); color: #ffc1bd; }
.pill.purple { background: rgba(154,98,208,.28); color: #ead5ff; }
.cards {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 8px;
}
.player, .option, .event {
	background: rgba(0,0,0,.22);
	border-radius: 6px;
	padding: 10px;
}
.player.disconnected { opacity: .7; border: 1px dashed rgba(255,255,255,.25); }
.kv {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
	gap: 6px;
	margin-top: 8px;
}
.kv div, .mod {
	background: rgba(255,255,255,.07);
	border-radius: 5px;
	padding: 5px 7px;
}
.section {
	margin-top: 14px;
}
.section-title {
	margin-bottom: 8px;
	font-weight: 800;
}
.events {
	display: grid;
	gap: 6px;
	max-height: 420px;
	overflow: auto;
}
.event {
	border-left: 4px solid var(--blue);
}
.event.warn { border-left-color: var(--orange); }
.event.error { border-left-color: var(--red); }
pre {
	margin: 0;
	white-space: pre-wrap;
	word-break: break-word;
}
.login {
	max-width: 420px;
	margin: 80px auto;
	background: var(--panel);
	border: 2px solid var(--line);
	border-radius: 8px;
	padding: 18px;
}
.login input {
	width: 100%;
	border: 1px solid rgba(157,184,200,.45);
	background: rgba(0,0,0,.25);
	color: var(--text);
	border-radius: 6px;
	padding: 10px;
	margin: 10px 0;
}
.hidden { display: none !important; }
@media (max-width: 900px) {
	.grid { grid-template-columns: 1fr; }
	.topbar { align-items: stretch; flex-direction: column; }
}
</style>
</head>
<body>
<div id="login" class="login hidden">
	<h1>Balatro Multiplayer Monitor</h1>
	<p class="muted">Enter the dashboard token configured on the server.</p>
	<input id="tokenInput" type="password" autocomplete="current-password" placeholder="Dashboard token">
	<button class="btn primary" id="loginBtn">Open Monitor</button>
	<p id="loginError" class="muted"></p>
</div>
<main id="app" class="shell hidden">
	<div class="topbar">
		<div>
			<h1>Balatro Multiplayer Monitor</h1>
			<div class="muted" id="generatedAt">Loading...</div>
		</div>
		<div class="toolbar">
			<button class="tab active" data-tab="live">Live</button>
			<button class="tab" data-tab="archived">Archived</button>
			<button class="btn" id="refreshBtn">Refresh</button>
			<button class="btn" id="exportBtn">Export JSON</button>
		</div>
	</div>
	<div class="stats" id="stats"></div>
	<div class="grid section">
		<div class="list" id="lobbyList"></div>
		<div class="detail" id="detail"></div>
	</div>
</main>
<script>
const state = {
	token: localStorage.getItem('mp_monitor_token') || '',
	tab: 'live',
	selectedId: '',
	data: null,
};
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({
	'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[ch]));
const fmtTime = (value) => value ? new Date(value).toLocaleString() : 'n/a';
const fmtDuration = (seconds) => seconds == null ? 'n/a' : seconds + 's';
const statusPill = (lobby) => lobby.status === 'in_game'
	? '<span class="pill green">In game</span>'
	: '<span class="pill orange">Waiting</span>';

function setToken(token) {
	state.token = token;
	localStorage.setItem('mp_monitor_token', token);
	document.cookie = 'mp_monitor_token=' + encodeURIComponent(token) + '; path=/; SameSite=Lax';
}

async function fetchSnapshot() {
	const response = await fetch('/admin/api/snapshot', {
		headers: { authorization: 'Bearer ' + state.token },
		cache: 'no-store',
	});
	if (response.status === 401) throw new Error('unauthorized');
	if (!response.ok) throw new Error('HTTP ' + response.status);
	return response.json();
}

function renderStats() {
	const counts = state.data?.counts || {};
	$('stats').innerHTML = [
		['Live lobbies', counts.live ?? 0],
		['In game', counts.inGame ?? 0],
		['Players', counts.players ?? 0],
		['Archived', counts.archived ?? 0],
	].map(([label, value]) => '<div class="stat"><span class="muted">' + label + '</span><b>' + value + '</b></div>').join('');
}

function getVisibleLobbies() {
	return state.tab === 'live' ? (state.data?.live || []) : (state.data?.archived || []);
}

function getItemId(lobby) {
	return lobby.id || (state.tab + ':' + lobby.code + ':' + (lobby.matchStartedAt || lobby.createdAt || 'unknown'));
}

function getItemTitle(lobby) {
	if (state.tab === 'archived') {
		const label = lobby.archiveReason === 'match_finished'
			? 'Match ' + (lobby.matchNumber || '?')
			: 'Lobby closed';
		return escapeHtml(lobby.code) + ' <span class="pill purple">' + escapeHtml(label) + '</span>';
	}
	return escapeHtml(lobby.code);
}

function renderLobbyList() {
	const lobbies = getVisibleLobbies();
	if (!lobbies.length) {
		$('lobbyList').innerHTML = '<p class="muted">No ' + state.tab + ' lobbies.</p>';
		$('detail').innerHTML = '<p class="muted">Nothing selected.</p>';
		return;
	}
	if (!lobbies.some(lobby => getItemId(lobby) === state.selectedId)) {
		state.selectedId = getItemId(lobbies[0]);
	}
	$('lobbyList').innerHTML = lobbies.map(lobby => {
		const itemId = getItemId(lobby);
		const active = itemId === state.selectedId ? ' active' : '';
		return '<button class="lobby ' + lobby.status + active + '" data-id="' + escapeHtml(itemId) + '">' +
			'<div class="row"><span class="code">' + getItemTitle(lobby) + '</span>' + statusPill(lobby) + '</div>' +
			'<div class="muted">' + escapeHtml(lobby.gameMode) + ' / ' + escapeHtml(lobby.lobbyType) + '</div>' +
			'<div class="row"><span>' + lobby.playerCount + '/' + lobby.maxPlayers + ' players</span><span>' + escapeHtml(lobby.ownerName || 'No host') + '</span></div>' +
			'<div class="muted">' + (state.tab === 'archived' ? 'Started ' + fmtTime(lobby.matchStartedAt) + ' · Ended ' + fmtTime(lobby.endedAt) : 'Updated ' + fmtTime(lobby.updatedAt)) + '</div>' +
			'</button>';
	}).join('');
	for (const button of document.querySelectorAll('.lobby[data-id]')) {
		button.addEventListener('click', () => {
			state.selectedId = button.getAttribute('data-id');
			render();
		});
	}
}

function renderPlayer(player) {
	const mods = player.mods?.length
		? player.mods.map(mod => '<span class="mod">' + escapeHtml(mod) + '</span>').join('')
		: '<span class="mod">' + escapeHtml(player.modHash || 'No mod hash') + '</span>';
	return '<div class="player ' + (player.isDisconnected ? 'disconnected' : '') + '">' +
		'<div class="player-head"><b>' + escapeHtml(player.username) + '</b><span>' +
		(player.isOwner ? '<span class="pill purple">Host</span> ' : '') +
		(player.isDisconnected ? '<span class="pill red">Disconnected</span>' : '<span class="pill green">Online</span>') +
		'</span></div>' +
		'<div class="kv">' +
		'<div>Lives: <b>' + player.lives + '</b></div>' +
		'<div>Score: <b>' + escapeHtml(player.score) + '</b></div>' +
		'<div>Ante: <b>' + player.ante + '</b></div>' +
		'<div>Skips: <b>' + player.skips + '</b></div>' +
		'<div>Hands: <b>' + player.handsLeft + '</b></div>' +
		'<div>Money: <b>$' + player.money + '</b></div>' +
		'<div>Team: <b>' + escapeHtml(player.team ?? 'none') + '</b></div>' +
		'<div>Location: <b>' + escapeHtml(player.location) + '</b></div>' +
		'<div>Ready blind: <b>' + escapeHtml([player.readyBlindRow, player.readyBlindKind].filter(Boolean).join(' ') || 'none') + '</b></div>' +
		'<div>Active blind: <b>' + escapeHtml([player.activeBlindRow, player.activeBlindKind].filter(Boolean).join(' ') || 'none') + '</b></div>' +
		'</div>' +
		'<div class="section-title" style="margin-top:8px">Mods</div><div class="cards">' + mods + '</div>' +
		'</div>';
}

function renderEvents(lobby) {
	const events = [...(lobby.events || [])].reverse();
	if (!events.length) return '<p class="muted">No monitor events yet.</p>';
	return '<div class="events">' + events.map(event =>
		'<div class="event ' + escapeHtml(event.level) + '">' +
		'<div class="row"><b>' + escapeHtml(event.event) + '</b><span class="muted">' + fmtTime(event.at) + '</span></div>' +
		'<div>' + escapeHtml(event.message) + '</div>' +
		(event.playerName ? '<div class="muted">Player: ' + escapeHtml(event.playerName) + '</div>' : '') +
		(event.details ? '<pre class="muted">' + escapeHtml(JSON.stringify(event.details, null, 2)) + '</pre>' : '') +
		'</div>'
	).join('') + '</div>';
}

function renderDetail() {
	const lobby = getVisibleLobbies().find(item => getItemId(item) === state.selectedId);
	if (!lobby) {
		$('detail').innerHTML = '<p class="muted">Nothing selected.</p>';
		return;
	}
	const allPlayers = [...(lobby.players || []), ...(lobby.disconnectedPlayers || [])];
	const options = Object.entries(lobby.options || {}).sort(([a], [b]) => a.localeCompare(b));
	$('detail').innerHTML =
		'<div class="section-title"><span class="code">' + getItemTitle(lobby) + '</span>' + statusPill(lobby) + '</div>' +
		'<div class="kv">' +
		'<div>Mode: <b>' + escapeHtml(lobby.gameMode) + '</b></div>' +
		'<div>Lobby type: <b>' + escapeHtml(lobby.lobbyType) + '</b></div>' +
		'<div>Match: <b>' + escapeHtml(lobby.matchNumber ? '#' + lobby.matchNumber : 'none') + '</b></div>' +
		'<div>Match ID: <b>' + escapeHtml(lobby.matchId || 'none') + '</b></div>' +
		'<div>Host: <b>' + escapeHtml(lobby.ownerName || 'No host') + '</b></div>' +
		'<div>Created: <b>' + fmtTime(lobby.createdAt) + '</b></div>' +
		'<div>Started: <b>' + fmtTime(lobby.matchStartedAt) + '</b></div>' +
		'<div>Ended: <b>' + fmtTime(lobby.endedAt) + '</b></div>' +
		'<div>Duration: <b>' + fmtDuration(lobby.durationSeconds) + '</b></div>' +
		'<div>Timer: <b>' + lobby.timer.time + 's ' + (lobby.timer.started ? 'running' : 'paused') + '</b></div>' +
		'</div>' +
		'<div class="section"><div class="section-title">Players</div><div class="cards">' + allPlayers.map(renderPlayer).join('') + '</div></div>' +
		'<div class="section"><div class="section-title">Options</div><div class="cards">' + options.map(([key, value]) => '<div class="option"><b>' + escapeHtml(key) + '</b><br><span class="muted">' + escapeHtml(JSON.stringify(value)) + '</span></div>').join('') + '</div></div>' +
		'<div class="section"><div class="section-title">Game Logs</div>' + renderEvents(lobby) + '</div>';
}

function render() {
	if (!state.data) return;
	$('generatedAt').textContent = 'Updated ' + fmtTime(state.data.generatedAt);
	renderStats();
	renderLobbyList();
	renderDetail();
	document.querySelectorAll('.tab').forEach(tab => {
		tab.classList.toggle('active', tab.getAttribute('data-tab') === state.tab);
	});
}

async function refresh() {
	try {
		state.data = await fetchSnapshot();
		$('login').classList.add('hidden');
		$('app').classList.remove('hidden');
		render();
	} catch (error) {
		if (error.message === 'unauthorized') {
			$('app').classList.add('hidden');
			$('login').classList.remove('hidden');
			$('loginError').textContent = state.token ? 'Invalid token.' : '';
			return;
		}
		$('generatedAt').textContent = 'Refresh failed: ' + error.message;
	}
}

$('loginBtn').addEventListener('click', () => {
	setToken($('tokenInput').value.trim());
	refresh();
});
$('tokenInput').addEventListener('keydown', event => {
	if (event.key === 'Enter') $('loginBtn').click();
});
$('refreshBtn').addEventListener('click', refresh);
$('exportBtn').addEventListener('click', () => {
	const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
	const link = document.createElement('a');
	link.href = URL.createObjectURL(blob);
	link.download = 'balatro-monitor-' + Date.now() + '.json';
	link.click();
	URL.revokeObjectURL(link.href);
});
document.querySelectorAll('.tab').forEach(tab => {
	tab.addEventListener('click', () => {
		state.tab = tab.getAttribute('data-tab');
		state.selectedId = '';
		render();
	});
});
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`

const handleDashboardRequest = (
	request: IncomingMessage,
	response: ServerResponse,
) => {
	const url = new URL(request.url ?? '/', 'http://localhost')
	if (url.pathname === '/') {
		response.writeHead(302, {
			location: '/admin',
			'cache-control': 'no-store',
		})
		response.end()
		return
	}

	if (!url.pathname.startsWith('/admin')) {
		sendText(response, 404, 'Not found')
		return
	}

	if (!isAuthorized(request, url)) {
		if (url.pathname === '/admin' || url.pathname === '/admin/') {
			sendText(response, 200, dashboardHtml, 'text/html; charset=utf-8')
			return
		}
		sendJson(response, 401, { success: false, error: 'Unauthorized' })
		return
	}

	if (url.pathname === '/admin' || url.pathname === '/admin/') {
		sendText(response, 200, dashboardHtml, 'text/html; charset=utf-8')
		return
	}

	if (url.pathname === '/admin/api/snapshot') {
		sendJson(response, 200, getMonitorSnapshot(Lobbies.values()))
		return
	}

	sendText(response, 404, 'Not found')
}

export type MonitorDashboardServer = {
	host: string
	port: number
	handleConnection: (socket: Socket, initialData?: Buffer) => void
	listen: () => void
}

export const createMonitorDashboardServer = (): MonitorDashboardServer | null => {
	if (!isTruthyEnvValue(process.env.MONITOR_DASHBOARD_ENABLED)) {
		return null
	}

	if (!getMonitorToken()) {
		console.warn(
			'Monitor dashboard disabled: set ADMIN_DASHBOARD_TOKEN or MONITOR_DASHBOARD_TOKEN to enable it.',
		)
		return null
	}

	const port = getMonitorPort()
	const host = getMonitorHost()
	const server = createServer(handleDashboardRequest)

	return {
		host,
		port,
		handleConnection(socket, initialData) {
			if (initialData) {
				socket.unshift(initialData)
			}
			server.emit('connection', socket)
		},
		listen() {
			server.listen(port, host, () => {
				console.log(`Monitor dashboard listening on ${host}:${port}/admin`)
			})
		},
	}
}

export const startMonitorDashboard = () => {
	createMonitorDashboardServer()?.listen()
}
