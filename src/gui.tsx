import { Plugin, Slot, Style, type UiTooltipProps } from "@opencode/plugin/gui"
import { For, Show, createSignal, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Usage } from "./rpc"
import { Snapshot, creditExpiryLabel, resetSummaryLabel, isStale, resetLabel, type ProviderSnapshot } from "./model"
import { SharedUsage, type UsageView } from "./usage-state"
import css from "./gui.css?inline"
import { halfRingPath, ringWindows, tooltipWindows, weeklyTrack } from "./presentation"
import type { QuotaWindow, ResetCredits } from "./model"

function provider(snapshot: Snapshot | undefined, name: ProviderSnapshot["provider"]) {
  return snapshot?.providers.find((item) => item.provider === name)
}

function HalfRing(props: {
  quota: ProviderSnapshot | undefined
  name: ProviderSnapshot["provider"]
  window: QuotaWindow | undefined
  radius: number
  strokeWidth?: number
  now: number
  offline: boolean
}) {
  const used = () => Math.min(100, Math.max(0, props.window?.usedPercent ?? 0))
  const path = () => halfRingPath(props.name, props.radius)
  return (
    <Show when={props.window || (!props.quota?.windows.length && props.quota?.status !== "ready")}>
      <g
        data-unknown={!props.window}
        data-stale={props.offline || (!!props.quota && isStale(props.quota, props.now))}
        style={{ "--usage-ring-stroke": String(props.strokeWidth ?? 1.5) }}
      >
        <path class="usage-wheel__track" d={path()} />
        <Show when={props.window}>
          <path class="usage-wheel__progress" d={path()} pathLength="100" stroke-dasharray={`${used()} 100`} />
        </Show>
      </g>
    </Show>
  )
}

function Warning(props: { message: string; Tooltip: Component<UiTooltipProps> }) {
  return (
    <props.Tooltip value={props.message}>
      <span class="usage-warning" tabindex="0" aria-label={props.message}>
        !
      </span>
    </props.Tooltip>
  )
}

function Details(props: { state: UsageView; now: number; Tooltip: Component<UiTooltipProps> }) {
  return (
    <div class="usage-details usage-details--quota">
      <For each={["claude", "codex"] as const}>
        {(name) => {
          const quota = () => provider(props.state.snapshot, name)
          return (
            <section class="usage-details__provider">
              <div class="usage-details__heading">
                <strong>{name === "claude" ? "Claude" : "Codex"}</strong>
                <Show
                  when={
                    props.state.offline ||
                    (quota() && isStale(quota()!, props.now)) ||
                    (quota()?.resetInventoryStatus && quota()?.resetInventoryStatus !== "ready")
                  }
                >
                  <Warning
                    Tooltip={props.Tooltip}
                    message={
                      props.state.offline
                        ? "Offline — showing last observation"
                        : quota()?.resetInventoryStatus && quota()?.resetInventoryStatus !== "ready"
                          ? "Reset inventory unavailable or out of date"
                          : "Usage may be out of date"
                    }
                  />
                </Show>
                <ResetChips quota={quota()} now={props.now} Tooltip={props.Tooltip} />
              </div>
              <For each={tooltipWindows(quota())}>
                {(window) => (
                  <div class="usage-details__window">
                    <span>{window.label}</span>
                    <span>{Math.round(window.usedPercent)}% used</span>
                    <span class="usage-details__muted">{resetLabel(window.resetsAt, props.now)}</span>
                  </div>
                )}
              </For>
              <Show when={!quota()?.windows.length}>
                <p class="usage-details__muted">Usage unavailable</p>
              </Show>
            </section>
          )
        }}
      </For>
    </div>
  )
}

function UsageWheel(props: {
  state: UsageView
  now: number
  Tooltip: Component<UiTooltipProps>
  refresh(force?: boolean): void
}) {
  return (
    <props.Tooltip placement="bottom" value={<Details state={props.state} now={props.now} Tooltip={props.Tooltip} />}>
      <button
        class="usage-wheel"
        type="button"
        aria-label="Claude and Codex account usage"
        aria-busy={props.state.busy}
        onClick={() => props.refresh(true)}
        onPointerEnter={() => props.refresh()}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <For each={["claude", "codex"] as const}>
            {(name) => {
              const quota = () => provider(props.state.snapshot, name)
              const windows = () => ringWindows(quota())
              return (
                <>
                  <HalfRing
                    quota={quota()}
                    name={name}
                    window={windows().fiveHour}
                    radius={8}
                    now={props.now}
                    offline={props.state.offline}
                  />
                  <HalfRing
                    quota={quota()}
                    name={name}
                    window={windows().sevenDay}
                    radius={weeklyTrack(quota()).radius}
                    strokeWidth={weeklyTrack(quota()).strokeWidth}
                    now={props.now}
                    offline={props.state.offline}
                  />
                </>
              )
            }}
          </For>
        </svg>
      </button>
    </props.Tooltip>
  )
}

function ResetChips(props: { quota: ProviderSnapshot | undefined; now: number; Tooltip: Component<UiTooltipProps> }) {
  const groups = (): NonNullable<ResetCredits["groups"]> =>
    props.quota?.resetCredits?.groups ??
    (props.quota?.resetCredits?.available
      ? [
          {
            type: "Reset",
            available: props.quota.resetCredits.available,
            expirations: [props.quota.resetCredits.expiresAt],
          },
        ]
      : [])
  return (
    <Show when={resetSummaryLabel(props.quota?.resetCredits, props.now)}>
      {(label) => (
        <span class="usage-resets" aria-label="Available resets">
          <props.Tooltip
            placement="left"
            value={
              <div class="usage-details">
                <Show when={props.quota?.resetInventoryStatus && props.quota.resetInventoryStatus !== "ready"}>
                  <span class="usage-details__muted">Last observation — inventory unavailable</span>
                </Show>
                <For each={groups()}>
                  {(group) => (
                    <section>
                      <strong>
                        {group.available} {group.available === 1 ? "reset" : "resets"} ·{" "}
                        {group.type.replaceAll("_", " ")}
                      </strong>
                      <Show when={group.usableNow === false}>
                        <span class="usage-details__muted">Not usable right now</span>
                      </Show>
                      <For each={[...group.expirations].sort((a, b) => (a ?? Infinity) - (b ?? Infinity))}>
                        {(expiry) => <span class="usage-details__muted">{creditExpiryLabel(expiry, props.now)}</span>}
                      </For>
                    </section>
                  )}
                </For>
                <Show when={!props.quota?.resetCredits?.groups}>
                  <span class="usage-details__muted">Earliest reported expiration</span>
                </Show>
              </div>
            }
          >
            <button type="button" class="usage-reset-chip" aria-label={label()}>
              {label()}
            </button>
          </props.Tooltip>
        </span>
      )}
    </Show>
  )
}

export default Plugin.define({
  setup(ctx) {
    const [memory, updateMemory] = ctx.storage.memory<{ snapshot?: Snapshot }>("global-usage-v1", { initial: {} })
    const initial = Snapshot.safeParse(memory.snapshot)
    const [state, setState] = createStore<UsageView>({
      snapshot: initial.success ? initial.data : undefined,
      busy: false,
      offline: false,
    })
    const [now, setNow] = createSignal(Date.now())
    const usage = new SharedUsage(
      (refresh) => ctx.client.rpc(Usage).snapshot({ refresh }),
      state.snapshot,
      (next) => {
        setState(next)
        if (next.snapshot)
          updateMemory((draft) => {
            draft.snapshot = next.snapshot
          })
      },
    )
    const refresh = (force = false) => {
      if (document.visibilityState !== "hidden") void usage.refresh(force)
    }
    let resetKey = ""
    const tick = setInterval(() => {
      const time = Date.now()
      setNow(time)
      const crossed =
        state.snapshot?.providers
          .flatMap((item) => [
            ...item.windows
              .filter((window) => window.resetsAt !== null && window.resetsAt <= time)
              .map((window) => `${item.provider}:${window.id}:${window.resetsAt}`),
            ...(item.resetCredits?.expiresAt != null && item.resetCredits.expiresAt <= time
              ? [`${item.provider}:reset-credits:${item.resetCredits.expiresAt}`]
              : []),
            ...(item.resetCredits?.groups ?? []).flatMap((group) =>
              group.expirations
                .filter((at) => at !== null && at <= time)
                .map((at) => `${item.provider}:${group.type}:${at}`),
            ),
          ])
          .sort()
          .join("|") ?? ""
      if (crossed && crossed !== resetKey) {
        resetKey = crossed
        refresh(true)
      }
    }, 15_000)
    const poll = setInterval(() => refresh(), 30_000)
    const focus = () => {
      setNow(Date.now())
      refresh()
    }
    window.addEventListener("focus", focus)
    document.addEventListener("visibilitychange", focus)
    ctx.add(Style, css)
    ctx.add(Slot, {
      at: "session.header",
      // Installed OpenCode 2.2.4 registers its native context wheel at 10.
      order: 0,
      render: () => <UsageWheel state={state} now={now()} Tooltip={ctx.ui.Tooltip} refresh={refresh} />,
    })
    refresh()
    return () => {
      usage.dispose()
      clearInterval(tick)
      clearInterval(poll)
      window.removeEventListener("focus", focus)
      document.removeEventListener("visibilitychange", focus)
    }
  },
})
