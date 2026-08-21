import {
	type Component,
	requestUrl,
	type RequestUrlParam,
	setIcon,
} from "obsidian";
import type { HomeView } from "./view";
import {
	type DashboardCard,
	effectiveAutoRefreshMinutes,
	type GitlabConfig,
	type GitlabControl,
	type GitlabScope,
	type GitlabSelections,
} from "./types";
import { t } from "./i18n";

/**
 * The GitLab merge-request card: your own open merge requests as compact rows,
 * with refinement chips above them and a manual refresh.
 *
 * Shaped after the Jira card (`src/jira.ts`) — per-card connection settings, an
 * in-memory cache keyed on the config object, the same refresh/cache knobs — but
 * GitLab's API forces two differences:
 *
 * - **Refinement is local.** Jira pushes chip selections back into JQL; GitLab's
 *   merge-request list can filter on neither pipeline status nor approval state,
 *   so the card fetches once and filters the rows it already holds. Nothing is
 *   interpolated into a query, so there is no injection surface to guard here.
 * - **Rows need enriching.** `GET /merge_requests` returns neither the head
 *   pipeline nor approval state (checked against GitLab 17.4), so every row
 *   costs a detail request and an approvals request on top of the list.
 */

/** GitLab's REST base path. Fixed by GitLab — unlike Jira's versioned paths, so
 * this is a constant rather than a card setting. */
export const GITLAB_API_BASE_PATH = "/api/v4";

/** Refinement controls, in the order their chips appear above the list. */
export const GITLAB_CONTROLS: GitlabControl[] = [
	"project",
	"draft",
	"pipeline",
	"approval",
];

/** The `scope` values the card offers on GitLab's merge-request list. */
export const GITLAB_SCOPES: GitlabScope[] = ["created_by_me", "assigned_to_me"];

/** GitLab's own ceiling on `per_page`. */
export const GITLAB_MAX_RESULTS = 100;

/** Rows enriched at a time. Each row costs two more requests, so a small pool
 * keeps a full refresh from opening a hundred sockets against one instance. */
const ENRICH_CONCURRENCY = 6;

/** GitLab puts "Draft:" (historically "WIP:") in the title as well as in the
 * `draft` flag. The rows carry a Draft tag of their own, so strip it. */
const DRAFT_TITLE_PREFIX = /^(?:draft|wip):\s*/i;

/** A merge request flattened to what a row and the chips need. */
export interface GitlabMergeRequest {
	projectId: number;
	iid: number;
	/** Project path, e.g. `my-group/my-project`. */
	project: string;
	/** Reference within the project, e.g. `!130`. */
	reference: string;
	title: string;
	/** Absolute URL on the configured host. */
	webUrl: string;
	draft: boolean;
	/** Head pipeline status (`success`, `failed`, …), `"none"` when the merge
	 * request has no pipeline, and `null` when the detail request failed —
	 * unknown is deliberately not reported as "none". */
	pipeline: string | null;
	/** Whether every required approval is in, or `null` when approval state
	 * could not be read (the approvals endpoint is not on every plan). */
	approved: boolean | null;
	/** Approvals still required, when known. */
	approvalsLeft: number | null;
}

export type GitlabOptions = Record<GitlabControl, string[]>;

interface GitlabMergeRequestResponse {
	project_id?: unknown;
	iid?: unknown;
	title?: unknown;
	web_url?: unknown;
	draft?: unknown;
	work_in_progress?: unknown;
	references?: { full?: unknown } | null;
}

interface GitlabDetailResponse {
	head_pipeline?: { status?: unknown } | null;
}

interface GitlabApprovalsResponse {
	approved?: unknown;
	approvals_left?: unknown;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

const gitlabCache = new WeakMap<GitlabConfig, Map<string, CacheEntry<unknown>>>();

/** Split GitLab's `references.full` (`group/project!42`) into its parts, falling
 * back to the merge request's web URL when the reference is absent. */
export function parseGitlabReference(
	full: string | undefined,
	webUrl: string,
	iid: number,
): { project: string; reference: string } {
	const raw = (full ?? "").trim();
	const bang = raw.lastIndexOf("!");
	if (bang > 0) return { project: raw.slice(0, bang), reference: raw.slice(bang) };
	let project = "";
	try {
		// A merge request's path is /group/project/-/merge_requests/42.
		project = new URL(webUrl).pathname.split("/-/")[0].replace(/^\/+|\/+$/g, "");
	} catch {
		project = "";
	}
	return { project, reference: `!${iid}` };
}

/** Flatten one list entry, or drop it when GitLab did not return the fields a
 * row is built from. `origin` is the configured host's origin: a row's link is
 * opened in the browser, so a URL pointing anywhere else is not trusted. */
export function normalizeGitlabMergeRequest(
	raw: unknown,
	origin: string,
): GitlabMergeRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const mr = raw as GitlabMergeRequestResponse;
	const projectId = typeof mr.project_id === "number" ? mr.project_id : NaN;
	const iid = typeof mr.iid === "number" ? mr.iid : NaN;
	const rawTitle = typeof mr.title === "string" ? mr.title.trim() : "";
	const webUrl = typeof mr.web_url === "string" ? mr.web_url : "";
	if (!Number.isFinite(projectId) || !Number.isFinite(iid) || !rawTitle) return null;
	let parsed: URL;
	try {
		parsed = new URL(webUrl);
	} catch {
		return null;
	}
	if (parsed.origin !== origin) return null;
	const full = typeof mr.references?.full === "string" ? mr.references.full : undefined;
	const { project, reference } = parseGitlabReference(full, webUrl, iid);
	const title = rawTitle.replace(DRAFT_TITLE_PREFIX, "").trim() || rawTitle;
	return {
		projectId,
		iid,
		project,
		reference,
		title,
		webUrl,
		draft:
			mr.draft === true ||
			mr.work_in_progress === true ||
			DRAFT_TITLE_PREFIX.test(rawTitle),
		pipeline: null,
		approved: null,
		approvalsLeft: null,
	};
}

/** The value a row contributes to one control, or null when the data cannot
 * back it — so a chip never offers an option that filters everything away. */
export function gitlabControlValue(
	row: GitlabMergeRequest,
	control: GitlabControl,
): string | null {
	switch (control) {
		case "project":
			return row.project || null;
		case "draft":
			return row.draft ? "draft" : "ready";
		case "pipeline":
			return row.pipeline;
		case "approval":
			return row.approved === null ? null : row.approved ? "approved" : "unapproved";
	}
}

/** Derive chip options from the loaded rows, retaining persisted selections so
 * a value that has since disappeared still shows as checked. */
export function deriveGitlabOptions(
	rows: GitlabMergeRequest[],
	selections: GitlabSelections,
): GitlabOptions {
	const sets = Object.fromEntries(
		GITLAB_CONTROLS.map((control) => [control, new Set(selections[control] ?? [])]),
	) as Record<GitlabControl, Set<string>>;
	for (const row of rows) {
		for (const control of GITLAB_CONTROLS) {
			const value = gitlabControlValue(row, control);
			if (value) sets[control].add(value);
		}
	}
	return Object.fromEntries(
		GITLAB_CONTROLS.map((control) => [
			control,
			Array.from(sets[control]).sort((a, b) => a.localeCompare(b)),
		]),
	) as GitlabOptions;
}

/** Apply the persisted chip selections: values within one control are OR-ed,
 * controls are AND-ed — the shape of the Jira card's JQL clauses, done locally
 * because GitLab cannot filter on pipeline or approval state. */
export function filterGitlabMergeRequests(
	rows: GitlabMergeRequest[],
	selections: GitlabSelections,
): GitlabMergeRequest[] {
	const active = GITLAB_CONTROLS.map((control) => ({
		control,
		values: (selections[control] ?? []).filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		),
	})).filter((entry) => entry.values.length > 0);
	if (!active.length) return [...rows];
	return rows.filter((row) =>
		active.every(({ control, values }) => {
			const value = gitlabControlValue(row, control);
			return value !== null && values.includes(value);
		}),
	);
}

/** Narrow a control's options with a case-insensitive substring query. */
export function filterGitlabOptions(values: string[], query: string): string[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return [...values];
	return values.filter((value) => value.toLocaleLowerCase().includes(needle));
}

/** Badge tone for a pipeline status. GitLab's vocabulary keeps growing, so an
 * unrecognized status reads as neutral rather than as a guess. */
export function pipelineStatusClass(status: string | null): string {
	switch (status) {
		case "success":
			return "is-success";
		case "failed":
			return "is-failed";
		case "running":
		case "pending":
		case "created":
		case "preparing":
		case "waiting_for_resource":
		case "scheduled":
			return "is-running";
		default:
			return "is-idle";
	}
}

function validatedHost(host: string): URL {
	const parsed = new URL(host);
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error("invalid-host");
	}
	return parsed;
}

function relativePath(path: string): string {
	if (
		!path.startsWith("/") ||
		path.startsWith("//") ||
		path.includes("\\") ||
		path.includes("?") ||
		path.includes("#") ||
		/^[a-z][a-z0-9+.-]*:/i.test(path)
	) {
		throw new Error("invalid-api-path");
	}
	return path.replace(/\/+$/, "");
}

/** Build a GitLab REST URL that cannot escape the explicitly configured host. */
export function buildGitlabUrl(
	host: string,
	endpoint: string,
	query?: Record<string, string>,
): URL {
	const parsedHost = validatedHost(host);
	const endpointPath = relativePath(endpoint);
	const hostPath = parsedHost.pathname.replace(/\/+$/, "");
	const url = new URL(parsedHost.origin);
	url.pathname = `${hostPath}${GITLAB_API_BASE_PATH}${endpointPath}`;
	for (const [key, value] of Object.entries(query ?? {})) {
		url.searchParams.set(key, value);
	}
	if (url.origin !== parsedHost.origin) throw new Error("cross-origin-request");
	return url;
}

function ttlMs(config: GitlabConfig): number {
	return Math.max(0, config.cacheMin ?? 5) * 60_000;
}

function cacheGet<T>(config: GitlabConfig, key: string): T | null {
	const cache = gitlabCache.get(config);
	const entry = cache?.get(key) as CacheEntry<T> | undefined;
	if (!entry || entry.expiresAt <= Date.now()) {
		if (entry) cache?.delete(key);
		return null;
	}
	return entry.value;
}

function cacheSet<T>(key: string, value: T, config: GitlabConfig): void {
	const ttl = ttlMs(config);
	if (ttl <= 0) return;
	let cache = gitlabCache.get(config);
	if (!cache) {
		cache = new Map<string, CacheEntry<unknown>>();
		gitlabCache.set(config, cache);
	}
	cache.set(key, { value, expiresAt: Date.now() + ttl });
}

/** Drop every cached response associated with this card's connection object. */
export function clearGitlabCache(config: GitlabConfig): void {
	gitlabCache.delete(config);
}

async function requestGitlab<T>(
	config: GitlabConfig,
	endpoint: string,
	query?: Record<string, string>,
	force = false,
): Promise<T> {
	const url = buildGitlabUrl(config.host ?? "", endpoint, query);
	const key = url.toString();
	if (!force) {
		const cached = cacheGet<T>(config, key);
		if (cached !== null) return cached;
	}
	const params: RequestUrlParam = {
		url: key,
		method: "GET",
		throw: false,
		headers: {
			// SECURITY-REVIEW: The PAT is read from per-card plugin data and sent
			// only to the validated GitLab origin. It is never logged or included
			// in an error. PRIVATE-TOKEN is GitLab's documented header for a
			// personal access token.
			"PRIVATE-TOKEN": config.pat ?? "",
			Accept: "application/json",
		},
	};
	// SECURITY-REVIEW: External request target is constructed by buildGitlabUrl,
	// restricted to the configured HTTPS origin and relative REST paths.
	const response = await requestUrl(params);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`gitlab-http-${response.status}`);
	}
	if (!response.json || typeof response.json !== "object") {
		throw new Error("gitlab-invalid-response");
	}
	const value = response.json as T;
	cacheSet(key, value, config);
	return value;
}

/** Run `work` over `items` with at most `limit` of them in flight. */
export async function mapWithConcurrency<T>(
	items: T[],
	limit: number,
	work: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (next < items.length) {
				await work(items[next++]);
			}
		},
	);
	await Promise.all(workers);
}

/** Fill in the two things the list endpoint leaves out. A failure on either
 * leaves that field unknown rather than failing the whole card. */
async function enrichMergeRequest(
	config: GitlabConfig,
	row: GitlabMergeRequest,
	force: boolean,
): Promise<void> {
	const path = `/projects/${row.projectId}/merge_requests/${row.iid}`;
	const [detail, approvals] = await Promise.all([
		requestGitlab<GitlabDetailResponse>(config, path, undefined, force).catch(
			() => null,
		),
		requestGitlab<GitlabApprovalsResponse>(
			config,
			`${path}/approvals`,
			undefined,
			force,
		).catch(() => null),
	]);
	if (detail) {
		const status = detail.head_pipeline?.status;
		row.pipeline = typeof status === "string" && status ? status : "none";
	}
	if (approvals && typeof approvals.approved === "boolean") {
		row.approved = approvals.approved;
		row.approvalsLeft =
			typeof approvals.approvals_left === "number" ? approvals.approvals_left : null;
	}
}

/** Load the configured scope of open merge requests, enriched with pipeline and
 * approval state. */
export async function loadGitlabMergeRequests(
	config: GitlabConfig,
	force: boolean,
): Promise<GitlabMergeRequest[]> {
	const origin = validatedHost(config.host ?? "").origin;
	const scope: GitlabScope =
		config.scope === "assigned_to_me" ? "assigned_to_me" : "created_by_me";
	const response = await requestGitlab<unknown>(
		config,
		"/merge_requests",
		{
			scope,
			state: "opened",
			order_by: "updated_at",
			sort: "desc",
			per_page: String(
				Math.max(1, Math.min(GITLAB_MAX_RESULTS, config.maxResults ?? 25)),
			),
		},
		force,
	);
	if (!Array.isArray(response)) return [];
	const rows = response
		.map((raw) => normalizeGitlabMergeRequest(raw, origin))
		.filter((row): row is GitlabMergeRequest => row !== null);
	await mapWithConcurrency(rows, ENRICH_CONCURRENCY, (row) =>
		enrichMergeRequest(config, row, force),
	);
	return rows;
}

function controlLabel(control: GitlabControl): string {
	return t().cards.gitlab.controls[control];
}

/** The display label for one chip option. Pipeline statuses, draft state and
 * approval state are tokens, so they are translated; a project path is data and
 * shown as GitLab returned it. An unknown pipeline status falls back to the raw
 * value rather than to nothing. */
export function gitlabOptionLabel(control: GitlabControl, value: string): string {
	const strings = t().cards.gitlab;
	const table: Record<string, string> | null =
		control === "pipeline"
			? strings.pipelineValues
			: control === "draft"
				? strings.draftValues
				: control === "approval"
					? strings.approvalValues
					: null;
	return table?.[value] ?? value;
}

/** Render the GitLab merge-request card. */
export function renderGitlabCard(
	view: HomeView,
	card: DashboardCard,
	body: HTMLElement,
	component: Component,
): void {
	const config = card.gitlab ?? {};
	const strings = t().cards.gitlab;
	const wrap = body.createDiv("hearth-gitlab");
	if (view.plugin.settings.disableExternalCalls) {
		wrap.createDiv({ cls: "hearth-gitlab-state", text: strings.disabled });
		return;
	}
	if (!config.host?.trim() || !config.pat?.trim()) {
		wrap.createDiv({ cls: "hearth-gitlab-state", text: strings.notConfigured });
		return;
	}

	let destroyed = false;
	let loading = false;
	let error = false;
	let rows: GitlabMergeRequest[] = [];
	let options: GitlabOptions = {
		project: [],
		draft: [],
		pipeline: [],
		approval: [],
	};
	let saveTimer = 0;

	const selections = (config.selections ??= {});
	const persistSelections = (): void => {
		window.clearTimeout(saveTimer);
		saveTimer = window.setTimeout(() => {
			if (!destroyed) void view.plugin.saveData(view.plugin.settings);
		}, 300);
	};

	const toolbar = wrap.createDiv("hearth-gitlab-toolbar");
	const content = wrap.createDiv("hearth-gitlab-list");
	let refreshButton: HTMLButtonElement | null = null;

	const paintLoading = (): void => {
		refreshButton?.toggleClass("is-loading", loading);
	};

	const approvalLabel = (row: GitlabMergeRequest): string => {
		if (row.approved) return strings.approvalValues.approved;
		return row.approvalsLeft
			? strings.approvalsLeft(row.approvalsLeft)
			: strings.approvalValues.unapproved;
	};

	const paintRows = (): void => {
		if (destroyed) return;
		content.empty();
		if (loading && !rows.length) {
			content.createDiv({ cls: "hearth-gitlab-state", text: strings.loading });
			return;
		}
		if (error && !rows.length) {
			content.createDiv({ cls: "hearth-gitlab-state", text: strings.error });
			return;
		}
		const visible = filterGitlabMergeRequests(rows, selections);
		if (!visible.length) {
			content.createDiv({ cls: "hearth-gitlab-state", text: strings.empty });
			return;
		}
		for (const row of visible) {
			const item = content.createEl("button", { cls: "hearth-gitlab-mr" });
			item.addEventListener("click", () =>
				window.open(row.webUrl, "_blank", "noopener"),
			);
			const icon = item.createDiv("hearth-gitlab-icon");
			setIcon(icon, "git-pull-request");
			const main = item.createDiv("hearth-gitlab-main");
			const meta = main.createDiv("hearth-gitlab-meta");
			meta.createSpan({ cls: "hearth-gitlab-project", text: row.project });
			meta.createSpan({ cls: "hearth-gitlab-ref", text: row.reference });
			if (row.draft) {
				meta.createSpan({ cls: "hearth-gitlab-draft", text: strings.draftTag });
			}
			main.createDiv({ cls: "hearth-gitlab-title", text: row.title });
			const badges = item.createDiv("hearth-gitlab-badges");
			if (row.approved !== null) {
				badges.createSpan({
					cls: `hearth-gitlab-approval ${row.approved ? "is-approved" : "is-unapproved"}`,
					text: approvalLabel(row),
				});
			}
			if (row.pipeline !== null) {
				badges.createSpan({
					cls: `hearth-gitlab-pipeline ${pipelineStatusClass(row.pipeline)}`,
					text: gitlabOptionLabel("pipeline", row.pipeline),
				});
			}
		}
	};

	const paintToolbar = (): void => {
		if (destroyed) return;
		toolbar.empty();
		const enabled = config.controls ?? GITLAB_CONTROLS;
		for (const control of enabled) {
			const details = toolbar.createEl("details", { cls: "hearth-gitlab-filter" });
			const selected = selections[control] ?? [];
			const summary = details.createEl("summary");
			summary.setText(
				selected.length
					? strings.controlCount(controlLabel(control), selected.length)
					: controlLabel(control),
			);
			const menu = details.createDiv("hearth-gitlab-filter-menu");
			const values = options[control];
			const searchWrap = menu.createDiv("hearth-gitlab-filter-search");
			const search = searchWrap.createEl("input", {
				attr: {
					"aria-label": strings.searchAria(controlLabel(control)),
					autocomplete: "off",
					spellcheck: "false",
				},
			});
			search.type = "search";
			search.placeholder = strings.searchPlaceholder;
			const optionList = menu.createDiv("hearth-gitlab-filter-options");
			const paintOptions = (): void => {
				optionList.empty();
				const filtered = filterGitlabOptions(values, search.value);
				if (!filtered.length) {
					optionList.createDiv({
						cls: "hearth-gitlab-filter-empty",
						text: values.length ? strings.noMatchingOptions : strings.noOptions,
						attr: { role: "status" },
					});
					return;
				}
				for (const value of filtered) {
					const label = optionList.createEl("label", {
						cls: "hearth-gitlab-filter-option",
					});
					const input = label.createEl("input");
					input.type = "checkbox";
					input.checked = (selections[control] ?? []).includes(value);
					label.createSpan({ text: gitlabOptionLabel(control, value) });
					input.addEventListener("change", () => {
						const next = new Set(selections[control] ?? []);
						if (input.checked) next.add(value);
						else next.delete(value);
						selections[control] = Array.from(next);
						summary.setText(
							next.size
								? strings.controlCount(controlLabel(control), next.size)
								: controlLabel(control),
						);
						persistSelections();
						paintRows();
					});
				}
			};
			search.addEventListener("input", paintOptions);
			details.addEventListener("toggle", () => {
				if (details.open) {
					window.requestAnimationFrame(() => {
						if (!destroyed && search.isConnected) search.focus();
					});
					return;
				}
				search.value = "";
				paintOptions();
			});
			paintOptions();
		}
		refreshButton = toolbar.createEl("button", {
			cls: "hearth-gitlab-refresh",
			attr: { "aria-label": strings.refresh },
		});
		setIcon(refreshButton, "refresh-cw");
		paintLoading();
		refreshButton.addEventListener("click", () => void load(true));
	};

	const load = async (force: boolean): Promise<void> => {
		// Nothing the chips do refetches (refinement is local), so the only
		// concurrent callers are the refresh button and the timer: dropping a
		// request while one is in flight is enough serialization.
		if (destroyed || loading) return;
		loading = true;
		error = false;
		paintLoading();
		paintRows();
		try {
			const loaded = await loadGitlabMergeRequests(config, force);
			if (destroyed) return;
			rows = loaded;
			options = deriveGitlabOptions(rows, selections);
			paintToolbar();
		} catch {
			if (destroyed) return;
			error = true;
		} finally {
			if (!destroyed) {
				loading = false;
				paintLoading();
				paintRows();
			}
		}
	};

	component.register(() => {
		destroyed = true;
		window.clearTimeout(saveTimer);
	});

	paintToolbar();
	paintRows();
	void load(false);
	// Low power mode reports 0 here, so GitLab is fetched on render and on the
	// manual refresh only — never on a timer.
	const refreshMin = effectiveAutoRefreshMinutes(
		view.plugin.settings,
		Math.max(0, config.refreshMin ?? 0),
	);
	if (refreshMin > 0) {
		component.registerInterval(
			window.setInterval(() => void load(true), refreshMin * 60_000),
		);
	}
}
