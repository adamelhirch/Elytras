import { useEffect, useMemo, useState } from "react";
import type { ChannelCatalogEntry, DashboardChannel } from "../types";
import {
  buildChannelRouteSummary,
  normalizeChannelAccountId,
  resolveChannelRouteKind,
} from "./routes";

type ChannelRouteMultiSelectorProps = {
  channels: DashboardChannel[];
  channelTemplateById: Map<string, ChannelCatalogEntry["template"]>;
  selectedIds: string[];
  onChange: (nextIds: string[]) => void;
  disabledIds?: string[];
  emptySelectionLabel: string;
  emptyResultsTitle?: string;
  emptyResultsBody?: string;
  searchPlaceholder?: string;
};

type RouteOption = {
  channel: DashboardChannel;
  summary: string;
  transportId: string;
  transportLabel: string;
  accountId: string;
  accountLabel: string;
  destinationKindId: string;
  destinationKindLabel: string;
  destinationValue: string;
};

type RouteGroup = {
  key: string;
  transportId: string;
  transportLabel: string;
  accountId: string;
  accountLabel: string;
  selectedCount: number;
  totalCount: number;
  routes: RouteOption[];
};

function sortSelectedFirst(
  routes: RouteOption[],
  selectedIds: Set<string>,
) {
  return [...routes].toSorted((left, right) => {
    const leftSelected = selectedIds.has(left.channel.id) ? 1 : 0;
    const rightSelected = selectedIds.has(right.channel.id) ? 1 : 0;
    if (leftSelected !== rightSelected) {
      return rightSelected - leftSelected;
    }
    return left.destinationValue.localeCompare(right.destinationValue);
  });
}

export function ChannelRouteMultiSelector(props: ChannelRouteMultiSelectorProps) {
  const [transportFilter, setTransportFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [destinationKindFilter, setDestinationKindFilter] = useState("all");
  const [destinationSearch, setDestinationSearch] = useState("");

  const selectedIdSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
  const disabledIdSet = useMemo(() => new Set(props.disabledIds || []), [props.disabledIds]);

  const routeOptions = useMemo<RouteOption[]>(
    () =>
      props.channels
        .map((channel) => {
          const template = props.channelTemplateById.get(channel.kind);
          const routeKind = resolveChannelRouteKind(
            template ? { template } : undefined,
            channel.destinationType,
          );
          return {
            channel,
            summary: buildChannelRouteSummary(channel, template),
            transportId: channel.kind,
            transportLabel: template?.label || channel.kind,
            accountId: normalizeChannelAccountId(channel.accountId),
            accountLabel: channel.accountId?.trim() || "default",
            destinationKindId: routeKind?.id || channel.destinationType || "target",
            destinationKindLabel: routeKind?.label || template?.routeConfig.targetLabel || "Destination",
            destinationValue: channel.deliveryTarget || channel.target || "n/a",
          };
        })
        .toSorted((left, right) => {
          if (left.transportLabel !== right.transportLabel) {
            return left.transportLabel.localeCompare(right.transportLabel);
          }
          if (left.accountLabel !== right.accountLabel) {
            return left.accountLabel.localeCompare(right.accountLabel);
          }
          return left.destinationValue.localeCompare(right.destinationValue);
        }),
    [props.channelTemplateById, props.channels],
  );

  const transportOptions = useMemo(
    () =>
      Array.from(
        new Map(routeOptions.map((route) => [route.transportId, route.transportLabel])).entries(),
      ).map(([value, label]) => ({ value, label })),
    [routeOptions],
  );

  const accountOptions = useMemo(() => {
    const scopedRoutes =
      transportFilter === "all"
        ? routeOptions
        : routeOptions.filter((route) => route.transportId === transportFilter);
    return Array.from(
      new Map(scopedRoutes.map((route) => [route.accountId, route.accountLabel])).entries(),
    ).map(([value, label]) => ({ value, label }));
  }, [routeOptions, transportFilter]);

  const destinationKindOptions = useMemo(() => {
    const scopedRoutes = routeOptions.filter((route) => {
      if (transportFilter !== "all" && route.transportId !== transportFilter) {
        return false;
      }
      if (accountFilter !== "all" && route.accountId !== accountFilter) {
        return false;
      }
      return true;
    });
    return Array.from(
      new Map(
        scopedRoutes.map((route) => [route.destinationKindId, route.destinationKindLabel]),
      ).entries(),
    ).map(([value, label]) => ({ value, label }));
  }, [accountFilter, routeOptions, transportFilter]);

  useEffect(() => {
    if (transportFilter === "all") {
      return;
    }
    if (!transportOptions.some((option) => option.value === transportFilter)) {
      setTransportFilter("all");
    }
  }, [transportFilter, transportOptions]);

  useEffect(() => {
    if (accountFilter === "all") {
      return;
    }
    if (!accountOptions.some((option) => option.value === accountFilter)) {
      setAccountFilter("all");
    }
  }, [accountFilter, accountOptions]);

  useEffect(() => {
    if (destinationKindFilter === "all") {
      return;
    }
    if (!destinationKindOptions.some((option) => option.value === destinationKindFilter)) {
      setDestinationKindFilter("all");
    }
  }, [destinationKindFilter, destinationKindOptions]);

  const filteredRoutes = useMemo(() => {
    const normalizedSearch = destinationSearch.trim().toLowerCase();
    return routeOptions.filter((route) => {
      if (transportFilter !== "all" && route.transportId !== transportFilter) {
        return false;
      }
      if (accountFilter !== "all" && route.accountId !== accountFilter) {
        return false;
      }
      if (
        destinationKindFilter !== "all" &&
        route.destinationKindId !== destinationKindFilter
      ) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      const haystack = [
        route.channel.name,
        route.destinationValue,
        route.destinationKindLabel,
        route.summary,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [
    accountFilter,
    destinationKindFilter,
    destinationSearch,
    routeOptions,
    transportFilter,
  ]);

  const filteredGroups = useMemo<RouteGroup[]>(
    () =>
      Array.from(
        filteredRoutes.reduce((groups, route) => {
          const key = `${route.transportId}::${route.accountId}`;
          const existing = groups.get(key);
          if (existing) {
            existing.routes.push(route);
            existing.totalCount += 1;
            if (selectedIdSet.has(route.channel.id)) {
              existing.selectedCount += 1;
            }
            return groups;
          }
          groups.set(key, {
            key,
            transportId: route.transportId,
            transportLabel: route.transportLabel,
            accountId: route.accountId,
            accountLabel: route.accountLabel,
            selectedCount: selectedIdSet.has(route.channel.id) ? 1 : 0,
            totalCount: 1,
            routes: [route],
          });
          return groups;
        }, new Map<string, RouteGroup>()),
      )
        .map(([, group]) => ({
          ...group,
          routes: sortSelectedFirst(group.routes, selectedIdSet),
        }))
        .toSorted((left, right) => {
          if (left.transportLabel !== right.transportLabel) {
            return left.transportLabel.localeCompare(right.transportLabel);
          }
          return left.accountLabel.localeCompare(right.accountLabel);
        }),
    [filteredRoutes, selectedIdSet],
  );

  const selectedRoutes = useMemo(
    () => sortSelectedFirst(routeOptions.filter((route) => selectedIdSet.has(route.channel.id)), selectedIdSet),
    [routeOptions, selectedIdSet],
  );
  const selectedTransportCount = useMemo(
    () => new Set(selectedRoutes.map((route) => route.transportId)).size,
    [selectedRoutes],
  );
  const selectedAccountCount = useMemo(
    () => new Set(selectedRoutes.map((route) => `${route.transportId}:${route.accountId}`)).size,
    [selectedRoutes],
  );
  const selectedDestinationKindCount = useMemo(
    () => new Set(selectedRoutes.map((route) => route.destinationKindId)).size,
    [selectedRoutes],
  );
  const visibleSelectedRoutes = selectedRoutes.slice(0, 4);
  const hiddenSelectedRouteCount = Math.max(selectedRoutes.length - visibleSelectedRoutes.length, 0);

  function commitSelection(nextIds: string[]) {
    props.onChange(Array.from(new Set(nextIds)).toSorted((left, right) => left.localeCompare(right)));
  }

  function toggleChannel(channelId: string) {
    if (disabledIdSet.has(channelId)) {
      return;
    }
    const nextIds = selectedIdSet.has(channelId)
      ? props.selectedIds.filter((entry) => entry !== channelId)
      : [...props.selectedIds, channelId];
    commitSelection(nextIds);
  }

  function toggleGroup(group: RouteGroup) {
    const eligibleIds = group.routes
      .map((route) => route.channel.id)
      .filter((channelId) => !disabledIdSet.has(channelId));
    if (!eligibleIds.length) {
      return;
    }
    const allSelected = eligibleIds.every((channelId) => selectedIdSet.has(channelId));
    const eligibleIdSet = new Set(eligibleIds);
    commitSelection(
      allSelected
        ? props.selectedIds.filter((entry) => !eligibleIdSet.has(entry))
        : [...props.selectedIds, ...eligibleIds],
    );
  }

  function clearSelection() {
    commitSelection(props.selectedIds.filter((entry) => disabledIdSet.has(entry)));
  }

  return (
    <div className="route-selector-shell">
      <div className="route-selector-summary-grid">
        <article className="route-selector-summary-card">
          <span>Destinations actives</span>
          <strong>{selectedRoutes.length}</strong>
          <small>{filteredRoutes.length} visible(s) avec les filtres courants</small>
        </article>
        <article className="route-selector-summary-card">
          <span>Transports couverts</span>
          <strong>{selectedTransportCount}</strong>
          <small>{transportOptions.length} transport(s) detecte(s)</small>
        </article>
        <article className="route-selector-summary-card">
          <span>Comptes couverts</span>
          <strong>{selectedAccountCount}</strong>
          <small>{accountOptions.length} compte(s) compatibles</small>
        </article>
        <article className="route-selector-summary-card">
          <span>Types de cible</span>
          <strong>{selectedDestinationKindCount}</strong>
          <small>{destinationKindOptions.length} type(s) disponibles</small>
        </article>
      </div>

      <div className="route-selector-selection-strip">
        {selectedRoutes.length ? (
          <>
            {visibleSelectedRoutes.map((route) => (
            <span key={`selection-${route.channel.id}`} className="inline-tag route-selector-chip">
              {route.summary}
            </span>
            ))}
            {hiddenSelectedRouteCount ? (
              <span className="inline-tag route-selector-chip">
                +{hiddenSelectedRouteCount} autre(s)
              </span>
            ) : null}
            <button type="button" className="ghost-button route-selector-clear" onClick={clearSelection}>
              Vider
            </button>
          </>
        ) : (
          <span className="inline-tag route-selector-chip">{props.emptySelectionLabel}</span>
        )}
      </div>

      <div className="route-selector-toolbar">
        <label>
          <span>Transport</span>
          <select
            className="select"
            value={transportFilter}
            onChange={(event) => setTransportFilter(event.target.value)}
          >
            <option value="all">Tous</option>
            {transportOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Compte</span>
          <select
            className="select"
            value={accountFilter}
            onChange={(event) => setAccountFilter(event.target.value)}
          >
            <option value="all">Tous</option>
            {accountOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Type destination</span>
          <select
            className="select"
            value={destinationKindFilter}
            onChange={(event) => setDestinationKindFilter(event.target.value)}
          >
            <option value="all">Tous</option>
            {destinationKindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="route-selector-search">
          <span>Destination</span>
          <input
            className="input"
            value={destinationSearch}
            onChange={(event) => setDestinationSearch(event.target.value)}
            placeholder={props.searchPlaceholder || "@channel, user id, group, thread..."}
          />
        </label>
      </div>

      {filteredGroups.length ? (
        <div className="route-selector-groups">
          {filteredGroups.map((group) => (
            <section key={group.key} className="route-selector-group">
              <div className="route-selector-group-head">
                <div className="stack compact">
                  <strong>{group.transportLabel}</strong>
                  <small className="muted-line">
                    compte {group.accountLabel} · {group.selectedCount}/{group.totalCount} selectionnee(s)
                  </small>
                </div>
                <div className="route-selector-group-actions">
                  <code className="mono route-selector-group-code">
                    {group.transportId}:{group.accountId}
                  </code>
                  <button
                    type="button"
                    className="ghost-button route-selector-group-toggle"
                    onClick={() => toggleGroup(group)}
                  >
                    {group.routes.every(
                      (route) => disabledIdSet.has(route.channel.id) || selectedIdSet.has(route.channel.id),
                    )
                      ? "Tout retirer"
                      : "Tout activer"}
                  </button>
                </div>
              </div>
              <div className="route-selector-grid">
                {group.routes.map((route) => {
                  const selected = selectedIdSet.has(route.channel.id);
                  const disabled = disabledIdSet.has(route.channel.id);
                  return (
                    <button
                      key={route.channel.id}
                      type="button"
                      disabled={disabled}
                      className={`route-selector-card ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`}
                      onClick={() => toggleChannel(route.channel.id)}
                    >
                      <div className="info-row compact">
                        <strong>{route.channel.name}</strong>
                        <span className={`status-pill ${selected ? "success" : disabled ? "danger" : "muted"}`}>
                          {selected ? "actif" : disabled ? "bloque" : "off"}
                        </span>
                      </div>
                      <div className="route-selector-card-tags">
                        <span className="inline-tag">{route.destinationKindLabel}</span>
                        <span className="inline-tag">{route.accountLabel}</span>
                      </div>
                      <div className="route-selector-card-target">
                        <span>Destination reelle</span>
                        <code className="mono">{route.destinationValue}</code>
                      </div>
                      <small className="muted-line">{route.summary}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <strong>{props.emptyResultsTitle || "Aucune destination trouvee"}</strong>
          <p>
            {props.emptyResultsBody ||
              "Ajuste les filtres transport/compte/destination ou cree une nouvelle destination dans Channels."}
          </p>
        </div>
      )}
    </div>
  );
}
