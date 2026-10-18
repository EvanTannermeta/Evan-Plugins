import { Design } from '@revenge-mod/discord/design'
import { Stores } from '@revenge-mod/discord/flux'
import { callNativeMethod } from '@revenge-mod/modules/native'
import { useEffect, useState } from 'react'
import { Alert, AppState, ScrollView } from 'react-native'
import type { JsonStorage } from '@revenge-mod/json-storage'

/**
 * Sends an Android notification for ghost pings detected by Message Logger.
 * Message Logger is a dependency (see manifest.json), so it is always started first and
 * exposes its API on `api.messageLogger`.
 */

// ---------------------------------------------------------------------------
// Message Logger's API (mirrors what that plugin exposes)
// ---------------------------------------------------------------------------

interface GhostPing {
	id: string
	author: string
	where: string
	content: string
	/** What they pinged, for example "pinged you". */
	kind: string
	how: 'deleted' | 'edited'
	at: number
	/** Which server it happened in. Needs Message Logger 1.7 or newer. */
	guildId?: string
	channelId?: string
}

interface MessageLoggerApi {
	/** Calls `listener` for every ghost ping. Returns a function that stops listening. */
	onGhostPing(listener: (ping: GhostPing) => void): () => void
}

// ---------------------------------------------------------------------------
// Native bridge (src/main/kotlin/.../GhostPingNotifications.kt)
// ---------------------------------------------------------------------------

declare module '@revenge-mod/modules/native' {
	export interface NativeMethods {
		'evantanner.ghost-ping-notifications.notify': [
			[title: string, body: string, hideOnLockScreen: string],
			string,
		]
		'evantanner.ghost-ping-notifications.status': [[], string]
		'evantanner.ghost-ping-notifications.requestPermission': [[], string]
	}
}

const notifyNative = (title: string, body: string, hideOnLockScreen: boolean) =>
	callNativeMethod('evantanner.ghost-ping-notifications.notify', [
		title,
		body,
		hideOnLockScreen ? '1' : '0',
	])
const statusNative = () =>
	callNativeMethod('evantanner.ghost-ping-notifications.status', [])
const requestPermissionNative = () =>
	callNativeMethod('evantanner.ghost-ping-notifications.requestPermission', [])

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Settings {
	enabled: boolean
	/** Skip the notification while Discord is open, since Message Logger already shows an alert. */
	onlyInBackground: boolean
	/** Include the message text in the notification. */
	showText: boolean
	/** On the lock screen, show only "Ghost ping" until the phone is unlocked. */
	hideOnLockScreen: boolean
	/** JSON array of server ids that never send a notification. */
	mutedGuilds: string
}

const DEFAULTS: Settings = {
	enabled: true,
	onlyInBackground: true,
	showText: true,
	hideOnLockScreen: true,
	mutedGuilds: '[]',
}

function parseMuted(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed)
			? parsed.filter((x): x is string => typeof x === 'string')
			: []
	} catch {
		return []
	}
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

function guildName(id: string): string {
	try {
		return (Stores as any).GuildStore?.getGuild?.(id)?.name ?? id
	} catch {
		return id
	}
}

function compose(ping: GhostPing, showText: boolean) {
	const what =
		ping.how === 'deleted' ? 'deleted the message' : 'edited the ping out'
	const lines = [`${ping.kind} in ${ping.where} and then ${what}.`]
	if (showText) lines.push(ping.content || '(no text)')

	return {
		title: `Ghost ping from ${ping.author}`,
		body: lines.join('\n').slice(0, 500),
	}
}

type PluginLogger = { log(...a: unknown[]): void; warn(...a: unknown[]): void }
let logger: PluginLogger | undefined

export default plugin({
	jsonStorage: { load: true, default: DEFAULTS },

	SettingsComponent({ api }) {
		const {
			Button,
			Stack,
			Text,
			TextInput,
			TableRow,
			TableRowGroup,
			TableSwitchRow,
		} = Design
		const storage = api.jsonStorage as unknown as JsonStorage<Settings>
		const s: Settings = { ...DEFAULTS, ...(storage.use() ?? {}) }

		// undefined = not checked yet, null = the native part isn't loaded
		const [status, setStatus] = useState<
			{ enabled: boolean; sdk: number } | null | undefined
		>()
		const [refreshKey, setRefreshKey] = useState(0)

		const [serverQuery, setServerQuery] = useState('')
		const serverResults = searchGuilds(serverQuery)
		const muted = parseMuted(s.mutedGuilds)
		const setMuted = (next: string[]) =>
			storage.set({ mutedGuilds: JSON.stringify(next) })

		useEffect(() => {
			let alive = true
			statusNative()
				.then(raw => alive && setStatus(JSON.parse(raw)))
				.catch(() => alive && setStatus(null))
			return () => {
				alive = false
			}
		}, [refreshKey])

		const allow = async () => {
			try {
				const result = await requestPermissionNative()
				if (result === 'granted') {
					Alert.alert(
						'Already allowed',
						'Discord can already send notifications.',
					)
				}
				// Give the system dialog a moment, then re-check.
				setTimeout(() => setRefreshKey(k => k + 1), 2000)
			} catch (e) {
				Alert.alert("Couldn't ask for permission", String(e))
			}
		}

		const sendTest = async () => {
			try {
				const result = await notifyNative(
					'Ghost ping from Example',
					'pinged you in Example Server · #general and then deleted the message.',
					s.hideOnLockScreen,
				)
				if (result !== 'shown')
					Alert.alert("Couldn't send the notification", result)
			} catch (e) {
				Alert.alert("Couldn't send the notification", String(e))
			}
		}

		return (
			<ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
				<TableRowGroup title="Ghost Ping Notifications">
					<TableSwitchRow
						label="Send notifications"
						subLabel="When someone pings you and then deletes the message"
						value={s.enabled}
						onValueChange={(v: boolean) => storage.set({ enabled: v })}
					/>
					<TableSwitchRow
						label="Only when Discord isn't open"
						subLabel="Message Logger already shows an alert inside the app"
						value={s.onlyInBackground}
						onValueChange={(v: boolean) => storage.set({ onlyInBackground: v })}
					/>
					<TableSwitchRow
						label="Show the message text"
						subLabel="Turn off to only say who pinged you and where"
						value={s.showText}
						onValueChange={(v: boolean) => storage.set({ showText: v })}
					/>
					<TableSwitchRow
						label="Hide details on the lock screen"
						subLabel="Shows only “Ghost ping” until you unlock your phone"
						value={s.hideOnLockScreen}
						onValueChange={(v: boolean) => storage.set({ hideOnLockScreen: v })}
					/>
				</TableRowGroup>

				<TableRowGroup title="Muted servers">
					<TextInput
						label="Find a server to mute"
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
									muted.includes(g.id) ? 'Already muted' : 'Tap to mute'
								}
								onPress={() => {
									if (!muted.includes(g.id)) setMuted([...muted, g.id])
								}}
							/>
						))}
					</TableRowGroup>
				) : null}

				{muted.length ? (
					<TableRowGroup title={`Muted (${muted.length}), tap to unmute`}>
						{muted.map(id => (
							<TableRow
								key={id}
								label={guildName(id)}
								subLabel={id}
								onPress={() => setMuted(muted.filter(m => m !== id))}
							/>
						))}
					</TableRowGroup>
				) : (
					<Text variant="text-sm/medium">
						Muted servers don't send a notification. Ghost pings there still
						appear in Message Logger. Needs Message Logger 1.7 or newer.
					</Text>
				)}

				<Stack spacing={8}>
					<Text variant="text-md/semibold">Permission</Text>
					<Text variant="text-sm/medium">
						{status === undefined
							? 'Checking…'
							: status === null
								? 'The native part of this plugin is not loaded, so notifications cannot be sent.'
								: status.enabled
									? 'Discord is allowed to send notifications.'
									: 'Notifications are off for Discord. Allow them below, or in Android settings.'}
					</Text>
					<Stack spacing={8} direction="horizontal">
						<Button
							size="sm"
							variant="secondary"
							text="Allow notifications"
							disabled={!status || status.enabled}
							onPress={allow}
						/>
						<Button
							size="sm"
							variant="secondary"
							text="Send a test"
							disabled={!status}
							onPress={sendTest}
						/>
					</Stack>
				</Stack>

				<Text variant="text-sm/medium">
					Notifications only arrive while Discord is still running in the
					background. Android may stop it after a while, and then nothing can be
					detected.
				</Text>
			</ScrollView>
		)
	},

	start(api) {
		const { cleanup, jsonStorage, logger: pluginLogger } = api
		logger = pluginLogger as PluginLogger

		const messageLogger = (
			api as unknown as { messageLogger?: MessageLoggerApi }
		).messageLogger
		if (!messageLogger) {
			logger.warn(
				'Message Logger did not provide its API, so there is nothing to listen to',
			)
			return
		}

		const storage = jsonStorage as JsonStorage<Settings>
		const getSettings = (): Settings => ({
			...DEFAULTS,
			...(storage.cache ?? {}),
		})

		cleanup(
			messageLogger.onGhostPing(ping => {
				try {
					const s = getSettings()
					if (!s.enabled) return
					if (ping.guildId && parseMuted(s.mutedGuilds).includes(ping.guildId))
						return
					// While Discord is open, Message Logger's own alert is already showing.
					if (s.onlyInBackground && AppState.currentState === 'active') return

					const { title, body } = compose(ping, s.showText)
					notifyNative(title, body, s.hideOnLockScreen)
						.then(result => {
							if (result !== 'shown')
								logger?.warn('Notification not shown:', result)
						})
						.catch(e => logger?.warn('Notification failed:', String(e)))
				} catch (e) {
					logger?.warn('Ghost ping notification failed:', String(e))
				}
			}),
		)

		logger.log('Listening for ghost pings from Message Logger')
	},
})
