import { Plugin, Slot, Style, type UiTooltipProps } from "@opencode/plugin/gui"
import { For, Show, createSignal, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Usage } from "./rpc"
import { Snapshot, isStale, resetLabel, type ProviderSnapshot } from "./model"
import { SharedUsage, type UsageView } from "./usage-state"
import css from "./gui.css?inline"
import { halfRingPath, ringWindows, tooltipWindows, weeklyTrack } from "./presentation"
import type { QuotaWindow } from "./model"

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

function Details(props: { state: UsageView; now: number }) {
  return (
    <div class="usage-details">
      <For each={["claude", "codex"] as const}>
        {(name) => {
          const quota = () => provider(props.state.snapshot, name)
          return (
            <section class="usage-details__provider">
              <div class="usage-details__heading">
                <strong>{name === "claude" ? "Claude" : "Codex"}</strong>
                <Show when={props.state.offline || (quota() && isStale(quota()!, props.now))}>
                  <span>{props.state.offline ? "Offline" : "Stale"}</span>
                </Show>
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
    <props.Tooltip placement="bottom" value={<Details state={props.state} now={props.now} />}>
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
          .flatMap((item) =>
            item.windows
              .filter((window) => window.resetsAt !== null && window.resetsAt <= time)
              .map((window) => `${item.provider}:${window.id}:${window.resetsAt}`),
          )
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
