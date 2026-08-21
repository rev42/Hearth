import { Setting } from "obsidian";
import { t } from "../i18n";
import {
	clearGitlabCache,
	GITLAB_CONTROLS,
	GITLAB_MAX_RESULTS,
	GITLAB_SCOPES,
	renderGitlabCard,
} from "../gitlab";
import { type GitlabControl, type GitlabScope } from "../types";
import { type CardDefinition, type CardEditorContext } from "./definition";

export function gitlabEditor(ctx: CardEditorContext, containerEl: HTMLElement): void {
	const cfg = (ctx.card.gitlab ??= {});
	const strings = t().editors.gitlab;

	new Setting(containerEl)
		.setName(strings.host)
		.setDesc(strings.hostDesc)
		.addText((txt) =>
			txt
				.setPlaceholder(strings.hostPlaceholder)
				.setValue(cfg.host ?? "")
				.onChange((value) => {
					const next = value.trim().replace(/\/+$/, "") || undefined;
					if (next !== cfg.host) clearGitlabCache(cfg);
					cfg.host = next;
					ctx.opts.save();
				}),
		);

	new Setting(containerEl)
		.setName(strings.pat)
		.setDesc(strings.patDesc)
		.addText((txt) => {
			txt.setValue(cfg.pat ?? "").onChange((value) => {
				// SECURITY-REVIEW: PAT remains in the password control and per-card
				// plugin data; it is never displayed elsewhere or logged.
				const next = value || undefined;
				if (next !== cfg.pat) clearGitlabCache(cfg);
				cfg.pat = next;
				ctx.opts.save();
			});
			txt.inputEl.type = "password";
			txt.inputEl.autocomplete = "off";
		});

	new Setting(containerEl)
		.setName(strings.scope)
		.setDesc(strings.scopeDesc)
		.addDropdown((dropdown) => {
			for (const scope of GITLAB_SCOPES) {
				dropdown.addOption(scope, strings.scopes[scope]);
			}
			dropdown.setValue(cfg.scope ?? "created_by_me").onChange((value) => {
				const next = value as GitlabScope;
				if (next !== cfg.scope) clearGitlabCache(cfg);
				cfg.scope = next;
				cfg.selections = {};
				ctx.opts.save();
				ctx.opts.rerender();
			});
		});

	new Setting(containerEl).setName(strings.controls).setHeading();
	const enabled = new Set<GitlabControl>(cfg.controls ?? GITLAB_CONTROLS);
	for (const control of GITLAB_CONTROLS) {
		new Setting(containerEl)
			.setName(t().cards.gitlab.controls[control])
			.addToggle((toggle) =>
				toggle.setValue(enabled.has(control)).onChange((value) => {
					if (value) enabled.add(control);
					else enabled.delete(control);
					cfg.controls = GITLAB_CONTROLS.filter((item) => enabled.has(item));
					ctx.opts.save();
					ctx.opts.rerender();
				}),
			);
	}

	const maxResults = new Setting(containerEl)
		.setName(strings.maxResults)
		.setDesc(strings.maxResultsDesc);
	maxResults.addText((txt) => {
		txt.setValue(String(cfg.maxResults ?? 25)).onChange((value) => {
			const parsed = parseInt(value, 10);
			cfg.maxResults =
				Number.isNaN(parsed) || parsed <= 0
					? undefined
					: Math.min(GITLAB_MAX_RESULTS, parsed);
			ctx.opts.save();
		});
		txt.inputEl.type = "number";
		txt.inputEl.min = "1";
		txt.inputEl.max = String(GITLAB_MAX_RESULTS);
		txt.inputEl.addClass("hearth-count-input");
	});

	const numberSetting = (
		name: string,
		description: string,
		value: number,
		update: (next: number | undefined) => void,
	): void => {
		new Setting(containerEl)
			.setName(name)
			.setDesc(description)
			.addText((txt) => {
				txt.setValue(String(value)).onChange((raw) => {
					const parsed = parseInt(raw, 10);
					update(Number.isNaN(parsed) || parsed < 0 ? undefined : parsed);
					ctx.opts.save();
				});
				txt.inputEl.type = "number";
				txt.inputEl.min = "0";
				txt.inputEl.addClass("hearth-count-input");
			});
	};
	numberSetting(
		strings.refresh,
		strings.refreshDesc,
		cfg.refreshMin ?? 0,
		(value) => {
			cfg.refreshMin = value;
		},
	);
	numberSetting(strings.cache, strings.cacheDesc, cfg.cacheMin ?? 5, (value) => {
		cfg.cacheMin = value;
	});
}

/** A GitLab card listing your open merge requests, with refinement controls. */
export const gitlabCard: CardDefinition<"gitlab"> = {
	kind: "gitlab",
	templates: [
		{
			id: "gitlab",
			name: "GitLab merge requests",
			icon: "git-pull-request",
			build: () => ({
				kind: "gitlab",
				title: "GitLab",
				gitlab: {
					scope: "created_by_me",
					controls: ["project", "draft", "pipeline", "approval"],
					maxResults: 25,
					refreshMin: 0,
					cacheMin: 5,
				},
				w: 6,
				h: 5,
			}),
		},
	],
	render: (view, card, body, component) => renderGitlabCard(view, card, body, component),
	renderEditor: (container, ctx) => gitlabEditor(ctx, container),
	cloneConfig: (source, copy) => {
		if (source.gitlab)
			copy.gitlab = {
				...source.gitlab,
				controls: source.gitlab.controls ? [...source.gitlab.controls] : undefined,
				selections: source.gitlab.selections
					? Object.fromEntries(
							Object.entries(source.gitlab.selections).map(([key, values]) => [
								key,
								values ? [...values] : values,
							]),
						)
					: undefined,
			};
	},
	liveness: { mode: "static" },
};
