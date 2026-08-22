# Agent Note: Model picker navigation for large catalogs

Status: implemented

English | [中文](2026-08-22-model-picker-large-catalog-navigation.zh.md)

## Problem

The composer's model pane renders the advertised directory as one provider-grouped scroll, and the seat is the only per-session way to switch models. That reads well for a deployment running one or two hand-listed routes, which is what every shipped composition did when the pane was built. A pi-ai gateway route changes the size: a route naming an installed catalog provider serves that provider's whole catalog, and OpenRouter alone advertises 276 models. Reaching one then means scrolling roughly three hundred rows through a card capped at 360px, with the provider heading as the only landmark.

## Decision

The model pane gets two ways through a large catalog: a text filter above the grouped list, and a provider heading that folds its own models away.

### The filter

The pane renders a text input above the grouped list, and the list shows only what the query matches.

A query is split on whitespace, and every token must match the same row to keep it. One row's searchable text is its provider's id and name plus the model's own id, name, and description, compared case-insensitively. Matching the id beside the display name is what keeps a model reachable by the id its provider documents when the catalog renders a different name for it — `gemini-3-flash` finds `Google: Gemini 3 Flash` — and matching the provider fields lets a route name narrow the pane to that route. Requiring every token rather than the raw string lets `gemini flash` reach `Google: Gemini 3 Flash`, which a substring test would miss.

The filter is display-only: it narrows what the open pane renders over the already-resident directory and never queries the Host, so the advertised set, the selection contract, and `session.selectModel` are untouched. A group whose models all drop out renders no heading, and a query matching nothing renders its own message naming the query, which is a different fact from a catalog with no models at all and reads as a different line.

The query belongs to one visit of the pane. Entering the pane focuses the box on the whole list; leaving it, or closing the menu, discards the query, so a later visit never opens onto a list silently narrowed by a filter it does not show. ArrowDown from the box moves into the list at its first row, because the generic wrap-around the menu already uses starts from whichever item holds focus and none does while the caret is in the box.

### Folding a group

Each provider heading is the group's disclosure control rather than static text: pressing it folds that group's models away and pressing it again brings them back. The heading always renders, because it is the way back, and it carries the count of what it holds — the fact a folded group would otherwise hide, and the number of matches while a query is active. The headings join the menu's arrow-key order, so the first row ArrowDown reaches from the filter box is the first group's heading.

Folding outlives one visit of the pane, unlike the query. Putting a 276-model route out of the way is a standing preference about a group that is noisy for this deployment, so re-opening the menu keeps it folded, whereas a query is a single lookup and starting the next visit inside it would hide models the pane never explains.

An active query overrides folding: every matching group renders expanded, and the fold is not cleared, only ignored while the query stands. A search whose own answer sits inside a folded group would otherwise report nothing, which is worse than having no search at all.

## Alternatives considered

**Filtering through the Host.** Passing the query to `session.models` was rejected: the directory is already resident and shared with the `/model` entry, so a round trip per keystroke buys no correctness and makes the pane's content depend on connection state that nothing else in the seat depends on.

**Matching the display name only.** Rejected because the name a catalog renders and the id a provider documents routinely differ, and the id is what a user reads in provider docs, config, and session logs. A name-only filter would leave a model unreachable by the only string its user knows.

**Raw substring matching.** Rejected: it fails exactly where a model name carries a version or vendor segment between the words a user types, which is most of a gateway catalog.

**Showing the filter only past a row count.** Rejected because the threshold is an invented constant with no owner, and a control that appears for some routes and not others makes the pane's behavior unpredictable to the person using it.

**Virtualizing the list instead.** Rejected as an answer to this problem: it makes three hundred rows cheaper to render without making one of them easier to find. It stays available later for render cost, which is a separate concern from reaching a known model.

**Folding every group by default.** Rejected: it would make a first-time pane show nothing but headings, and a deployment with one small route — which every shipped composition still is — would pay a press to see the list it used to open on.

**Clearing the fold when a query starts.** Rejected in favor of ignoring it: clearing means the fold silently disappears after an unrelated search, so the group the user put away comes back without them asking.

**Persisting the fold to user settings.** Rejected for want of a current consumer: the seat holds it for the session it belongs to, and nothing yet asks for the preference to survive a reload. A settings section would need a schema, a namespace, and a Host round trip for a preference no one has asked to keep.

## Consequences

The seat's Host-facing behavior is unchanged, so no session event, wire field, or durable fact moves; this is a client-local rendering decision and the directory remains the one source of the offered set.

The filter re-derives on every keystroke over the resident groups. At catalog sizes this is one array pass, and `useMemo` keys it to the groups and the query, so an unrelated directory refresh does not redo it. A folded group renders no option rows at all rather than hidden ones, so its models leave the arrow-key order with them.

The heading is now a control, so the group's `aria-labelledby` points at a button whose accessible name carries the group name and its count, and the fold state rides `aria-expanded` on that button.

`ModelSelect.tsx` sits under the client GUI coverage exemption in `vitest.config.ts`, so the new branches answer to the package's jsdom suite rather than to the per-file coverage gate.

The `/model` popupSelect entry keeps its own presentation and is not covered by this decision; a deployment reaching a large catalog through that entry still scrolls.

## Testing

`packages/client/ui-model-selection/tests/model-select.client.spec.tsx` covers the blank query against a narrowed one, matching by provider name, model id, and description, the every-token rule including a query whose tokens match different rows, the no-match message against an empty catalog's message, focus on entry and ArrowDown into the list, discarding the query when the pane is left, and selecting a row the filter narrowed to.

For folding it covers one heading press and its reverse, two groups folded independently, a fold surviving a pane visit while the query does not, a folded group's matches rendering while a query stands and folding again once it clears, and the count reporting matches rather than the catalog under a query.
