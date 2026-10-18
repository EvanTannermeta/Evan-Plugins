import { Design } from '@revenge-mod/discord/design'
import { Stores } from '@revenge-mod/discord/flux'
import { getModules } from '@revenge-mod/modules/finders'
import { createFilterGenerator } from '@revenge-mod/modules/finders/filters'
import { after } from '@revenge-mod/patcher'
import { useMemo, useState } from 'react'
import { ScrollView } from 'react-native'
import type { JsonStorage } from '@revenge-mod/json-storage'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Settings {
	defaultTag: string
	/** Hex color of the tag background, e.g. "5865F2". */
	color: string
	/** The server owner has every permission implicitly. */
	tagOwner: boolean
	/** JSON object: { [userId]: tagText }. Stored as a string so removing a key is safe. */
	overrides: string
}

const DEFAULTS: Settings = {
	defaultTag: 'STAFF',
	color: '5865F2',
	tagOwner: true,
	overrides: '{}',
}

const HEX = /^#?([0-9a-f]{6})$/i
const USER_ID = /^\d{15,25}$/

let overridesCache: { raw: string; value: Record<string, string> } = {
	raw: '{}',
	value: {},
}

function parseOverrides(raw: string): Record<string, string> {
	if (overridesCache.raw === raw) return overridesCache.value
	let value: Record<string, string> = {}
	try {
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === 'object') value = parsed
	} catch {}
	overridesCache = { raw, value }
	return value
}

// Discord stores colors as signed 32-bit ARGB ints (see tagBackgroundColor in the dump).
function toColor(hex: string): number {
	const m = HEX.exec(hex.trim())
	const rgb = Number.parseInt(m ? m[1]! : DEFAULTS.color, 16)
	return 0xff000000 | rgb | 0
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type PluginLogger = { log(...a: unknown[]): void }
let logger: PluginLogger | undefined
const warned = new Set<string>()

function log(...args: unknown[]) {
	console.log('[staff-tags]', ...args)
	try {
		logger?.log(args.map(String).join(' '))
	} catch {}
}

function warnOnce(key: string, ...args: unknown[]) {
	if (warned.has(key)) return
	warned.add(key)
	log(...args)
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

const ADMINISTRATOR = BigInt(8) // 1 << 3

function getRoles(
	guildId: string,
	guild: any,
): Record<string, any> | undefined {
	const s = Stores as any
	try {
		const a = s.GuildRoleStore?.getRoles?.(guildId)
		if (a) return a
	} catch {}
	try {
		const b = s.GuildStore?.getRoles?.(guildId)
		if (b) return b
	} catch {}
	return guild?.roles
}

function computeIsAdmin(
	guildId: string,
	userId: string,
	tagOwner: boolean,
): boolean {
	try {
		const s = Stores as any
		const guild = s.GuildStore?.getGuild?.(guildId)

		if (tagOwner && guild?.ownerId === userId) return true

		const member = s.GuildMemberStore?.getMember?.(guildId, userId)
		if (!member?.roles?.length) return false

		const roles = getRoles(guildId, guild)
		if (!roles) {
			warnOnce(
				'no-roles',
				'Could not find a role source (GuildRoleStore/GuildStore)',
			)
			return false
		}

		for (const roleId of member.roles) {
			const perms = roles[roleId]?.permissions
			if (perms != null && (BigInt(perms) & ADMINISTRATOR) === ADMINISTRATOR) {
				return true
			}
		}
	} catch (e) {
		warnOnce('admin-check', 'Admin check failed:', String(e))
	}
	return false
}

// This runs for every message that is drawn, and each check goes through a user's roles with
// BigInt math, so answers are remembered for a short while. A "no" is remembered for less
// time, because it may just mean the member or roles hadn't loaded yet.
const ADMIN_YES_MS = 30_000
const ADMIN_NO_MS = 5_000
const ADMIN_CACHE_MAX = 2000
const adminCache = new Map<string, { value: boolean; at: number }>()

function isAdmin(guildId: string, userId: string, tagOwner: boolean): boolean {
	const key = `${guildId}:${userId}:${tagOwner ? 1 : 0}`
	const now = Date.now()

	const hit = adminCache.get(key)
	if (hit && now - hit.at < (hit.value ? ADMIN_YES_MS : ADMIN_NO_MS))
		return hit.value

	const value = computeIsAdmin(guildId, userId, tagOwner)
	if (adminCache.size >= ADMIN_CACHE_MAX) adminCache.clear()
	adminCache.set(key, { value, at: now })
	return value
}

// ---------------------------------------------------------------------------
// Emoji support
// ---------------------------------------------------------------------------
// Unicode emojis (😀) are plain text and just work. Custom server emojis are
// written as <:name:id> or <a:name:id> (animated). Discord renders tag text as
// plain text, so a custom emoji is pulled out and shown through tagIconUrl.

const CUSTOM_EMOJI = /<(a?):\w+:(\d+)>/g

function parseTag(raw: string): { text: string; iconUrl?: string } {
	let iconUrl: string | undefined
	const text = raw
		.replace(CUSTOM_EMOJI, (_m, animated: string, id: string) => {
			iconUrl ??= `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=64`
			return ''
		})
		.trim()
	// An icon-only tag still needs some text for Discord to draw the tag.
	return { text: text || (iconUrl ? '\u200b' : ''), iconUrl }
}

// Emoji finder: looks up custom emojis from the servers you are in by name.

interface FoundEmoji {
	id: string
	name: string
	animated: boolean
	guild: string
	code: string
}

const MAX_RESULTS = 10

function searchEmojis(query: string): FoundEmoji[] {
	const q = query.trim().toLowerCase().replace(/^:|:$/g, '')
	if (!q) return []

	const out: FoundEmoji[] = []
	try {
		const st = Stores as any
		const guilds: Record<string, any> = st.GuildStore?.getGuilds?.() ?? {}

		for (const guild of Object.values(guilds)) {
			let emojis: any[] = []
			try {
				emojis = st.EmojiStore?.getGuildEmoji?.(guild.id) ?? []
			} catch {}
			if (!emojis.length) {
				emojis = st.EmojiStore?.getGuilds?.()?.[guild.id]?.emojis ?? []
			}

			for (const e of emojis) {
				const name: string | undefined = e?.name
				if (!name || !e.id || !name.toLowerCase().includes(q)) continue
				const animated = !!e.animated
				out.push({
					id: e.id,
					name,
					animated,
					guild: guild.name ?? guild.id,
					code: `<${animated ? 'a' : ''}:${name}:${e.id}>`,
				})
			}
		}
	} catch (e) {
		warnOnce('emoji-search', 'Emoji search failed:', String(e))
	}

	// Exact name matches first, then alphabetical.
	out.sort(
		(a, b) =>
			Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) ||
			a.name.localeCompare(b.name),
	)
	return out.slice(0, MAX_RESULTS)
}

// User finder: looks through the users Discord has cached on this device.

interface FoundUser {
	id: string
	username: string
	displayName: string
}

function searchUsers(query: string): FoundUser[] {
	const q = query.trim().toLowerCase().replace(/^@/, '')
	if (!q) return []

	const scored: { score: number; user: FoundUser }[] = []
	try {
		const users: Record<string, any> =
			(Stores as any).UserStore?.getUsers?.() ?? {}

		for (const u of Object.values(users)) {
			const username: string = u?.username ?? ''
			const globalName: string = u?.globalName ?? u?.global_name ?? ''
			const fields = [username.toLowerCase(), globalName.toLowerCase()]

			let score = -1
			if (u.id === q) score = 4
			else if (fields.includes(q)) score = 3
			else if (fields.some(f => f.startsWith(q))) score = 2
			else if (fields.some(f => f.includes(q))) score = 1
			if (score < 0) continue

			scored.push({
				score,
				user: {
					id: u.id,
					username,
					displayName: globalName || username,
				},
			})
		}
	} catch (e) {
		warnOnce('user-search', 'User search failed:', String(e))
	}

	scored.sort(
		(a, b) =>
			b.score - a.score || a.user.displayName.localeCompare(b.user.displayName),
	)
	return scored.slice(0, MAX_RESULTS).map(r => r.user)
}

// ---------------------------------------------------------------------------
// Row patch
// ---------------------------------------------------------------------------

function applyTag(settings: Settings, row: any) {
	const msg = row?.message
	if (!msg?.authorId) return

	const overrides = parseOverrides(settings.overrides)
	const custom = overrides[msg.authorId]

	let text: string | null = null
	if (custom !== undefined) {
		// An override always wins; empty text means "use the default tag".
		text = custom || settings.defaultTag
	} else if (
		msg.guildId &&
		msg.tagText == null && // don't replace BOT / APP / etc. tags
		isAdmin(msg.guildId, msg.authorId, settings.tagOwner)
	) {
		text = settings.defaultTag
	}
	if (!text) return

	const tag = parseTag(text)
	if (!tag.text) return

	msg.tagText = tag.text
	if (tag.iconUrl) msg.tagIconUrl = tag.iconUrl
	msg.tagBackgroundColor = toColor(settings.color)
	msg.tagTextColor = -1 // white
	msg.tagVerified = false
}

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
	() => 'staff-tags.generate',
)

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

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
		const overrides = parseOverrides(s.overrides)

		const [newId, setNewId] = useState('')
		const [newTag, setNewTag] = useState('')
		const [error, setError] = useState('')
		const [emojiQuery, setEmojiQuery] = useState('')
		const emojiResults = useMemo(() => searchEmojis(emojiQuery), [emojiQuery])
		const [userQuery, setUserQuery] = useState('')
		const userResults = useMemo(() => searchUsers(userQuery), [userQuery])

		const saveOverrides = (next: Record<string, string>) =>
			storage.set({ overrides: JSON.stringify(next) })

		const addOverride = () => {
			const id = newId.trim()
			if (!USER_ID.test(id)) {
				setError('Enter a valid user ID (numbers only).')
				return
			}
			setError('')
			saveOverrides({ ...overrides, [id]: newTag.trim() })
			setNewId('')
			setNewTag('')
		}

		return (
			<ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
				<TableRowGroup title="Tag">
					<TextInput
						label="Default tag text"
						size="md"
						placeholder="STAFF"
						value={s.defaultTag}
						onChange={(v: string) => storage.set({ defaultTag: v })}
					/>
					<TextInput
						label="Tag color (hex)"
						size="md"
						placeholder="5865F2"
						value={s.color}
						onChange={(v: string) => storage.set({ color: v })}
					/>
					<TableSwitchRow
						label="Tag server owners"
						subLabel="Owners have every permission, including Administrator"
						value={s.tagOwner}
						onValueChange={(v: boolean) => storage.set({ tagOwner: v })}
					/>
				</TableRowGroup>

				<TableRowGroup title="Custom tags per person">
					{Object.keys(overrides).length === 0 ? (
						<TableRow label="No custom tags yet" />
					) : (
						Object.entries(overrides).map(([id, tag]) => (
							<TableRow
								key={id}
								label={tag || `${s.defaultTag} (default)`}
								subLabel={`${id} · tap to remove`}
								onPress={() => {
									const { [id]: _removed, ...rest } = overrides
									saveOverrides(rest)
								}}
							/>
						))
					)}
				</TableRowGroup>

				<TableRowGroup title="User finder">
					<TextInput
						label="Search by username or display name"
						size="md"
						placeholder="e.g. evantannermeta"
						value={userQuery}
						onChange={(v: string) => setUserQuery(v)}
					/>
				</TableRowGroup>

				{userQuery.trim() && userResults.length === 0 ? (
					<Text variant="text-sm/medium">
						No cached user matches that. Users appear here once Discord has
						loaded them (for example, after you open a channel they chatted in).
					</Text>
				) : null}

				{userResults.map(user => (
					<Card key={user.id}>
						<Stack spacing={6}>
							<Text variant="text-md/semibold">{user.displayName}</Text>
							<Text variant="text-sm/medium" selectable>
								@{user.username} · {user.id}
							</Text>
							<Stack spacing={8} direction="horizontal">
								<Button
									text="Use in form below"
									variant="secondary"
									size="sm"
									onPress={() => {
										setNewId(user.id)
										setError('')
									}}
								/>
								<Button
									text="Add with default tag"
									variant="secondary"
									size="sm"
									onPress={() => saveOverrides({ ...overrides, [user.id]: '' })}
								/>
							</Stack>
						</Stack>
					</Card>
				))}

				<TableRowGroup title="Add custom tag">
					<TextInput
						label="User ID"
						size="md"
						placeholder="e.g. 1494597581920272534"
						value={newId}
						onChange={(v: string) => setNewId(v)}
					/>
					<TextInput
						label="Tag text (empty = default)"
						size="md"
						placeholder={s.defaultTag}
						value={newTag}
						onChange={(v: string) => setNewTag(v)}
					/>
					{error ? <Text variant="text-sm/medium">{error}</Text> : null}
					<Button variant="primary" text="Add" onPress={addOverride} />
				</TableRowGroup>

				<TableRowGroup title="Emoji code finder">
					<TextInput
						label="Emoji name"
						size="md"
						placeholder="e.g. emoji_4"
						value={emojiQuery}
						onChange={(v: string) => setEmojiQuery(v)}
					/>
				</TableRowGroup>

				{emojiQuery.trim() && emojiResults.length === 0 ? (
					<Text variant="text-sm/medium">
						No emoji with that name in your servers.
					</Text>
				) : null}

				{emojiResults.map(emoji => (
					<Card key={emoji.code}>
						<Stack spacing={6}>
							<Text variant="text-md/semibold">
								:{emoji.name}: · {emoji.guild}
							</Text>
							<Text variant="text-sm/medium" selectable>
								{emoji.code}
							</Text>
							<Stack spacing={8} direction="horizontal">
								<Button
									text="Add to default tag"
									variant="secondary"
									size="sm"
									onPress={() =>
										storage.set({
											defaultTag: `${s.defaultTag} ${emoji.code}`.trim(),
										})
									}
								/>
								<Button
									text="Add to custom tag"
									variant="secondary"
									size="sm"
									onPress={() => setNewTag(t => `${t} ${emoji.code}`.trim())}
								/>
							</Stack>
						</Stack>
					</Card>
				))}

				<Text variant="text-sm/medium">
					Emojis: type normal emojis straight into any tag (for example 👑
					STAFF). For a custom server emoji, paste its code like{' '}
					{'<:name:123456789>'}
					(the icon is shown on the tag).
				</Text>
				<Text variant="text-sm/medium">
					A custom tag is shown for that person even if they are not an
					administrator. Reopen the channel to see changes on existing messages.
				</Text>
			</ScrollView>
		)
	},

	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		log('Step 1: plugin starting')
		const storage = jsonStorage as JsonStorage<Settings>
		const getSettings = (): Settings => ({
			...DEFAULTS,
			...(storage.cache ?? {}),
		})

		cleanup(() => adminCache.clear())

		log('Step 2: looking for the chat row manager')
		cleanup(
			getModules(withGenerate(), (exports: any, id: number) => {
				try {
					const cls = exports.prototype?.generate ? exports : exports.default
					log(`Step 3: patching generate() on module ${id}`)
					cleanup(
						// An `after` hook receives only the return value, here the row itself.
						after(cls.prototype, 'generate', (ret: any) => {
							try {
								applyTag(getSettings(), ret)
							} catch (e) {
								warnOnce('apply', 'applyTag failed:', String(e))
							}
							return ret
						}),
					)
				} catch (e) {
					log(`Patch failed on module ${id}:`, String(e))
				}
			}),
		)
	},
})
