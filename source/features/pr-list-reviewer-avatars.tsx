import './pr-list-reviewer-avatars.css';

import batchedFunction from 'batched-function';
import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import {closestElement} from 'select-dom';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import getUserAvatarURL from '../github-helpers/get-user-avatar.js';
import observe from '../helpers/selector-observer.js';

type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING';

type Reviewer = {
	login: string;
	avatarUrl: string;
	state: ReviewState;
};

type Pr = {
	link: HTMLAnchorElement;
	owner: string;
	repo: string;
	number: number;
};

function buildQuery(prsByRepo: Map<string, Pr[]>): string {
	return [...prsByRepo.values()].map(prs => {
		const {owner, repo} = prs[0];
		return `
			${api.escapeKey('repo', owner, repo)}: repository(owner: "${owner}", name: "${repo}") {
				${
					prs.map(pr => `
					${api.escapeKey('pr', pr.number)}: pullRequest(number: ${pr.number}) {
						author { login }
						reviewRequests(first: 10) {
							nodes {
								requestedReviewer {
									... on User { login avatarUrl }
									... on Team { login: combinedSlug avatarUrl }
								}
							}
						}
						reviews(last: 20) {
							nodes {
								state
								author { login avatarUrl }
							}
						}
						reviewThreads(first: 100) {
							nodes {
								isResolved
							}
						}
					}
				`).join('\n')
				}
			}
		`;
	}).join('\n');
}

function renderUnresolvedComments(pr: Pr, count: number): void {
	if (count === 0) {
		return;
	}

	const badge = (
		<span className="rgh-unresolved-comments ml-2 tmp-ml-2">
			{count} unresolved
		</span>
	);

	const metadataRow = pr.link.matches('.js-issue-row *')
		? pr.link.closest('.js-issue-row')!.querySelector('.text-small.color-fg-muted .d-none.d-md-inline-flex')
		: closestElement('li', pr.link)?.querySelector(
			'div[data-testid="list-row-repo-name-and-number"], div[class^="Description"]',
		);

	metadataRow?.append(badge);
}

function renderReviewers(pr: Pr, reviewers: Reviewer[]): void {
	if (reviewers.length === 0) {
		return;
	}

	const avatarStack = (
		<span className="rgh-reviewer-avatars ml-2 tmp-ml-2">
			{reviewers.map(reviewer => {
				const isTeam = reviewer.login.includes('/');
				const avatarUrl = isTeam
					? reviewer.avatarUrl + '&s=40'
					: (getUserAvatarURL(reviewer.login, 20) ?? reviewer.avatarUrl + '&s=40');
				const href = isTeam
					? `/orgs/${reviewer.login.replace('/', '/teams/')}`
					: `/${reviewer.login}`;
				const stateClass = reviewer.state === 'APPROVED'
					? 'rgh-reviewer-avatar--approved'
					: reviewer.state === 'CHANGES_REQUESTED' || reviewer.state === 'COMMENTED'
						? 'rgh-reviewer-avatar--needs-work'
						: '';
				return (
					<a href={href} title={reviewer.login}>
						<img
							className={`rgh-reviewer-avatar${stateClass ? ` ${stateClass}` : ''}`}
							src={avatarUrl}
							width={20}
							height={20}
							loading="lazy"
						/>
					</a>
				);
			})}
		</span>
	);

	const metadataRow = pr.link.matches('.js-issue-row *')
		// Legacy DOM
		? pr.link.closest('.js-issue-row')!.querySelector('.text-small.color-fg-muted .d-none.d-md-inline-flex')
		// React DOM
		: closestElement('li', pr.link)?.querySelector(
			'div[data-testid="list-row-repo-name-and-number"], div[class^="Description"]',
		);

	metadataRow?.append(avatarStack);
}

async function add(prLinks: HTMLAnchorElement[]): Promise<void> {
	const prs = new Set<Pr>();
	for (const link of prLinks) {
		const [, owner, repo, , number] = link.pathname.split('/');
		prs.add({
			link,
			owner,
			repo,
			number: Number(number),
		});
	}

	const prsByRepo = Map.groupBy(prs, pr => `${pr.owner}/${pr.repo}`);
	const data = await api.v4(buildQuery(prsByRepo));

	for (const repoPrs of prsByRepo.values()) {
		const {owner, repo} = repoPrs[0];
		const repoData = data[api.escapeKey('repo', owner, repo)];

		for (const pr of repoPrs) {
			const prData = repoData[api.escapeKey('pr', pr.number)];

			// Build login → reviewer map; later entries override earlier ones (state priority)
			const byLogin = new Map<string, Reviewer>();

			const isFiltered = (login: string): boolean =>
				login === 'copilot-pull-request-reviewer'
				|| login === prData.author?.login;

			// Pending requests have no review state yet
			for (const node of prData.reviewRequests.nodes) {
				const r = node.requestedReviewer;
				if (r?.login && !isFiltered(r.login)) {
					byLogin.set(r.login, {login: r.login, avatarUrl: r.avatarUrl, state: 'PENDING'});
				}
			}

			// Later reviews override earlier ones; APPROVED/CHANGES_REQUESTED beat COMMENTED
			const statePriority: Record<string, number> = {COMMENTED: 1, CHANGES_REQUESTED: 2, APPROVED: 3};
			for (const node of prData.reviews.nodes) {
				if (!node.author?.login || isFiltered(node.author.login)) {
					continue;
				}

				const existing = byLogin.get(node.author.login);
				const incomingPriority = statePriority[node.state] ?? 0;
				const existingPriority = existing ? (statePriority[existing.state] ?? 0) : 0;
				if (incomingPriority >= existingPriority) {
					byLogin.set(node.author.login, {
						login: node.author.login,
						avatarUrl: node.author.avatarUrl,
						state: node.state as ReviewState,
					});
				}
			}

			renderReviewers(pr, [...byLogin.values()]);

			const unresolvedCount = prData.reviewThreads.nodes.filter(
				(node: {isResolved: boolean}) => !node.isResolved,
			).length;
			renderUnresolvedComments(pr, unresolvedCount);
		}
	}
}

async function init(signal: AbortSignal): Promise<void> {
	observe(
		[
			'.js-issue-row a[data-hovercard-type="pull_request"]',
			'a[data-hovercard-type="pull_request"][data-testid="listitem-title-link"]',
			'a[data-hovercard-type="pull_request"][data-testid="issue-pr-title-link"]',
		],
		batchedFunction(add, {delay: 100}),
		{signal},
	);
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isIssueOrPRList,
	],
	requiresToken: true,
	init,
});

/*

Test URLs:

- Repo PR list: https://github.com/refined-github/refined-github/pulls
- Global PR list: https://github.com/pulls

*/
