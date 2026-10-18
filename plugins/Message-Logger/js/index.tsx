import { Design } from '@revenge-mod/discord/design'
import { onFluxEventDispatched, Stores } from '@revenge-mod/discord/flux'
import { Clipboard } from '@revenge-mod/externals/react-native-clipboard'
import { getModules } from '@revenge-mod/modules/finders'
import { createFilterGenerator } from '@revenge-mod/modules/finders/filters'
import { callNativeMethod } from '@revenge-mod/modules/native'
import { after } from '@revenge-mod/patcher'
import { useEffect, useState } from 'react'
import { Alert, Image, Linking, ScrollView, Share } from 'react-native'
import type { JsonStorage } from '@revenge-mod/json-storage'

// ---------------------------------------------------------------------------
// Native bridge typings (the Kotlin side of this plugin registers these)
// ---------------------------------------------------------------------------

declare module '@revenge-mod/modules/native' {
	export interface NativeMethods {
		'evantanner.message-logger.save': [
			[messageId: string, filesJson: string, bucket: string],
			string,
		]
		'evantanner.message-logger.keep': [[messageId: string], string]
		'evantanner.message-logger.listKept': [[], string]
		'evantanner.message-logger.stats': [[], string]
		'evantanner.message-logger.deleteKept': [[messageId: string], string]
		'evantanner.message-logger.deleteAllKept': [[], string]
		'evantanner.message-logger.purgePending': [[hours: string], string]
		'evantanner.message-logger.setKeptLimit': [[bytes: string], string]
		'evantanner.message-logger.exportToDownloads': [
			[fileName: string, mime: string, content: string],
			string,
		]
	}
}

// ---------------------------------------------------------------------------
// Settings + log storage
// ---------------------------------------------------------------------------

type ExportFormat = 'text' | 'json'

interface Settings {
	enabled: boolean
	/** Also keep messages you deleted yourself. */
	logOwn: boolean
	/** Show "(deleted)" after the message, where the "(edited)" label normally goes. */
	showLabel: boolean
	/** Save attachment links with each logged message. */
	logAttachments: boolean
	/** Show image previews for saved attachments in the log. */
	showPreviews: boolean
	/** Alert when someone pings you and then deletes the message. */
	ghostPing: boolean
	/** Also alert when the ping is edited out of a message. */
	ghostEdits: boolean
	/** Count @everyone and @here as pings. */
	ghostEveryone: boolean
	/** Count pings of roles you have. */
	ghostRoles: boolean
	/** JSON array of GhostEntry, newest first. */
	ghostLog: string
	/** Show what a message said before it was edited, above the new text. */
	showEdits: boolean
	/** Also track your own edits. */
	editsOwn: boolean
	/** JSON array of EditRecord, newest first. */
	editLog: string
	/** Download deleted messages' attachment files to this device (needs the native part). */
	saveFilesToDevice: boolean
	/** Also copy attachments as new messages arrive, so they survive link expiry. */
	preSaveFiles: boolean
	/** Format used by the Copy and Share buttons. */
	exportFormat: ExportFormat
	maxLogged: number
	/** Never log messages from bots. */
	ignoreBots: boolean
	/** JSON IgnoreList: servers, channels and people that are never logged. */
	ignored: string
	/** Most megabytes of saved files to keep on the device. 0 = no limit. */
	maxKeptMB: number
	/** JSON array of Entry, newest first. Stored as a string so clearing it is safe. */
	entries: string
}

interface FileInfo {
	name: string
	/** Original attachment link. */
	url: string
	/** Media-proxy link, usually the one that still loads images. */
	proxyUrl?: string
	type?: string
	size?: number
}

interface Entry {
	id: string
	author: string
	where: string
	content: string
	/** Number of attachments (older entries only have this). */
	attachments: number
	/** Saved attachment details, when "Save attachments" was on. */
	files?: FileInfo[]
	/** Where it was and who sent it, so the log can offer "Ignore" buttons. Older entries lack these. */
	guildId?: string
	channelId?: string
	authorId?: string
	deletedAt: number
}

const DEFAULTS: Settings = {
	enabled: true,
	logOwn: false,
	showLabel: true,
	logAttachments: true,
	showPreviews: true,
	ghostPing: true,
	ghostEdits: true,
	ghostEveryone: false,
	ghostRoles: false,
	ghostLog: '[]',
	showEdits: true,
	editsOwn: false,
	editLog: '[]',
	saveFilesToDevice: true,
	preSaveFiles: false,
	exportFormat: 'text',
	maxLogged: 200,
	ignoreBots: false,
	ignored: '{"guilds":[],"channels":[],"users":[]}',
	maxKeptMB: 500,
	entries: '[]',
}

function parseEntries(raw: string): Entry[] {
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

// ---------------------------------------------------------------------------
// Ignore list: servers, channels and people that are never logged
// ---------------------------------------------------------------------------

interface IgnoreList {
	guilds: string[]
	channels: string[]
	users: string[]
}

let ignoreCache: { raw: string; value: IgnoreList } | undefined

function parseIgnore(raw: string): IgnoreList {
	if (ignoreCache?.raw === raw) return ignoreCache.value
	const ids = (v: unknown) =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
	let value: IgnoreList = { guilds: [], channels: [], users: [] }
	try {
		const parsed = JSON.parse(raw)
		value = {
			guilds: ids(parsed?.guilds),
			channels: ids(parsed?.channels),
			users: ids(parsed?.users),
		}
	} catch {}
	ignoreCache = { raw, value }
	return value
}

/** True when a message must not be logged: its server, channel or author is ignored, or it is a bot. */
function isIgnored(
	s: Settings,
	message: any,
	channelId?: string,
	guildId?: string,
): boolean {
	const list = parseIgnore(s.ignored)
	if (guildId && list.guilds.includes(guildId)) return true
	if (channelId && list.channels.includes(channelId)) return true
	const author = message?.author
	if (author?.id && list.users.includes(author.id)) return true
	return !!(s.ignoreBots && author?.bot)
}

/** Servers you are in whose name contains the text. */
function searchGuilds(query: string): { id: string; name: string }[] {
	const q = query.trim().toLowerCase()
	if (!q) return []
	try {
		const guilds: Record<string, any> =
			(Stores as any).GuildStore?.getGuilds?.() ?? {}
		return Object.values(guilds)
			.filter(g =>
				String(g?.name ?? '')
					.toLowerCase()
					.includes(q),
			)
			.map(g => ({ id: String(g.id), name: String(g.name) }))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, 10)
	} catch {
		return []
	}
}

/** A readable name for an ignored id, falling back to the id itself. */
function nameOfIgnored(kind: keyof IgnoreList, id: string): string {
	try {
		const st = Stores as any
		if (kind === 'guilds') return st.GuildStore?.getGuild?.(id)?.name ?? id
		if (kind === 'channels') {
			const channel = st.ChannelStore?.getChannel?.(id)
			return channel?.name ? `#${channel.name}` : id
		}
		const user = st.UserStore?.getUser?.(id)
		return user?.globalName ?? user?.username ?? id
	} catch {
		return id
	}
}

const IGNORE_KIND_LABEL = {
	guilds: 'Server',
	channels: 'Channel',
	users: 'User',
} as const

/** Choices for how much saved-file storage to use. */
const KEPT_LIMITS = [
	{ label: '100 MB', mb: 100 },
	{ label: '250 MB', mb: 250 },
	{ label: '500 MB', mb: 500 },
	{ label: '1 GB', mb: 1024 },
	{ label: 'No limit', mb: 0 },
]

// Discord stores colors as signed 32-bit ARGB ints.
const RED = 0xff000000 | 0xed4245 | 0

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type PluginLogger = { log(...a: unknown[]): void }
let logger: PluginLogger | undefined

function log(...args: unknown[]) {
	console.log('[message-logger]', ...args)
	try {
		logger?.log(args.map(String).join(' '))
	} catch {}
}

// ---------------------------------------------------------------------------
// Native helpers. Every call is optional: if the native part isn't loaded,
// calls fail quietly and the plugin keeps working with links only.
// ---------------------------------------------------------------------------

const PENDING_HOURS = 24 // pre-saved copies older than this are purged

let warnedNative = false
async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
	try {
		return await fn()
	} catch (e) {
		if (!warnedNative) {
			warnedNative = true
			log('Native call failed (is the native part installed?):', String(e))
		}
		return undefined
	}
}

const filesPayload = (files: FileInfo[]) =>
	JSON.stringify(
		files.map(f => ({ name: f.name, url: f.url, fallback: f.proxyUrl ?? '' })),
	)

const nativeSave = (
	id: string,
	files: FileInfo[],
	bucket: 'kept' | 'pending',
) =>
	callNativeMethod('evantanner.message-logger.save', [
		id,
		filesPayload(files),
		bucket,
	])
const nativeKeep = (id: string) =>
	callNativeMethod('evantanner.message-logger.keep', [id])
const nativeListKept = () =>
	callNativeMethod('evantanner.message-logger.listKept', [])
const nativeStats = () =>
	callNativeMethod('evantanner.message-logger.stats', [])
const nativeDeleteAll = () =>
	callNativeMethod('evantanner.message-logger.deleteAllKept', [])
const nativePurge = () =>
	callNativeMethod('evantanner.message-logger.purgePending', [
		String(PENDING_HOURS),
	])
const nativeSetLimit = (mb: number) =>
	callNativeMethod('evantanner.message-logger.setKeptLimit', [
		String(Math.max(0, Math.round(mb * 1024 * 1024))),
	])
const nativeExport = (name: string, mime: string, content: string) =>
	callNativeMethod('evantanner.message-logger.exportToDownloads', [
		name,
		mime,
		content,
	])

/** Copies a deleted message's files to the device: moves pre-saved copies if there are any, else downloads now. */
async function keepFilesOnDevice(
	id: string,
	files: FileInfo[],
	usedPreSave: boolean,
) {
	let result: string | undefined
	if (usedPreSave) result = await safe(() => nativeKeep(id))
	if (result !== 'kept')
		result = await safe(() => nativeSave(id, files, 'kept'))
	log('Files for', id, '->', result ?? 'native part unavailable')
}

/** Local path of the n-th attachment, given the native listing for its message. */
const localPathFor = (paths: string[] | undefined, index: number) =>
	paths?.find(p => (p.split('/').pop() ?? '').startsWith(`${index}-`))

// ---------------------------------------------------------------------------
// Deleted-message tracking
// ---------------------------------------------------------------------------

/** Ids of messages that were deleted while we could still see them. */
const deletedIds = new Set<string>()

function describeWhere(channelId: string, guildId?: string): string {
	try {
		const st = Stores as any
		const channel = st.ChannelStore?.getChannel?.(channelId)
		const guild = guildId ? st.GuildStore?.getGuild?.(guildId) : null
		const name = channel?.name ? `#${channel.name}` : 'DM'
		return guild?.name ? `${guild.name} · ${name}` : name
	} catch {
		return channelId
	}
}

function getCachedMessage(channelId: string, id: string): any {
	try {
		return (Stores as any).MessageStore?.getMessage?.(channelId, id)
	} catch {
		return undefined
	}
}

function isOwn(message: any): boolean {
	try {
		const me = (Stores as any).UserStore?.getCurrentUser?.()?.id
		return !!me && message?.author?.id === me
	} catch {
		return false
	}
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i

const isImage = (f: FileInfo) =>
	!!f.type?.startsWith('image/') || IMAGE_NAME.test(f.name)

/** Reads attachment details off a message. Field names differ between Discord versions. */
function collectFiles(message: any): FileInfo[] {
	const list = message?.attachments
	if (!Array.isArray(list)) return []

	return list
		.slice(0, 10)
		.map((a: any): FileInfo => {
			const size = a.size
			return {
				name: String(a.filename ?? a.name ?? 'file'),
				url: String(a.url ?? a.proxy_url ?? a.proxyURL ?? a.proxyUrl ?? ''),
				proxyUrl:
					(a.proxy_url ?? a.proxyURL ?? a.proxyUrl)
						? String(a.proxy_url ?? a.proxyURL ?? a.proxyUrl)
						: undefined,
				type: a.content_type ?? a.contentType ?? undefined,
				size: typeof size === 'number' ? size : undefined,
			}
		})
		.filter(f => f.url)
}

function makeEntry(
	message: any,
	channelId: string,
	guildId: string | undefined,
	saveFiles: boolean,
): Entry {
	const author =
		message.author?.globalName ??
		message.author?.username ??
		(Stores as any).UserStore?.getUser?.(message.author?.id)?.username ??
		'Unknown'

	const files = saveFiles ? collectFiles(message) : []

	// Warm the image cache now, while the links still work.
	for (const f of files) {
		if (isImage(f)) Image.prefetch(f.proxyUrl ?? f.url).catch(() => {})
	}

	return {
		id: message.id,
		author,
		where: describeWhere(channelId, guildId),
		content: String(message.content ?? '').slice(0, 1000),
		attachments: message.attachments?.length ?? 0,
		files: files.length ? files : undefined,
		guildId,
		channelId,
		authorId: message.author?.id,
		deletedAt: Date.now(),
	}
}

// ---------------------------------------------------------------------------
// Ghost-ping alerts
// ---------------------------------------------------------------------------

interface GhostEntry {
	id: string
	author: string
	where: string
	content: string
	/** What they pinged, for example "pinged you". */
	kind: string
	how: 'deleted' | 'edited'
	at: number
	/** Where it happened, so other plugins can filter by server. */
	guildId?: string
	channelId?: string
}

interface TrackedPing {
	id: string
	channelId: string
	guildId?: string
	author: string
	content: string
	kind: string
}

const MAX_TRACKED = 300

/** Pings aimed at you, remembered from the moment they arrive (works even in channels you haven't opened). */
const trackedPings = new Map<string, TrackedPing>()
const alertedIds = new Set<string>()
const alertQueue: GhostEntry[] = []
let alertOpen = false

// Set in start() so these helpers can see the current settings and save the log.
let readSettings: () => Settings = () => DEFAULTS
let ghostSink: ((entry: GhostEntry) => void) | undefined

/** Plugins that depend on this one and want to hear about ghost pings (see `decorate` in start). */
const ghostListeners = new Set<(entry: GhostEntry) => void>()

function parseGhost(raw: string): GhostEntry[] {
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

const currentUserId = (): string | undefined =>
	(Stores as any).UserStore?.getCurrentUser?.()?.id

const authorOf = (message: any): string =>
	message?.author?.globalName ??
	message?.author?.global_name ??
	message?.author?.username ??
	'Unknown'

/** The kind of ping a message contains for you, or null. Works on cached messages and raw gateway payloads. */
function pingKind(m: any, guildId?: string): string | null {
	const me = currentUserId()
	if (!me || !m) return null
	const s = readSettings()

	const mentions: any[] = m.mentions ?? []
	if (mentions.some(x => (typeof x === 'string' ? x : x?.id) === me))
		return 'pinged you'

	if (s.ghostEveryone && (m.mentionEveryone ?? m.mention_everyone)) {
		return 'pinged @everyone or @here'
	}

	if (s.ghostRoles && guildId) {
		const roleIds: string[] = m.mentionRoles ?? m.mention_roles ?? []
		if (roleIds.length) {
			const mine: string[] =
				(Stores as any).GuildMemberStore?.getMember?.(guildId, me)?.roles ?? []
			if (roleIds.some(r => mine.includes(r))) return 'pinged one of your roles'
		}
	}
	return null
}

/** Remembers a new message if it pings you. */
function trackPing(message: any, guildId?: string) {
	if (!message?.id || isOwn(message)) return
	const kind = pingKind(message, guildId)
	if (!kind) return

	trackedPings.set(message.id, {
		id: message.id,
		channelId: message.channel_id ?? message.channelId,
		guildId,
		author: authorOf(message),
		content: String(message.content ?? '').slice(0, 300),
		kind,
	})
	if (trackedPings.size > MAX_TRACKED) {
		trackedPings.delete(trackedPings.keys().next().value as string)
	}
}

function showNextAlert() {
	if (alertOpen) return
	const entry = alertQueue.shift()
	if (!entry) return

	alertOpen = true
	let closed = false
	const close = () => {
		if (closed) return
		closed = true
		alertOpen = false
		setTimeout(showNextAlert, 300)
	}

	Alert.alert(
		'Ghost ping',
		`${entry.author} ${entry.kind} in ${entry.where} and then ${
			entry.how === 'deleted' ? 'deleted the message' : 'edited the ping out'
		}.\n\n${entry.content || '(no text)'}`,
		[{ text: 'Okay', onPress: close }],
		{ cancelable: true, onDismiss: close },
	)
}

/** Call when a message was deleted or edited. Alerts only if it had pinged you. */
function reportGhost(
	id: string,
	how: GhostEntry['how'],
	channelId: string,
	guildId: string | undefined,
	cached: any,
) {
	if (!readSettings().ghostPing || alertedIds.has(id)) return

	let tracked = trackedPings.get(id)
	if (!tracked && cached && !isOwn(cached)) {
		const kind = pingKind(cached, guildId)
		if (kind) {
			tracked = {
				id,
				channelId,
				guildId,
				author: authorOf(cached),
				content: String(cached.content ?? '').slice(0, 300),
				kind,
			}
		}
	}
	if (!tracked) return

	if (alertedIds.size > 500) alertedIds.clear()
	alertedIds.add(id)
	trackedPings.delete(id)

	const entry: GhostEntry = {
		id,
		author: tracked.author,
		where: describeWhere(
			tracked.channelId ?? channelId,
			tracked.guildId ?? guildId,
		),
		content: tracked.content,
		kind: tracked.kind,
		how,
		at: Date.now(),
		guildId: tracked.guildId ?? guildId,
		channelId: tracked.channelId ?? channelId,
	}
	log('Ghost ping from', entry.author, `(${how})`)
	ghostSink?.(entry)
	for (const listener of [...ghostListeners]) {
		try {
			listener(entry)
		} catch (e) {
			log('A ghost ping listener failed:', String(e))
		}
	}
	alertQueue.push(entry)
	showNextAlert()
}

// ---------------------------------------------------------------------------
// Edit history
// ---------------------------------------------------------------------------

interface EditRecord {
	id: string
	channelId: string
	guildId?: string
	author: string
	where: string
	/** Earlier versions of the text, oldest first. */
	history: string[]
	/** What the message really says now (the chat may show more than this). */
	current: string
	/** When it was last edited. */
	at: number
}

const MAX_EDIT_RECORDS = 300
const MAX_VERSIONS_KEPT = 10
const MAX_VERSIONS_SHOWN = 3
const MAX_VERSION_CHARS = 500

/** Edited messages by id. The newest edit is last. Loaded from storage when the plugin starts. */
const edits = new Map<string, EditRecord>()
let resetEdits: (() => void) | undefined

function parseEdits(raw: string): EditRecord[] {
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

/** What the chat shows: earlier versions as struck-through quotes, then the real text. */
function withHistory(record: Pick<EditRecord, 'history' | 'current'>): string {
	const before = record.history.slice(-MAX_VERSIONS_SHOWN).map(version => {
		const text =
			version.length > MAX_VERSION_CHARS
				? `${version.slice(0, MAX_VERSION_CHARS)}…`
				: version
		const lines = text.split('\n').filter(line => line.trim())
		if (!lines.length) return '> ~~(no text)~~'

		// Strikethrough breaks code blocks, so those are only quoted.
		const strike = !text.includes('```')
		return lines
			.map(line =>
				strike ? `> ~~${line.split('~~').join('')}~~` : `> ${line}`,
			)
			.join('\n')
	})

	return record.current
		? `${before.join('\n\n')}\n${record.current}`
		: before.join('\n\n')
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function formatSize(bytes?: number) {
	if (!bytes) return ''
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function toText(entries: Entry[]) {
	return entries
		.map(e => {
			const lines = [
				`[${new Date(e.deletedAt).toLocaleString()}] ${e.author} · ${e.where}`,
				e.content || '(no text)',
			]

			if (e.files?.length) {
				lines.push(
					'Attachments:',
					...e.files.map(
						f =>
							`  - ${f.name}${f.size ? ` (${formatSize(f.size)})` : ''}: ${f.url}`,
					),
				)
			} else if (e.attachments) {
				lines.push(`Attachments: ${e.attachments} (links not saved)`)
			}

			return lines.join('\n')
		})
		.join('\n\n---\n\n')
}

function toJson(entries: Entry[]) {
	return JSON.stringify(
		{
			exportedAt: new Date().toISOString(),
			count: entries.length,
			entries: entries.map(e => ({
				...e,
				deletedAt: new Date(e.deletedAt).toISOString(),
			})),
		},
		null,
		2,
	)
}

const build = (entries: Entry[], format: ExportFormat) =>
	format === 'json' ? toJson(entries) : toText(entries)

// Android's share sheet fails on very large text, so stay well under its limit.
const SHARE_LIMIT = 300_000

// ---------------------------------------------------------------------------
// Attachment preview (settings screen)
// ---------------------------------------------------------------------------

function AttachmentView({
	file,
	preview,
	localPath,
}: {
	file: FileInfo
	preview: boolean
	localPath?: string
}) {
	const { Button, Stack, Text } = Design
	const [failed, setFailed] = useState(false)
	const showImage = preview && isImage(file) && !failed

	return (
		<Stack spacing={4}>
			{showImage ? (
				<Image
					source={{
						uri: localPath
							? `file://${localPath}`
							: (file.proxyUrl ?? file.url),
					}}
					style={{ width: '100%', height: 180, borderRadius: 8 }}
					resizeMode="contain"
					onError={() => setFailed(true)}
				/>
			) : null}
			<Text variant="text-sm/medium" selectable>
				{file.name}
				{file.size ? ` · ${formatSize(file.size)}` : ''}
				{localPath ? ' · saved on this device' : ''}
				{failed ? ' · preview unavailable (the link may have expired)' : ''}
			</Text>
			<Button
				variant="secondary"
				size="sm"
				text="Open link"
				onPress={() => {
					Linking.openURL(file.url).catch(() => {})
				}}
			/>
		</Stack>
	)
}

// ---------------------------------------------------------------------------
// Chat row manager
// ---------------------------------------------------------------------------

// Finds Discord's Flux dispatcher, so we can ask the chat to redraw a message.
const withDispatcher = createFilterGenerator<[]>(
	(_args, _id, exports) => {
		const t = typeof exports
		if (!exports || (t !== 'object' && t !== 'function')) return false
		const d = typeof exports.dispatch === 'function' ? exports : exports.default
		return (
			!!d &&
			typeof d.dispatch === 'function' &&
			typeof d.subscribe === 'function' &&
			typeof d.unsubscribe === 'function' &&
			typeof d.wait === 'function'
		)
	},
	() => 'message-logger.dispatcher',
)

// Finds Discord's chat row manager: a class whose prototype has `generate`.
const withGenerate = createFilterGenerator<[]>(
	(_args, _id, exports) => {
		const t = typeof exports
		if (!exports || (t !== 'object' && t !== 'function')) return false
		return (
			typeof exports.prototype?.generate === 'function' ||
			typeof exports.default?.prototype?.generate === 'function'
		)
	},
	() => 'message-logger.generate',
)

export default plugin({
	jsonStorage: { load: true, default: DEFAULTS },

	SettingsComponent({ api }) {
		const {
			Button,
			Card,
			Stack,
			Text,
			TextInput,
			TableRow,
			TableRowGroup,
			TableSwitchRow,
		} = Design
		const storage = api.jsonStorage as unknown as JsonStorage<Settings>
		const s: Settings = { ...DEFAULTS, ...(storage.use() ?? {}) }
		const entries = parseEntries(s.entries)
		const ghosts = parseGhost(s.ghostLog)
		const editRecords = parseEdits(s.editLog)
		const [maxText, setMaxText] = useState(String(s.maxLogged))

		const [serverQuery, setServerQuery] = useState('')
		const serverResults = searchGuilds(serverQuery)
		const ignore = parseIgnore(s.ignored)
		const ignoreCount =
			ignore.guilds.length + ignore.channels.length + ignore.users.length
		const addIgnore = (kind: keyof IgnoreList, id: string) => {
			if (ignore[kind].includes(id)) return
			storage.set({
				ignored: JSON.stringify({ ...ignore, [kind]: [...ignore[kind], id] }),
			})
		}
		const removeIgnore = (kind: keyof IgnoreList, id: string) =>
			storage.set({
				ignored: JSON.stringify({
					...ignore,
					[kind]: ignore[kind].filter(x => x !== id),
				}),
			})
		const setLimit = (mb: number) => {
			storage.set({ maxKeptMB: mb })
			void safe(() => nativeSetLimit(mb))
		}

		// What the native part has saved on this device. undefined = not loaded yet or unavailable.
		const [kept, setKept] = useState<Record<string, string[]> | undefined>()
		const [usage, setUsage] = useState<
			{ kept: number; pending: number } | undefined
		>()
		const [nativeChecked, setNativeChecked] = useState(false)

		useEffect(() => {
			let alive = true
			;(async () => {
				const [list, stats] = await Promise.all([
					safe(nativeListKept),
					safe(nativeStats),
				])
				if (!alive) return
				try {
					setKept(list ? JSON.parse(list) : undefined)
					setUsage(stats ? JSON.parse(stats) : undefined)
				} catch {}
				setNativeChecked(true)
			})()
			return () => {
				alive = false
			}
		}, [s.entries])

		const nativeOk = nativeChecked && usage !== undefined

		const confirmClear = () =>
			Alert.alert(
				'Clear the log?',
				`This removes all ${entries.length} saved messages${nativeOk ? ' and their saved files' : ''}.`,
				[
					{ text: 'Cancel', style: 'cancel' },
					{
						text: 'Clear',
						style: 'destructive',
						onPress: () => {
							storage.set({ entries: '[]' })
							if (nativeOk) void safe(nativeDeleteAll).then(() => setKept({}))
							log('Log cleared')
						},
					},
				],
			)

		const saveToDownloads = async () => {
			const ext = s.exportFormat === 'json' ? 'json' : 'txt'
			const mime = ext === 'json' ? 'application/json' : 'text/plain'
			const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
			const result = await safe(() =>
				nativeExport(
					`message-logger-${stamp}.${ext}`,
					mime,
					build(entries, s.exportFormat),
				),
			)
			if (!result || result.startsWith('error')) {
				Alert.alert(
					"Couldn't save",
					result ?? 'The native part of this plugin is not loaded.',
				)
			} else {
				Alert.alert('Saved', `The export is in ${result}`)
			}
		}

		const copyLog = () => {
			try {
				Clipboard.setString(build(entries, s.exportFormat))
				Alert.alert(
					'Copied',
					`${entries.length} message(s) copied as ${s.exportFormat}.`,
				)
			} catch (e) {
				Alert.alert("Couldn't copy", String(e))
			}
		}

		const shareLog = async () => {
			try {
				let subset = entries
				let text = build(subset, s.exportFormat)

				// Newest entries come first, so trimming keeps the most recent ones.
				while (text.length > SHARE_LIMIT && subset.length > 1) {
					subset = subset.slice(0, Math.max(1, Math.floor(subset.length / 2)))
					text = build(subset, s.exportFormat)
				}

				if (subset.length < entries.length) {
					Alert.alert(
						'Log is large',
						`Sharing the newest ${subset.length} of ${entries.length} messages. Use Copy to export everything.`,
					)
				}

				await Share.share({ title: 'Message Logger export', message: text })
			} catch (e) {
				Alert.alert("Couldn't share", String(e))
			}
		}

		return (
			<ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
				<TableRowGroup title="Message Logger">
					<TableSwitchRow
						label="Keep deleted messages"
						subLabel="They stay in chat and turn red"
						value={s.enabled}
						onValueChange={(v: boolean) => storage.set({ enabled: v })}
					/>
					<TableSwitchRow
						label="Include my own deleted messages"
						value={s.logOwn}
						onValueChange={(v: boolean) => storage.set({ logOwn: v })}
					/>
					<TableSwitchRow
						label='Show "(deleted)" label'
						value={s.showLabel}
						onValueChange={(v: boolean) => storage.set({ showLabel: v })}
					/>
					<TextInput
						label="Max saved messages (10 to 1000)"
						size="md"
						value={maxText}
						onChange={(v: string) => {
							setMaxText(v)
							const n = Number.parseInt(v, 10)
							if (n >= 10 && n <= 1000) storage.set({ maxLogged: n })
						}}
					/>
				</TableRowGroup>

				<TableRowGroup title="Edits">
					<TableSwitchRow
						label="Show edit history in chat"
						subLabel="Puts what a message said before above the new text, struck through"
						value={s.showEdits}
						onValueChange={(v: boolean) => storage.set({ showEdits: v })}
					/>
					<TableSwitchRow
						label="Include my own edits"
						value={s.editsOwn}
						onValueChange={(v: boolean) => storage.set({ editsOwn: v })}
					/>
				</TableRowGroup>

				<TableRowGroup title="Ignore list">
					<TableSwitchRow
						label="Ignore bots"
						subLabel="Never log messages from bots"
						value={s.ignoreBots}
						onValueChange={(v: boolean) => storage.set({ ignoreBots: v })}
					/>
					<TextInput
						label="Find a server to ignore"
						size="md"
						placeholder="Server name"
						value={serverQuery}
						onChange={(v: string) => setServerQuery(v)}
					/>
				</TableRowGroup>

				{serverQuery.trim() && !serverResults.length ? (
					<Text variant="text-sm/medium">No server with that name.</Text>
				) : null}

				{serverResults.length ? (
					<TableRowGroup title="Matching servers">
						{serverResults.map(g => (
							<TableRow
								key={g.id}
								label={g.name}
								subLabel={
									ignore.guilds.includes(g.id)
										? 'Already ignored'
										: 'Tap to ignore'
								}
								onPress={() => addIgnore('guilds', g.id)}
							/>
						))}
					</TableRowGroup>
				) : null}

				{ignoreCount ? (
					<TableRowGroup title={`Ignored (${ignoreCount}), tap to remove`}>
						{(['guilds', 'channels', 'users'] as const).flatMap(kind =>
							ignore[kind].map(id => (
								<TableRow
									key={`${kind}-${id}`}
									label={nameOfIgnored(kind, id)}
									subLabel={`${IGNORE_KIND_LABEL[kind]} · ${id}`}
									onPress={() => removeIgnore(kind, id)}
								/>
							)),
						)}
					</TableRowGroup>
				) : (
					<Text variant="text-sm/medium">
						Ignored servers, channels and people aren't logged, and their
						deleted messages disappear as normal. Ghost-ping alerts still work
						there. Add them here, or from a saved message below.
					</Text>
				)}

				<TableRowGroup title="Ghost pings">
					<TableSwitchRow
						label="Alert on ghost pings"
						subLabel="Warns you when someone pings you, then deletes the message"
						value={s.ghostPing}
						onValueChange={(v: boolean) => storage.set({ ghostPing: v })}
					/>
					<TableSwitchRow
						label="Also alert when the ping is edited out"
						value={s.ghostEdits}
						onValueChange={(v: boolean) => storage.set({ ghostEdits: v })}
					/>
					<TableSwitchRow
						label="Include @everyone and @here"
						value={s.ghostEveryone}
						onValueChange={(v: boolean) => storage.set({ ghostEveryone: v })}
					/>
					<TableSwitchRow
						label="Include role pings"
						subLabel="Only roles you have"
						value={s.ghostRoles}
						onValueChange={(v: boolean) => storage.set({ ghostRoles: v })}
					/>
				</TableRowGroup>

				<Stack spacing={8}>
					<Text variant="text-md/semibold">Ghost pings ({ghosts.length})</Text>
					{ghosts.length ? (
						<Button
							variant="secondary"
							text="Clear ghost pings"
							onPress={() => storage.set({ ghostLog: '[]' })}
						/>
					) : (
						<Text variant="text-sm/medium">
							None yet. They show up here after an alert.
						</Text>
					)}
				</Stack>

				{ghosts.slice(0, 30).map(g => (
					<Card key={`${g.id}-${g.at}`}>
						<Stack spacing={4}>
							<Text variant="text-md/semibold">
								{g.author} {g.kind}
							</Text>
							<Text variant="text-sm/medium">
								{g.where} · {new Date(g.at).toLocaleString()} ·{' '}
								{g.how === 'deleted' ? 'deleted' : 'edited out'}
							</Text>
							<Text variant="text-md/medium" selectable>
								{g.content || '(no text)'}
							</Text>
						</Stack>
					</Card>
				))}

				<Stack spacing={8}>
					<Text variant="text-md/semibold">
						Edited messages ({editRecords.length})
					</Text>
					{editRecords.length ? (
						<Button
							variant="secondary"
							text="Clear edit history"
							onPress={() => {
								resetEdits?.()
								storage.set({ editLog: '[]' })
							}}
						/>
					) : (
						<Text variant="text-sm/medium">
							None yet. Messages show up here after someone edits one you can
							see.
						</Text>
					)}
				</Stack>

				{editRecords.slice(0, 30).map(r => (
					<Card key={r.id}>
						<Stack spacing={4}>
							<Text variant="text-md/semibold">{r.author}</Text>
							<Text variant="text-sm/medium">
								{r.where} · edited {r.history.length} time(s) ·{' '}
								{new Date(r.at).toLocaleString()}
							</Text>
							{r.history.map((version, i) => (
								<Text key={`${r.id}-${i}`} variant="text-sm/medium" selectable>
									{`Before: ${version || '(no text)'}`}
								</Text>
							))}
							<Text variant="text-md/medium" selectable>
								{`Now: ${r.current || '(no text)'}`}
							</Text>
						</Stack>
					</Card>
				))}

				<TableRowGroup title="Attachments">
					<TableSwitchRow
						label="Save attachments"
						subLabel="Keeps links to deleted files in the log. Applies to new deletions."
						value={s.logAttachments}
						onValueChange={(v: boolean) => storage.set({ logAttachments: v })}
					/>
					<TableSwitchRow
						label="Show image previews"
						subLabel="Loads saved images in the log below"
						value={s.showPreviews}
						onValueChange={(v: boolean) => storage.set({ showPreviews: v })}
					/>
					<TableSwitchRow
						label="Save files on this device"
						subLabel="Downloads deleted attachments so they still open after the links expire"
						value={s.saveFilesToDevice}
						onValueChange={(v: boolean) =>
							storage.set({ saveFilesToDevice: v })
						}
					/>
					<TableSwitchRow
						label="Pre-save new attachments"
						subLabel="Copies files as messages arrive, so even fast deletions are caught. Uses data and storage; copies older than 24 hours are removed."
						value={s.preSaveFiles}
						onValueChange={(v: boolean) => storage.set({ preSaveFiles: v })}
					/>
				</TableRowGroup>

				<TableRowGroup title="Saved file limit">
					{KEPT_LIMITS.map(l => (
						<TableRow
							key={l.mb}
							label={`${s.maxKeptMB === l.mb ? '✓  ' : '     '}${l.label}`}
							onPress={() => setLimit(l.mb)}
						/>
					))}
				</TableRowGroup>
				<Text variant="text-sm/medium">
					When saved files go over the limit, the oldest ones are removed. The
					log keeps their links.
				</Text>

				<Text variant="text-sm/medium">
					{nativeOk
						? `Saved files: ${formatSize(usage?.kept) || '0 B'} kept, ${formatSize(usage?.pending) || '0 B'} waiting`
						: nativeChecked
							? 'The native part of this plugin is not loaded, so files are not saved on the device (links are still logged).'
							: 'Checking the native part…'}
				</Text>

				<Stack spacing={8}>
					<Text variant="text-md/semibold">Export</Text>
					<Stack spacing={8} direction="horizontal">
						<Button
							size="sm"
							text="Text"
							variant={s.exportFormat === 'text' ? 'primary' : 'secondary'}
							onPress={() => storage.set({ exportFormat: 'text' })}
						/>
						<Button
							size="sm"
							text="JSON"
							variant={s.exportFormat === 'json' ? 'primary' : 'secondary'}
							onPress={() => storage.set({ exportFormat: 'json' })}
						/>
					</Stack>
					<Stack spacing={8} direction="horizontal">
						<Button
							size="sm"
							variant="secondary"
							text="Copy"
							disabled={!entries.length}
							onPress={copyLog}
						/>
						<Button
							size="sm"
							variant="secondary"
							text="Share"
							disabled={!entries.length}
							onPress={shareLog}
						/>
						<Button
							size="sm"
							variant="secondary"
							text="Save to Downloads"
							disabled={!entries.length || !nativeOk}
							onPress={saveToDownloads}
						/>
					</Stack>
					<Text variant="text-sm/medium">
						Exports are plain text. Files in your Downloads folder can be read
						by other apps.
					</Text>
				</Stack>

				<Stack spacing={8}>
					<Text variant="text-md/semibold">
						Saved messages ({entries.length})
					</Text>
					{entries.length ? (
						<Button
							variant="secondary"
							text="Clear log"
							onPress={confirmClear}
						/>
					) : (
						<Text variant="text-sm/medium">
							Nothing yet. Deleted messages show up here once someone deletes
							one you can see.
						</Text>
					)}
				</Stack>

				{entries.slice(0, 50).map(e => (
					<Card key={`${e.id}-${e.deletedAt}`}>
						<Stack spacing={6}>
							<Text variant="text-md/semibold">{e.author}</Text>
							<Text variant="text-sm/medium">
								{e.where} · {new Date(e.deletedAt).toLocaleString()}
							</Text>
							<Text variant="text-md/medium" selectable>
								{e.content || '(no text)'}
							</Text>
							{e.files?.length ? (
								e.files.map((f, i) => (
									<AttachmentView
										key={`${f.url}`}
										file={f}
										preview={s.showPreviews}
										localPath={localPathFor(kept?.[e.id], i)}
									/>
								))
							) : e.attachments ? (
								<Text variant="text-sm/medium">
									{e.attachments} attachment(s), links weren't saved
								</Text>
							) : null}
							<Stack spacing={8} direction="horizontal">
								{e.guildId && !ignore.guilds.includes(e.guildId) ? (
									<Button
										size="sm"
										variant="secondary"
										text="Ignore server"
										onPress={() => addIgnore('guilds', e.guildId as string)}
									/>
								) : null}
								{e.channelId && !ignore.channels.includes(e.channelId) ? (
									<Button
										size="sm"
										variant="secondary"
										text="Ignore channel"
										onPress={() => addIgnore('channels', e.channelId as string)}
									/>
								) : null}
								{e.authorId && !ignore.users.includes(e.authorId) ? (
									<Button
										size="sm"
										variant="secondary"
										text="Ignore user"
										onPress={() => addIgnore('users', e.authorId as string)}
									/>
								) : null}
							</Stack>
						</Stack>
					</Card>
				))}
			</ScrollView>
		)
	},

	start({ cleanup, decorate, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger

		// Library API: plugins that list this plugin in their manifest `dependencies` get
		// `api.messageLogger`. Done first, because dependents start right after this plugin.
		decorate(dependent => {
			;(dependent.api as any).messageLogger = {
				/** Calls `listener` for every ghost ping. Returns a function that stops listening. */
				onGhostPing(listener: (entry: GhostEntry) => void) {
					ghostListeners.add(listener)
					const stop = () => {
						ghostListeners.delete(listener)
					}
					dependent.api.cleanup(stop)
					return stop
				},
			}
		})
		log('Step 1: plugin starting')
		const storage = jsonStorage as JsonStorage<Settings>
		const getSettings = (): Settings => ({
			...DEFAULTS,
			...(storage.cache ?? {}),
		})

		readSettings = getSettings
		ghostSink = entry => {
			const next = [entry, ...parseGhost(getSettings().ghostLog)].slice(0, 100)
			storage.set({ ghostLog: JSON.stringify(next) })
		}
		cleanup(() => {
			ghostSink = undefined
			readSettings = () => DEFAULTS
			alertQueue.length = 0
			trackedPings.clear()
			ghostListeners.clear()
		})

		// One write for any number of entries, so a bulk delete doesn't rewrite the log per message.
		const saveMany = (batch: Entry[]) => {
			if (!batch.length) return
			const s = getSettings()
			const next = [...[...batch].reverse(), ...parseEntries(s.entries)].slice(
				0,
				s.maxLogged,
			)
			storage.set({ entries: JSON.stringify(next) })
		}
		const save = (entry: Entry) => saveMany([entry])

		// Discord's dispatcher, found below. Used to make the chat redraw kept messages right away.
		let dispatcher: any

		log('Step 1b: looking for the Flux dispatcher (instant redraw)')
		cleanup(
			getModules(withDispatcher(), (exports: any) => {
				dispatcher =
					typeof exports.dispatch === 'function' ? exports : exports.default
				log('Found the Flux dispatcher')
			}),
		)

		// Makes the chat redraw kept messages immediately. Attachment-only messages have no text
		// to color or label, so they get a short "(deleted attachment)" line.
		const refresh = (messages: any[], channelId: string, guildId?: string) => {
			setTimeout(() => {
				// Deferred: dispatching from inside a dispatch is not allowed.
				try {
					for (const m of messages) {
						const text = String(m.content ?? '')
						const attachmentOnly =
							!text.trim() && (m.attachments?.length ?? 0) > 0
						dispatcher?.dispatch({
							type: 'MESSAGE_UPDATE',
							guildId,
							message: {
								id: m.id,
								channel_id: channelId,
								guild_id: guildId,
								content:
									attachmentOnly && getSettings().showLabel
										? '(deleted attachment)'
										: text,
							},
						})
					}
				} catch (e) {
					log('Redraw through the dispatcher failed:', String(e))
				}

				// Fallback: nudge the stores the chat rows listen to.
				const st = Stores as any
				for (const name of ['MessageStore', 'UserStore', 'GuildMemberStore']) {
					try {
						st[name]?.emitChange?.()
					} catch {}
				}
			}, 0)
		}

		log('Step 2: intercepting MESSAGE_DELETE and MESSAGE_DELETE_BULK')
		cleanup(
			onFluxEventDispatched('MESSAGE_DELETE', (payload: any) => {
				try {
					const s = getSettings()
					const message = getCachedMessage(payload.channelId, payload.id)

					// Ghost-ping check comes first so it works even with the logger off.
					reportGhost(
						payload.id,
						'deleted',
						payload.channelId,
						payload.guildId,
						message,
					)

					if (!s.enabled) return payload
					if (deletedIds.has(payload.id)) return undefined // already kept

					if (!message) {
						log('Deleted message not cached, letting it through:', payload.id)
						return payload
					}
					if (isOwn(message) && !s.logOwn) return payload
					if (isIgnored(s, message, payload.channelId, payload.guildId))
						return payload

					const entry = makeEntry(
						message,
						payload.channelId,
						payload.guildId,
						s.logAttachments || s.saveFilesToDevice,
					)
					deletedIds.add(payload.id)
					save(entry)
					if (s.saveFilesToDevice && entry.files?.length) {
						void keepFilesOnDevice(entry.id, entry.files, s.preSaveFiles)
					}
					log('Kept deleted message', payload.id, 'from', entry.author)
					refresh([message], payload.channelId, payload.guildId)
					return undefined // block the delete so the message stays
				} catch (e) {
					log('MESSAGE_DELETE handler failed, letting it through:', String(e))
					return payload
				}
			}),

			onFluxEventDispatched('MESSAGE_DELETE_BULK', (payload: any) => {
				try {
					const s = getSettings()

					for (const id of payload.ids as string[]) {
						reportGhost(
							id,
							'deleted',
							payload.channelId,
							payload.guildId,
							getCachedMessage(payload.channelId, id),
						)
					}

					if (!s.enabled) return payload

					// Messages we keep stay in chat. Everything else is deleted as normal.
					const found = (payload.ids as string[])
						.map(id => getCachedMessage(payload.channelId, id))
						.filter(
							(m: any) =>
								m &&
								(s.logOwn || !isOwn(m)) &&
								!isIgnored(s, m, payload.channelId, payload.guildId),
						)
					if (!found.length) return payload

					const batch: Entry[] = []
					for (const message of found) {
						deletedIds.add(message.id)
						const entry = makeEntry(
							message,
							payload.channelId,
							payload.guildId,
							s.logAttachments || s.saveFilesToDevice,
						)
						batch.push(entry)
						if (s.saveFilesToDevice && entry.files?.length) {
							void keepFilesOnDevice(entry.id, entry.files, s.preSaveFiles)
						}
					}
					saveMany(batch)
					log(`Kept ${found.length} bulk-deleted message(s)`)
					refresh(found, payload.channelId, payload.guildId)

					const keptIds = new Set(found.map((m: any) => m.id))
					const rest = (payload.ids as string[]).filter(id => !keptIds.has(id))
					if (!rest.length) return undefined // block the whole event
					payload.ids = rest // the others are deleted as normal
					return payload
				} catch (e) {
					log(
						'MESSAGE_DELETE_BULK handler failed, letting it through:',
						String(e),
					)
					return payload
				}
			}),
		)

		log('Step 3: watching for pings aimed at you (ghost-ping alerts)')
		cleanup(
			onFluxEventDispatched('MESSAGE_CREATE', (payload: any) => {
				// Never block this event: always hand the payload back.
				try {
					if (getSettings().ghostPing && !payload?.optimistic) {
						trackPing(
							payload?.message,
							payload?.guildId ?? payload?.message?.guild_id,
						)
					}
				} catch (e) {
					log('Ping tracking failed:', String(e))
				}
				return payload
			}),

			onFluxEventDispatched('MESSAGE_UPDATE', (payload: any) => {
				try {
					const m = payload?.message
					const s = getSettings()
					// Only real edits that carry a full mention list count.
					if (
						s.ghostPing &&
						s.ghostEdits &&
						m?.id &&
						m.edited_timestamp &&
						Array.isArray(m.mentions)
					) {
						const channelId = m.channel_id ?? m.channelId
						const guildId = payload.guildId ?? m.guild_id
						if (!pingKind(m, guildId)) {
							reportGhost(
								m.id,
								'edited',
								channelId,
								guildId,
								getCachedMessage(channelId, m.id),
							)
						}
					}
				} catch (e) {
					log('MESSAGE_UPDATE handler failed:', String(e))
				}
				return payload
			}),
		)

		log('Step 3a: tracking edits (shows what a message said before)')
		// Stored newest first, kept in memory oldest first.
		for (const record of parseEdits(getSettings().editLog).reverse()) {
			edits.set(record.id, record)
		}

		// Edits arrive in bursts on busy servers, so the log is written at most once every 2 seconds.
		let editSaveTimer: ReturnType<typeof setTimeout> | undefined
		const writeEdits = () => {
			editSaveTimer = undefined
			storage.set({ editLog: JSON.stringify([...edits.values()].reverse()) })
		}
		const saveEdits = () => {
			while (edits.size > MAX_EDIT_RECORDS) {
				edits.delete(edits.keys().next().value as string)
			}
			editSaveTimer ??= setTimeout(writeEdits, 2000)
		}

		resetEdits = () => edits.clear()
		cleanup(() => {
			if (editSaveTimer) {
				clearTimeout(editSaveTimer)
				writeEdits()
			}
			resetEdits = undefined
			edits.clear()
		})

		cleanup(
			onFluxEventDispatched('MESSAGE_UPDATE', (payload: any) => {
				// Edits the text Discord is about to store. Never blocks the event.
				try {
					const s = getSettings()
					const m = payload?.message
					if (!s.showEdits || !m?.id || typeof m.content !== 'string')
						return payload

					const channelId = m.channel_id ?? m.channelId ?? payload.channelId
					const guildId = payload.guildId ?? m.guild_id
					const sender = m.author ? m : getCachedMessage(channelId, m.id)
					if (isIgnored(s, sender, channelId, guildId)) return payload
					const known = edits.get(m.id)

					// Same text as last time (a link preview, a pin...): put the history back,
					// because Discord would otherwise replace it with the plain text.
					if (known && m.content === known.current) {
						m.content = withHistory(known)
						return payload
					}

					// Only real edits count, and only when the earlier text is known.
					if (!m.edited_timestamp) return payload
					const cached = getCachedMessage(channelId, m.id)
					const before = known ? known.current : cached?.content
					if (typeof before !== 'string' || before === m.content) return payload
					// Not the real text: the cache is showing history we added and forgot.
					if (!known && before.startsWith('> ~~')) return payload
					if (!s.editsOwn && (isOwn(m) || isOwn(cached))) return payload

					const record: EditRecord = known ?? {
						id: m.id,
						channelId,
						guildId,
						author: authorOf(m.author ? m : (cached ?? m)),
						where: describeWhere(channelId, guildId),
						history: [],
						current: before,
						at: 0,
					}

					record.history.push(before)
					if (record.history.length > MAX_VERSIONS_KEPT) record.history.shift()
					record.current = m.content
					record.at = Date.now()

					// Move to the end, so the newest edit is last.
					edits.delete(record.id)
					edits.set(record.id, record)
					saveEdits()

					m.content = withHistory(record)
				} catch (e) {
					log('Edit tracking failed:', String(e))
				}
				return payload
			}),

			// Brings the history back when Discord reloads a channel's messages.
			// Best effort: if this event isn't the one Discord uses, nothing happens.
			onFluxEventDispatched('LOAD_MESSAGES_SUCCESS', (payload: any) => {
				try {
					if (!getSettings().showEdits || !edits.size) return payload
					if (!Array.isArray(payload?.messages)) return payload

					for (const m of payload.messages) {
						const record = m?.id ? edits.get(m.id) : undefined
						if (record && m.content === record.current) {
							m.content = withHistory(record)
						}
					}
				} catch (e) {
					log('Restoring edit history failed:', String(e))
				}
				return payload
			}),
		)

		log('Step 3b: pre-saving new attachments (only when that setting is on)')
		cleanup(
			onFluxEventDispatched('MESSAGE_CREATE', (payload: any) => {
				// Never block this event: always hand the payload back.
				try {
					const s = getSettings()
					const message = payload?.message
					if (
						!s.enabled ||
						!s.preSaveFiles ||
						payload?.optimistic ||
						!message?.id
					)
						return payload

					const me = (Stores as any).UserStore?.getCurrentUser?.()?.id
					if (!s.logOwn && message.author?.id === me) return payload
					if (
						isIgnored(
							s,
							message,
							message.channel_id ?? payload.channelId,
							payload.guildId ?? message.guild_id,
						)
					)
						return payload

					const files = collectFiles(message)
					if (files.length)
						void safe(() => nativeSave(message.id, files, 'pending'))
				} catch (e) {
					log('MESSAGE_CREATE pre-save failed:', String(e))
				}
				return payload
			}),
		)

		const purge = () => {
			if (getSettings().preSaveFiles) void safe(nativePurge)
		}
		purge()
		void safe(() => nativeSetLimit(getSettings().maxKeptMB))
		const purgeTimer = setInterval(purge, 60 * 60 * 1000)
		cleanup(() => clearInterval(purgeTimer))

		log('Step 4: patching the chat row manager to color kept messages')
		cleanup(
			getModules(withGenerate(), (exports: any, id: number) => {
				try {
					const cls = exports.prototype?.generate ? exports : exports.default
					log(`Patching generate() on module ${id}`)
					cleanup(
						// An `after` hook receives only the return value.
						after(cls.prototype, 'generate', (row: any) => {
							try {
								const msg = row?.message
								if (msg?.id && deletedIds.has(msg.id)) {
									msg.textColor = RED
									if (getSettings().showLabel) {
										msg.edited = '(deleted)'
										msg.editedColor = RED
									}
								}
							} catch {}
							return row
						}),
					)
				} catch (e) {
					log(`Patch failed on module ${id}:`, String(e))
				}
			}),
		)
	},
})
