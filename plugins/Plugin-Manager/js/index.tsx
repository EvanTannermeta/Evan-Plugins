import { getAssetIdByName } from '@revenge-mod/assets'
import { Page, SearchInput, TableRowAssetIcon } from '@revenge-mod/components'
import { AlertActionCreators } from '@revenge-mod/discord/actions'
import { Tokens } from '@revenge-mod/discord/common/tokens'
import { Design } from '@revenge-mod/discord/design'
import {
	addSettingsItemToSection,
	onSettingsModulesLoaded,
	refreshSettings,
	registerSettingsItem,
} from '@revenge-mod/discord/modules/settings'
import { reloadApp } from '@revenge-mod/modules/native/app'
import {
	disablePluginInActiveSlot,
	enablePluginInActiveSlot,
	getInternalPluginMeta,
	getLinkedOptionalDependents,
	getPluginDependents,
	isPluginEnabledInActiveSlot,
	isPluginErrored,
	isPluginInternal,
	isPluginPendingReload,
	pEmitter,
	pList,
	resyncPluginSources,
	runPluginLate,
	uninstallExternalPlugin,
} from '@revenge-mod/plugins/_'
import {
	installFromRepo,
	listRepoPlugins,
	listRepos,
	listUpdates,
	planInstall,
	refreshAllRepos,
	refreshRepo,
	selectSafeUpdates,
	setRepos,
	updatePlugins,
} from '@revenge-mod/plugins/_/repositories'
import {
	formatVersion,
	getPluginContributorName,
} from '@revenge-mod/plugins/utils'
import { Component, useCallback, useEffect, useMemo, useState } from 'react'
import { Image, ScrollView, View } from 'react-native'
import type { SettingsItem } from '@revenge-mod/discord/modules/settings'
import type { JsonStorage } from '@revenge-mod/json-storage'
import type { AnyPlugin } from '@revenge-mod/plugins/_'
import type {
	InstallPlan,
	PluginUpdate,
	Repo,
	RepoPluginListing,
} from '@revenge-mod/plugins/_/repositories'
import type { ReactNode } from 'react'

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const ALERT_KEY = 'plugin-manager-alert'

const errorText = (e: unknown) =>
	e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)

const noop = () => {}

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

interface Settings {
	/** Check for plugin updates in the background. */
	autoCheck: boolean
	/** Minutes between background checks. One of INTERVALS. */
	intervalMin: number
}

const INTERVALS = [
	{ label: '1 minute', min: 1 },
	{ label: '5 minutes', min: 5 },
	{ label: '15 minutes', min: 15 },
	{ label: '30 minutes', min: 30 },
	{ label: '1 hour', min: 60 },
]

const DEFAULTS: Settings = { autoCheck: true, intervalMin: 15 }

/** Fills in defaults and ignores an interval that isn't one of the choices. */
function readSettings(raw?: Partial<Settings> | null): Settings {
	const s = { ...DEFAULTS, ...(raw ?? {}) }
	if (!INTERVALS.some(i => i.min === s.intervalMin))
		s.intervalMin = DEFAULTS.intervalMin
	return s
}

/** Opens an alert. Buttons close it before running their action. */
function openAlert(
	title: string,
	content: string,
	buttons: { text: string; variant?: string; onPress?: () => void }[] = [
		{ text: 'Okay' },
	],
) {
	const { AlertModal, AlertActionButton, Stack } = Design

	AlertActionCreators.dismissAlert(ALERT_KEY)
	AlertActionCreators.openAlert(
		ALERT_KEY,
		<AlertModal
			title={title}
			content={content}
			actions={
				<Stack>
					{buttons.map(b => (
						<AlertActionButton
							key={b.text}
							text={b.text}
							variant={(b.variant ?? 'primary') as any}
							onPress={() => {
								AlertActionCreators.dismissAlert(ALERT_KEY)
								b.onPress?.()
							}}
						/>
					))}
				</Stack>
			}
		/>,
	)
}

/** Promise-based confirm. Resolves false on cancel. */
function confirm(title: string, content: string, confirmText: string) {
	return new Promise<boolean>(resolve =>
		openAlert(title, content, [
			{ text: confirmText, onPress: () => resolve(true) },
			{ text: 'Cancel', variant: 'secondary', onPress: () => resolve(false) },
		]),
	)
}

/** "Palm <123> (https://...)" -> "Palm" */
function nameOf(contributor?: string | null) {
	if (!contributor) return null
	try {
		return getPluginContributorName(contributor)
	} catch {
		return contributor
	}
}

function formatSize(bytes?: number) {
	if (!bytes) return null
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function versionOf(plugin: AnyPlugin) {
	try {
		return formatVersion(plugin.manifest.version as never)
	} catch {
		return String(plugin.manifest.version ?? '?')
	}
}

/* -------------------------------------------------------------------------- */
/*  Icons, credits, requirements                                              */
/* -------------------------------------------------------------------------- */

let useIconStyles: (() => { icon: object }) | undefined

/** Plugin icon: a packaged asset name (tinted) or an inline `data:` image. */
function PluginIcon({
	icon,
	size = 28,
}: {
	icon?: string | null
	size?: number
}) {
	// Created on first use, because Design isn't available when the file loads.
	useIconStyles ??= Design.createStyles({
		icon: { tintColor: Tokens.default.colors.TEXT_STRONG },
	}) as never
	const styles = useIconStyles!()

	const isData = !!icon?.startsWith('data:')
	const source = isData
		? { uri: icon as string }
		: ((icon ? getAssetIdByName(icon) : undefined) ??
			getAssetIdByName('PuzzlePieceIcon', 'png'))

	if (source == null) return null

	return (
		<Image
			source={source as never}
			style={[!isData && styles.icon, { width: size, height: size }]}
		/>
	)
}

function PluginTitle({ name, icon }: { name: string; icon?: string | null }) {
	const { Text } = Design

	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
			<PluginIcon icon={icon} />
			<View style={{ flexShrink: 1 }}>
				<Text variant="heading-md/semibold">{name}</Text>
			</View>
		</View>
	)
}

/** "by Palm +2" */
function bylineOf(author?: string | null, contributors?: string[] | null) {
	const main = nameOf(author)
	if (!main) return null
	const extra = contributors?.length ?? 0
	return `by ${main}${extra ? ` +${extra}` : ''}`
}

function showCredits(
	title: string,
	author?: string | null,
	contributors?: string[] | null,
) {
	const names = (contributors ?? []).map(nameOf).filter(Boolean)

	openAlert(
		`${title} credits`,
		[
			`Author\n${nameOf(author) ?? 'Unknown'}`,
			names.length ? `Contributors\n${names.join('\n')}` : null,
		]
			.filter(Boolean)
			.join('\n\n'),
	)
}

function CreditsButton({
	title,
	author,
	contributors,
}: {
	title: string
	author?: string | null
	contributors?: string[] | null
}) {
	const { Button } = Design
	if (!contributors?.length) return null

	return (
		<Button
			text="Credits"
			variant="tertiary"
			size="sm"
			onPress={() => showCredits(title, author, contributors)}
		/>
	)
}

/** Revenge itself and Discord are always required, so only list other plugins. */
const BUILT_IN_REQUIREMENTS = new Set(['revenge.api', 'discord'])

function requirementsOf(listing: RepoPluginListing, version: string) {
	const deps = listing.versions[version]?.dependencies ?? {}

	return Object.entries(deps)
		.filter(([id]) => !BUILT_IN_REQUIREMENTS.has(id))
		.map(([id, dep]) => {
			const installed = pList.get(id)
			const flags = [
				dep.optional ? 'optional' : null,
				installed ? null : 'not installed',
			].filter(Boolean)

			return `${installed?.manifest.name ?? id}${flags.length ? ` (${flags.join(', ')})` : ''}`
		})
}

/** Re-renders when anything about the plugin list changes. */
function usePluginListTick() {
	const [tick, setTick] = useState(0)

	useEffect(() => {
		const bump = () => setTick(t => t + 1)
		const events = [
			'register',
			'unregister',
			'install',
			'stateUpdate',
			'statusUpdate',
			'metadataUpdate',
		] as const

		for (const e of events) pEmitter.on(e as any, bump)
		return () => {
			for (const e of events) pEmitter.off(e as any, bump)
		}
	}, [])

	return tick
}

/* -------------------------------------------------------------------------- */
/*  Actions (same flow Revenge's own plugin screen uses)                      */
/* -------------------------------------------------------------------------- */

async function enablePlugin(plugin: AnyPlugin) {
	await enablePluginInActiveSlot(plugin, true)
	await runPluginLate(plugin).catch(noop)
}

async function disablePlugin(plugin: AnyPlugin) {
	// Read before disabling, which changes the list.
	const optionals = getLinkedOptionalDependents(plugin)
	await disablePluginInActiveSlot(plugin)
	// Optional dependents are stopped by the cascade; restart them without this plugin.
	await Promise.all(optionals.map(dep => runPluginLate(dep).catch(noop)))
}

async function togglePlugin(plugin: AnyPlugin) {
	try {
		if (isPluginEnabledInActiveSlot(plugin)) {
			const dependents = getPluginDependents(plugin).filter(
				isPluginEnabledInActiveSlot,
			)

			if (dependents.length) {
				const ok = await confirm(
					`Disable ${plugin.manifest.name}?`,
					`These plugins need it and will be disabled too:\n\n${dependents
						.map(d => d.manifest.name)
						.join('\n')}`,
					'Disable',
				)
				if (!ok) return
			}

			await disablePlugin(plugin)
		} else {
			await enablePlugin(plugin)
		}
	} catch (e) {
		openAlert(`Couldn't change ${plugin.manifest.name}`, errorText(e))
	}
}

async function uninstallPlugin(plugin: AnyPlugin) {
	const ok = await confirm(
		`Uninstall ${plugin.manifest.name}?`,
		'The plugin and all of its data will be removed. This cannot be undone.',
		'Uninstall',
	)
	if (!ok) return

	try {
		await uninstallExternalPlugin(plugin)
	} catch (e) {
		openAlert('Uninstall failed', errorText(e))
	}
}

/* -------------------------------------------------------------------------- */
/*  Filters                                                                   */
/* -------------------------------------------------------------------------- */

type FilterKey =
	| 'installed'
	| 'notInstalled'
	| 'enabled'
	| 'disabled'
	| 'updates'
	| 'errors'
	| 'reload'

const FILTERS: Record<FilterKey, { label: string; desc: string }> = {
	installed: { label: 'Installed', desc: 'Plugins you have installed' },
	notInstalled: {
		label: 'Not installed',
		desc: 'Plugins you can still install',
	},
	enabled: { label: 'Enabled', desc: 'Plugins that are turned on' },
	disabled: { label: 'Disabled', desc: 'Plugins that are turned off' },
	updates: { label: 'Update available', desc: 'Has a newer version' },
	errors: { label: 'Has errors', desc: 'Failed to start or reported errors' },
	reload: { label: 'Needs reload', desc: 'Restart Discord to apply' },
}

const INSTALLED_FILTERS: FilterKey[] = [
	'enabled',
	'disabled',
	'updates',
	'errors',
	'reload',
]

const BROWSE_FILTERS: FilterKey[] = [
	'installed',
	'notInstalled',
	'enabled',
	'disabled',
	'updates',
	'errors',
	'reload',
]

/** Every selected filter has to match. `plugin` is undefined for plugins that aren't installed. */
function matchesFilters(
	plugin: AnyPlugin | undefined,
	id: string,
	filters: Set<FilterKey>,
	updateById: Map<string, PluginUpdate>,
) {
	const enabled = !!plugin && isPluginEnabledInActiveSlot(plugin)

	return (
		(!filters.has('installed') || !!plugin) &&
		(!filters.has('notInstalled') || !plugin) &&
		(!filters.has('enabled') || enabled) &&
		(!filters.has('disabled') || (!!plugin && !enabled)) &&
		(!filters.has('updates') || updateById.has(id)) &&
		(!filters.has('errors') || (!!plugin && isPluginErrored(plugin))) &&
		(!filters.has('reload') || (!!plugin && isPluginPendingReload(plugin)))
	)
}

function FilterPanel({
	keys,
	active,
	onChange,
	updatesChecked,
}: {
	keys: FilterKey[]
	active: Set<FilterKey>
	onChange: (next: Set<FilterKey>) => void
	updatesChecked: boolean
}) {
	const { TableRowGroup, TableSwitchRow } = Design

	return (
		<TableRowGroup title="Show only (all selected must match)">
			{keys.map(key => (
				<TableSwitchRow
					key={key}
					label={FILTERS[key].label}
					subLabel={
						key === 'updates' && !updatesChecked
							? 'Tap "Check for updates" first'
							: FILTERS[key].desc
					}
					value={active.has(key)}
					onValueChange={(on: boolean) => {
						const next = new Set(active)
						on ? next.add(key) : next.delete(key)
						onChange(next)
					}}
				/>
			))}
		</TableRowGroup>
	)
}

/* -------------------------------------------------------------------------- */
/*  Update checking shared by both tabs                                       */
/* -------------------------------------------------------------------------- */

function useUpdates() {
	const [updates, setUpdates] = useState<PluginUpdate[] | null>(null)
	const [checking, setChecking] = useState(false)
	const [installing, setInstalling] = useState(false)

	const updateById = useMemo(
		() => new Map((updates ?? []).map(u => [u.id, u] as const)),
		[updates],
	)
	const safeIds = useMemo(
		() => (updates ? selectSafeUpdates(updates) : new Set<string>()),
		[updates],
	)

	const checkUpdates = useCallback(async () => {
		setChecking(true)
		try {
			const { errors } = await refreshAllRepos()
			const all = await listUpdates()
			setUpdates(all)

			const safe = selectSafeUpdates(all)
			const available = all.filter(u => safe.has(u.id))

			if (available.length) {
				// Same Yes/No popup as the automatic checker: Yes updates and reloads.
				const sizes = await getUpdateSizes(available)
				const ids = new Set(available.map(u => u.id))
				openAlert(
					`${available.length} plugin update${available.length === 1 ? '' : 's'} available`,
					summarizeUpdates(available, sizes),
					[
						{
							text: 'Yes',
							onPress: () => {
								log('User chose Yes (manual check)')
								void applyUpdatesAndReload(ids)
							},
						},
						{
							text: 'No',
							variant: 'secondary',
							onPress: () => log('User chose No (manual check)'),
						},
					],
				)
			} else if (errors.length) {
				openAlert(
					'Some repositories failed to refresh',
					errors.map(e => `${e.url}: ${errorText(e.error)}`).join('\n'),
				)
			}
		} catch (e) {
			openAlert("Couldn't check for updates", errorText(e))
		} finally {
			setChecking(false)
		}
	}, [])

	const runUpdate = async (ids: Set<string>) => {
		if (!ids.size) return
		setInstalling(true)
		try {
			const { installed, pending, errors } = await updatePlugins(ids)
			await resyncPluginSources().catch(noop)
			setUpdates(await listUpdates())

			const lines = [
				installed.length ? `Updated: ${installed.join(', ')}` : null,
				pending.length ? `Applies after reload: ${pending.join(', ')}` : null,
				...errors.map(e => `${e.id} failed: ${errorText(e.error)}`),
			].filter(Boolean)
			openAlert('Update finished', lines.join('\n\n') || 'Nothing changed.')
		} catch (e) {
			openAlert('Update failed', errorText(e))
		} finally {
			setInstalling(false)
		}
	}

	return {
		updates,
		updateById,
		safeIds,
		checking,
		installing,
		checkUpdates,
		updateAll: () => runUpdate(safeIds),
		updateOne: (id: string) => runUpdate(new Set([id])),
	}
}

type Updater = ReturnType<typeof useUpdates>

/** Filter button + update buttons, identical on both tabs. */
function PluginToolbar({
	filters,
	showFilters,
	onToggleFilters,
	updater,
}: {
	filters: Set<FilterKey>
	showFilters: boolean
	onToggleFilters: () => void
	updater: Updater
}) {
	const { Stack, Text, Button } = Design
	const { updates, safeIds, checking, installing, checkUpdates, updateAll } =
		updater

	return (
		<Stack spacing={8}>
			<Stack spacing={8} direction="horizontal">
				<Button
					text={filters.size ? `Filter (${filters.size})` : 'Filter'}
					variant={showFilters || filters.size ? 'primary' : 'secondary'}
					size="sm"
					onPress={onToggleFilters}
				/>
				<Button
					text={
						safeIds.size
							? `Update all (${safeIds.size})`
							: updates
								? 'No updates'
								: 'Check for updates'
					}
					variant="secondary"
					size="sm"
					loading={checking || installing}
					disabled={checking || installing || (!!updates && !safeIds.size)}
					onPress={safeIds.size ? updateAll : checkUpdates}
				/>
				{updates ? (
					<Button
						text="Recheck"
						variant="tertiary"
						size="sm"
						disabled={checking || installing}
						onPress={checkUpdates}
					/>
				) : null}
			</Stack>

			{updates && updates.length > safeIds.size ? (
				<Text variant="text-sm/medium" color="text-muted">
					{updates.length - safeIds.size} update(s) skipped because they are
					blocked or would break another plugin.
				</Text>
			) : null}
		</Stack>
	)
}

/* -------------------------------------------------------------------------- */
/*  Installed tab                                                             */
/* -------------------------------------------------------------------------- */

function InstalledPluginCard({
	plugin,
	update,
}: {
	plugin: AnyPlugin
	update?: PluginUpdate
}) {
	const { Card, Stack, Text, Button } = Design
	const enabled = isPluginEnabledInActiveSlot(plugin)
	const errored = isPluginErrored(plugin)
	const reload = isPluginPendingReload(plugin)

	const status = [
		enabled ? 'Enabled' : 'Disabled',
		errored ? 'errors' : null,
		reload ? 'needs reload' : null,
		update ? `update → v${update.available}` : null,
	]
		.filter(Boolean)
		.join(' · ')

	const byline = bylineOf(plugin.manifest.author, plugin.manifest.contributors)

	return (
		<Card>
			<Stack spacing={6}>
				<PluginTitle name={plugin.manifest.name} icon={plugin.manifest.icon} />
				<Text variant="text-sm/medium" color="text-muted">
					{[`v${versionOf(plugin)}`, byline].filter(Boolean).join(' · ')}
				</Text>
				{plugin.manifest.description ? (
					<Text variant="text-md/medium">{plugin.manifest.description}</Text>
				) : null}
				<Text variant="text-sm/medium" color="text-muted">
					{status}
				</Text>
				<Stack spacing={8} direction="horizontal">
					<Button
						text={enabled ? 'Disable' : 'Enable'}
						variant={enabled ? 'secondary' : 'primary'}
						size="sm"
						onPress={() => togglePlugin(plugin)}
					/>
					<Button
						text="Uninstall"
						variant="destructive"
						size="sm"
						onPress={() => uninstallPlugin(plugin)}
					/>
					<CreditsButton
						title={plugin.manifest.name}
						author={plugin.manifest.author}
						contributors={plugin.manifest.contributors}
					/>
				</Stack>
			</Stack>
		</Card>
	)
}

function InstalledTab({ updater }: { updater: Updater }) {
	const { Stack, Text } = Design
	const tick = usePluginListTick()
	const { updates, updateById } = updater

	const [query, setQuery] = useState('')
	const [showFilters, setShowFilters] = useState(false)
	const [filters, setFilters] = useState<Set<FilterKey>>(new Set())

	const plugins = useMemo(() => {
		const q = query.trim().toLowerCase()

		return [...pList.values()]
			.filter(p => !isPluginInternal(getInternalPluginMeta(p)))
			.filter(p => {
				if (q) {
					const hay = [p.manifest.id, p.manifest.name, p.manifest.description]
						.filter(Boolean)
						.join(' ')
						.toLowerCase()
					if (!hay.includes(q)) return false
				}

				return matchesFilters(p, p.manifest.id, filters, updateById)
			})
			.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
		// `tick` makes this re-run when plugin state changes.
	}, [query, filters, updateById, tick])

	return (
		<View style={{ gap: 12 }}>
			<Stack spacing={8}>
				<SearchInput onChange={(v: string) => setQuery(v)} />
				<PluginToolbar
					filters={filters}
					showFilters={showFilters}
					onToggleFilters={() => setShowFilters(s => !s)}
					updater={updater}
				/>
			</Stack>

			{showFilters ? (
				<FilterPanel
					keys={INSTALLED_FILTERS}
					active={filters}
					onChange={setFilters}
					updatesChecked={!!updates}
				/>
			) : null}

			{plugins.length === 0 ? (
				<Text variant="text-md/medium" color="text-muted">
					No installed plugins match.
				</Text>
			) : null}

			{plugins.map(p => (
				<InstalledPluginCard
					key={p.manifest.id}
					plugin={p}
					update={updateById.get(p.manifest.id)}
				/>
			))}
		</View>
	)
}

/* -------------------------------------------------------------------------- */
/*  Browse tab                                                                */
/* -------------------------------------------------------------------------- */

interface BrowseEntry {
	listing: RepoPluginListing
	repoUrl: string
	repoName: string | null
}

const COMMUNITY_REPO = 'https://revenge-mod.github.io/revenge-community-plugins'

const normalizeUrl = (url: string) => url.replace(/\/+$/, '').toLowerCase()

/**
 * Makes sure the community repository is in Revenge's repository list.
 * Only adds it when missing (a repo you disabled yourself stays disabled), and puts it
 * first, like Revenge's own default repository. Your other repositories are kept as they are.
 */
async function ensureCommunityRepo(): Promise<Repo[]> {
	const repos = await listRepos()
	const target = normalizeUrl(COMMUNITY_REPO)

	if (repos.some(r => normalizeUrl(r.url) === target)) return repos

	const userRepos = repos
		.filter(r => !r.internal)
		.map(({ url, enabled }) => ({ url, enabled }))

	await setRepos([{ url: COMMUNITY_REPO, enabled: true }, ...userRepos])
	await refreshRepo(COMMUNITY_REPO).catch(noop)

	return listRepos()
}

async function loadBrowse(
	refresh: boolean,
): Promise<{ entries: BrowseEntry[]; repos: Repo[] }> {
	await ensureCommunityRepo()
	if (refresh) await refreshAllRepos()

	const repos = (await listRepos()).filter(r => r.enabled)
	const seen = new Set<string>()
	const entries: BrowseEntry[] = []

	// Repos are listed by priority, the first one serving a plugin wins.
	for (const repo of repos) {
		for (const listing of await listRepoPlugins(repo.url)) {
			if (seen.has(listing.id)) continue
			seen.add(listing.id)
			entries.push({ listing, repoUrl: repo.url, repoName: repo.name })
		}
	}

	entries.sort((a, b) => a.listing.name.localeCompare(b.listing.name))
	return { entries, repos }
}

/** How many versions the version picker lists. */
const MAX_VERSIONS = 6

function describePlan(plan: InstallPlan) {
	const lines = plan.actions.map(
		a => `${a.replaces ? 'Update' : 'Install'} ${a.id} v${a.version}`,
	)
	const warnings = plan.warnings.map(w => w.message)
	return [...lines, ...warnings].join('\n')
}

function BrowseTab({ updater }: { updater: Updater }) {
	const { Card, Stack, Text, Button } = Design
	const tick = usePluginListTick()
	const { updates, updateById, safeIds, installing, updateOne } = updater

	const [entries, setEntries] = useState<BrowseEntry[] | null>(null)
	const [repos, setRepoList] = useState<Repo[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [showFilters, setShowFilters] = useState(false)
	const [filters, setFilters] = useState<Set<FilterKey>>(new Set())
	const [busyId, setBusyId] = useState<string | null>(null)

	const load = useCallback(async (refresh: boolean) => {
		setLoading(true)
		setError(null)
		try {
			const result = await loadBrowse(refresh)
			setEntries(result.entries)
			setRepoList(result.repos)
		} catch (e) {
			setError(errorText(e))
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		load(false)
	}, [load])

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase()
		return (entries ?? []).filter(({ listing: l }) => {
			if (
				q &&
				![l.id, l.name, l.description, l.author]
					.filter(Boolean)
					.join(' ')
					.toLowerCase()
					.includes(q)
			)
				return false

			return matchesFilters(pList.get(l.id), l.id, filters, updateById)
		})
		// `tick` makes this re-run when plugin state changes.
	}, [entries, query, filters, updateById, tick])

	/** `version` pins that exact version. Leave it out to follow the latest. */
	const install = async (
		{ listing, repoUrl }: BrowseEntry,
		version?: string,
	) => {
		setBusyId(listing.id)
		try {
			const plan = await planInstall(listing.id, {
				repos: [repoUrl],
				...(version
					? { targets: { [listing.id]: { repo: repoUrl, version } } }
					: {}),
			})
			setBusyId(null)

			const pinNote = version
				? `\n\nv${version} will be pinned: updates for ${listing.name} stay paused until you install the latest version again.`
				: ''

			const ok = await confirm(
				`Install ${listing.name}${version ? ` v${version}` : ''}?`,
				`${describePlan(plan)}${pinNote}\n\nPlugins run with full access to your Discord client, including your messages and token. Only install plugins you trust.`,
				'Install',
			)
			if (!ok) return

			setBusyId(listing.id)
			const { pending } = await installFromRepo(plan)
			openAlert(
				`${listing.name} installed`,
				pending.length
					? 'Reload Discord to finish applying it, then enable it in the Installed tab.'
					: 'Enable it from the Installed tab.',
			)
		} catch (e) {
			openAlert('Install failed', errorText(e))
		} finally {
			setBusyId(null)
		}
	}

	const chooseVersion = async (entry: BrowseEntry) => {
		const { listing } = entry
		const latest = listing.channels.latest ?? listing.order[0]
		const current = pList.get(listing.id)
		const installedVersion = current ? versionOf(current) : null
		const shown = listing.order.slice(0, MAX_VERSIONS)

		const picked = await new Promise<string | null>(resolve =>
			openAlert(
				`${listing.name} versions`,
				[
					'Choose a version to install.',
					listing.order.length > shown.length
						? `Showing the newest ${shown.length} of ${listing.order.length}.`
						: null,
					'Older versions are pinned, so updates for this plugin pause until you install the latest again.',
				]
					.filter(Boolean)
					.join('\n\n'),
				[
					...shown.map(v => ({
						text: `v${v}${v === latest ? ' (latest)' : ''}${v === installedVersion ? ' · installed' : ''}`,
						variant: 'secondary',
						onPress: () => resolve(v),
					})),
					{
						text: 'Cancel',
						variant: 'secondary',
						onPress: () => resolve(null),
					},
				],
			),
		)

		if (!picked || picked === installedVersion) return
		// The latest version follows updates normally, so it isn't pinned.
		await install(entry, picked === latest ? undefined : picked)
	}

	return (
		<View style={{ gap: 12 }}>
			<Stack spacing={8}>
				<SearchInput onChange={(v: string) => setQuery(v)} />
				<PluginToolbar
					filters={filters}
					showFilters={showFilters}
					onToggleFilters={() => setShowFilters(s => !s)}
					updater={updater}
				/>
				<Button
					text="Refresh repositories"
					variant="secondary"
					size="sm"
					loading={loading}
					disabled={loading}
					onPress={() => load(true)}
				/>
			</Stack>

			{showFilters ? (
				<FilterPanel
					keys={BROWSE_FILTERS}
					active={filters}
					onChange={setFilters}
					updatesChecked={!!updates}
				/>
			) : null}

			{repos.length ? (
				<Text variant="text-sm/medium" color="text-muted">
					Searching {repos.length} repositor{repos.length === 1 ? 'y' : 'ies'}:{' '}
					{repos.map(r => r.name ?? r.url).join(', ')}
				</Text>
			) : null}

			{error ? (
				<Text variant="text-md/medium" color="text-danger">
					Couldn't load plugins: {error}
				</Text>
			) : null}

			{!loading && !error && visible.length === 0 ? (
				<Text variant="text-md/medium" color="text-muted">
					No plugins found.
				</Text>
			) : null}

			{visible.map(entry => {
				const { listing } = entry
				const installedPlugin = pList.get(listing.id)
				const update = updateById.get(listing.id)
				const canUpdate = !!update && safeIds.has(listing.id)
				const latest = listing.channels.latest ?? listing.order[0]
				const requires = latest ? requirementsOf(listing, latest) : []

				return (
					<Card key={listing.id}>
						<Stack spacing={6}>
							<PluginTitle name={listing.name} icon={listing.icon} />
							<Text variant="text-sm/medium" color="text-muted">
								{[
									latest ? `v${latest}` : null,
									formatSize(listing.versions[latest ?? '']?.size),
									bylineOf(listing.author, listing.contributors),
								]
									.filter(Boolean)
									.join(' · ')}
							</Text>
							{listing.description ? (
								<Text variant="text-md/medium">{listing.description}</Text>
							) : null}
							{requires.length ? (
								<Text variant="text-sm/medium" color="text-muted">
									Requires: {requires.join(', ')}
								</Text>
							) : null}
							{installedPlugin ? (
								<Text variant="text-sm/medium" color="text-muted">
									{[
										`Installed v${versionOf(installedPlugin)}`,
										isPluginEnabledInActiveSlot(installedPlugin)
											? 'enabled'
											: 'disabled',
										update ? `update → v${update.available}` : null,
									]
										.filter(Boolean)
										.join(' · ')}
								</Text>
							) : null}
							{entry.repoName ? (
								<Text variant="text-xs/medium" color="text-muted">
									{entry.repoName}
								</Text>
							) : null}
							<Stack spacing={8} direction="horizontal">
								{update ? (
									<Button
										text={
											canUpdate
												? `Update to v${update.available}`
												: 'Update blocked'
										}
										variant="primary"
										size="sm"
										loading={installing}
										disabled={!canUpdate || installing || busyId !== null}
										onPress={() => updateOne(listing.id)}
									/>
								) : (
									<Button
										text={installedPlugin ? 'Installed' : 'Install'}
										variant={installedPlugin ? 'secondary' : 'primary'}
										size="sm"
										loading={busyId === listing.id}
										disabled={!!installedPlugin || busyId !== null}
										onPress={() => install(entry)}
									/>
								)}
								{listing.order.length > 1 ? (
									<Button
										text="Versions"
										variant="secondary"
										size="sm"
										disabled={installing || busyId !== null}
										onPress={() => chooseVersion(entry)}
									/>
								) : null}
								<CreditsButton
									title={listing.name}
									author={listing.author}
									contributors={listing.contributors}
								/>
							</Stack>
						</Stack>
					</Card>
				)
			})}
		</View>
	)
}

function SettingsTab({ storage }: { storage: JsonStorage<Settings> }) {
	const { Text, TableRow, TableRowGroup, TableSwitchRow } = Design
	const s = readSettings(storage.use())

	return (
		<View style={{ gap: 16 }}>
			<TableRowGroup title="Automatic update checks">
				<TableSwitchRow
					label="Check for plugin updates"
					subLabel="Refreshes your repositories in the background and asks before updating"
					value={s.autoCheck}
					onValueChange={(v: boolean) => storage.set({ autoCheck: v })}
				/>
			</TableRowGroup>

			<TableRowGroup title="Check interval">
				{INTERVALS.map(i => (
					<TableRow
						key={i.min}
						label={`${s.intervalMin === i.min ? '✓  ' : '     '}${i.label}`}
						onPress={() => storage.set({ intervalMin: i.min })}
					/>
				))}
			</TableRowGroup>

			<Text variant="text-sm/medium" color="text-muted">
				{s.autoCheck
					? 'Shorter intervals use more battery and data. Changes apply right away.'
					: 'Automatic checks are off. You can still check by hand from the Installed tab.'}
			</Text>
		</View>
	)
}

/* -------------------------------------------------------------------------- */
/*  Revenge internals check                                                   */
/* -------------------------------------------------------------------------- */

/**
 * This plugin uses Revenge's plugin internals, which are not a public API and can change
 * between versions. Returns the names of any that are missing, so we can say so clearly
 * instead of crashing.
 */
function missingInternals(): string[] {
	// Written as pairs because the build turns imported names into property lookups,
	// and those can't be used as shorthand properties in an object literal.
	const things: [string, () => unknown][] = [
		['pList', () => pList],
		['pEmitter', () => pEmitter],
		['enablePluginInActiveSlot', () => enablePluginInActiveSlot],
		['disablePluginInActiveSlot', () => disablePluginInActiveSlot],
		['uninstallExternalPlugin', () => uninstallExternalPlugin],
		['installFromRepo', () => installFromRepo],
		['listRepoPlugins', () => listRepoPlugins],
		['listRepos', () => listRepos],
		['listUpdates', () => listUpdates],
		['planInstall', () => planInstall],
		['refreshAllRepos', () => refreshAllRepos],
		['refreshRepo', () => refreshRepo],
		['selectSafeUpdates', () => selectSafeUpdates],
		['setRepos', () => setRepos],
		['updatePlugins', () => updatePlugins],
	]

	const missing: string[] = []
	for (const [name, get] of things) {
		try {
			if (get() == null) missing.push(name)
		} catch {
			missing.push(name)
		}
	}
	return missing
}

/** Shows what went wrong instead of letting one bad render crash the whole screen. */
class ErrorBoundary extends Component<
	{ children?: ReactNode },
	{ error?: unknown }
> {
	state: { error?: unknown } = {}

	static getDerivedStateFromError(error: unknown) {
		return { error }
	}

	componentDidCatch(error: unknown) {
		log('The screen crashed:', String(error))
	}

	render() {
		if (this.state.error === undefined) return this.props.children

		const { Button, Stack, Text } = Design
		const e = this.state.error
		return (
			<Page>
				<Stack spacing={12}>
					<Text variant="heading-md/semibold">
						Plugin Browser hit a problem
					</Text>
					<Text variant="text-sm/medium" color="text-muted" selectable>
						{e instanceof Error ? e.message : String(e)}
					</Text>
					<Button
						text="Try again"
						variant="secondary"
						size="sm"
						onPress={() => this.setState({ error: undefined })}
					/>
				</Stack>
			</Page>
		)
	}
}

/** The screen, protected from crashes and from a Revenge build it doesn't match. */
function PluginManagerScreen(props: {
	plugin?: AnyPlugin
	storage?: JsonStorage<Settings>
}) {
	const { Stack, Text } = Design
	const missing = useMemo(missingInternals, [])

	if (missing.length) {
		return (
			<Page>
				<Stack spacing={12}>
					<Text variant="heading-md/semibold">
						This Revenge build isn't supported
					</Text>
					<Text variant="text-sm/medium" color="text-muted">
						Plugin Browser relies on parts of Revenge that have changed, so it
						is paused. Update Plugin Browser, or Revenge, and try again.
					</Text>
					<Text variant="text-sm/medium" color="text-muted" selectable>
						Missing: {missing.join(', ')}
					</Text>
				</Stack>
			</Page>
		)
	}

	return (
		<ErrorBoundary>
			<PluginManager {...props} />
		</ErrorBoundary>
	)
}

/* -------------------------------------------------------------------------- */
/*  Screen                                                                    */
/* -------------------------------------------------------------------------- */

function PluginManager({
	plugin: self,
	storage,
}: {
	plugin?: AnyPlugin
	storage?: JsonStorage<Settings>
}) {
	const { Stack, Button, Text } = Design
	const [tab, setTab] = useState<'installed' | 'browse' | 'settings'>(
		'installed',
	)
	// Shared, so a check done on one tab shows on the other.
	const updater = useUpdates()

	return (
		<Page>
			<ScrollView
				contentContainerStyle={{ gap: 12, paddingBottom: 32 }}
				keyboardShouldPersistTaps="handled"
			>
				{self ? (
					<Text variant="text-sm/medium" color="text-muted">
						{self.manifest.name} v{versionOf(self)}
					</Text>
				) : null}

				<Stack spacing={8} direction="horizontal">
					<Button
						text="Installed"
						variant={tab === 'installed' ? 'primary' : 'secondary'}
						size="sm"
						onPress={() => setTab('installed')}
					/>
					<Button
						text="Browse"
						variant={tab === 'browse' ? 'primary' : 'secondary'}
						size="sm"
						onPress={() => setTab('browse')}
					/>
					<Button
						text="Settings"
						variant={tab === 'settings' ? 'primary' : 'secondary'}
						size="sm"
						onPress={() => setTab('settings')}
					/>
				</Stack>

				{tab === 'installed' ? (
					<InstalledTab updater={updater} />
				) : tab === 'browse' ? (
					<BrowseTab updater={updater} />
				) : storage ? (
					<SettingsTab storage={storage} />
				) : (
					<Text variant="text-sm/medium" color="text-muted">
						Settings aren't available yet. Try again in a moment.
					</Text>
				)}
			</ScrollView>
		</Page>
	)
}

/* -------------------------------------------------------------------------- */
/*  Automatic update checker                                                  */
/* -------------------------------------------------------------------------- */

const FIRST_CHECK_DELAY_MS = 10 * 1000 // let Discord finish starting first
const MAX_LISTED = 8 // keep the popup readable

type PluginLogger = { log(...a: unknown[]): void }
let pluginLogger: PluginLogger | undefined

function log(...args: unknown[]) {
	console.log('[plugin-browser:updates]', ...args)
	try {
		pluginLogger?.log(args.map(String).join(' '))
	} catch {}
}

/** True while an update is being installed, so checks don't overlap it. */
let applyingUpdates = false

/** Download sizes come from the repository listing, keyed by plugin id. */
async function getUpdateSizes(
	updates: PluginUpdate[],
): Promise<Map<string, number>> {
	const sizes = new Map<string, number>()
	try {
		const repos = (await listRepos()).filter(r => r.enabled)
		for (const repo of repos) {
			for (const listing of await listRepoPlugins(repo.url)) {
				const update = updates.find(u => u.id === listing.id)
				if (!update || sizes.has(update.id)) continue
				const size = listing.versions[update.available]?.size
				if (size) sizes.set(update.id, size)
			}
		}
	} catch (e) {
		log('Could not read update sizes:', errorText(e))
	}
	return sizes
}

function installedVersionOf(update: PluginUpdate) {
	const plugin = pList.get(update.id)
	if (plugin) return versionOf(plugin)
	const any = update as any
	return String(any.installed ?? any.current ?? '?')
}

function summarizeUpdates(updates: PluginUpdate[], sizes: Map<string, number>) {
	const lines = updates.slice(0, MAX_LISTED).map(u => {
		const name = pList.get(u.id)?.manifest.name ?? u.id
		const size = formatSize(sizes.get(u.id))
		return `${name}\nv${installedVersionOf(u)} → v${u.available}${size ? ` · ${size}` : ''}`
	})

	const more = updates.length - MAX_LISTED
	if (more > 0) lines.push(`…and ${more} more`)

	const total = formatSize(
		updates.reduce((sum, u) => sum + (sizes.get(u.id) ?? 0), 0),
	)

	return [
		...lines,
		total ? `Total download: ${total}` : null,
		'Update all of them and reload Revenge now?',
	]
		.filter(Boolean)
		.join('\n\n')
}

/** Installs the given updates, then reloads Revenge. */
async function applyUpdatesAndReload(ids: Set<string>) {
	applyingUpdates = true
	try {
		log(`Updating ${ids.size} plugin(s):`, [...ids].join(', '))
		const { installed, pending, errors } = await updatePlugins(ids)
		await resyncPluginSources().catch(noop)
		log(
			`Done. installed=${installed.length} pending=${pending.length} errors=${errors.length}`,
		)

		if (!errors.length) {
			log('Reloading Revenge')
			reloadApp()
			return
		}

		// Something failed: tell the user instead of reloading silently.
		const failed = errors
			.map(e => `${e.id} failed: ${errorText(e.error)}`)
			.join('\n\n')
		const worked = installed.length + pending.length > 0

		openAlert(
			'Some updates failed',
			worked ? `${failed}\n\nThe rest were updated. Reload now?` : failed,
			worked
				? [
						{ text: 'Reload now', onPress: () => reloadApp() },
						{ text: 'Later', variant: 'secondary' },
					]
				: [{ text: 'Okay' }],
		)
	} catch (e) {
		log('Update failed:', errorText(e))
		openAlert('Update failed', errorText(e))
	} finally {
		applyingUpdates = false
	}
}

function startUpdateChecker(storage: JsonStorage<Settings>): () => void {
	const getSettings = () => readSettings(storage.cache)

	// The set of updates the user was last asked about. Answering No (or closing
	// the popup) means we stay quiet until a different set of updates shows up.
	let lastAsked = ''
	let checking = false
	let stopped = false

	const check = async () => {
		if (checking || stopped || applyingUpdates) return
		checking = true
		try {
			log('Step 1: refreshing repositories')
			const { errors } = await refreshAllRepos()
			if (errors.length) {
				log(
					'Some repositories failed:',
					errors.map(e => `${e.url}: ${errorText(e.error)}`).join('; '),
				)
			}

			log('Step 2: checking installed plugins for updates')
			const all = await listUpdates()
			const safe = selectSafeUpdates(all)
			const updates = all.filter(u => safe.has(u.id))

			if (!updates.length) {
				log('No updates available')
				lastAsked = ''
				return
			}

			const signature = updates
				.map(u => `${u.id}@${u.available}`)
				.sort()
				.join('|')
			if (signature === lastAsked) {
				log('Already asked about these updates, staying quiet')
				return
			}
			lastAsked = signature

			log(`Step 3: ${updates.length} update(s) found, showing popup`)
			const sizes = await getUpdateSizes(updates)
			const ids = new Set(updates.map(u => u.id))

			openAlert(
				`${updates.length} plugin update${updates.length === 1 ? '' : 's'} available`,
				summarizeUpdates(updates, sizes),
				[
					{
						text: 'Yes',
						onPress: () => {
							log('User chose Yes')
							void applyUpdatesAndReload(ids)
						},
					},
					{
						text: 'No',
						variant: 'secondary',
						onPress: () => log('User chose No'),
					},
				],
			)
		} catch (e) {
			log('Update check failed:', errorText(e))
		} finally {
			checking = false
		}
	}

	let timer: ReturnType<typeof setInterval> | undefined
	let scheduled: { autoCheck: boolean; intervalMin: number } | undefined

	// (Re)starts the repeating check from the current settings.
	const schedule = () => {
		const { autoCheck, intervalMin } = getSettings()
		if (
			scheduled &&
			scheduled.autoCheck === autoCheck &&
			scheduled.intervalMin === intervalMin
		)
			return
		scheduled = { autoCheck, intervalMin }

		if (timer) clearInterval(timer)
		timer = undefined

		if (!autoCheck) {
			log('Automatic update checks are off')
			return
		}
		log(`Update checker running every ${intervalMin} minute(s)`)
		timer = setInterval(check, intervalMin * 60 * 1000)
	}

	const first = setTimeout(() => {
		if (getSettings().autoCheck) check()
	}, FIRST_CHECK_DELAY_MS)
	schedule()
	const unsubscribe = storage.subscribe(schedule)

	return () => {
		stopped = true
		clearTimeout(first)
		if (timer) clearInterval(timer)
		unsubscribe()
		log('Update checker stopped')
	}
}

/* -------------------------------------------------------------------------- */
/*  Settings → Revenge entry                                                  */
/* -------------------------------------------------------------------------- */

const SETTING_KEY = 'EvanPluginBrowser'
const ROUTE_NAME = 'Plugin Browser'

/** This plugin's own record and storage, so the screen can show its version and settings. */
let selfPlugin: AnyPlugin | undefined
let selfStorage: JsonStorage<Settings> | undefined

function PluginBrowserScreen() {
	return <PluginManagerScreen plugin={selfPlugin} storage={selfStorage} />
}

const PluginBrowserSetting: SettingsItem = {
	parent: null,
	type: 'route',
	IconComponent: () => <TableRowAssetIcon name="DownloadIcon" />,
	useTitle: () => 'Plugin Browser',
	screen: {
		route: ROUTE_NAME,
		getComponent: () => PluginBrowserScreen,
	},
}

/** Adds "Plugin Browser" to Settings → Revenge. Returns a function that removes it. */
function registerBrowserSetting() {
	const unregister = registerSettingsItem(SETTING_KEY, PluginBrowserSetting)

	let removeFromSection = noop
	try {
		removeFromSection = addSettingsItemToSection('REVENGE', SETTING_KEY)
	} catch (e) {
		log('Could not add the settings entry:', errorText(e))
	}

	refreshSettings()

	return () => {
		removeFromSection()
		unregister()
		refreshSettings()
	}
}

export default plugin({
	// Loaded up front so the checker can read the settings as soon as it starts.
	jsonStorage: { load: true, default: DEFAULTS },

	start({ cleanup, jsonStorage, logger, plugin: self }) {
		pluginLogger = logger
		selfPlugin = self as unknown as AnyPlugin
		selfStorage = jsonStorage as unknown as JsonStorage<Settings>

		const missing = missingInternals()
		if (missing.length) {
			// Don't start anything that would call what's missing. The screen explains why.
			logger.warn(
				`Revenge's plugin internals changed (missing: ${missing.join(', ')}). Update checks are paused.`,
			)
		} else {
			cleanup(startUpdateChecker(selfStorage))
		}

		// Registered once Discord's settings are ready, to keep startup fast.
		cleanup(
			onSettingsModulesLoaded(() => {
				cleanup(registerBrowserSetting())
			}),
		)
	},

	SettingsComponent({ api }) {
		return (
			<PluginManagerScreen
				plugin={api?.plugin as unknown as AnyPlugin | undefined}
				storage={api?.jsonStorage as unknown as JsonStorage<Settings>}
			/>
		)
	},
})
