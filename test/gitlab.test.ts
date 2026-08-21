import { describe, expect, it } from "vitest";
import {
	buildGitlabUrl,
	deriveGitlabOptions,
	filterGitlabMergeRequests,
	filterGitlabOptions,
	type GitlabMergeRequest,
	gitlabControlValue,
	mapWithConcurrency,
	normalizeGitlabMergeRequest,
	parseGitlabReference,
	pipelineStatusClass,
} from "../src/gitlab";
import { exportLayout, exportSettings, sanitizeGitlab } from "../src/layout";
import {
	DEFAULT_SETTINGS,
	type DashboardCard,
	type GitlabSelections,
	type HomeSettings,
} from "../src/types";

const ORIGIN = "https://gitlab.example.com";

/** A merge-request row with everything known, overridable per test. */
function row(overrides: Partial<GitlabMergeRequest> = {}): GitlabMergeRequest {
	return {
		projectId: 1,
		iid: 7,
		project: "group/app",
		reference: "!7",
		title: "Add a thing",
		webUrl: `${ORIGIN}/group/app/-/merge_requests/7`,
		draft: false,
		pipeline: "success",
		approved: true,
		approvalsLeft: 0,
		...overrides,
	};
}

describe("parseGitlabReference", () => {
	it("splits references.full into project path and reference", () => {
		expect(parseGitlabReference("group/sub/app!42", "", 42)).toEqual({
			project: "group/sub/app",
			reference: "!42",
		});
	});

	it("falls back to the web URL path when the reference is missing", () => {
		expect(
			parseGitlabReference(undefined, `${ORIGIN}/group/app/-/merge_requests/9`, 9),
		).toEqual({ project: "group/app", reference: "!9" });
	});

	it("survives a reference and a URL it cannot parse", () => {
		expect(parseGitlabReference("!5", "not a url", 5)).toEqual({
			project: "",
			reference: "!5",
		});
	});
});

describe("normalizeGitlabMergeRequest", () => {
	const raw = {
		project_id: 1265,
		iid: 185,
		title: "Draft: Wire the launcher",
		web_url: `${ORIGIN}/karen/app/-/merge_requests/185`,
		draft: true,
		references: { full: "karen/app!185" },
	};

	it("flattens a list entry and strips the draft title prefix", () => {
		expect(normalizeGitlabMergeRequest(raw, ORIGIN)).toEqual({
			projectId: 1265,
			iid: 185,
			project: "karen/app",
			reference: "!185",
			title: "Wire the launcher",
			webUrl: `${ORIGIN}/karen/app/-/merge_requests/185`,
			draft: true,
			// Pipeline and approval state are not in the list response; they stay
			// unknown until the per-row enrichment requests fill them in.
			pipeline: null,
			approved: null,
			approvalsLeft: null,
		});
	});

	it("reads a draft off the title even when the flag is absent", () => {
		const legacy = normalizeGitlabMergeRequest(
			{ ...raw, draft: undefined, work_in_progress: undefined },
			ORIGIN,
		);
		expect(legacy?.draft).toBe(true);
	});

	it("drops entries missing the fields a row is built from", () => {
		expect(normalizeGitlabMergeRequest(null, ORIGIN)).toBeNull();
		expect(normalizeGitlabMergeRequest({ ...raw, iid: "185" }, ORIGIN)).toBeNull();
		expect(normalizeGitlabMergeRequest({ ...raw, title: "  " }, ORIGIN)).toBeNull();
		expect(normalizeGitlabMergeRequest({ ...raw, web_url: "nope" }, ORIGIN)).toBeNull();
	});

	it("refuses a link that leaves the configured host", () => {
		// The row's URL is opened in the browser, so a hostile or mistaken
		// response must not be able to send the user somewhere else.
		expect(
			normalizeGitlabMergeRequest(
				{ ...raw, web_url: "https://evil.example/karen/app/-/merge_requests/185" },
				ORIGIN,
			),
		).toBeNull();
		expect(
			normalizeGitlabMergeRequest({ ...raw, web_url: "javascript:alert(1)" }, ORIGIN),
		).toBeNull();
	});
});

describe("gitlabControlValue", () => {
	it("maps each control onto a stable token", () => {
		const mr = row({ draft: true, pipeline: "failed", approved: false });
		expect(gitlabControlValue(mr, "project")).toBe("group/app");
		expect(gitlabControlValue(mr, "draft")).toBe("draft");
		expect(gitlabControlValue(mr, "pipeline")).toBe("failed");
		expect(gitlabControlValue(mr, "approval")).toBe("unapproved");
	});

	it("reports unknown rather than guessing when enrichment failed", () => {
		const mr = row({ pipeline: null, approved: null, project: "" });
		expect(gitlabControlValue(mr, "pipeline")).toBeNull();
		expect(gitlabControlValue(mr, "approval")).toBeNull();
		expect(gitlabControlValue(mr, "project")).toBeNull();
	});
});

describe("deriveGitlabOptions", () => {
	it("derives sorted unique options and keeps selected missing values", () => {
		const options = deriveGitlabOptions(
			[
				row({ project: "group/app", draft: true, pipeline: "failed", approved: false }),
				row({ project: "group/api", pipeline: "success", approved: true }),
				row({ project: "group/api", pipeline: null, approved: null }),
			],
			{ project: ["group/gone"] },
		);
		expect(options.project).toEqual(["group/api", "group/app", "group/gone"]);
		expect(options.draft).toEqual(["draft", "ready"]);
		expect(options.pipeline).toEqual(["failed", "success"]);
		expect(options.approval).toEqual(["approved", "unapproved"]);
	});

	it("offers no option a control cannot populate", () => {
		const options = deriveGitlabOptions([row({ pipeline: null, approved: null })], {});
		expect(options.pipeline).toEqual([]);
		expect(options.approval).toEqual([]);
	});
});

describe("filterGitlabMergeRequests", () => {
	const rows = [
		row({ iid: 1, project: "group/app", pipeline: "success", approved: true }),
		row({ iid: 2, project: "group/api", pipeline: "failed", approved: false, draft: true }),
		row({ iid: 3, project: "group/api", pipeline: null, approved: null }),
	];

	it("returns a copy of every row when nothing is selected", () => {
		const all = filterGitlabMergeRequests(rows, {});
		expect(all).toEqual(rows);
		expect(all).not.toBe(rows);
	});

	it("ORs values within a control and ANDs across controls", () => {
		const selections: GitlabSelections = {
			project: ["group/api", "group/app"],
			pipeline: ["failed"],
		};
		expect(filterGitlabMergeRequests(rows, selections).map((r) => r.iid)).toEqual([2]);
	});

	it("hides rows whose value for an active control is unknown", () => {
		expect(
			filterGitlabMergeRequests(rows, { approval: ["approved", "unapproved"] }).map(
				(r) => r.iid,
			),
		).toEqual([1, 2]);
	});

	it("ignores empty and non-string selections", () => {
		const selections = { project: ["", null] } as unknown as GitlabSelections;
		expect(filterGitlabMergeRequests(rows, selections)).toHaveLength(3);
	});
});

describe("filterGitlabOptions", () => {
	const options = ["group/api", "group/app", "other/tool"];

	it("returns every option for an empty or whitespace-only query", () => {
		const unfiltered = filterGitlabOptions(options, "");
		expect(unfiltered).toEqual(options);
		expect(unfiltered).not.toBe(options);
		expect(filterGitlabOptions(options, "   ")).toEqual(options);
	});

	it("matches case-insensitive substrings after trimming the query", () => {
		expect(filterGitlabOptions(options, "  GROUP/A  ")).toEqual([
			"group/api",
			"group/app",
		]);
	});
});

describe("pipelineStatusClass", () => {
	it("tones the statuses GitLab documents", () => {
		expect(pipelineStatusClass("success")).toBe("is-success");
		expect(pipelineStatusClass("failed")).toBe("is-failed");
		expect(pipelineStatusClass("running")).toBe("is-running");
		expect(pipelineStatusClass("pending")).toBe("is-running");
	});

	it("stays neutral for no pipeline and for a status it has never seen", () => {
		expect(pipelineStatusClass("none")).toBe("is-idle");
		expect(pipelineStatusClass(null)).toBe("is-idle");
		expect(pipelineStatusClass("teleported")).toBe("is-idle");
	});
});

describe("buildGitlabUrl", () => {
	it("builds v4 API URLs beneath the configured host", () => {
		expect(
			buildGitlabUrl("https://gitlab.example.com/", "/merge_requests", {
				scope: "created_by_me",
				state: "opened",
			}).toString(),
		).toBe(
			"https://gitlab.example.com/api/v4/merge_requests?scope=created_by_me&state=opened",
		);
	});

	it("keeps an instance hosted under a subpath", () => {
		expect(
			buildGitlabUrl("https://example.com/gitlab", "/projects/1/merge_requests/2").toString(),
		).toBe("https://example.com/gitlab/api/v4/projects/1/merge_requests/2");
	});

	it("rejects unsupported hosts and absolute endpoints", () => {
		expect(() => buildGitlabUrl("file:///etc", "/merge_requests")).toThrow();
		expect(() => buildGitlabUrl("http://gitlab.example.com", "/merge_requests")).toThrow();
		expect(() =>
			buildGitlabUrl("https://gitlab.example.com", "https://evil.example/merge_requests"),
		).toThrow();
		expect(() =>
			buildGitlabUrl("https://gitlab.example.com", "/merge_requests?private_token=x"),
		).toThrow();
	});
});

describe("mapWithConcurrency", () => {
	it("visits every item without exceeding the limit", async () => {
		const order: number[] = [];
		let inFlight = 0;
		let peak = 0;
		await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Promise.resolve();
			order.push(item);
			inFlight--;
		});
		expect(order.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(peak).toBeLessThanOrEqual(3);
	});

	it("does nothing for an empty list", async () => {
		const seen: unknown[] = [];
		await mapWithConcurrency([], 4, async (item) => {
			seen.push(item);
		});
		expect(seen).toEqual([]);
	});
});

function gitlabCard(id: string, pat: string): DashboardCard {
	return {
		id,
		kind: "gitlab",
		x: 0,
		y: 0,
		w: 4,
		h: 4,
		gitlab: {
			host: "https://gitlab.example.com",
			pat,
			scope: "created_by_me",
			maxResults: 25,
		},
	};
}

function settingsWithGitlab(pat: string): HomeSettings {
	return {
		...DEFAULT_SETTINGS,
		dashboards: [
			{ id: "dashboard", name: "Dashboard", cards: [gitlabCard("card", pat)] },
		],
		activeDashboardId: "dashboard",
		pinnedCards: [gitlabCard("pinned", pat)],
	};
}

describe("GitLab export credential scrubbing", () => {
	it("excludes PATs from layout exports without mutating live settings", () => {
		const sentinel = "GITLAB_PAT_SENTINEL_LAYOUT";
		const settings = settingsWithGitlab(sentinel);
		const exported = exportLayout(settings);

		expect(exported).not.toContain(sentinel);
		expect(exported).toContain("https://gitlab.example.com");
		expect(settings.dashboards[0].cards[0].gitlab?.pat).toBe(sentinel);
		expect(settings.pinnedCards[0].gitlab?.pat).toBe(sentinel);
	});

	it("excludes PATs from full settings exports without mutating live settings", () => {
		const sentinel = "GITLAB_PAT_SENTINEL_SETTINGS";
		const settings = settingsWithGitlab(sentinel);
		const exported = exportSettings(settings);

		expect(exported).not.toContain(sentinel);
		expect(exported).toContain("https://gitlab.example.com");
		expect(settings.dashboards[0].cards[0].gitlab?.pat).toBe(sentinel);
		expect(settings.pinnedCards[0].gitlab?.pat).toBe(sentinel);
	});
});

describe("sanitizeGitlab", () => {
	it("allowlists and clamps a valid imported configuration", () => {
		expect(
			sanitizeGitlab({
				host: "https://gitlab.example.com/",
				pat: "secret",
				scope: "assigned_to_me",
				controls: ["project", "pipeline", "invalid"],
				selections: {
					project: ["group/app", 3],
					pipeline: ["success"],
					other: ["drop"],
				},
				maxResults: 9999,
				refreshMin: -4,
				cacheMin: 12,
				untrusted: "drop",
			}),
		).toEqual({
			host: "https://gitlab.example.com",
			pat: "secret",
			scope: "assigned_to_me",
			controls: ["project", "pipeline"],
			selections: { project: ["group/app"], pipeline: ["success"] },
			maxResults: 100,
			refreshMin: 0,
			cacheMin: 12,
		});
	});

	it("does not crash on malformed nested values", () => {
		expect(sanitizeGitlab(null)).toEqual({});
		expect(sanitizeGitlab({ controls: "project", selections: 42 })).toEqual({});
		expect(sanitizeGitlab({ scope: "everyone" })).toEqual({});
		expect(sanitizeGitlab({ selections: { project: null, draft: "bad" } })).toEqual({
			selections: {},
		});
	});
});
